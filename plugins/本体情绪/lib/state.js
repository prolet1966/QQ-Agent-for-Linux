// 本体情绪核心（从魔改版 bot-state.js 抽出的通用子集）
// 去掉：亢奋模式、管理员 QQ 硬编码、超大 UI 视图
import fs from 'node:fs';
import path from 'node:path';

export const EMOTIONS = {
  anger: { halfLifeMin: 6, label: '愤怒', cat: 'out', sign: 'neg' },
  irk: { halfLifeMin: 5, label: '烦躁', cat: 'out', sign: 'neg' },
  disgust: { halfLifeMin: 10, label: '厌恶', cat: 'out', sign: 'neg' },
  joy: { halfLifeMin: 18, label: '喜悦', cat: 'out', sign: 'pos' },
  cheer: { halfLifeMin: 15, label: '开心', cat: 'out', sign: 'pos' },
  pride: { halfLifeMin: 20, label: '自豪', cat: 'out', sign: 'pos' },
  smug: { halfLifeMin: 18, label: '得意', cat: 'out', sign: 'pos' },
  hype: { halfLifeMin: 8, label: '亢奋', cat: 'out', sign: 'pos' },
  gratitude: { halfLifeMin: 18, label: '感激', cat: 'out', sign: 'pos' },
  anxiety: { halfLifeMin: 12, label: '焦虑', cat: 'in', sign: 'neg' },
  sadness: { halfLifeMin: 22, label: '悲伤', cat: 'in', sign: 'neg' },
  fear: { halfLifeMin: 8, label: '恐惧', cat: 'in', sign: 'neg' },
  shame: { halfLifeMin: 15, label: '羞耻', cat: 'in', sign: 'neg' },
  guilt: { halfLifeMin: 16, label: '内疚', cat: 'in', sign: 'neg' },
  envy: { halfLifeMin: 18, label: '嫉妒', cat: 'in', sign: 'neg' },
  loneliness: { halfLifeMin: 25, label: '孤独', cat: 'in', sign: 'neg' },
  down: { halfLifeMin: 20, label: '低落', cat: 'in', sign: 'neg' },
  boredom: { halfLifeMin: 15, label: '无聊', cat: 'in', sign: 'neg' },
  surprise: { halfLifeMin: 3, label: '惊讶', cat: 'neu', sign: 'neu' },
  curiosity: { halfLifeMin: 12, label: '好奇', cat: 'neu', sign: 'neu' },
  hope: { halfLifeMin: 22, label: '期待', cat: 'neu', sign: 'pos' }
};

const EMO_KEYS = Object.keys(EMOTIONS);
const EMO_PLAIN = {
  joy: '心里挺高兴', cheer: '心情不错', pride: '有点得意', smug: '得瑟起来了',
  gratitude: '被人谢了', hope: '有盼头', hype: '有点嗨', curiosity: '想接着聊',
  surprise: '完全没想到', anger: '上头了', irk: '有点烦', anxiety: '心里没底',
  fear: '发怵', sadness: '不太好受', down: '有点蔫', loneliness: '空落落的',
  boredom: '提不起劲', disgust: '膈应', shame: '有点虚', guilt: '心里有愧', envy: '有点酸'
};

const POS_EMO = new Set(['joy', 'cheer', 'pride', 'gratitude', 'hope', 'smug', 'hype']);
const NEG_EMO = new Set(['anger', 'irk', 'anxiety', 'sadness', 'down', 'loneliness', 'fear', 'disgust', 'shame', 'guilt', 'envy', 'boredom']);
const NEG_KINDS = new Set(['roast', 'ignore', 'busy', 'toolFail', 'error', 'disgust', 'shame', 'envy', 'lonely', 'sadness', 'anxiety', 'fear', 'boredom', 'guilt', 'vent', 'upset']);
const AIMED_NEG = new Set(['roast', 'upset', 'shame', 'disgust', 'envy']);
const HOT_NEG = new Set(['anger', 'irk', 'disgust']);

const MIN = 60 * 1000;
const MAX_LOG = 40;
const DECAY_COMMIT_MS = 20_000;

const DEFAULT = {
  mood: 50,
  arousal: 50,
  energy: { physical: 65, cognitive: 60, emotional: 60, will: 55 },
  acuteStress: 0,
  chronicStress: 0,
  intent: '',
  emotions: {},
  lastEvent: null,
  eventLog: [],
  lastEmoteAt: {},
  updatedAt: Date.now(),
  lastDecayAt: Date.now(),
  ignoredStreak: 0,
  ignoreHits: 0
};

let FILE = path.join('data', 'bot-state.json');

export function configure({ file }) {
  if (file) FILE = file;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function emptyEmotions() {
  const o = {};
  for (const k of EMO_KEYS) o[k] = 0;
  return o;
}

function normEmotions(raw) {
  const out = emptyEmotions();
  if (raw && typeof raw === 'object') {
    for (const k of EMO_KEYS) {
      if (raw[k] != null) out[k] = clamp(Math.round(Number(raw[k]) || 0), 0, 100);
    }
  }
  return out;
}

function normEnergy(raw) {
  const d = DEFAULT.energy;
  const e = { ...d, ...(raw || {}) };
  return {
    physical: clamp(Math.round(Number(e.physical) || 0), 0, 100),
    cognitive: clamp(Math.round(Number(e.cognitive) || 0), 0, 100),
    emotional: clamp(Math.round(Number(e.emotional) || 0), 0, 100),
    will: clamp(Math.round(Number(e.will) || 0), 0, 100)
  };
}

function readRaw() {
  try {
    let t = fs.readFileSync(FILE, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    let energy = normEnergy(j.energy);
    if (typeof j.energy === 'number' && j.energy >= 1 && j.energy <= 4) {
      const map = {
        1: { physical: 15, cognitive: 20, emotional: 25, will: 20 },
        2: { physical: 35, cognitive: 40, emotional: 45, will: 40 },
        3: { physical: 60, cognitive: 60, emotional: 60, will: 55 },
        4: { physical: 85, cognitive: 80, emotional: 80, will: 75 }
      };
      energy = { ...(map[j.energy] || energy) };
    }
    let mood = Number(j.mood);
    if (!Number.isFinite(mood)) mood = 50;
    if (mood < 0) mood = 50 + mood;
    mood = clamp(Math.round(mood), 0, 100);
    return {
      ...DEFAULT,
      ...j,
      mood,
      arousal: clamp(Math.round(Number(j.arousal) || 50), 0, 100),
      energy,
      acuteStress: clamp(Number(j.acuteStress) || 0, 0, 100),
      chronicStress: clamp(Number(j.chronicStress) || 0, 0, 100),
      intent: String(j.intent || ''),
      emotions: normEmotions(j.emotions),
      eventLog: Array.isArray(j.eventLog) ? j.eventLog.slice(0, MAX_LOG) : [],
      lastEmoteAt: (j.lastEmoteAt && typeof j.lastEmoteAt === 'object') ? j.lastEmoteAt : {},
      lastDecayAt: Number(j.lastDecayAt) || Number(j.updatedAt) || Date.now()
    };
  } catch {
    return { ...DEFAULT, energy: { ...DEFAULT.energy }, emotions: emptyEmotions() };
  }
}

function write(s) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch { /* 持久化失败不拖垮主流程 */ }
}

function hourEnergyTargets(hour) {
  if (hour < 5) return { physical: 25, cognitive: 22 };
  if (hour < 7) return { physical: 38, cognitive: 35 };
  if (hour < 9) return { physical: 55, cognitive: 52 };
  if (hour < 12) return { physical: 75, cognitive: 78 };
  if (hour < 14) return { physical: 68, cognitive: 65 };
  if (hour < 18) return { physical: 88, cognitive: 85 };
  if (hour < 21) return { physical: 72, cognitive: 70 };
  return { physical: 48, cognitive: 45 };
}

function decayEmotions(emotions, minutes) {
  if (minutes <= 0) return emotions;
  const out = { ...emotions };
  for (const k of EMO_KEYS) {
    const hl = EMOTIONS[k].halfLifeMin;
    const f = Math.exp(-(Math.LN2 * minutes) / hl);
    const next = (Number(out[k]) || 0) * f;
    out[k] = next < 1.5 ? 0 : clamp(Math.round(next), 0, 100);
  }
  return out;
}

export function energyLabel(v) {
  const n = Number(v) || 0;
  if (n >= 85) return '很足';
  if (n >= 65) return '还行';
  if (n >= 40) return '一般';
  if (n >= 20) return '偏累';
  return '很累';
}

export function moodLabel(v) {
  const n = Number(v) || 50;
  if (n >= 80) return '很好';
  if (n >= 62) return '不错';
  if (n >= 42) return '一般';
  if (n >= 25) return '不太爽';
  return '很差';
}

export function topEmotionPhrases(emotions, max = 2) {
  return EMO_KEYS
    .map((k) => ({ k, v: emotions[k] || 0, label: EMOTIONS[k].label }))
    .filter((x) => x.v >= 15)
    .sort((a, b) => b.v - a.v)
    .slice(0, max)
    .map((x) => (EMO_PLAIN[x.k] ? `${x.label}(${EMO_PLAIN[x.k]})` : x.label));
}

function sumHotEmotions(emo) {
  let sum = 0;
  for (const k of HOT_NEG) sum += Number(emo?.[k]) || 0;
  return sum;
}

function dampenPair(emo, hot, cold, ratio = 0.1) {
  const h = Number(emo[hot]) || 0;
  if (h < 15) return;
  emo[cold] = clamp(Math.round((emo[cold] || 0) - h * ratio), 0, 100);
}

function applyEmotionOpposition(emo) {
  let pos = 0;
  let neg = 0;
  for (const k of POS_EMO) pos += emo[k] || 0;
  for (const k of NEG_EMO) neg += emo[k] || 0;
  if (pos - neg > 25) {
    for (const k of NEG_EMO) {
      if ((emo[k] || 0) >= 18) emo[k] = clamp(Math.round(emo[k] - (pos - neg) * 0.05), 0, 100);
    }
  }
  if (neg - pos > 25) {
    for (const k of POS_EMO) {
      if ((emo[k] || 0) >= 18) emo[k] = clamp(Math.round(emo[k] - (neg - pos) * 0.05), 0, 100);
    }
  }
  dampenPair(emo, 'joy', 'sadness', 0.14);
  dampenPair(emo, 'cheer', 'down', 0.14);
  dampenPair(emo, 'pride', 'shame', 0.12);
  dampenPair(emo, 'hope', 'anxiety', 0.12);
  dampenPair(emo, 'anger', 'fear', 0.08);
  for (const k of EMO_KEYS) {
    if ((emo[k] || 0) > 0 && emo[k] < 2) emo[k] = 0;
  }
}

function appraiseAndAct(s, kinds = [], opts = {}) {
  const emo = s.emotions;
  const GAIN_SCALE = 0.85;
  const closenessBoost = 1 + clamp(Number(opts.closeness) || 0, 0, 1) * 0.8;
  const softGain = (v, cur) => {
    const n = Number(cur) || 0;
    if (n >= 70) return v * 0.03;
    if (n >= 50) return v * 0.08;
    if (n >= 35) return v * 0.2;
    if (n >= 18) return v * 0.4;
    return v;
  };
  const add = (k, v) => {
    const cur = emo[k] || 0;
    const mul = NEG_EMO.has(k) ? closenessBoost : 1;
    const scaled = Math.round(v * mul * GAIN_SCALE * 10) / 10;
    emo[k] = clamp(Math.round(cur + softGain(scaled, cur)), 0, 100);
  };
  const drop = (k, v) => { emo[k] = clamp(Math.round((emo[k] || 0) - v), 0, 100); };
  const drainCog = (v) => {
    const cur = Number(s.energy.cognitive) || 0;
    const scale = cur < 20 ? 0.25 : cur < 40 ? 0.65 : 1;
    s.energy.cognitive = clamp(cur - Math.round(v * scale), 0, 100);
  };

  for (const kind of (Array.isArray(kinds) ? kinds : [kinds].filter(Boolean))) {
    switch (kind) {
      case 'roast':
        add('irk', 14); add('anger', 10); add('down', 2);
        drop('joy', 5); drop('cheer', 6); drop('smug', 4);
        s.acuteStress = clamp(s.acuteStress + 10, 0, 100);
        s.chronicStress = clamp(s.chronicStress + 1, 0, 100);
        s.arousal = clamp(s.arousal + 9, 0, 100);
        s.mood = clamp(s.mood - 5, 0, 100);
        break;
      case 'upset':
        add('guilt', 12); add('shame', 6); add('anxiety', 5);
        drop('smug', 10); drop('pride', 6);
        s.mood = clamp(s.mood - 6, 0, 100);
        break;
      case 'praise':
        add('joy', 11); add('pride', 7); add('gratitude', 5); add('cheer', 6);
        drop('irk', 6); drop('down', 4); drop('anxiety', 4);
        s.mood = clamp(s.mood + 5, 0, 100);
        s.acuteStress = clamp(s.acuteStress - 7, 0, 100);
        break;
      case 'tease':
        add('smug', 4); add('cheer', 2); add('curiosity', 2);
        drop('boredom', 3); drop('down', 2);
        s.mood = clamp(s.mood + 1, 0, 100);
        break;
      case 'chat':
        add('cheer', 2); add('joy', 1);
        drop('boredom', 3); drop('loneliness', 1);
        break;
      case 'mention':
        add('curiosity', 3); add('hope', 2);
        drop('boredom', 2);
        s.arousal = clamp(s.arousal + 2, 0, 100);
        break;
      case 'memeOk':
        add('smug', 2); add('cheer', 2); add('joy', 1);
        drop('down', 1); drop('boredom', 1);
        break;
      case 'help':
        add('curiosity', 8); add('hope', 3); add('pride', 2);
        drop('boredom', 2);
        break;
      case 'busy':
        add('boredom', 8); add('irk', 10); add('anxiety', 2);
        drop('curiosity', 5); drop('joy', 4);
        s.energy.emotional = clamp(s.energy.emotional - 8, 0, 100);
        s.acuteStress = clamp(s.acuteStress + 8, 0, 100);
        break;
      case 'ignore':
        add('loneliness', 9); add('down', 6); add('boredom', 3);
        drop('cheer', 4); drop('smug', 3);
        s.mood = clamp(s.mood - 3, 0, 100);
        s.arousal = clamp(s.arousal - 4, 0, 100);
        break;
      case 'toolFail':
        add('anxiety', 9); add('fear', 5); add('irk', 3);
        drop('hope', 3);
        s.acuteStress = clamp(s.acuteStress + 9, 0, 100);
        drainCog(2);
        s.mood = clamp(s.mood - 2, 0, 100);
        break;
      case 'toolOk':
        if ((s.mood || 50) < 72) {
          add('joy', 2); add('hope', 3);
          drop('anxiety', 2); drop('boredom', 2);
        }
        s.acuteStress = clamp(s.acuteStress - 1, 0, 100);
        break;
      case 'error':
        add('anxiety', 8); add('down', 4); add('guilt', 5);
        drop('hope', 3);
        s.acuteStress = clamp(s.acuteStress + 9, 0, 100);
        drainCog(2);
        break;
      case 'hype':
        add('hype', 13); add('joy', 4); add('surprise', 6);
        drop('boredom', 6); drop('down', 4);
        s.arousal = clamp(s.arousal + 12, 0, 100);
        s.mood = clamp(s.mood + 3, 0, 100);
        break;
      case 'curiosity':
        add('curiosity', 10); add('hope', 3);
        drop('boredom', 5); drop('down', 2);
        s.arousal = clamp(s.arousal + 2, 0, 100);
        break;
      case 'sadness':
        add('sadness', 10); add('down', 8);
        drop('joy', 5); drop('cheer');
        s.mood = clamp(s.mood - 5, 0, 100);
        s.arousal = clamp(s.arousal - 4, 0, 100);
        break;
      case 'anxiety':
        add('anxiety', 10); add('fear', 3);
        drop('smug', 5); drop('hope', 2);
        s.acuteStress = clamp(s.acuteStress + 5, 0, 100);
        break;
      default:
        break;
    }
  }
  applyEmotionOpposition(emo);
}

function computeIntent(s) {
  if (s.acuteStress >= 70) return '先稳一下，别硬刚';
  if (sumHotEmotions(s.emotions) >= 28) return '想骂就骂，别硬憋';
  if (s.energy.cognitive < 25) return '少查少绕，简单回';
  if ((s.emotions.curiosity || 0) >= 40) return '多好奇，少敷衍';
  if ((s.emotions.loneliness || 0) >= 35) return '主动接点话';
  return '';
}

function allowEmote(s, kind) {
  const t = Number(s.lastEmoteAt?.[kind]) || 0;
  return Date.now() - t >= 60_000;
}

function pushLog(s, kind, note, chatKey, delta) {
  s.lastEvent = { kind, note: String(note || '').slice(0, 80), chatKey, at: Date.now(), delta };
  s.eventLog = [s.lastEvent, ...(s.eventLog || [])].slice(0, MAX_LOG);
  s.lastEmoteAt = s.lastEmoteAt || {};
  for (const k of String(kind).split('+')) {
    s.lastEmoteAt[k] = Date.now();
  }
}

export function getBotState({ persist = true, forceDecay = false } = {}) {
  const s = readRaw();
  const now = Date.now();
  const hour = new Date(now).getHours();
  if (!Number(s.lastDecayAt)) s.lastDecayAt = Number(s.updatedAt) || now;
  const ageMs = Math.max(0, now - s.lastDecayAt);
  const ageMin = ageMs / MIN;
  const tgt = hourEnergyTargets(hour);

  if (ageMs < DECAY_COMMIT_MS && !forceDecay) {
    s.intent = computeIntent(s);
    return s;
  }

  const kf = 1 - Math.exp(-(Math.LN2 * ageMin) / 15);
  s.energy.physical = clamp(Math.round(s.energy.physical + (tgt.physical - s.energy.physical) * kf), 0, 100);
  s.energy.cognitive = clamp(Math.round(s.energy.cognitive + (tgt.cognitive - s.energy.cognitive) * kf), 0, 100);
  const ke = 1 - Math.exp(-(Math.LN2 * ageMin) / 4);
  s.energy.emotional = clamp(Math.round(s.energy.emotional + (55 - s.energy.emotional) * ke), 0, 100);
  s.energy.will = clamp(Math.round(s.energy.will + (55 - s.energy.will) * kf * 0.6), 0, 100);
  const ka = 1 - Math.exp(-(Math.LN2 * ageMin) / 8);
  s.arousal = clamp(Math.round(s.arousal + (50 - s.arousal) * ka), 0, 100);
  const km = 1 - Math.exp(-(Math.LN2 * ageMin) / 40);
  s.mood = clamp(Math.round(s.mood + (50 - s.mood) * km * 0.5), 0, 100);
  s.acuteStress = clamp(Math.round(s.acuteStress * Math.exp(-(Math.LN2 * ageMin) / 18)), 0, 100);
  s.chronicStress = clamp(s.chronicStress * Math.exp(-(Math.LN2 * ageMin) / 120), 0, 100);
  s.emotions = decayEmotions(s.emotions, ageMin);
  s.lastDecayAt = now;
  s.intent = computeIntent(s);
  if (persist) write(s);
  return s;
}

export function botStatePromptLine(stateIn) {
  const s = stateIn || getBotState({ persist: false });
  const e = s.energy;
  const avgE = Math.round((e.physical + e.cognitive + e.emotional + e.will) / 4);
  const parts = [`精力${energyLabel(avgE)}`, `心情${moodLabel(s.mood)}`];
  if (s.acuteStress >= 40) parts.push('刚被刺激过，还没缓过来');
  else if (s.chronicStress >= 40) parts.push('一直没停，有点绷不住');

  const dirSum = { out: 0, in: 0, neu: 0 };
  const dirTop = { out: [], in: [], neu: [] };
  for (const k of EMO_KEYS) {
    const v = Number(s.emotions[k]) || 0;
    if (v < 10) continue;
    const cat = EMOTIONS[k].cat;
    dirSum[cat] += v;
    dirTop[cat].push({ k, v, label: EMOTIONS[k].label });
  }
  const dirWord = (n) => (n >= 50 ? '很重' : n >= 30 ? '偏重' : n >= 15 ? '有点' : n >= 6 ? '一点点' : '');
  const bits = [];
  for (const [key, name] of [['in', '向内'], ['out', '向外'], ['neu', '中性']]) {
    const w = dirWord(dirSum[key]);
    if (!w) continue;
    dirTop[key].sort((a, b) => b.v - a.v);
    const named = dirTop[key].slice(0, 2)
      .map((x) => (EMO_PLAIN[x.k] ? `${x.label}(${EMO_PLAIN[x.k]})` : x.label)).join('、');
    bits.push(`${name}${w}${named ? '：' + named : ''}`);
  }
  let line = `（此刻）${parts.join('，')}。`;
  if (bits.length) line += `情绪：${bits.join('；')}。`;
  if (s.intent) line += `倾向：${s.intent}。`;
  const hot = sumHotEmotions(s.emotions);
  if (hot >= 28) line += '气到这份上了，想骂就骂，别硬憋。';
  else if (hot >= 14) line += '有点上火，被惹了可以炸回去。';
  else if (s.acuteStress >= 70) line += '有点绷着，先别硬刚。';
  else if (e.cognitive < 25) line += '脑子转不动就少查少绕。';
  return line;
}

export function botStateView() {
  const s = getBotState({ persist: false });
  const avgE = Math.round((s.energy.physical + s.energy.cognitive + s.energy.emotional + s.energy.will) / 4);
  return {
    energy: avgE,
    energyLabel: energyLabel(avgE),
    energyDetail: s.energy,
    mood: Math.round(s.mood - 50),
    moodLabel: moodLabel(s.mood),
    moodRaw: s.mood,
    arousal: s.arousal,
    acuteStress: Math.round(s.acuteStress),
    chronicStress: Math.round(s.chronicStress),
    intent: s.intent,
    emotions: s.emotions,
    emotionPhrases: topEmotionPhrases(s.emotions, 5),
    lastEvent: s.lastEvent,
    eventLog: s.eventLog || [],
    promptLine: botStatePromptLine(s),
    updatedAt: s.updatedAt
  };
}

export function setBotState(partial = {}) {
  const s = getBotState({ persist: false, forceDecay: true });
  if (partial.energy != null) {
    if (typeof partial.energy === 'object') {
      s.energy = normEnergy({ ...s.energy, ...partial.energy });
    } else {
      const avg = clamp(Number(partial.energy) || 50, 0, 100);
      s.energy = { physical: avg, cognitive: avg, emotional: avg, will: avg };
    }
  }
  if (partial.mood != null) {
    let m = Number(partial.mood);
    if (Number.isFinite(m)) {
      if (m < 0) m = 50 + m;
      s.mood = clamp(Math.round(m), 0, 100);
    }
  }
  if (partial.acuteStress != null) s.acuteStress = clamp(Number(partial.acuteStress) || 0, 0, 100);
  if (partial.chronicStress != null) s.chronicStress = clamp(Number(partial.chronicStress) || 0, 0, 100);
  if (partial.emotions && typeof partial.emotions === 'object') {
    s.emotions = normEmotions({ ...s.emotions, ...partial.emotions });
  }
  if (partial.reset) {
    s.mood = DEFAULT.mood;
    s.arousal = DEFAULT.arousal;
    s.energy = { ...DEFAULT.energy };
    s.acuteStress = 0;
    s.chronicStress = 0;
    s.intent = '';
    s.emotions = emptyEmotions();
    s.lastEvent = null;
    s.eventLog = [];
  }
  s.intent = computeIntent(s);
  s.updatedAt = Date.now();
  write(s);
  return botStateView();
}

export function parseEmotionTags(raw) {
  const s = String(raw || '').toLowerCase();
  const map = [
    [/愤怒|生气|炸|上头|骂/, 'roast'],
    [/开心|快乐|嗨|得意|爽/, 'praise'],
    [/低落|难过|sad/, 'sadness'],
    [/烦|燥|讨厌/, 'busy'],
    [/好奇|想知道/, 'curiosity'],
    [/无聊|干瘪/, 'ignore']
  ];
  const out = [];
  for (const [re, kind] of map) {
    if (re.test(s) && !out.includes(kind)) out.push(kind);
  }
  return out;
}

export function detectIncomingHint(triggerTexts = []) {
  const text = String(triggerTexts.join('\n'))
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/@[^\s\[\]]{0,24}/g, '');
  if (!text.trim()) return null;
  const found = [];
  const push = (t) => { if (!found.includes(t)) found.push(t); };
  if (/(傻逼|智障|弱智|去死|滚蛋|闭嘴|垃圾|废物|烦死|讨厌)/i.test(text)) push('roast');
  if (/(你好?可爱|真厉害|好厉害|喜欢你|爱你|好棒|贴贴)/i.test(text)) push('praise');
  if (/(为什么|怎么|是什么|求解释|科普|讲讲)/i.test(text)) push('curiosity');
  if (/(刷屏|别插嘴|闭嘴听我说|别吵)/i.test(text)) push('busy');
  if (/(没人在|不理你|消失|又不说话)/i.test(text)) push('ignore');
  if (/(气死了|真生气|你气死我了)/i.test(text)) push('upset');
  if (/(冲|杀|芜湖|起飞|燃起来了)/i.test(text)) push('hype');
  if (!found.length) return null;
  return { type: found, text: text.slice(0, 200) };
}

export function applyRunToBotState({
  sentTexts = [],
  chatKey = '',
  incomingHint = null,
  toolFailed = false,
  error = false,
  favor = null,
  moodHint = '',
  triggerText = '',
  addressed = false,
  triggerCount = 0
} = {}) {
  const s = getBotState({ persist: false, forceDecay: true });
  const n = sentTexts.filter(Boolean).length;
  const cue = String(triggerText || incomingHint?.text || '');
  const closeness = Number.isFinite(Number(favor)) ? clamp((Number(favor) - 50) / 50, 0, 1) : 0;
  const act = (ks, o = {}) => appraiseAndAct(s, ks, { closeness, ...o });

  let kinds = [...parseEmotionTags(moodHint)];
  if (incomingHint) {
    const flat = (Array.isArray(incomingHint.type) ? incomingHint.type : [incomingHint.type]).flat().filter(Boolean);
    for (const k of flat) {
      if (k === 'praise' && (kinds.length || !addressed)) continue;
      if (!kinds.includes(k)) kinds.push(k);
    }
  }
  kinds = kinds.sort((a, b) => (NEG_KINDS.has(a) ? 0 : 1) - (NEG_KINDS.has(b) ? 0 : 1)).slice(0, 3);
  if (kinds.some((k) => NEG_KINDS.has(k))) kinds = kinds.filter((k) => k !== 'praise');
  if (!addressed) kinds = kinds.filter((k) => !AIMED_NEG.has(k));
  if (toolFailed && !kinds.includes('toolFail')) kinds.push('toolFail');
  if (error && !kinds.includes('error')) kinds.push('error');
  if (!kinds.length && n > 0) kinds = ['chat'];

  kinds = kinds.filter((k) => allowEmote(s, k));
  if (kinds.length) {
    act(kinds, { socialHeavy: n >= 4 });
    pushLog(s, kinds.join('+'), moodHint || cue, chatKey, 0);
  }

  if (addressed) {
    s.ignoredStreak = 0;
  } else if (n > 0) {
    s.ignoredStreak = Math.min(9, (Number(s.ignoredStreak) || 0) + 1);
    if (s.ignoredStreak >= 3 && allowEmote(s, 'ignore')) {
      act(['ignore'], { quiet: true });
      pushLog(s, 'ignore', `连续${s.ignoredStreak}轮没人接话`, chatKey, 0);
      s.ignoredStreak = 0;
      s.ignoreHits = Math.min(9, (Number(s.ignoreHits) || 0) + 1);
    }
  }

  applyEmotionOpposition(s.emotions);
  s.intent = computeIntent(s);
  s.updatedAt = Date.now();
  write(s);
  return botStateView();
}
