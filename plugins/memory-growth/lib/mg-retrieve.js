// mg-retrieve.js —— 记忆检索（宿主 recallMemory 语义照搬：粗筛最近 300 条全额打分 + minScore 门槛 + 过滤 archived）
import { cosine } from './mg-dedupe.js';

/**
 * 检索该群记忆。宿主第十二节改进：
 *   粗筛从「不排序的 40 条」改成「按 last_seen_at 排序的 300 条」全额进打分
 *   （字面不重叠但语义相关的记忆最该被捞出，先卡字面等于关在门外）；
 *   minScore 默认 0.48；过滤 archived。
 */
export async function recallMemory(db, c, { tenant, query, topK = 5 }) {
  const minScore = c.minScore ?? 0.48;
  // 粗筛：该群最近 300 条（宿主：不再字面 $in 预筛）
  let pool = [];
  try {
    pool = await db.collection('memory_items').find({
      tenant_id: tenant,
      archived: { $ne: true },
      status: { $in: ['active', 'approved'] },
    }).sort({ last_seen_at: -1 }).limit(300).toArray();
  } catch { return { hits: [], minScore, degraded: true }; }
  if (!pool.length) return { hits: [], minScore, degraded: false };

  // 打分：语义向量优先，退回词面
  const qNorm = normalizeQuery(query);
  const scored = pool.map((m) => {
    let score = 0;
    if (Array.isArray(m.embedding) && m.embedding.length) {
      score = cosine(m.embedding, qNorm.vector || m.embedding.map(() => 0)) * 0.75;
    }
    // 词面重合降级为加分项（宿主：字面重合不再是硬预筛）
    const jac = jaccardTokens(qNorm.tokens, tokenizeContent(m.content));
    score += jac * 0.25;
    return { ...m, score: Math.round(score * 10000) / 10000 };
  }).filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return { hits: scored, minScore, degraded: false };
}

function normalizeQuery(q) {
  const t = String(q ?? '').toLowerCase().replace(/\s+/g, '');
  const zh = t.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const tokens = new Set();
  for (const seg of zh) for (let i = 0; i + 2 <= seg.length; i++) tokens.add(seg.slice(i, i + 2));
  for (const w of (t.match(/[a-z0-9_]{2,}/g) || [])) tokens.add(w);
  return { tokens: [...tokens], vector: null }; // 语义向量由调用方（embedder）算好注入；这里词面
}
function tokenizeContent(text) {
  const t = String(text ?? '').toLowerCase().replace(/\s+/g, '');
  const out = new Set();
  const zh = t.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const seg of zh) for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  for (const w of (t.match(/[a-z0-9_]{2,}/g) || [])) out.add(w);
  return [...out];
}
function jaccardTokens(a, b) {
  const sa = new Set(a), sb = new Set(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}
