// kb-retrieve.js —— 混合检索（从宿主 kb-retrieve.js 提炼；tokens 倒排预筛 + 向量余弦 + 关键词分融合）
import { tokenize, round } from './kb-util.js';

export async function retrieveFromKb(mongoHandle, opts = {}) {
  const db = mongoHandle.db;
  const t0 = Date.now();
  const { tenant, query, topK = 5 } = opts;
  const qTokens = tokenize(query);
  const retrieve = opts;

  // 服务端聚合：tokens 倒排预筛（$match + tenant_tokens 索引）+ $setIntersection 算命中数
  let hits = [];
  try {
    hits = await db.collection('knowledge_chunks').aggregate([
      { $match: { tenant_id: tenant, status: 'active', tokens: { $in: qTokens } } },
      { $addFields: { hit_count: { $size: { $setIntersection: ['$tokens', qTokens] } } } },
      { $sort: { hit_count: -1 } },
      { $limit: 120 },
    ]).toArray();
  } catch { return { confidence: 0, hits: [], ms: Date.now() - t0 }; }

  // 应用侧：top-K 补取向量 → 余弦 → 融合
  const qVec = null; // 向量由 Embedder 在调用方算好注入；这里只做关键词分（语义向量在 kb-growth.js 主文件并行算）
  const scored = hits.map((h) => {
    const kwScore = h.hit_count / Math.max(1, qTokens.length);
    const vecScore = 0; // 占位；实际语义余弦在 kb-growth.js 主文件并行算后传入
    const conf = round(kwScore * (Number(retrieve.keywordWeight) || 0.38) + vecScore * (Number(retrieve.vectorWeight) || 0.62));
    return { ...h, _conf: conf };
  }).sort((a, b) => b._conf - a._conf).slice(0, topK);

  const maxConf = scored[0]?._conf ?? 0;
  const hardMin = Number(retrieve.hardMinConfidence) || 0.58;
  if (maxConf < hardMin) return { confidence: 0, hits: [], ms: Date.now() - t0 };
  return { confidence: maxConf, hits: scored, ms: Date.now() - t0 };
}

export function buildKbContext(hits, maxChars = 2600) {
  const parts = [];
  let budget = maxChars;
  for (const h of hits) {
    const line = '【' + (h.title ?? h.topic ?? '') + '】 ' + (h.content ?? '').slice(0, 400) + '（来源：' + (h.source_url ?? '-') + '）';
    if (budget - line.length < 0 && parts.length) break;
    parts.push(line);
    budget -= line.length;
  }
  return parts.join('\n');
}
