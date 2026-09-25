// bs-schema.js —— 本体状态（主干三维 + 21 格情绪）默认值
// 按上传清单 §3.2 文字规格新建（宿主无此实现）；情绪表照清单 21 格。

export const AXES = {
  energy:  { min: 0, max: 1, base: 0.7, label: '精力' },
  social:  { min: 0, max: 1, base: 0.6, label: '社交' },
  mood:    { min: 0, max: 1, base: 0.5, label: '心情' },
};

// 21 个情绪格子（清单 §3.2：100 分制，每格独立半衰期指数衰减 + 唤醒权重）
export const EMOTION_GRID = [
  { id: 'disgust',    name: '厌恶',   group: 'neg', halfLifeMin: 10, wakeWeight: 0.3 },
  { id: 'shame',      name: '羞耻',   group: 'neg', halfLifeMin: 15, wakeWeight: 0.3 },
  { id: 'guilt',      name: '内疚',   group: 'neg', halfLifeMin: 16, wakeWeight: 0.2 },
  { id: 'anger',      name: '愤怒',   group: 'neg', halfLifeMin: 6,  wakeWeight: 0.8 },
  { id: 'anxiety',    name: '焦虑',   group: 'neg', halfLifeMin: 12, wakeWeight: 0.5 },
  { id: 'sadness',    name: '悲伤',   group: 'neg', halfLifeMin: 22, wakeWeight: -0.8 },
  { id: 'fear',       name: '恐惧',   group: 'neg', halfLifeMin: 8,  wakeWeight: 0.6 },
  { id: 'envy',       name: '嫉妒',   group: 'neg', halfLifeMin: 18, wakeWeight: 0.3 },
  { id: 'boredom',    name: '无聊',   group: 'neg', halfLifeMin: 15, wakeWeight: -0.6 },
  { id: 'loneliness', name: '孤独',   group: 'neg', halfLifeMin: 6,  wakeWeight: -0.5 },
  { id: 'irritation', name: '烦躁',   group: 'neg', halfLifeMin: 5,  wakeWeight: 0.4 },
  { id: 'depression', name: '低落',   group: 'neg', halfLifeMin: 29, wakeWeight: -0.7 },
  { id: 'happiness',  name: '开心',   group: 'pos', halfLifeMin: 11, wakeWeight: 0.3 },
  { id: 'joy',        name: '喜悦',   group: 'pos', halfLifeMin: 18, wakeWeight: 0.4 },
  { id: 'gratitude',  name: '感恩',   group: 'pos', halfLifeMin: 16, wakeWeight: 0.1 },
  { id: 'hope',       name: '希望',   group: 'pos', halfLifeMin: 22, wakeWeight: 0.2 },
  { id: 'pride',      name: '自豪',   group: 'pos', halfLifeMin: 20, wakeWeight: 0.2 },
  { id: 'smugness',   name: '得意',   group: 'pos', halfLifeMin: 10, wakeWeight: 0.3 },
  { id: 'excitement', name: '亢奋',   group: 'pos', halfLifeMin: 8,  wakeWeight: 1.0 },
  { id: 'curiosity',  name: '好奇',   group: 'neu', halfLifeMin: 11, wakeWeight: 0.4 },
  { id: 'surprise',   name: '惊讶',   group: 'neu', halfLifeMin: 3,  wakeWeight: 0.8 },
];

// 五条经典聚合视图（清单：joy/hype/pride/irrit/blue 由格子加权聚合，兼容旧消费端）
export const AGGREGATES = {
  joy:   ['happiness', 'joy', 'gratitude', 'pride'],
  hype:  ['excitement', 'smugness'],
  pride: ['pride', 'smugness'],
  irrit: ['anger', 'irritation', 'envy'],
  blue:  ['sadness', 'depression', 'loneliness', 'shame'],
};

export const DEFAULT_CONFIG = {
  enabled: true,
  inject: false,
  moodBase: 0.5,
  emotionCap: 100,
  dailyRebaseHour: 5,
  energyRecoverPerHour: 0.02,
  socialRecoverPerHour: 0.015,
  energyCostPerMsg: 0.01,
  socialCostPerMsg: 0.008,
  sleepDice: { enabled: true, goodProb: 0.5, badProb: 0.2 },
};

export function mergeConfig(cfg) {
  const src = cfg && typeof cfg === 'object' ? cfg : {};
  return { ...DEFAULT_CONFIG, ...src };
}

export function emotionIndex() {
  const map = {};
  for (const e of EMOTION_GRID) map[e.id] = e;
  return map;
}
