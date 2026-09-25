// memory-growth —— 记忆库自增长（V0.3.1 确定性插件）
//
// 宿主来源：部署版 src/memory-growth.js（58KB，含全部演化特性：去重加固/相似合并/
//   冲突标记/生命周期/语义向量/检索门槛校准/控制台展示）。
// 一句话原则：抽取 → 去重/相似合并 → 冲突标记 → 人工审核 → 注入 → 生命周期，全链路可审计。
//
// 软依赖（缺了不崩，自动降级）：
//   - MongoDB（127.0.0.1:27017，独立库 qq_agent_memory，与知识库物理隔离）：无库时记忆库不工作（跳过抽取/检索），优雅降级不卡聊天
//   - 语义向量服务（127.0.0.1:3917）：不可用时逐字节退回哈希向量（宿主 kb-embed.js 同款降级路径）
//
// ⚠️ memory.* 是自建能力名 —— 核心不认识。必须被 skills/memory-growth-skill 用
//   api.capability() 消费（防孤儿能力，见 plugin-development.md §5）。
//   memory.recall 在 inject=true 时由核心提示词组装阶段软调用（before-context 钩子兜底）。

import { loadConfig, getCfg, tenantFor } from './lib/mg-config.js';
import { MongoHandle } from './lib/mg-mongo.js';
import { normalizeMemoryContent, contentKeyOf, similarityJaccard } from './lib/mg-dedupe.js';
import { conflictSignal } from './lib/mg-conflict.js';
import { recallMemory } from './lib/mg-retrieve.js';
import { reviewCandidate, archiveOne, forgetOne, undoPromote } from './lib/mg-review.js';
import { extractMemories, MEMORY_KINDS } from './lib/mg-extract.js';
import { hashEmbed } from './lib/mg-embed.js';

// ── 模块状态（setup 初始化，activate 建，deactivate 必须清）────────
let cfg = () => ({});
let mongoHandle = null;
let extractionTimer = null;
let cleanupTimer = null;   // 定期清理（weeklyCleanup）
let mongoProbeState = { ok: false, reason: '未探测', probeAt: 0 };
let semanticProbeState = { ok: false, reason: '未探测', probeAt: 0 };
let stats = { extracted: 0, pending: 0, approved: 0, rejected: 0, archived: 0, conflicts: 0 };

let api = null;

export function setup(a) {
  api = a;
  cfg = a.config;
  api.log('memory-growth 已加载（Mongo/语义向量均为软依赖，缺了优雅降级）');
}

/** available() 必须同步：首次乐观放行 + 后台探测缓存。缺 Mongo 不判不可用（降级跳过抽取）。 */
export function available() {
  return { ok: true, reason: mongoProbeState.ok ? 'Mongo 已连接' : '降级模式：' + (mongoProbeState.reason || 'Mongo 未探活') };
}

export async function activate(ctx) {
  // 1) Mongo 软依赖探活（后台，不阻塞）
  mongoProbeState = { ok: false, reason: '探测中', probeAt: Date.now() };
  (async () => {
    try {
      const c = cfg();
      mongoHandle = new MongoHandle({ uri: c.mongoUri, db: c.mongoDb });
      await mongoHandle.connect({ serverSelectionTimeoutMs: 800 });
      await ensureIndexes(mongoHandle.db);
      mongoProbeState = { ok: true, reason: 'connected', probeAt: Date.now() };
      api.log?.('memory-growth: MongoDB 已连接 ' + c.mongoUri + '/' + c.mongoDb);
    } catch (e) {
      mongoHandle = null;
      mongoProbeState = { ok: false, reason: e?.message ?? String(e), probeAt: Date.now() };
      api.log?.('memory-growth: MongoDB 不可用 → 记忆库不工作（' + e?.message + '），不卡聊天');
    }
  })();

  // 2) 语义向量服务探活（软依赖）
  const c0 = cfg();
  if (c0.semanticEmbedEnabled !== false) {
    const probe = async () => {
      try {
        const res = await fetch((c0.semanticEmbedUrl || 'http://127.0.0.1:3917') + '/health', { signal: AbortSignal.timeout(800) });
        semanticProbeState = { ok: res.ok, reason: res.ok ? 'online' : 'HTTP ' + res.status, probeAt: Date.now() };
      } catch (e) {
        semanticProbeState = { ok: false, reason: String(e?.message ?? e), probeAt: Date.now() };
      }
    };
    await probe();
    api.log?.('memory-growth: 语义向量服务 ' + (semanticProbeState.ok ? '已连接' : '不可用 → 退回哈希向量'));
  }

  // 3) 定时抽取 tick（每 10 分钟，仅在新消息时调模型；宿主语义照搬）
  if (c0.inject === true || c0.extractionEnabled !== false) {
    extractionTimer = setInterval(() => {
      runExtraction().catch((e) => api.warn?.('memory-growth: 抽取 tick 失败 ' + (e?.message ?? e)));
    }, c0.extractionIntervalMs ?? 600_000);
    extractionTimer.unref?.();
    api.log?.('memory-growth: 定时抽取已启动（间隔 ' + (c0.extractionIntervalMs ?? 600000) + 'ms）');
  }

  // 4) 定期清理（宿主 memoryGrowth.weeklyCleanup / cleanupDays / cleanupMaxMention / pinnedProtected）
  //    宿主那四个设置 V0.3.1 原本没有实现，这里补上：
  //    按"多久没被提到 + 被提到几次"把冷记忆归档（不是删除，可 unarchive 找回）。
  if (c0.weeklyCleanup === true) {
    const every = Math.max(3600_000, Number(c0.cleanupIntervalMs) || 7 * 86400_000);
    cleanupTimer = setInterval(() => {
      runCleanup().catch((e) => api.warn?.('memory-growth: 清理 tick 失败 ' + (e?.message ?? e)));
    }, every);
    cleanupTimer.unref?.();
    api.log?.('memory-growth: 定期清理已启动（每 ' + Math.round(every / 86400000) + ' 天，冷于 '
      + (Number(c0.cleanupDays) || 90) + ' 天且被提及 ≤ ' + (Number(c0.cleanupMaxMention) || 1) + ' 次的记忆归档）');
  }
}

/**
 * 定期清理：把「很久没被提到 + 被提到次数很少」的记忆归档（软删除，可恢复）。
 * 宿主语义：weeklyCleanup 开关 + cleanupDays 冷多久 + cleanupMaxMention 提及次数门槛
 *          + pinnedProtected 固定项不清理。
 */
async function runCleanup() {
  const c = cfg();
  if (!mongoProbeState.ok || !mongoHandle) return { ok: false, error: 'Mongo 不可用' };
  const days = Math.max(1, Number(c.cleanupDays) || 90);
  const maxMention = Math.max(0, Number(c.cleanupMaxMention) || 1);
  const cutoff = new Date(Date.now() - days * 86400_000);
  const filter = {
    archived: { $ne: true },
    status: { $ne: 'rejected' },
    mention_count: { $lte: maxMention },
    $or: [
      { last_seen_at: { $lt: cutoff } },
      { last_seen_at: { $exists: false }, created_at: { $lt: cutoff } },
    ],
  };
  if (c.pinnedProtected !== false) filter.pinned = { $ne: true };
  const res = await mongoHandle.db.collection('memory_items').updateMany(filter, {
    $set: { archived: true, archived_reason: 'scheduled-cleanup', archived_at: new Date() },
  });
  const n = res?.modifiedCount ?? 0;
  if (n > 0) {
    stats.cleaned = (stats.cleaned || 0) + n;
    api.log?.('memory-growth: 定期清理归档了 ' + n + ' 条冷记忆（冷于 ' + days + ' 天 / 提及 ≤ ' + maxMention + ' 次）');
  }
  return { ok: true, archived: n, days, maxMention };
}

export async function deactivate(ctx) {
  // 必须清掉 activate 建的东西
  if (extractionTimer) { clearInterval(extractionTimer); extractionTimer = null; }
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
  try { await mongoHandle?.close(); } catch {}
  mongoHandle = null;
  api.log?.('memory-growth: 已停用，抽取 tick 与 Mongo 连接全部清理');
}

export function dispose() {
  mongoHandle = null;
  extractionTimer = null;
  cleanupTimer = null;
}

// ── providers ────────────────────────────────────────────────────
export const providers = {
  /**
   * 记忆检索（供核心 before-context 注入或技能查询）。宿主 recallMemory 语义照搬：
   *   粗筛该群最近 300 条全额进打分（不再字面 $in 预筛，语义空间收益所在）；
   *   minScore 门槛（默认 0.48）过滤；过滤 archived；冲突候选不合并。
   * 入参：{ query, chatKey, topK? }
   * 返回：{ hits:[{...memory, score}], minScore, degraded }
   */
  'memory.recall': async ({ query, chatKey, topK } = {}) => {
    const c = cfg();
    if (!mongoProbeState.ok || !mongoHandle) return { hits: [], minScore: c.minScore ?? 0.48, degraded: true, reason: 'Mongo 不可用' };
    const tenant = tenantFor(chatKey, c);
    const r = await recallMemory(mongoHandle.db, c, { tenant, query, topK: topK ?? 5 });
    return r;
  },

  /**
   * 定时抽取（activate 已起 tick；此能力供手动触发 / 测试）。
   * 入参：{ chatKey?, sinceTs? }
   * 返回：{ ok, newCount, duplicates, reopened, conflicts }
   */
  'memory.extraction': async ({ chatKey, sinceTs } = {}) => {
    const r = await runExtraction({ chatKey, sinceTs });
    return r;
  },

  /**
   * 手动触发定期清理（也可由 weeklyCleanup 定时跑）。
   * 入参：{} —— 门槛全走设置（cleanupDays / cleanupMaxMention / pinnedProtected）。
   * 返回：{ ok, archived, days, maxMention }
   */
  'memory.cleanup': async () => runCleanup(),

  /** 插件整体状态（控制台「记忆库」页查询用）。 */
  'memory.growth-status': async () => ({
    mongo: mongoProbeState,
    semantic: semanticProbeState,
    stats,
    inject: cfg().inject === true,
    minScore: cfg().minScore ?? 0.48,
    simVector: cfg().simVector ?? 0.95,
    simSuspect: cfg().simSuspect ?? 0.88,
    reReviewAfter: cfg().reReviewAfter ?? 3,
    archiveAfterDays: cfg().archiveAfterDays ?? 0,
    weeklyCleanup: cfg().weeklyCleanup === true,
    cleanupDays: cfg().cleanupDays ?? 90,
    cleanupMaxMention: cfg().cleanupMaxMention ?? 1,
    pinnedProtected: cfg().pinnedProtected !== false,
    cleaned: stats.cleaned || 0,
  }),

  /**
   * 审核（approve / reject / undo）。宿主 review() 语义照搬：
   *   upsert 匹配键补齐 chat_key（防跨群串味）；mention_count 用 $max 不被重复转正冲小。
   * 入参：{ action:'approve'|'reject'|'undo', memoryId, chatKey, tenant }
   * 返回：{ ok, memoryId, status, error? }
   */
  'memory.review': async ({ action, memoryId, chatKey, tenant } = {}) => {
    const c = cfg();
    if (!mongoProbeState.ok || !mongoHandle) return { ok: false, error: 'Mongo 不可用，无法审核' };
    const t = tenant ?? tenantFor(chatKey, c);
    if (action === 'undo') {
      const r = await undoPromote(mongoHandle.db, t, memoryId);
      return r;
    }
    const r = await reviewCandidate(mongoHandle.db, c, { action, memoryId, chatKey, tenant: t });
    if (r.ok) {
      if (action === 'approve') { stats.approved++; stats.pending--; }
      else if (action === 'reject') { stats.rejected++; stats.pending--; }
    }
    return r;
  },

  /**
   * 生命周期（forget / archive / unarchive）。宿主阶段 D 语义照搬：
   *   forget：候选+正式库一起删，删前写审计（memory.forgotten）；
   *   archive：archived=true（不参与检索、数据还在），只针对 event（梗/关系不过期）；
   *   unarchive：捞回（archived 只是开关，不是删除）。
   * 入参：{ op:'forget'|'archive'|'unarchive', memoryIds?, days?, tenant }
   * 返回：{ ok, op, count, error? }
   */
  'memory.lifecycle': async ({ op, memoryIds, days, tenant } = {}) => {
    const c = cfg();
    if (!mongoProbeState.ok || !mongoHandle) return { ok: false, error: 'Mongo 不可用，无法操作生命周期' };
    const t = tenant ?? tenantFor(null, c);
    if (op === 'forget') {
      const ids = Array.isArray(memoryIds) && memoryIds.length ? memoryIds : [memoryIds];
      const r = await forgetOne(mongoHandle.db, t, ids);
      stats.archived += r.count ?? 0;
      return { ok: r.ok, op, count: r.count, error: r.error };
    }
    if (op === 'archive') {
      const r = await archiveOne(mongoHandle.db, c, { tenant: t, memoryIds: Array.isArray(memoryIds) ? memoryIds : null, days });
      return { ok: r.ok, op, count: r.count ?? r.preview, dryRun: !!r.preview && r.applied === false, error: r.error };
    }
    if (op === 'unarchive') {
      const ids = Array.isArray(memoryIds) && memoryIds.length ? memoryIds : [memoryIds];
      const r = await unarchiveOne(mongoHandle.db, t, ids);
      return { ok: r.ok, op, count: r.count, error: r.error };
    }
    // pin/unpin：钉住的记忆**永不被定期清理自动归档**（对应宿主 pinnedProtected 设置）。
    // 用 ObjectId 兼容两种入参：字符串 id 与 { $in: [...] } 都行。
    if (op === 'pin' || op === 'unpin') {
      const ids = (Array.isArray(memoryIds) ? memoryIds : [memoryIds]).map(String).filter(Boolean);
      if (!ids.length) return { ok: false, op, error: '没有给记忆 id' };
      try {
        const { ObjectId } = await import('mongodb');
        const oids = ids.filter((x) => /^[a-f0-9]{24}$/i.test(x)).map((x) => new ObjectId(x));
        const strIds = ids.filter((x) => !/^[a-f0-9]{24}$/i.test(x));
        const or = [];
        if (oids.length) or.push({ _id: { $in: oids } });
        if (strIds.length) or.push({ memory_id: { $in: strIds } });
        if (!or.length) return { ok: false, op, error: 'id 格式不认识' };
        const res = await mongoHandle.db.collection('memory_items').updateMany(
          { tenant_id: t, $or: or },
          { $set: { pinned: op === 'pin', pinned_at: new Date() } },
        );
        return { ok: true, op, count: res?.modifiedCount ?? 0 };
      } catch (e) {
        return { ok: false, op, error: String(e?.message ?? e) };
      }
    }
    return { ok: false, error: '未知操作 ' + op + '（支持 forget/archive/unarchive/pin/unpin）' };
  },

  /**
   * 控制台「扩展」面板的**写操作**入口（action. 前缀 = 核心 HTTP 放行的写白名单）。
   * op: 'review'  → { action:'approve'|'reject'|'undo', memoryId }  审核记忆
   *     'cleanup' → { }                                              跑一次定期清理
   *     'pin'     → { memoryIds:[], pinned? }                        固定/取消固定
   */
  'action.memory': async (args = {}) => {
    const op = String(args.op || '');
    if (op === 'review') return providers['memory.review']({ action: args.action, memoryId: args.memoryId });
    if (op === 'cleanup') return runCleanup();
    if (op === 'pin') return providers['memory.lifecycle']({ op: args.pinned === false ? 'unpin' : 'pin', memoryIds: args.memoryIds });
    return { ok: false, error: '未知操作 ' + op + '（支持 review / cleanup / pin）' };
  },

  /**
   * 控制台「扩展」面板数据（只读）。panel. 前缀 = 核心放行的只读约定。
   */
  'panel.memory': async () => {
    const c = cfg();
    const summary = [
      { label: 'MongoDB', value: mongoProbeState.ok ? '已连接' : ('降级：' + (mongoProbeState.reason || '未探活')) },
      { label: '语义向量', value: semanticProbeState.ok ? '已连接' : ('退回哈希：' + (semanticProbeState.reason || '未探活')) },
      { label: '注入对话', value: c.inject === true ? '开' : '关（只读）' },
      { label: '检索门槛', value: String(c.minScore ?? 0.48) },
      { label: '相似合并', value: '自动 ≥' + (c.simVector ?? 0.95) + ' / 存疑 ≥' + (c.simSuspect ?? 0.88) },
      { label: '已抽取', value: String(stats.extracted ?? 0) },
      { label: '定期清理', value: c.weeklyCleanup === true
        ? ('开（冷于 ' + (c.cleanupDays ?? 90) + ' 天 / 提及 ≤ ' + (c.cleanupMaxMention ?? 1) + ' 次' + (c.pinnedProtected !== false ? '，固定项跳过' : '') + '），已清 ' + (stats.cleaned || 0) + ' 条')
        : '关' },
    ];
    const sections = [];
    if (!mongoProbeState.ok || !mongoHandle?.db) {
      sections.push({ type: 'note', title: '为什么看不到数据', text: 'MongoDB 不可用（' + (mongoProbeState.reason || '未探活') + '），记忆库当前不工作（设计如此：优雅降级，不卡聊天）。' });
      return { title: '记忆库', summary, sections };
    }
    try {
      const db = mongoHandle.db;
      const tenant = tenantFor(null, c);
      const [pend, active, archived] = await Promise.all([
        db.collection('memory_candidates').countDocuments({ tenant_id: tenant, status: 'pending' }),
        db.collection('memory_items').countDocuments({ tenant_id: tenant, archived: { $ne: true } }),
        db.collection('memory_items').countDocuments({ tenant_id: tenant, archived: true }),
      ]);
      summary.push({ label: '待审', value: String(pend) }, { label: '正式记忆', value: String(active) }, { label: '已归档', value: String(archived) });
      const rows = await db.collection('memory_candidates')
        .find({ tenant_id: tenant, status: 'pending' })
        .sort({ last_seen_at: -1 }).limit(20)
        .project({ content: 1, kind: 1, mention_count: 1, suspect_dup: 1, conflict_suspect: 1, status: 1 })
        .toArray();
      if (rows.length) {
        sections.push({
          type: 'table', title: '待审记忆（20 条）',
          columns: ['类型', '内容', '提及次数', '标记'],
          rows: rows.map((x) => [
            String(x.kind ?? '-'),
            String(x.content ?? '').replace(/\s+/g, ' ').slice(0, 50),
            String(x.mention_count ?? 1),
            x.conflict_suspect ? '冲突' : (x.suspect_dup ? '存疑重复' : '-'),
          ]),
        });
      }
      const items = await db.collection('memory_items')
        .find({ tenant_id: tenant, archived: { $ne: true } })
        .sort({ last_seen_at: -1 }).limit(20)
        .project({ content: 1, kind: 1, mention_count: 1, last_seen_at: 1 })
        .toArray();
      if (items.length) {
        sections.push({
          type: 'table', title: '正式记忆（20 条）',
          columns: ['类型', '内容', '提及', '最近'],
          rows: items.map((x) => [String(x.kind ?? '-'), String(x.content ?? '').replace(/\s+/g, ' ').slice(0, 50), String(x.mention_count ?? 1), x.last_seen_at ? new Date(x.last_seen_at).toLocaleDateString('zh-CN') : '-']),
        });
      }
    } catch (e) {
      sections.push({ type: 'note', title: '查询失败', text: String(e?.message ?? e) });
    }
    // 控制台交互（实现在 action.memory）：审核待审记忆 + 跑清理 + 固定
    const actions = [
      {
        type: 'input', label: '审核待审记忆', capability: 'action.memory', args: { op: 'review', action: 'approve' },
        fields: [{ name: 'memoryId', placeholder: '记忆 id' }], submit: '通过',
      },
      {
        type: 'input', label: '（同上）', capability: 'action.memory', args: { op: 'review', action: 'reject' },
        fields: [{ name: 'memoryId', placeholder: '记忆 id' }], submit: '拒绝',
      },
      {
        type: 'button', label: '清理冷记忆', capability: 'action.memory', args: { op: 'cleanup' },
        confirm: '按当前门槛把冷记忆归档？（不是删除，可用 memory_unarchive 找回）',
      },
    ];
    return { title: '记忆库', summary, sections, actions };
  },
};

// ── 抽取 tick（宿主每 10 分钟、仅新消息时调模型；隐私闸过滤）──────
let lastExtractionTs = 0;
async function runExtraction({ chatKey, sinceTs } = {}) {
  const c = cfg();
  if (!mongoProbeState.ok || !mongoHandle) return { ok: false, error: 'Mongo 不可用，抽取跳过（降级）' };
  const from = sinceTs ?? lastExtractionTs;
  lastExtractionTs = Date.now();
  // 宿主抽取逻辑在 mg-extract.js：拉新消息 → 调模型抽 event/meme/relation →
  // 隐私闸过滤手机号/身份证/邮箱/密码 → 归一化 content_key → 去重/相似/冲突 → 入库
  const r = await extractMemories(mongoHandle.db, c, { chatKey, sinceTs: from });
  stats.extracted += r.newCount ?? 0;
  stats.pending += (r.newCount ?? 0);
  stats.conflicts += r.conflicts ?? 0;
  return { ok: true, newCount: r.newCount ?? 0, duplicates: r.duplicates ?? 0, reopened: r.reopened ?? 0, conflicts: r.conflicts ?? 0 };
}

// ── 辅助 ──────────────────────────────────────────────────────────
async function ensureIndexes(db) {
  // 宿主 MEMORY_INDEXES 全部索引（含 chat_content_key 唯一索引、10 个索引，见交接第十节）
  try {
    await db.collection('memory_candidates').createIndexes([
      { name: 'cand_memory_id', unique: true, key: { memory_id: 1 } },
      { name: 'chat_content_key', unique: true, key: { chat_key: 1, content_key: 1 }, sparse: true },
      { name: 'cand_status', key: { status: 1 } },
      { name: 'cand_chat_key', key: { chat_key: 1 } },
      { name: 'cand_kind', key: { kind: 1 } },
      { name: 'cand_last_seen', key: { last_seen_at: -1 } },
    ]);
    await db.collection('memory_items').createIndexes([
      { name: 'item_memory_id', unique: true, key: { memory_id: 1 } },
      { name: 'item_chat_content', unique: true, key: { chat_key: 1, content_key: 1 }, sparse: true },
      { name: 'item_kind', key: { kind: 1 } },
      { name: 'item_archived', key: { archived: 1 } },
      { name: 'item_last_seen', key: { last_seen_at: -1 } },
    ]);
    await db.collection('memory_audit').createIndexes([
      { name: 'audit_event', key: { event: 1, ts: -1 } },
    ]);
  } catch (e) {
    // 索引已存在则忽略
  }
}

async function unarchiveOne(db, tenant, ids) {
  const res = await db.collection('memory_items').updateMany(
    { tenant_id: tenant, memory_id: { $in: ids }, archived: true },
    { $set: { archived: false } },
  );
  await db.collection('memory_audit').insertOne({ event: 'memory.unarchived', tenant_id: tenant, memory_ids: ids, ts: new Date() });
  return { ok: true, count: res.modifiedCount };
}

// 导出给 lib 模块复用
export { hashEmbed, normalizeMemoryContent, contentKeyOf, similarityJaccard, conflictSignal, MEMORY_KINDS };
