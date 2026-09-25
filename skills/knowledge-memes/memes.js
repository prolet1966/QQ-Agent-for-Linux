// 知识库（梗 / 口头禅 / 内部笑话 / 可复用短笔记）
//
// 移植自桌面魔改包 `09-knowledge-memes/src/memes.js`。改动点：
//   ① DATA_DIR / 审计改为从核心与本模块注入（原版直接 import 了 08 的 memory-audit，
//      而 08 并未整合进本项目 —— 带过来的话这个模块根本 import 不进来）；
//   ② 落盘 vs 只读分离，便于测试注入临时目录；
//   ③ 中文打分逻辑**原样保留**（滑窗 + 二字共现）—— 这部分是作者按真实语料调出来的，
//      没有理由改。
//
// 存储仍是 `data/memes.json`（与魔改包同名，便于已有的库直接搬过来）。

import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 200;

let FILE = '';
let onChange = () => {};

/** 由 index.js 在 setup 时注入：数据目录 + 变更回调（审计用）。 */
export function configure({ dataDir, onMemoryChange } = {}) {
  if (dataDir) FILE = path.join(String(dataDir), 'memes.json');
  if (typeof onMemoryChange === 'function') onChange = onMemoryChange;
}

export function filePath() {
  return FILE;
}

function read() {
  if (!FILE) return [];
  try {
    let t = fs.readFileSync(FILE, 'utf8');
    // BOM 会让 JSON.parse 直接抛 —— Windows 编辑器很容易带上
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    return Array.isArray(j.memes) ? j.memes : [];
  } catch {
    return [];
  }
}

function write(memes) {
  if (!FILE) throw new Error('知识库未初始化（缺少数据目录）');
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // 先写临时文件再 rename：中途崩了也不会留下半个坏 JSON
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, memes: memes.slice(-MAX_ENTRIES) }, null, 1), 'utf8');
  fs.renameSync(tmp, FILE);
}

/** 分词：整句片段 + 中文 2~4 字滑窗（中文没空格，不切窗就整句当一个 token）。 */
function tokenize(s) {
  const t = String(s || '').toLowerCase();
  const out = new Set();
  for (const w of t.match(/[\u4e00-\u9fff]{2,}|[a-z0-9_]{3,}/g) || []) out.add(w);
  const cjk = t.match(/[\u4e00-\u9fff]+/g) || [];
  for (const seg of cjk) {
    for (let n = 2; n <= 4; n += 1) {
      for (let i = 0; i + n <= seg.length; i += 1) out.add(seg.slice(i, i + n));
    }
  }
  return out;
}

/** 中文二字滑动窗：用于「沾点边就闪」的弱联想。 */
function bigrams(s) {
  const t = String(s || '').replace(/[^\u4e00-\u9fffa-z0-9_]/gi, '').toLowerCase();
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) {
    const a = t[i];
    const b = t[i + 1];
    if (/[\u4e00-\u9fff]/.test(a) && /[\u4e00-\u9fff]/.test(b)) out.add(a + b);
    else if (/[a-z0-9_]/.test(a) && /[a-z0-9_]/.test(b)) out.add(a + b);
  }
  return out;
}

/** 保存一条条目；同名（忽略大小写）视为同一条，累加 uses 而不是新增。 */
export function saveMeme({ text, tags = [], note = '', kind = 'meme' } = {}) {
  const body = String(text || '').trim().slice(0, 120);
  if (!body) return { ok: false, error: '内容不能为空' };
  const list = read();
  const key = body.toLowerCase();
  const existing = list.find((m) => String(m.text || '').toLowerCase() === key);
  if (existing) {
    existing.uses = (existing.uses || 0) + 1;
    existing.updatedAt = Date.now();
    if (tags?.length) existing.tags = [...new Set([...(existing.tags || []), ...tags.map(String).slice(0, 6)])];
    if (note) existing.note = String(note).slice(0, 120);
    write(list);
    return { ok: true, meme: existing, deduped: true };
  }
  const meme = {
    id: `m${Date.now().toString(36)}`,
    text: body,
    kind: kind === 'note' ? 'note' : 'meme',
    tags: (tags || []).map(String).filter(Boolean).slice(0, 6),
    note: String(note || '').slice(0, 120),
    uses: 1,
    updatedAt: Date.now()
  };
  list.push(meme);
  write(list);
  try { onChange({ type: 'knowledge_save', text: body.slice(0, 40), kind: meme.kind }); } catch { /* 审计失败不影响保存 */ }
  return { ok: true, meme };
}

/**
 * 关键词搜（工具/管理页用，可稍严）。
 * @param {number} minScore 默认 2.5：允许弱命中，方便人工翻库。
 */
export function searchMeme(query, { limit = 5, minScore = 2.5 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const list = read();
  const qt = tokenize(q);
  const qb = bigrams(q);
  const scored = [];
  for (const m of list) {
    const hay = `${m.text} ${(m.tags || []).join(' ')} ${m.note || ''}`.toLowerCase();
    let score = 0;
    if (hay.includes(q)) score += 5;
    for (const t of qt) {
      if (t.length < 2) continue;
      if (hay.includes(t)) score += 2;
    }
    const hb = bigrams(hay);
    let co = 0;
    for (const b of qb) if (hb.has(b)) co += 1;
    score += Math.min(3, co * 0.8);
    if (String(m.text || '').toLowerCase().includes(q)) score += 3;
    score += Math.min(1.5, (m.uses || 1) / 8);
    if (score >= minScore) scored.push({ score, m });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit)).map(({ m, score }) => ({
    text: m.text,
    tags: m.tags || [],
    note: m.note || '',
    uses: m.uses || 1,
    score: Math.round(score * 10) / 10
  }));
}

/**
 * 「脑内闪过」：允许弱相关也闪 1~2 条梗名。
 * 比 searchMeme 更松（标签命中 / 标题命中 / 二字共现都算），只给梗名。
 * 只返回梗名、不给细节 —— 细节交给 memory_meme_search，避免每次运行都灌一堆 token。
 */
export function cueMemories(triggerText, { limit = 2, minScore = 2.5 } = {}) {
  const qRaw = String(triggerText || '').toLowerCase();
  const q = qRaw.replace(/[，,。.！!？?、\s：:；;~～…]+/g, '');
  if (!q) return [];
  const list = read();
  const qt = [...tokenize(qRaw)].filter((t) => t.length >= 2 && t.length <= 4);
  const qb = bigrams(qRaw);
  const scored = [];
  for (const m of list) {
    const title = String(m.text || '').toLowerCase().replace(/[，,。.！!？?、\s：:；;~～…]+/g, '');
    const tags = (m.tags || []).join(' ').toLowerCase();
    const note = String(m.note || '').toLowerCase();
    const hay = `${title} ${tags} ${note}`;
    let score = 0;
    if (title && q.includes(title)) score += 8;
    if (title && title.includes(q) && q.length >= 4) score += 6;
    if (title.length >= 4 && q.includes(title.slice(0, Math.min(10, title.length)))) score += 4;
    for (const t of qt) {
      if (t.length < 2) continue;
      if (tags.includes(t)) score += 2.4;
      else if (note.includes(t) && t.length >= 3) score += 1.4;
      if (title.includes(t) && t.length >= 2) score += 1.6;
    }
    const hb = bigrams(hay);
    let co = 0;
    for (const b of qb) if (hb.has(b)) co += 1;
    if (co >= 1) score += Math.min(3.2, co * 1.1);
    score += Math.min(0.8, (m.uses || 1) / 12);
    if (score >= minScore) scored.push({ score, m });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit)).map(({ m }) => ({ text: m.text }));
}

/** 最常用的若干条（用于提示词里"你知道这些梗"，以及管理页）。 */
export function listMemeTips({ max = 8 } = {}) {
  return read()
    .slice()
    .sort((a, b) => (b.uses || 0) - (a.uses || 0))
    .slice(0, Math.max(0, max))
    .map((m) => m.text);
}

export function memeCount() {
  return read().length;
}

/** 从 tags 推主分类（知识库 UI 用）。 */
function categoryOf(entry) {
  const tags = (entry.tags || []).map((t) => String(t).toLowerCase());
  const priority = ['新三国', '折棒', '明日方舟', 'switch', 'deepseek', '大肥鱼', '评论区梗', '反应图', '台词梗', '人物梗'];
  for (const p of priority) {
    if (tags.some((t) => t.includes(p.toLowerCase()))) return p;
  }
  if (entry.kind === 'note') return '笔记';
  const t = (entry.tags || [])[0];
  if (t && !/^(回复|短句|吐槽|理论梗|世界观|历史梗|时间线|自嘲)$/.test(String(t))) return String(t);
  return t ? String(t) : '其他';
}

/** 分类统计 + 条目列表（知识库 UI 用）。 */
export function listKnowledge({ q = '', category = '', limit = 200 } = {}) {
  const list = read();
  const query = String(q || '').trim().toLowerCase();
  let out = list.map((m) => ({ ...m, kind: m.kind || 'meme', category: categoryOf(m) }));
  if (query) {
    out = out.filter((m) => `${m.text} ${(m.tags || []).join(' ')} ${m.note || ''}`.toLowerCase().includes(query));
  }
  if (category && category !== '全部') out = out.filter((m) => m.category === category);
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const cats = new Map();
  for (const m of list.map((x) => ({ ...x, category: categoryOf(x) }))) {
    cats.set(m.category, (cats.get(m.category) || 0) + 1);
  }
  const categories = [...cats.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return {
    items: out.slice(0, Math.max(1, limit)).map((m) => ({
      text: m.text, kind: m.kind, category: m.category,
      tags: m.tags || [], note: m.note || '', uses: m.uses || 1, updatedAt: m.updatedAt || 0
    })),
    categories: [{ name: '全部', count: list.length }, ...categories],
    total: list.length
  };
}

/** 删除一条（按原文精确匹配，忽略大小写）。 */
export function removeMeme(text) {
  const key = String(text || '').trim().toLowerCase();
  if (!key) return false;
  const list = read();
  const next = list.filter((m) => String(m.text || '').toLowerCase() !== key);
  if (next.length === list.length) return false;
  write(next);
  return true;
}

export const internals = { tokenize, bigrams, categoryOf, read, write, MAX_ENTRIES };
