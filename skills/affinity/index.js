// affinity —— 好感度（V0.4 移植版，只读最小闭环）
//
// 移植自 v0.3 部署版的 src/affinity.js + src/affinity-persona.js + src/affinity-score.js。
// 本轮**只做读 + 注入 + 查询**这三件事，不做写回（旧版的 affinity_adjust 写权限未移植）。
//
// ── 两条照抄的设计铁律（原文注释，不要改）──────────────────────────────
//   ① affinity-persona.js: "铁律：好感度只调「温度」，绝不调「边界」"
//      —— 注入文案只影响语气松紧，绝不触碰权限、安全与角色设定。
//   ② "不写内部档位名（常客/茶友等只在控制台出现）"
//      —— 模型只能看到"温度"指令，看不到生客/熟客/座上宾这类内部分档词。
//
// ── 注入位置照抄 ──────────────────────────────────────────────────
//   旧版 orchestrator.js:941 的 cache-opt 补丁写明："动态注入不再拼进 system，
//   改为落在用户消息末尾（prompt.js 的 ctx.archInject）" —— 目的是保住前缀缓存。
//   所以这里同样只追加到最后一条 user 消息，**不动系统提示词**。
//
// ── 数据 ─────────────────────────────────────────────────────────
//   DATA_DIR/affinity/state.json —— 由 MongoDB 导出整理而成（961 人 / 45605 事件 /
//   2026-09-10~09-23）。生成脚本：tools/affinity-report.mjs --state-out <path>。
//
// ── 未移植（有意为之，见 README）──────────────────────────────────
//   事件采集（从三层记忆抽"好感度证据"）、计分与衰减、每日结算与快照、
//   心情档位对插话概率的修正（chimIn）、控制台图表、写权限。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

// ── 档位表：照抄 affinity-score.js:57-64 的 TIERS ──────────────────
// name 是**内部分档名，绝不进提示词**；只有 tierId 参与语气映射。
const TIERS = [
  { id: 0, key: 'stranger',      name: '生客',   min: 0,  max: 19,  chimIn: 0.6,  lengthCap: 10, proactive: 'none' },
  { id: 1, key: 'guest',         name: '客人',   min: 20, max: 39,  chimIn: 0.8,  lengthCap: 15, proactive: 'none' },
  { id: 2, key: 'regular',       name: '熟客',   min: 40, max: 59,  chimIn: 1.0,  lengthCap: 20, proactive: 'rare' },
  { id: 3, key: 'frequent',      name: '常客',   min: 60, max: 79,  chimIn: 1.1,  lengthCap: 25, proactive: 'greet' },
  { id: 4, key: 'tea_friend',    name: '茶友',   min: 80, max: 94,  chimIn: 1.25, lengthCap: 28, proactive: 'greet' },
  { id: 5, key: 'regular_guest', name: '座上宾', min: 95, max: 100, chimIn: 1.4,  lengthCap: 30, proactive: 'greet+dm' }
];

// ── 语气映射：照抄 affinity-persona.js:6-13 的 TONE_MAP ─────────────
// 每条 ≤60 字符，且不含内部档位名。
const TONE_MAP = {
  0: '保持最标准的敬语，回应简短，不主动',
  1: '礼貌、话少，不主动开话题',
  2: '正常寒暄即可，不必格外热络',
  3: '可以更放松一点，接得住玩笑',
  4: '放松一些：多用语气词和颜文字，可以主动关心一句',
  5: '最放松的状态：可以主动开话题、开一点腹黑玩笑'
};

// ── 冷战语气：照抄 affinity-persona.js:16-20 ──────────────────────
const GRUDGE_TONES = {
  cool:     '语气转冷，改用"你"，不主动',
  chilling: '冷硬短句，不主动，不用颜文字',
  angry:    '可以不维持营业语气，直接表达不满；禁止人身攻击与侮辱'
};

// ── 人设红线自检词表：照抄 affinity-persona.js:23-27 ───────────────
// 启动时校验 TONE_MAP / GRUDGE_TONES，命中即报警（旧版是"拒绝加载"，
// 这里降级为"报警并停用注入"，避免一个措辞把整个机器人拖下水）。
const FORBIDDEN_IN_TONE = [
  '老公', '亲爱的', '达令', '主人', '爸爸', '爹', '主公', '大人', '姐夫', '妹夫',
  '撒娇', '傲娇', '哼', '亲亲', '贴贴', '抱抱', '老婆',
  '她是', '她觉', '她心'
];

const DEFAULTS = { enabled: true, inject: true, injectOnlyWhenMeaningful: true, moodEnabled: true, maxPeople: 2, debug: false };
const QQ_NUMBER = /^\d{5,15}$/;

let api = { log() {}, warn() {}, error() {}, config: () => ({}), isSkillActive: () => true };
let state = null;
let stateMtime = 0;
let toneAuditFailed = false;
const pending = new Map();   // sessionKey -> [personId]

// ------------------------------------------------------------------ helpers --
function checkToneLine(line) {
  const s = String(line || '');
  return FORBIDDEN_IN_TONE.filter((w) => s.includes(w));
}

/** 启动自检：任何一条文案命中红线就停用注入（照抄原意，失败方式更保守）。 */
function auditToneMap() {
  const bad = [];
  for (const [k, v] of Object.entries(TONE_MAP)) {
    const hits = checkToneLine(v);
    if (hits.length) bad.push({ where: 'TONE_MAP.' + k, hits });
  }
  for (const [k, v] of Object.entries(GRUDGE_TONES)) {
    const hits = checkToneLine(v);
    if (hits.length) bad.push({ where: 'GRUDGE_TONES.' + k, hits });
  }
  return bad;
}

function stateFile() {
  return path.join(DATA_DIR, 'affinity', 'state.json');
}

/** 懒加载 + mtime 缓存（每秒最多 stat 一次的成本，够便宜）。 */
function loadState() {
  try {
    const f = stateFile();
    const st = fs.statSync(f);
    if (state && st.mtimeMs === stateMtime) return state;
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    state = raw && typeof raw.people === 'object' ? raw : null;
    stateMtime = st.mtimeMs;
    return state;
  } catch {
    return null;
  }
}

function cfg() {
  // ★ 实测结论（2026-09-24）：V0.4 的 api.config() 返回的是**本技能自己的 settings**
  //   （这里就是 manifest.settings 那三个键），**不是全量 app config** —— 所以
  //   `api.config().affinity` 永远是 undefined。旧版的 config.affinity 四个开关改为
  //   镜像进 skills.affinity.settings（迁移脚本负责一次性搬运），这里优先读自己
  //   的 settings，同时也兼容"有人把 affinity 段塞进来"的情况。
  const c = (api.config && api.config()) || {};
  const legacy = (c.affinity && typeof c.affinity === 'object') ? c.affinity : {};
  return { ...DEFAULTS, ...legacy, ...c };
}

function personOf(id) {
  const s = loadState();
  return s && s.people ? s.people[String(id)] || null : null;
}

function tierIdOf(score) {
  const v = Math.max(0, Math.min(100, Number(score) || 0));
  for (let i = TIERS.length - 1; i >= 0; i -= 1) if (v >= TIERS[i].min) return TIERS[i].id;
  return 0;
}

function grudgeTone(level) {
  const l = Number(level) || 0;
  if (l >= 4) return GRUDGE_TONES.angry;
  if (l === 3) return GRUDGE_TONES.chilling;
  if (l === 2) return GRUDGE_TONES.cool;
  return '';
}

// ── 注入文案：格式照抄 affinity-persona.js:64-75 ────────────────────
function buildInjectBlock(people) {
  const lines = [];
  for (const p of people || []) {
    const who = (p.name || p.personId || '某人') + '(' + (p.personId || '?') + ')';
    const tone = p.grudgeLevel >= 2 ? grudgeTone(p.grudgeLevel) : (TONE_MAP[p.tierId] || TONE_MAP[2]);
    const val = Math.round(Number(p.dailyValue) || 0);
    const base = Math.round(Number(p.persistentScore) || 0);
    lines.push(who + ': 今日心情 ' + val + '（底色 ' + base + '）· ' + tone);
  }
  if (!lines.length) return '';
  return '【好感度】\n' + lines.join('\n');
}

/** 冷战注入：格式照抄 affinity-persona.js:78-85 */
function buildGrudgeBlock(person, grudge) {
  if (!person || !grudge || Number(grudge.level) < 2) return '';
  const hours = grudge.until ? Math.max(0, Math.round((Number(grudge.until) - Date.now()) / 3600000)) : 0;
  return [
    '【状态】你现在对这个人有些不快（' + grudge.level + ' 级，还剩 ' + hours + ' 小时）',
    '—— ' + grudgeTone(grudge.level) + '；不要骂人、不要人身攻击、不要提人设或设定，也不用解释为什么生气。'
  ].join('\n');
}

/** 注入判定：逐条照抄 affinity.js:408-438 的 injectFor。 */
function injectFor(personIds) {
  try {
    if (toneAuditFailed) return '';
    const c = cfg();
    if (c.enabled === false || c.inject !== true) return '';
    const s = loadState();
    if (!s) return '';

    const ids = [...new Set((personIds || []).map(String))].filter(Boolean).slice(0, Math.max(1, Number(c.maxPeople) || 2));
    if (!ids.length) return '';

    const blocks = [];
    const people = [];
    for (const id of ids) {
      const p = s.people[id];
      if (!p) continue;
      const grudgeLevel = Number(p.grudgeLevel ?? 0);
      if (grudgeLevel >= 2) {
        const g = buildGrudgeBlock({ name: p.name, personId: id }, { level: grudgeLevel, until: null });
        if (g) blocks.push(g);
        continue;
      }
      const tierId = Number(p.tierId ?? tierIdOf(p.score));
      // 熟客档 = 默认行为，不花这个钱（照抄 affinity.js:425）
      if (c.injectOnlyWhenMeaningful !== false && tierId === 2) continue;
      people.push({
        personId: id,
        name: p.name,
        dailyValue: c.moodEnabled === false ? Number(p.score ?? 0) : Number(p.dailyValue ?? p.score ?? 0),
        persistentScore: Number(p.score ?? 0),
        tierId,
        grudgeLevel
      });
    }
    if (people.length) {
      const b = buildInjectBlock(people);
      if (b) blocks.push(b);
    }
    return blocks.join('\n');
  } catch (error) {
    try { api.warn('好感度注入失败（已忽略）：' + (error?.message ?? error)); } catch { /* ignore */ }
    return '';
  }
}

/** 追加到最后一条 user 消息（照抄旧版 cache-opt 决策：不进 system，保住前缀缓存）。 */
function appendToLastUser(messages, text) {
  if (!Array.isArray(messages) || !text) return;
  let target = null;
  for (const m of messages) if (m && m.role === 'user') target = m;
  if (!target) { messages.push({ role: 'user', content: text }); return; }
  if (typeof target.content === 'string') { target.content += '\n\n' + text; return; }
  if (Array.isArray(target.content)) { target.content.push({ type: 'text', text }); return; }
}

// --------------------------------------------------------------------- setup --
export function setup(a) {
  api = { ...api, ...(a || {}) };
  const bad = auditToneMap();
  if (bad.length) {
    toneAuditFailed = true;
    api.error('好感度语气文案命中人设红线，已停用注入：' + JSON.stringify(bad));
  }
  const s = loadState();
  api.log('好感度（只读移植版）已就绪：' + (s ? `${Object.keys(s.people).length} 人档案，数据 ${s.eventDayRange?.[0] ?? '?'} ~ ${s.eventDayRange?.[1] ?? '?'}` : '未找到 DATA_DIR/affinity/state.json，注入将为空'));

  // 只读查询工具。**刻意不返回内部档位名**（照抄"档位名只在控制台出现"的约定），
  // 而是返回与注入同源的"温度"描述 + 相处统计。
  api.registerTool({
    id: 'affinity_query',
    name: '好感度查询',
    description: '查询机器人对某个群友的「关系温度」（长期相处累积的好感度）。userId 传 QQ 号；或传 name 用昵称关键字模糊查找。只读工具，不会修改任何数据。',
    category: 'knowledge',
    icon: '💗',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '对方的 QQ 号（优先使用，精确）' },
        name: { type: 'string', description: '昵称关键字（userId 缺失时使用）' }
      }
    },
    async execute(ctx, args) {
      const s = loadState();
      if (!s) return { content: '好感度数据未加载：缺少 <数据目录>/affinity/state.json。', isError: true };

      const id = String(args?.userId ?? '').trim();
      let entry = null;
      let pid = '';
      if (QQ_NUMBER.test(id)) {
        pid = id;
        entry = s.people[id] || null;
      }
      if (!entry) {
        const kw = String(args?.name ?? '').trim();
        if (!kw) return { content: '请提供 userId（QQ 号）或 name（昵称关键字）。', isError: true };
        const hits = Object.entries(s.people).filter(([, v]) => String(v.name || '').includes(kw));
        if (!hits.length) return { content: `没有找到昵称包含「${kw}」的记录（档案共 ${Object.keys(s.people).length} 人）。` };
        if (hits.length > 1) {
          const list = hits.slice(0, 6).map(([k, v]) => `${v.name}(${k})`).join('、');
          return { content: `「${kw}」匹配到 ${hits.length} 人，请用 QQ 号精确查询：${list}${hits.length > 6 ? ' …' : ''}` };
        }
        [pid, entry] = hits[0];
      }

      const tier = TIERS[Number(entry.tierId ?? tierIdOf(entry.score))] || TIERS[2];
      const tone = entry.grudgeLevel >= 2 ? grudgeTone(entry.grudgeLevel) : (TONE_MAP[tier.id] || TONE_MAP[2]);
      const lines = [
        `${entry.name}(${pid}) 的关系温度：`,
        `· 底色分：${entry.score}（今日心情 ${entry.dailyValue}）`,
        `· 相处统计：发言 ${entry.msgs} 条 / 对话 ${entry.rounds} 轮 / 被点名 ${entry.atBot} 次 / 活跃 ${entry.talkDays} 天`,
        `· 首次接触 ${entry.firstTalk || '未知'}，最近一次 ${entry.lastTalk || '未知'}`,
        `· 当前语气指令：${tone}`,
        entry.grudgeLevel >= 2 ? `· ⚠️ 处于冷战状态（${entry.grudgeLevel} 级）` : null
      ].filter(Boolean);
      return { content: lines.join('\n') };
    }
  });
}

// ── 供其它模块/插件调用的只读查询（与工具同源，避免两套逻辑）──────────
// 声明了 capabilities:[affinity.query] 就必须真的提供它，否则注册表会显示
// implementedCapabilities:[] —— 那是"声明了却不实现"的不诚实状态。
function lookupPerson({ userId, name } = {}) {
  const s = loadState();
  if (!s) return null;
  const id = String(userId ?? '').trim();
  if (QQ_NUMBER.test(id) && s.people[id]) return { personId: id, ...s.people[id] };
  const kw = String(name ?? '').trim();
  if (!kw) return null;
  const hits = Object.entries(s.people).filter(([, v]) => String(v.name || '').includes(kw));
  if (hits.length !== 1) return hits.length ? { ambiguous: hits.length, candidates: hits.slice(0, 6).map(([k, v]) => ({ personId: k, name: v.name })) } : null;
  return { personId: hits[0][0], ...hits[0][1] };
}

export const providers = {
  /** api.capability('affinity.query', { userId } | { name }) */
  'affinity.query': (args = {}) => {
    const p = lookupPerson(args);
    if (!p || p.ambiguous) return p;
    const tier = TIERS[Number(p.tierId ?? tierIdOf(p.score))] || TIERS[2];
    return {
      personId: p.personId,
      name: p.name,
      score: p.score,
      dailyValue: p.dailyValue,
      tierId: tier.id,
      tone: p.grudgeLevel >= 2 ? grudgeTone(p.grudgeLevel) : (TONE_MAP[tier.id] || TONE_MAP[2]),
      grudgeLevel: p.grudgeLevel,
      stats: { msgs: p.msgs, rounds: p.rounds, atBot: p.atBot, talkDays: p.talkDays, firstTalk: p.firstTalk, lastTalk: p.lastTalk }
    };
  }
};

// ------------------------------------------------------------------- hooks --
// 收集本轮触发者 → 在拼接 LLM 消息时注入（与 conversation-memory 同一套钩子）。
const DEBUG = () => { try { return cfg().debug === true; } catch { return false; } };  // 诊断开关走 settings.debug（默认关）
function dbg(line) {
  if (!DEBUG()) return;
  try {
    const d = path.join(DATA_DIR, 'affinity');
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, 'debug.log'), new Date().toISOString() + ' ' + line + '\n');
  } catch { /* ignore */ }
}

export const hooks = {
  async 'before-context'(ctx = {}) {
    try {
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      const ids = [];
      for (const e of entries) {
        if (!e || e.self) continue;                 // 自己发的消息不算
        const uid = String(e.senderId ?? '').trim();
        if (uid) ids.push(uid);
      }
      // 私聊：对方就是会话 id（照抄 orchestrator.js:882）
      if (String(ctx.kind || '') === 'private' && ctx.chatId) ids.push(String(ctx.chatId));
      if (ids.length) pending.set(String(ctx.sessionId || ctx.chatKey || ''), ids);
      dbg(`before-context: sessionId=${ctx.sessionId} chatKey=${ctx.chatKey} kind=${ctx.kind} entries=${entries.length} ids=[${ids.join(',')}] saved=${ids.length ? 'yes' : 'no'} cfgKeys=${Object.keys((api.config && api.config()) || {}).length}`);
    } catch (error) {
      api.warn('[affinity] before-context 异常：' + (error?.message ?? error));   // 收集失败只是这轮没有好感度
    }
  },

  async 'before-llm-messages'(ctx = {}) {
    try {
      const key = String(ctx.sessionId || ctx.chatKey || '');
      const ids = pending.get(key) || [];
      pending.delete(key);                        // 用完即删，别攒着会话引用
      const conf = cfg();
      const text = injectFor(ids);
      if (DEBUG()) {
        const which = conf.inject !== true ? 'inject=false' : (conf.injectOnlyWhenMeaningful !== false ? 'onlyMeaningful=true' : 'onlyMeaningful=false');
        dbg(`before-llm-messages: key=${key} ids=[${ids.join(',')}] msgs=${Array.isArray(ctx.messages) ? ctx.messages.length : 'n/a'} state=${loadState() ? 'loaded' : 'MISSING'} ${which} -> chars=${text.length}${text ? ' INJECTED' : ''}`);
      }
      if (text) appendToLastUser(ctx.messages, text);
    } catch (error) {
      try { api.warn('好感度注入失败（已忽略）：' + (error?.message ?? error)); } catch { /* ignore */ }
    }
  }
};

// 便于自测/控制台/其它模块调用
export { injectFor, loadState, TIERS, TONE_MAP, tierIdOf };



