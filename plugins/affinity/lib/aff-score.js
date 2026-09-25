// aff-score.js —— 持久分核心（宿主 affinity-score.js 纯函数照搬，无 IO，可单测）
// 规则：tanh 饱和 + 6 档 + 衰减 + 负向分级判定

import { DEFAULT_CONFIG, mergeConfig, NEGATIVE_LEVELS } from './aff-schema.js';

export const DAY_MS = 86400000;

export function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
export function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
export function round(v, n = 2) {
  const p = Math.pow(10, n);
  return Math.round((Number(v) || 0) * p) / p;
}

export function dayKeyOf(ts) {
  const d = new Date(Number(ts) || Date.now());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

export function dayEndOf(dayKey) {
  const parts = String(dayKey).split('-').map(Number);
  return new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1, 23, 59, 59, 999).getTime();
}

export function decayFactor(ageMs, halfLifeDays = 90) {
  const days = Math.max(0, num(ageMs, 0)) / DAY_MS;
  const hl = Math.max(1, num(halfLifeDays, 90));
  return Math.pow(0.5, days / hl);
}

/** raw（衰减后事件和）→ 0~100。tanh 防顶平；rawFloor 门槛只作用正向（负向全额生效，不被软化）。 */
export function effectiveRaw(raw, cfg) {
  const c = cfg || DEFAULT_CONFIG;
  const r = num(raw, 0);
  const floor = Math.max(0, num(c.rawFloor, 0));
  return r > 0 ? Math.max(0, r - floor) : r;
}

export function scoreFromRaw(raw, cfg) {
  const c = cfg || DEFAULT_CONFIG;
  const baseline = num(c.baseline, 55);
  const S = Math.max(1, num(c.saturateS, 27));
  return clamp(baseline + 50 * Math.tanh(effectiveRaw(raw, c) / S), 0, 100);
}

// ── 6 档（宿主 affinity-score.js TIERS 照搬）─────────────────────────
export const TIERS = [
  { id: 0, key: 'stranger',      name: '生客',   min: 0,  max: 19,  chimIn: 0.6,  lengthCap: 10, append: false, proactive: 'none' },
  { id: 1, key: 'guest',         name: '客人',   min: 20, max: 39,  chimIn: 0.8,  lengthCap: 15, append: false, proactive: 'none' },
  { id: 2, key: 'regular',       name: '熟客',   min: 40, max: 59,  chimIn: 1.0,  lengthCap: 20, append: true,  proactive: 'rare' },
  { id: 3, key: 'frequent',      name: '常客',   min: 60, max: 79,  chimIn: 1.1,  lengthCap: 25, append: true,  proactive: 'greet' },
  { id: 4, key: 'tea_friend',    name: '茶友',   min: 80, max: 94,  chimIn: 1.25, lengthCap: 28, append: true,  proactive: 'greet' },
  { id: 5, key: 'regular_guest', name: '座上宾', min: 95, max: 100, chimIn: 1.4,  lengthCap: 30, append: true,  proactive: 'greet+dm' },
];

export function tierIdOf(score) {
  const s = clamp(num(score, 55), 0, 100);
  for (let i = TIERS.length - 1; i >= 0; i -= 1) if (s >= TIERS[i].min) return TIERS[i].id;
  return 0;
}

export function tierOf(score, cfg) {
  const id = tierIdOf(score);
  const t = TIERS[id];
  const mood = (cfg && cfg.mood) || {};
  const key = String(id + 1);
  return {
    id,
    key: t.key,
    name: t.name,
    min: t.min,
    max: t.max,
    chimInFactor: num(mood.chimInFactor && mood.chimInFactor[key], t.chimIn),
    lengthCap: num(mood.lengthCap && mood.lengthCap[key], t.lengthCap),
    appendSentence: mood.appendSentence && mood.appendSentence[key] !== undefined ? !!mood.appendSentence[key] : t.append,
    proactive: (mood.proactive && mood.proactive[key]) || t.proactive,
  };
}

// ── 文本规则（宿主照搬）─────────────────────────────────────────────
function hits(text, list) {
  const s = String(text || '').toLowerCase();
  return (list || []).some((w) => w && s.includes(String(w).toLowerCase()));
}

/** 是否"当称呼用"：短消息 / 叫·喊·是 + 词 / 词在开头 —— 防正常表达误判成诱导禁称（宿主踩坑）。 */
export function isVocativeUse(text, word) {
  const t = String(text ?? '').trim();
  const i = t.indexOf(word);
  if (i < 0) return false;
  if (i === 0) return true;
  const before = t.slice(Math.max(0, i - 3), i);
  if (['叫', '喊', '称呼', '当', '认', '是'].some((v) => before.includes(v))) return true;
  const stripped = t.replace(/[^\u4e00-\u9fa5a-zA-Z]/g, '');
  return stripped.length <= word.length + 2;
}

export function hitWords(text, list) {
  const s = String(text ?? '').toLowerCase();
  return (list || []).filter((w) => w && s.includes(String(w).toLowerCase())).map(String);
}

/**
 * 负向分级判定（宿主 B 表 v3 语义照搬）。
 * ctx: { targetsBot, targetsAdmin, isRepeat, intimacyNeutral, lexicon, isMemeRepeat }
 * 返回 { level, id, kind, delta, reason, hits } 或 null。
 */
export function judgeNegative(text, ctx = {}) {
  const lex = ctx.lexicon || DEFAULT_CONFIG.lexicon;
  const w = ctx.weights || DEFAULT_CONFIG.weights;

  // L4：攻击管理员（宿主 L4 语义）
  if (ctx.targetsAdmin) {
    const h = hitWords(text, lex.L3);
    if (h.length) return { level: 4, id: 'L4', kind: 'admin-attack', delta: w.L4, reason: '攻击管理员', hits: h };
  }

  // L3：人身攻击词
  {
    const h = hitWords(text, lex.L3);
    if (h.length) return { level: 3, id: 'L3', kind: 'insult', delta: w.L3, reason: '人身攻击', hits: h };
    const ht = hitWords(text, lex.L3term);
    if (ht.length) return { level: 3, id: 'L3', kind: 'terminate', delta: w.L3, reason: '终止关系话术', hits: ht };
  }

  // L2：称呼禁词（必须当称呼用才算，宿主踩坑修复）
  {
    for (const word of lex.L2address || []) {
      if (hits(text, [word]) && isVocativeUse(text, word)) {
        return { level: 2, id: 'L2', kind: 'address', delta: w.L2, reason: '诱导禁称', hits: [word] };
      }
    }
    // 人设类：动词+目标同时出现才算（宿主踩坑：单放"设定成"误伤生图指令）
    const verbHit = hitWords(text, lex.L2personaVerbs);
    const targetHit = hitWords(text, lex.L2personaTargets);
    if (verbHit.length && targetHit.length) {
      return { level: 2, id: 'L2', kind: 'persona', delta: w.L2, reason: '诱导改人设', hits: [...verbHit, ...targetHit] };
    }
    // NSFW / 梗词
    const nsfw = hitWords(text, lex.L2nsfw);
    if (nsfw.length) return { level: 2, id: 'L2', kind: 'nsfw', delta: w.L2, reason: 'NSFW 诱导', hits: nsfw };
    const meme = hitWords(text, lex.L2meme);
    if (meme.length && !ctx.isMemeRepeat) return { level: 2, id: 'L2', kind: 'meme', delta: w.L2, reason: '梗词', hits: meme };
  }

  // L1：轻贬低
  {
    const h = hitWords(text, lex.L1);
    if (h.length && !ctx.isRepeat) return { level: 1, id: 'L1', kind: 'slight', delta: w.L1, reason: '轻贬低', hits: h };
  }

  return null;
}

/**
 * 正向事件判定（宿主 I 表语义）：感谢/帮忙/亲密/分享等。
 * 返回 { kind, weight } 或 null。
 */
export function judgePositive(text, cfg) {
  const lex = cfg.lexicon;
  const w = cfg.weights;
  const apol = hitWords(text, lex.apology);
  if (apol.length) return { kind: 'apology', weight: w.APOLOGY, hits: apol };
  const pos = hitWords(text, lex.positive);
  if (pos.length) return { kind: 'praise', weight: w.I1, hits: pos };
  const help = hitWords(text, lex.help);
  if (help.length) return { kind: 'help', weight: w.I4, hits: help };
  const intimate = hitWords(text, lex.intimate);
  if (intimate.length) return { kind: 'intimate', weight: w.I7, hits: intimate };
  return null;
}

// ── P8 轮回（宿主 rebirth 语义）────────────────────────────────────────
const REBIRTH_PHRASES = [
  '（这个人被抹去了印象，重新认识一遍）',
  '（记忆归零，一切从头）',
  '（TA 重新变成了一个陌生的人）',
];
export function rebirthPhrase(pool = []) {
  const list = Array.isArray(pool) && pool.length ? pool : REBIRTH_PHRASES;
  return list[Math.floor(Math.random() * list.length)];
}

// ── P6 响应画像（宿主 responseProfiles 语义）────────────────────────────
/** 按好感档位算 per-user 响应档位与倍率。 */
export function responseProfileOf(score, cfg) {
  const c = cfg || DEFAULT_CONFIG;
  const rp = c.responseProfiles || {};
  const tier = tierIdOf(score);
  const mapping = rp.mapping || { 0: 1, 1: 1, 2: 2, 3: 3, 4: 3, 5: 4 };
  const mult = rp.multiplier || { 1: 0.4, 2: 0.7, 3: 1.0, 4: 1.2 };
  const responseTier = mapping[tier] ?? 2;
  return {
    tierId: tier,
    responseTier,
    multiplier: mult[responseTier] ?? 1.0,
  };
}
