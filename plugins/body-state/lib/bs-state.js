// bs-state.js —— 本体状态引擎（纯函数 + 本地 JSON 落盘，21 格半衰期衰减 + 五条聚合 + 每日重置 + 睡眠掷骰）
import fs from 'node:fs';
import path from 'node:path';
import { EMOTION_GRID, AGGREGATES, AXES, mergeConfig, DEFAULT_CONFIG } from './bs-schema.js';

const DAY_MS = 86400000;

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// ── 21 格：每格独立半衰期指数衰减（清单：愤怒 6 分钟消气、低落 29 分钟持久、惊讶仅 3 分钟）──
export function decayEmotion(value, ageMs, halfLifeMin) {
  const v = num(value, 0);
  if (v <= 0) return 0;
  const hours = Math.max(0, ageMs / 3600000);
  const hl = Math.max(1, num(halfLifeMin, 10)) / 60; // 半衰期换算成小时
  return v * Math.pow(0.5, hours / hl);
}

/**
 * 物化：把落盘的原始格子（带 set_at）按半衰期衰减成"当前值"。
 * 入参 rawState（含 emotions:{id:{v, set_at}}）+ cfg。返回衰减后的当前值表。
 */
export function materializeEmotions(rawState, cfg) {
  const c = mergeConfig(cfg);
  const now = Date.now();
  const out = {};
  const emo = rawState?.emotions || {};
  for (const def of EMOTION_GRID) {
    const cell = emo[def.id];
    const cur = cell ? decayEmotion(cell.v, now - num(cell.set_at, now), def.halfLifeMin) : 0;
    out[def.id] = Math.round(clamp(cur, 0, c.emotionCap) * 100) / 100;
  }
  return out;
}

// ── 心情公式：基线 + (正向和 − 负向和) × 系数（清单关键机制）──
export function moodFromEmotions(emotions, cfg) {
  const c = mergeConfig(cfg);
  let pos = 0, neg = 0;
  for (const def of EMOTION_GRID) {
    const v = emotions[def.id] ?? 0;
    if (def.group === 'pos') pos += v;
    else if (def.group === 'neg') neg += v;
  }
  const mood = clamp(c.moodBase + (pos - neg) * 0.004, 0, 1);
  return Math.round(mood * 1000) / 1000;
}

// ── 情绪 → 行为概率（清单：心情差 ≠ 少发言；负情绪也是活跃度，精力/社交低才真正压低意愿）──
export function wakeProbability(emotions, axes, cfg) {
  const c = mergeConfig(cfg);
  // 唤醒权重加权：每格的 wakeWeight × 当前值
  let signal = 0;
  for (const def of EMOTION_GRID) {
    signal += (emotions[def.id] ?? 0) * (def.wakeWeight || 0);
  }
  const socialDrag = 1 - num(axes?.social, 0.5);   // 社交低 → 压低意愿
  const energyDrag = 1 - num(axes?.energy, 0.7);   // 精力低 → 压低意愿
  const base = 0.3 + 0.4 * clamp(signal / 30, 0, 1);
  const prob = clamp(base * (1 - socialDrag * 0.3) * (1 - energyDrag * 0.2), 0.05, 1);
  return Math.round(prob * 1000) / 1000;
}

// ── 情绪 → 温度调节（清单：情绪状态动态调整 LLM temperature）──
export function temperatureTune(emotions, axes, cfg) {
  const c = mergeConfig(cfg);
  const base = 0.7;
  const mood = num(axes?.mood, c.moodBase);
  let t = base + (mood - 0.5) * 0.3;               // 心情高 → 略高温度（更活跃）
  const anger = emotions.anger ?? 0;
  const excitement = emotions.excitement ?? 0;
  t += (anger + excitement) * 0.002;               // 强情绪 → 温度升
  return Math.round(clamp(t, 0.1, 1.5) * 100) / 100;
}

// ── 每日心情重置（清单：按情绪日默认凌晨 5 点起算，结算昨日账本 → 今日底色）──
export function isNewEmotionDay(ts, cfg) {
  const c = mergeConfig(cfg);
  const d = new Date(num(ts, Date.now()));
  const hour = d.getHours();
  const anchor = c.dailyRebaseHour ?? 5;
  // 情绪日 = 当天 anchor 点之后算同一天
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), anchor).getTime();
  return num(ts, Date.now()) >= start;
}

export function dailyRebase(rawState, cfg) {
  const c = mergeConfig(cfg);
  const s = rawState || {};
  const todayKey = new Date().toISOString().slice(0, 10);
  if (s.lastRebaseDay === todayKey) return { changed: false, state: s };
  // 结算昨日 → 今日心情底色（昨日净流决定概率，自述句按日期确定性）
  const emotions = materializeEmotions(s, c);
  let pos = 0, neg = 0;
  for (const def of EMOTION_GRID) {
    const v = emotions[def.id] ?? 0;
    if (def.group === 'pos') pos += v; else if (def.group === 'neg') neg += v;
  }
  const net = pos - neg;
  let roll = 0.5;
  if (net > 10) roll = 0.8;       // 昨日净正向 → 睡得好
  else if (net < -10) roll = 0.3; // 昨日净负向 → 失眠
  // 确定性：按日期 + salt 掷骰（清单：自述句注入提示词，按日期确定性）
  const seed = todayKey + ':body-state';
  const det = deterministicHash(seed);
  const sleepNote = det < roll * 0.5 ? '睡得好' : (det < roll ? '平常' : '失眠');
  const s2 = { ...s, lastRebaseDay: todayKey, sleepNote, sleepNet: net };
  return { changed: true, state: s2, sleepNote };
}

// ── 睡眠事件掷骰（昨日净流决定概率）──
function deterministicHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}

// ── 五条聚合视图（兼容旧消费端）──
export function aggregateViews(emotions) {
  const out = {};
  for (const [name, cells] of Object.entries(AGGREGATES)) {
    out[name] = cells.reduce((a, c) => a + (emotions[c] ?? 0), 0);
  }
  return out;
}

// ── 五通道之一：词表（零成本，入站消息情绪词 → 格子变动）──
const LEXICON = {
  positivity: { gratitude: ['谢谢', '感恩', '辛苦了'], happiness: ['开心', '哈哈', '真好', '太棒'], joy: ['喜悦', '兴奋'], hope: ['希望', '加油'], pride: ['厉害', '牛', '佩服'], excitement: ['亢奋', '冲', '燃'], curiosity: ['好奇', '是什么', '为什么', '怎么'], surprise: ['诶', '啊', '？', '真的吗'] },
  negativity: { anger: ['气死', '烦死', '可恶', '混蛋'], disgust: ['恶心', '恶心死了'], shame: ['丢人', '羞愧'], guilt: ['内疚', '对不起'], anxiety: ['焦虑', '紧张', '担心'], sadness: ['难过', '伤心', '泪'], fear: ['怕', '恐惧', '吓人'], envy: ['羡慕', '嫉妒'], boredom: ['无聊', '好闷'], loneliness: ['孤独', '一个人'], irritation: ['烦躁', '烦'], depression: ['低落', '沮丧', 'emo'] },
};

/** 词表通道：零 token，入站文本命中 → 对应格子加值。返回变动表 {id: delta}。 */
export function lexiconChannel(text) {
  const t = String(text ?? '');
  const moves = {};
  for (const [group, map] of Object.entries(LEXICON)) {
    const sign = group === 'negativity' ? 1 : 1; // 负向词命中也累加该格（数值是"该情绪强度"）
    for (const [emo, words] of Object.entries(map)) {
      for (const w of words) if (t.includes(w)) { moves[emo] = Math.min(100, (moves[emo] ?? 0) + 12); }
    }
  }
  return moves;
}

/** 事件钩子通道（清单：生面孔首次发言 → 好奇 +10）。 */
export function eventHookChannel(event, state) {
  const moves = {};
  if (event === 'new-face') moves.curiosity = 10;
  return moves;
}

// ── 本地 JSON 落盘（2s 节流，宿主纪律：失败只打日志不卡聊天）──
export class BodyStateStore {
  constructor({ dataDir }) {
    this.file = path.join(dataDir || (process.cwd() + '/data/body-state'), 'body-state.json');
    this.state = null;
    this.dirty = false;
    this._timer = null;
    this._load();
  }
  _load() {
    try {
      let t = fs.readFileSync(this.file, 'utf8');
      if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
      this.state = JSON.parse(t) || this._fresh();
    } catch { this.state = this._fresh(); }
  }
  _fresh() {
    const emo = {};
    for (const def of EMOTION_GRID) emo[def.id] = { v: 0, set_at: Date.now() };
    return { axes: { energy: 0.7, social: 0.6, mood: 0.5 }, emotions: emo, lastRebaseDay: '', log: [] };
  }
  getState() { if (!this.state) this._load(); return this.state; }
  markDirty() {
    this.dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 2000);
    this._timer.unref?.();
  }
  flush() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1), 'utf8');
      try { fs.unlinkSync(this.file); } catch {}
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch {}
  }
  close() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } this.flush(); }
}

/** 结算一次发言（清单：精力/社交消耗，发言后 settleSession 扣减）。 */
export function settleSession(state, cfg) {
  const c = mergeConfig(cfg);
  const s = state;
  s.axes = s.axes || { energy: 0.7, social: 0.6, mood: 0.5 };
  s.axes.energy = clamp(num(s.axes.energy, 0.7) - c.energyCostPerMsg, 0, 1);
  s.axes.social = clamp(num(s.axes.social, 0.6) - c.socialCostPerMsg, 0, 1);
  // 久置自然复原（按距离上次发言的小时数补回）
  const last = num(s.lastActiveAt, 0);
  if (last > 0) {
    const hrs = (Date.now() - last) / 3600000;
    s.axes.energy = clamp(s.axes.energy + hrs * c.energyRecoverPerHour, 0, 1);
    s.axes.social = clamp(s.axes.social + hrs * c.socialRecoverPerHour, 0, 1);
  }
  s.lastActiveAt = Date.now();
  s.axes.mood = moodFromEmotions(materializeEmotions(s, c), c);
  return s;
}
