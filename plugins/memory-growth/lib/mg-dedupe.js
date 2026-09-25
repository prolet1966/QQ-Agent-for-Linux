// mg-dedupe.js —— 记忆去重与相似合并（宿主 memory-growth.js 第十/十二节语义照搬）
import crypto from 'node:crypto';

/** 归一化正文：去空白 + 去标点 + 小写。去重键只由归一化正文决定（kind/subject_id 不进键，宿主已修）。 */
export function normalizeMemoryContent(text) {
  return String(text ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[「」"“”‘’'\u3001、,，.。!！?？;；:：(（)）\[\]【】\u2014\u2013\-~～|/\\]/g, '')
    .toLowerCase();
}

/** content_key = sha256(归一化正文)。宿主：只由正文决定，不掺 kind/subject。 */
export function contentKeyOf(kind, text) {
  void kind;
  return crypto.createHash('sha256').update(normalizeMemoryContent(text), 'utf8').digest('hex');
}

/** 词面 Jaccard 相似度（归一化后 token 集合）。宿主：双高门之一。 */
export function similarityJaccard(a, b) {
  const setA = new Set(tokenizeForSim(a));
  const setB = new Set(tokenizeForSim(b));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union ? inter / union : 0;
}

function tokenizeForSim(text) {
  const t = normalizeMemoryContent(text);
  const out = new Set();
  const zh = t.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const seg of zh) for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  for (const w of (t.match(/[a-z0-9_]{2,}/g) || [])) out.add(w);
  return [...out];
}

/**
 * 向量余弦（语义空间用）。入参两个 number[]。宿主：双空间各一套阈值（哈希 0.97 且词面 0.85；语义 0.95 只看向量）。
 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
