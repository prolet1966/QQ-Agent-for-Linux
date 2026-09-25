// mg-extract.js —— 记忆抽取（宿主：每 10 分钟、仅新消息时调模型；隐私闸；归一化去重键；相似合并双高门；冲突优先）
import { normalizeMemoryContent, contentKeyOf, similarityJaccard, cosine } from './mg-dedupe.js';
import { conflictSignal } from './mg-conflict.js';

export const MEMORY_KINDS = ['event', 'meme', 'relation'];

/** 隐私闸：过滤手机号/身份证/邮箱/密码（宿主语义照搬）。 */
const PRIVACY_RE = /(?:1\d{10}|\d{17}[\dXx]|\w+@\w+\.\w+|(?<=密码[为是]\s)[\w.\-@]+)/g;
function privacyGate(text) {
  const t = String(text ?? '');
  return !PRIVACY_RE.test(t);
}

/**
 * 抽取入口（宿主：拉新消息 → 调模型抽三类 → 隐私闸 → 归一化 → 去重/相似/冲突 → 入库）。
 * V0.3.1 形态：宿主调模型的那一段由调用方（核心/技能）提供 prompt；这里做「入库前的全部分流」：
 *   重复（同 content_key）→ mention_count+1 更新 last_seen_at，不 insert；
 *   相似（双高门）→ 自动合并 / 存疑打标；冲突（同一主体+Jaccard≥0.6+对立信号）→ 打 conflict_suspect 不合并；
 *   拒绝复活（reopened）→ 被拒 ≥reReviewAfter 次带 reopened 重提审。
 */
export async function extractMemories(db, c, { chatKey, sinceTs }) {
  const tenant = c.tenant?.default || 'default';
  const out = { newCount: 0, duplicates: 0, reopened: 0, conflicts: 0 };
  // 宿主模型调用在核心侧；这里提供「已抽到的候选批量入库」的纯分流逻辑（可被核心/技能复用）。
  // 实际的模型抽取由核心 before-llm-messages 钩子或技能触发，产出 rawCandidates 后调此函数入库。
  return out;
}

/** 把一批已抽好的候选记忆入库（宿主 ingestConversation 语义照搬）。 */
export async function ingestCandidates(db, c, rawCandidates, chatKey) {
  const tenant = c.tenant?.default || 'default';
  const simVector = c.simVector ?? 0.95;
  const simSuspect = c.simSuspect ?? 0.88;
  const reReviewAfter = c.reReviewAfter ?? 3;
  let newCount = 0, duplicates = 0, reopened = 0, conflicts = 0;

  // 相似池：该群最近记忆（宿主 loadSimilarityPool；projection 必须覆盖判定用到的每一个字段 —— 宿主踩两次坑的教训）
  const pool = await db.collection('memory_items').find({ tenant_id: tenant, archived: { $ne: true } })
    .project({ content: 1, kind: 1, subject_id: 1, subject_name: 1, embedding: 1, embed_provider: 1, mention_count: 1, status: 1 })
    .limit(500)
    .toArray();

  for (const raw of rawCandidates) {
    const kind = MEMORY_KINDS.includes(raw.kind) ? raw.kind : 'event';
    const content = String(raw.content ?? '').trim();
    if (!content || content.length < 6 || content.length > 300) continue;   // autoApprove 边界
    if (!privacyGate(content)) continue;                                     // 隐私闸

    const ckey = contentKeyOf(kind, content);
    // 1) 重复：同 chat_key + content_key → mention_count+1 并更新 last_seen_at，不 insert（宿主修复）
    const dup = await db.collection('memory_candidates').findOne({ tenant_id: tenant, chat_key: chatKey, content_key: ckey });
    if (dup) {
      await db.collection('memory_candidates').updateOne({ _id: dup._id }, {
        $inc: { mention_count: 1 },
        $set: { last_seen_at: new Date() },
      });
      // 拒绝复活：被拒 ≥ reReviewAfter 次带 reopened 重提审
      if (dup.status === 'rejected' && (dup.mention_count ?? 0) >= reReviewAfter) {
        await db.collection('memory_candidates').updateOne({ _id: dup._id }, {
          $set: { status: 'pending', reopened: { from: 'rejected', hits: dup.mention_count ?? 1 } },
        });
        reopened++;
      }
      duplicates++;
      continue;
    }

    // 2) 冲突优先于相似合并（宿主：「喜欢 X」vs「不喜欢 X」相似度极高，按相似处理会丢信息）
    let conflictHit = null;
    for (const p of pool) {
      if ((p.subject_id ?? null) !== (raw.subject_id ?? null)) continue;
      const jac = similarityJaccard(content, p.content);
      if (jac < 0.6) continue;
      const sig = conflictSignal({ content, subject_id: raw.subject_id }, p);
      if (sig.ok) { conflictHit = { of: p.memory_id ?? p.content_key, score: jac, reason: sig.reason, of_content: p.content }; break; }
    }
    if (conflictHit) {
      await insertCandidate(db, c, { kind, content, ckey, chatKey, tenant, raw, suspect: null, conflict_suspect: conflictHit });
      conflicts++;
      continue;
    }

    // 3) 相似双高门（语义空间：向量 ≥ simVector 自动合并；≥ simSuspect 存疑打标）
    let best = null;
    for (const p of pool) {
      const vec = Array.isArray(p.embedding) ? cosine(p.embedding, raw.embedding ?? p.embedding) : 0;
      const jac = similarityJaccard(content, p.content);
      if (vec >= simVector && (c.simVector === 0.95 ? true : jac >= (c.simJaccard ?? 0.85))) {
        best = p; break;
      }
      if (vec >= simSuspect && (!best || vec > (best._sim ?? 0))) { best = { ...p, _sim: vec }; }
    }
    if (best && Array.isArray(best.embedding)) {
      const isAuto = Array.isArray(best.embedding) && cosine(best.embedding, raw.embedding ?? best.embedding) >= simVector;
      if (isAuto) {
        // 自动合并：并进已有那条 mention_count+1、留变体、必要时重提审
        await db.collection('memory_items').updateOne({ tenant_id: tenant, memory_id: best.memory_id }, {
          $inc: { mention_count: 1 },
          $set: { last_seen_at: new Date() },
          $push: { variants: { text: content, at: new Date() } },
        });
        await db.collection('memory_candidates').insertOne(candidateDoc({ kind, content, ckey, chatKey, tenant, status: 'duplicate', deduped_to: best.memory_id }));
        duplicates++;
        continue;
      }
      // 存疑：打 suspect_dup 交人裁决
      await insertCandidate(db, c, { kind, content, ckey, chatKey, tenant, raw, suspect: { of: best.memory_id, score: best._sim ?? 0 }, conflict_suspect: null });
      newCount++;
      continue;
    }

    // 4) 全新：正常入库
    await insertCandidate(db, c, { kind, content, ckey, chatKey, tenant, raw, suspect: null, conflict_suspect: null });
    newCount++;
  }

  return { newCount, duplicates, reopened, conflicts };
}

function candidateDoc({ kind, content, ckey, chatKey, tenant, status, deduped_to, suspect, conflict_suspect, mention_count }) {
  const now = new Date();
  return {
    memory_id: 'mem_' + now.getTime().toString(36) + Math.random().toString(36).slice(2, 6),
    tenant_id: tenant,
    chat_key: chatKey,
    kind,
    content,
    content_key: ckey,
    status,
    mention_count: mention_count ?? 1,
    last_seen_at: now,
    created_at: now,
    expires_at: new Date(now.getTime() + 30 * 86400_000),
    ...(deduped_to ? { deduped_to } : {}),
    ...(suspect ? { suspect_dup: suspect } : {}),
    ...(conflict_suspect ? { conflict_suspect } : {}),
  };
}
async function insertCandidate(db, c, { kind, content, ckey, chatKey, tenant, raw, suspect, conflict_suspect }) {
  // 自动审批（宿主：默认放行，只在有疑点时留待审；实测 4B 模型几乎都标高置信）
  const auto = c.autoApprove ?? {};
  let status = 'pending';
  if (auto.enabled !== false && auto.sensitiveKinds?.length === 0 &&
      (raw.confidence ?? 1) >= (auto.minConfidence ?? 0.7) &&
      content.length >= (auto.minChars ?? 6) && content.length <= (auto.maxChars ?? 300)) {
    status = 'auto_approved';
  }
  await db.collection('memory_candidates').insertOne(
    candidateDoc({ kind, content, ckey, chatKey, tenant, status, suspect, conflict_suspect, mention_count: raw.mention_count ?? 1 }),
  );
}
