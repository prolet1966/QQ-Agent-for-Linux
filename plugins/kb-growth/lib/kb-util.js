// kb-util.js —— 通用小工具（从宿主 kb-util.js 提炼）
import crypto from 'node:crypto';

export function nowMs() { return Date.now(); }
export function newId() { return 'id_' + nowMs().toString(36) + '_' + Math.random().toString(36).slice(2, 10); }
export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}
export function summarize(text, max = 200) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}
export function tokenize(text) {
  const t = String(text ?? '').toLowerCase();
  const out = new Set();
  // 中文 bigram
  const zh = t.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const seg of zh) for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  // 英文/数字词
  const en = t.match(/[a-z0-9_]{2,}/g) || [];
  for (const w of en) out.add(w);
  return [...out];
}
export function round(x, p = 4) { const m = 10 ** p; return Math.round(x * m) / m; }
export async function raceTimeout(promise, ms) {
  let timer;
  const to = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout ' + ms + 'ms')), ms); });
  try { return await Promise.race([promise, to]); }
  finally { clearTimeout(timer); }
}
