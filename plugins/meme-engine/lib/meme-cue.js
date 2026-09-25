// meme-cue.js —— 梗库联想（宿主 memes.js cueMemories 语义照搬：融合打分 + 双门槛 + alias 保底 + 降级）
import crypto from 'node:crypto';

import fs from 'node:fs';
import path from 'node:path';

/** 读梗库（meme-engine 主文件用）。dataDir 由调用方传。 */
export function loadMemes(dataDir) {
  const f = path.join(dataDir, 'memes.json');
  try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { items: [] }; } catch { return { items: [] }; }
}
/** 存梗库。 */
export function saveMemes(dataDir, memes) {
  const f = path.join(dataDir, 'memes.json');
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(memes, null, 2)); } catch {}
}

export function contentHashOf(text) {
  return crypto.createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex');
}

export async function ensureMemeVectors(items, vectorsCache, { embedText, fetchVectors }) {
  const out = { ...(vectorsCache || {}) };
  const stale = items.filter((m) => {
    const h = contentHashOf(embedText(m));
    m._vecHash = h;
    return !out[h];
  });
  if (stale.length) {
    const texts = stale.map((m) => embedText(m));
    const vecs = await fetchVectors(texts);
    stale.forEach((m, i) => {
      if (Array.isArray(vecs[i]) && vecs[i].length) out[m._vecHash] = vecs[i];
    });
  }
  return out;
}

export function cueMemories(items, text, opts) {
  const c = opts;
  const q = String(text ?? '');
  const qTokens = new Set(tokenize(q));
  const results = [];
  for (const m of items) {
    const alias = aliasHit(m.text, q);
    if (alias) { results.push({ text: m.text, score: c.aliasFloor ?? 0.75, via: 'alias' }); continue; }
    const literal = literalScore(m, q, qTokens);
    const semantic = (m._vecHash && c.vectorsCache && c.vectorsCache[m._vecHash]) ? cosine(c.vectorsCache[m._vecHash], c.queryVector || c.vectorsCache[m._vecHash]) : 0;
    const hasOverlap = qTokens.size && [...qTokens].some((t) => tokenize(m.text).has(t));
    const threshold = hasOverlap ? (c.literalThreshold ?? 0.64) : (c.semanticThreshold ?? 0.7);
    const fused = semantic * (c.semanticWeight ?? 0.75) + Math.min(12, literal) * (c.literalWeight ?? 0.25);
    const norm = fused / 12;
    if (norm >= threshold) results.push({ text: m.text, score: Math.round(norm * 10000) / 10000, via: semantic > 0.4 ? 'semantic' : 'literal' });
  }
  return results.sort((a, b) => b.score - a.score);
}

export function cueLiteralFallback(items, text, opts) {
  const q = String(text ?? '');
  const qTokens = new Set(tokenize(q));
  const results = [];
  for (const m of items) {
    const alias = aliasHit(m.text, q);
    if (alias) { results.push({ text: m.text, score: opts.aliasFloor ?? 0.75, via: 'alias' }); continue; }
    const literal = literalScore(m, q, qTokens);
    const norm = Math.min(1, literal / 12);
    if (norm >= (opts.threshold ?? 0.64)) results.push({ text: m.text, score: Math.round(norm * 10000) / 10000, via: 'literal' });
  }
  return results.sort((a, b) => b.score - a.score);
}

function aliasHit(memeText, q) {
  const m = String(memeText ?? '').match(/[「"“]([^””"]{1,20})[””"]/);
  if (m && q.includes(m[1])) return true;
  const core = String(memeText ?? '').trim();
  return core.length >= 4 && q.includes(core.slice(0, Math.min(8, core.length)));
}
function literalScore(meme, q, qTokens) {
  const mText = String(meme.text ?? '');
  const mTokens = new Set(tokenize(mText));
  let hit = 0;
  for (const t of qTokens) if (mTokens.has(t)) hit++;
  if (q.length >= 4 && mText.includes(q)) hit += 4;
  for (const tag of (Array.isArray(meme.tags) ? meme.tags : [])) if (q.includes(tag)) hit += 2;
  return hit;
}
function tokenize(text) {
  const t = String(text ?? '').toLowerCase().replace(/\s+/g, '');
  const out = new Set();
  const zh = t.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const seg of zh) for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  for (const w of (t.match(/[a-z0-9_]{2,}/g) || [])) out.add(w);
  return out;
}
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
