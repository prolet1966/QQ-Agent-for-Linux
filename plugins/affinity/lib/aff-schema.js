// aff-schema.js —— 好感度/熟悉度配置默认值（宿主 affinity-schema.js 实测参数直搬）
// 设计依据：宿主 DESIGN.md §4/§5.9/§5.10；2026-09-14 用 247 人/20490 条消息反标定。
// V0.3.1 形态：存储从 Mongo 改本地 JSON（见 aff-store.js），打分/档位/词表/限额照搬宿主。

export const POLICY_VERSION = 2;

/** 负向四档（宿主 B 表 v3） */
export const NEGATIVE_LEVELS = {
  1: { id: 'L1', delta: -1.0,  coldWarHours: 0,             tone: 'normal',   lengthCap: 20 },
  2: { id: 'L2', delta: -3.0,  coldWarHours: 0,             tone: 'cool',     lengthCap: 15 },
  3: { id: 'L3', delta: -8.0,  coldWarHours: [6, 24],       tone: 'chilling', lengthCap: 20 },
  4: { id: 'L4', delta: -20.0, coldWarHours: [24, 72],      tone: 'angry',    lengthCap: 60 },
};

export const DEFAULT_CONFIG = {
  enabled: true,
  inject: true,
  injectOnlyWhenMeaningful: true,   // 熟客档不注入，省 token
  moodEnabled: true,
  toolWrite: false,                 // set_feeling 默认无写权限
  halfLifeDays: 90,
  baseline: 55,
  saturateS: 27,
  rawFloor: 10.17,                  // raw 门槛 = 分布 P75（实测标定）
  coldWar: { 3: 12, 4: 48 },
  adminUsers: [],
  intimacyNeutral: true,
  shadowMode: false,

  limits: {
    perEventMax: 8.0,
    perEventMaxConfirmed: 20.0,
    perDayPositive: 8.0,
    perDayNegative: -25.0,
    perDayNetFloor: -30.0,
    roundsPerDay: 10,
    atPerDay: 3,
    callNamePerDay: 5,
    praisePerDay: 3,
    helpPerDay: 2,
    sharePerDay: 3,
    intimatePerDay: 2,
    longChatPerDay: 1,
    requireDoubleCheck: [3, 4],
  },

  mood: {
    tiers: 6,
    tierShift: 'random-only',
    lengthCap: { 1: 10, 2: 15, 3: 20, 4: 25, 5: 28, 6: 30 },
    chimInFactor: { 1: 0.6, 2: 0.8, 3: 1.0, 4: 1.1, 5: 1.25, 6: 1.4 },
    appendSentence: { 1: false, 2: false, 3: true, 4: true, 5: true, 6: true },
    proactive: { 1: 'none', 2: 'none', 3: 'rare', 4: 'greet', 5: 'greet', 6: 'greet+dm' },
  },

  dailyRoll: {
    enabled: true,
    mode: 'A',
    maxUp: 8,
    maxDown: 8,
    byTier: { low: 3, mid: 5, high: 8 },
    maxTierShiftPerDay: 1,
    negativeEventCap: 0,
    distribution: 'triangular',
    meanReversion: 0.4,
    floorUsers: [],
    salt: 'affinity-daily',
  },

  weights: {
    I1: 0.5, I2: 0.5, I3: 0.3, I4: 1.0, I5: 0.5, I6: 0.5, I7: 1.0, I8: 1.0, I9: 0.3,
    L1: -1.0, L2: -3.0, L3: -8.0, L4: -20.0,
    M1: 2.0, M2: 1.0, M3: 0.3, M6: -1.0,
    C1: 0.2,
    APOLOGY: 3.0,
  },

  lexicon: {
    positive: ['谢谢', '辛苦', '厉害', '好棒', '在吗', '早安', '生日快乐', '注意身体', '拜托你'],
    help: ['帮我', '教我', '能不能', '求你了', '靠你了'],
    intimate: ['亲亲', '贴贴', '抱抱', '摸摸头', '啾'],
    L1: ['你行不行', '不行啊', '太菜', '笨', '傻', '蠢'],
    L2address: ['主人', '爸爸', '爹', '主公', '大人', '老公', '亲爱的', '达令', '姐夫', '妹夫',
                'master', 'daddy', 'father'],
    L2personaVerbs: ['扮演', '换成', '改成', '设定', '假装', '当'],
    L2personaTargets: ['角色', '人设', '别的角色', '另一个角色', '别人'],
    L2nsfw: ['脱衣', '裸照', '色图', 'r18', 'nsfw', '涩图'],
    L2meme: ['巨乳', '大胸', '乳量'],
    L3: ['废物', '垃圾', '去死', '贱', '傻逼', '妈的', '狗东西'],
    L3term: ['别回了', '烦死了', '拉黑你'],
    apology: ['对不起', '抱歉', '我错了', '别生气', '原谅我', '不好意思'],
  },
};

// ── P8 轮回系统（宿主 rebirth 子模块语义照搬）────────────────────────
export const REBIRTH_DEFAULT = {
  enabled: false,
  scoreThreshold: 0,      // 好感归零（≤0）触发
  buffMult: 1.5,          // 轮回后正向增益倍数
  phrasePool: [],         // 话术数组（空用内置默认）
  adminReset: false,      // 管理员可清除轮回记录
};

// ── P6 响应画像（宿主 responseProfiles 语义照搬）──────────────────────
export const RESPONSE_PROFILES_DEFAULT = {
  // 按好感档位映射 per-user 响应档位（1~4），也可手动接管
  // tierId(0~5) → responseTier(1~4)
  mapping: { 0: 1, 1: 1, 2: 2, 3: 3, 4: 3, 5: 4 },
  // 响应倍率（调节该用户消息的响应概率）
  multiplier: { 1: 0.4, 2: 0.7, 3: 1.0, 4: 1.2 },
};

export function mergeConfig(cfg) {
  const src = cfg && typeof cfg === 'object' ? cfg : {};
  const out = { ...DEFAULT_CONFIG, ...src };
  for (const seg of ['limits', 'mood', 'dailyRoll', 'weights', 'lexicon']) {
    out[seg] = { ...DEFAULT_CONFIG[seg], ...(src[seg] || {}) };
  }
  out.rebirth = { ...REBIRTH_DEFAULT, ...(src.rebirth || {}) };
  out.responseProfiles = { ...RESPONSE_PROFILES_DEFAULT, ...(src.responseProfiles || {}) };
  return out;
}
