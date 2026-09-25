// body-state —— 本体状态（21 格情绪 + 主干三维）确定性插件
//
// 按上传清单 §3.2 文字规格新建（宿主部署版无此实现，属"按规格造"非照搬）：
//   主干三维（精力/社交/心情）· 21 格情绪（独立半衰期指数衰减 + 唤醒权重）·
//   五条聚合视图（joy/hype/pride/irrit/blue）· 心情公式 · 情绪→行为概率 · 情绪→温度 ·
//   每日心情重置（凌晨 5 点情绪日）· 睡眠事件掷骰（按日期确定性）· 五通道（词表/自报/钩子/手动）。
//
// 设计：纯函数 + 本地 JSON 落盘（无外部依赖，2s 节流，失败只打日志不卡聊天）。
//
// ⚠️ bodystate.* 是自建能力名 —— 核心不认识。由 skills/emotion-skill（set_emotion/set_mood 工具）
//   用 api.capability() 消费，防孤儿能力（plugin-development.md §5）。

import { BodyStateStore, materializeEmotions, moodFromEmotions, wakeProbability, temperatureTune,
        aggregateViews, lexiconChannel, eventHookChannel, settleSession, dailyRebase } from './lib/bs-state.js';
import { mergeConfig, EMOTION_GRID } from './lib/bs-schema.js';
// 数据根目录：必须与正在运行的那份进程完全一致（多实例下插件自己拼会算错根目录，
// 表现是「实例 #2 的数据写进 #1 的目录」，两个机器人互相污染且极难发现）。
// 复用核心导出，唯一真源 —— 官方 conversation-memory 插件同款做法。
import { DATA_DIR } from '../../src/config.js';
import path from 'node:path';


let cfg = () => ({});
let api = null;
let store = null;
let dataDir = null;

/** 本轮触发内容暂存（before-context 有 triggerEntries，before-llm-messages 没有）。 */
const pendingTrigger = new Map();

export function setup(a) {
  api = a;
  cfg = a.config;
  api.log('body-state 已加载（21 格情绪 + 主干三维，本地 JSON；清单 §3.2 规格）');
}

export function available() {
  const c = cfg();
  if (c.enabled === false) return { ok: false, reason: 'body-state.enabled=false' };
  return { ok: true, reason: '本地 JSON，开箱即用' };
}

export function activate(ctx) {
  dataDir = path.join(DATA_DIR, 'body-state');
  store = new BodyStateStore({ dataDir });
  // 每日心情重置（启动时补算一次）
  const r = dailyRebase(store.getState(), cfg());
  if (r.changed) store.markDirty();
  api.log?.('body-state: 已激活（21 格，目录 ' + dataDir + '）');
}

export function deactivate(ctx) {
  try { store?.close(); } catch {}
  store = null;
}

export function dispose() {
  try { store?.close(); } catch {}
  store = null;
}

function st() {
  if (!store) store = new BodyStateStore({ dataDir });
  return store;
}

export const providers = {
  /**
   * 记录一种情绪（宿主 set_emotion 语义，五通道之「自报」）。
   * 入参：{ emotion: 'anger'|'joy'|..., value? }
   * 返回：{ ok, emotion, current, grid }
   */
  'bodystate.set-emotion': ({ emotion, value } = {}) => {
    const c = mergeConfig(cfg());
    const def = (EMOTION_GRID.find((e) => e.id === emotion));
    if (!def) return { ok: false, error: '未知情绪 ' + emotion + '（21 格：' + EMOTION_GRID.map((e) => e.id).join('/') + '）' };
    const s = st().getState();
    const cell = s.emotions[emotion] = { v: 0, set_at: Date.now() };
    // 自报通道：value 缺省 +20（明确表达），或给指定值
    cell.v = clampV(value != null ? Number(value) : 20, c);
    cell.set_at = Date.now();
    s.axes.mood = moodFromEmotions(materializeEmotions(s, c), c);
    st().markDirty();
    const emo = materializeEmotions(s, c);
    return { ok: true, emotion, name: def.name, current: emo[emotion], grid: emo };
  },

  /**
   * 更新本体状态（宿主 set_mood 语义：精力/社交/心情三维滑条，五通道之「手动」）。
   * 入参：{ energy?, social?, mood? }（0~1）
   * 返回：{ ok, axes }
   */
  'bodystate.set-axes': ({ energy, social, mood } = {}) => {
    const c = mergeConfig(cfg());
    const s = st().getState();
    s.axes = s.axes || { energy: 0.7, social: 0.6, mood: 0.5 };
    if (energy != null) s.axes.energy = clampV(energy, c);
    if (social != null) s.axes.social = clampV(social, c);
    if (mood != null) s.axes.mood = clampV(mood, c);
    st().markDirty();
    return { ok: true, axes: s.axes };
  },

  /**
   * 当前本体状态全貌（控制台/提示词注入用）。
   * 入参：{ chatKey? }
   * 返回：{ axes, emotions(衰减后), aggregates(五条), mood, wakeProbability, temperature, sleepNote }
   */
  'bodystate.status': ({ chatKey } = {}) => {
    const c = mergeConfig(cfg());
    const s = st().getState();
    const emo = materializeEmotions(s, c);
    const agg = aggregateViews(emo);
    return {
      ok: true,
      axes: s.axes,
      emotions: emo,
      aggregates: agg,
      mood: s.axes.mood,
      wakeProbability: wakeProbability(emo, s.axes, c),
      temperature: temperatureTune(emo, s.axes, c),
      sleepNote: s.sleepNote || null,
      sleepNet: s.sleepNet ?? 0,
      gridSize: EMOTION_GRID.length,
    };
  },

  /**
   * 词表通道（零 token）：入站消息命中情绪词 → 对应格子加值。
   * 宿主五通道之一。入参：{ text }
   * 返回：{ moves, ok }
   */
  'bodystate.lexicon': ({ text } = {}) => {
    const c = mergeConfig(cfg());
    const moves = lexiconChannel(String(text ?? ''));
    const s = st().getState();
    for (const [id, delta] of Object.entries(moves)) {
      s.emotions[id] = { v: clampV((s.emotions[id]?.v ?? 0) + delta, c), set_at: Date.now() };
    }
    if (Object.keys(moves).length) {
      s.axes.mood = moodFromEmotions(materializeEmotions(s, c), c);
      st().markDirty();
    }
    return { ok: true, moves };
  },

  /**
   * 事件钩子通道（宿主：生面孔首次发言 → 好奇 +10）。
   * 入参：{ event: 'new-face' }
   */
  'bodystate.event-hook': ({ event } = {}) => {
    const c = mergeConfig(cfg());
    const moves = eventHookChannel(event, st().getState());
    const s = st().getState();
    for (const [id, v] of Object.entries(moves)) {
      s.emotions[id] = { v: clampV((s.emotions[id]?.v ?? 0) + v, c), set_at: Date.now() };
    }
    if (Object.keys(moves).length) { st().markDirty(); }
    return { ok: true, moves };
  },

  /**
   * 发言结算（宿主 settleSession：精力/社交消耗 + 久置复原 + 心情重算）。
   * 入参：{ chatKey }
   */
  'bodystate.settle': ({ chatKey } = {}) => {
    const c = mergeConfig(cfg());
    const s = st().getState();
    settleSession(s, c);
    st().markDirty();
    return { ok: true, axes: s.axes };
  },

  /** 控制台「扩展」面板数据（只读）：三维 + 21 格情绪 + 五条聚合。 */
  /**
   * 控制台「扩展」面板的**写操作**入口（action. 前缀 = 核心 HTTP 放行的写白名单）。
   * op: 'set-axes'      → { energy?, social?, mood? }  三维滑条（0~1）
   *     'set-emotion'   → { emotion, value? }          21 格情绪（不给 value = 默认 +20）
   *     'settle'        → { }                          结算一次（扣精力/社交）
   *     'status'        → { }                          只读回读（配合滑条刷新）
   */
  'action.bodystate': (args = {}) => {
    const op = String(args.op || '');
    if (op === 'set-axes') return providers['bodystate.set-axes']({ energy: args.energy, social: args.social, mood: args.mood });
    if (op === 'set-emotion') return providers['bodystate.set-emotion']({ emotion: args.emotion, value: args.value });
    if (op === 'settle') return providers['bodystate.settle'](args);
    if (op === 'status') return providers['bodystate.status']({});
    return { ok: false, error: '未知操作 ' + op + '（支持 set-axes / set-emotion / settle / status）' };
  },

  'panel.bodystate': () => {
    const c = mergeConfig(cfg());
    const s = st().getState();
    const emo = materializeEmotions(s, c);
    const agg = aggregateViews(emo);
    const active = EMOTION_GRID
      .map((def) => ({ name: def.name, group: def.group, half: def.halfLifeMin, v: emo[def.id] ?? 0 }))
      .filter((x) => x.v > 0)
      .sort((a, b) => b.v - a.v);
    return {
      title: '本体状态',
      summary: [
        { label: '精力', value: Math.round((s.axes?.energy ?? 0.7) * 100) + '%' },
        { label: '社交', value: Math.round((s.axes?.social ?? 0.6) * 100) + '%' },
        { label: '心情', value: Math.round((s.axes?.mood ?? 0.5) * 100) + '%' },
        { label: '唤醒概率', value: String(wakeProbability(emo, s.axes, c)) },
        { label: '温度建议', value: String(temperatureTune(emo, s.axes, c)) },
        { label: '昨晚', value: s.sleepNote || '（未结算）' },
        { label: '注入提示词', value: c.inject === true ? '开' : '关（先观察）' },
      ],
      sections: [
        {
          type: 'table', title: '五条聚合视图',
          columns: ['视图', '强度'],
          rows: Object.entries(agg).map(([k, v]) => [k, Number(v).toFixed(1)]),
        },
        active.length ? {
          type: 'table', title: '活跃情绪格（' + active.length + '/21）',
          columns: ['情绪', '组', '半衰期(分)', '当前值'],
          rows: active.map((x) => [x.name, x.group, String(x.half), x.v.toFixed(1)]),
        } : { type: 'note', title: '所有情绪格都是 0', text: '还没有触发过情绪（词表通道会在群消息命中情绪词时自动加值）。' },
      ],
      // 控制台交互：三维滑条 + 情绪格按钮 + 结算（实现在 action.bodystate）
      actions: [
        { type: 'slider', label: '精力', capability: 'action.bodystate', args: { op: 'set-axes' }, field: 'energy', min: 0, max: 1, step: 0.05, value: Math.round((s.axes?.energy ?? 0.7) * 100) / 100 },
        { type: 'slider', label: '社交', capability: 'action.bodystate', args: { op: 'set-axes' }, field: 'social', min: 0, max: 1, step: 0.05, value: Math.round((s.axes?.social ?? 0.6) * 100) / 100 },
        { type: 'slider', label: '心情', capability: 'action.bodystate', args: { op: 'set-axes' }, field: 'mood', min: 0, max: 1, step: 0.05, value: Math.round((s.axes?.mood ?? 0.5) * 100) / 100 },
        { type: 'button', label: '结算一次（扣精力/社交）', capability: 'action.bodystate', args: { op: 'settle' }, confirm: '按当前状态结算一次（扣减精力与社交）？' },
      ],
    };
  },
};

function clampV(v, c) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  // 三维 0~1，格子 0~100 —— 按调用处语义：这里供 axes 用 0~1
  return Math.max(0, Math.min(1, n));
}

// settleSession 在 bs-state.js 里用了 this.state，修正为纯函数（传 state）
// ── hooks（让本体状态真正参与对话）──────────────────────────────────
// before-context 收集触发文本 → before-llm-messages 跑词表通道 + 注入状态 → after-response 结算精力/社交。
// 约束：纯本地字符串与 JSON 操作，5s 内完成，不做网络/模型调用、不发消息。

function appendToSystem(messages, text) {
  if (!Array.isArray(messages) || !text) return;
  const sys = messages.find((m) => m && m.role === 'system');
  if (sys && typeof sys.content === 'string') { sys.content += text; return; }
  if (sys && Array.isArray(sys.content)) { sys.content.push({ type: 'text', text }); return; }
  messages.unshift({ role: 'system', content: String(text).trim() });
}

export const hooks = {
  'before-context'(ctx = {}) {
    try {
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      const texts = [];
      for (const e of entries) {
        const t = String(e?.text ?? '').trim();
        if (t) texts.push(t);
      }
      pendingTrigger.set(String(ctx.sessionId || ctx.chatKey || ''), { triggerText: texts.join('\n').slice(0, 800) });
    } catch {}
  },

  'before-llm-messages'(ctx = {}) {
    try {
      const c = mergeConfig(cfg());
      if (c.enabled === false) return;
      const key = String(ctx.sessionId || ctx.chatKey || '');
      const trig = pendingTrigger.get(key);
      pendingTrigger.delete(key);

      // 1) 词表通道（零 token）：入站情绪词 → 格子加值 + 睡眠事件钩子
      if (trig?.triggerText) {
        const moves = lexiconChannel(trig.triggerText);
        const s = st().getState();
        for (const [id, delta] of Object.entries(moves)) {
          s.emotions[id] = { v: Math.min(c.emotionCap, (s.emotions[id]?.v ?? 0) + delta), set_at: Date.now() };
        }
        if (Object.keys(moves).length) {
          s.axes.mood = moodFromEmotions(materializeEmotions(s, c), c);
          st().markDirty();
        }
      }

      // 2) 注入（settings.inject 默认 false：先观察再开）
      if (c.inject !== true) return;
      const s2 = st().getState();
      const emo = materializeEmotions(s2, c);
      const agg = aggregateViews(emo);
      const top = Object.entries(emo).filter(([, v]) => v > 8).sort((a, b) => b[1] - a[1]).slice(0, 3);
      let block = '\n\n【当下状态】精力 ' + Math.round((s2.axes?.energy ?? 0.7) * 100) + '% · 社交 ' + Math.round((s2.axes?.social ?? 0.6) * 100) + '% · 心情 ' + Math.round((s2.axes?.mood ?? 0.5) * 100) + '%';
      if (top.length) block += '｜情绪：' + top.map(([k, v]) => {
        const def = EMOTION_GRID.find((e) => e.id === k);
        return (def?.name ?? k) + Math.round(v);
      }).join('、');
      if (s2.sleepNote) block += '｜昨晚' + s2.sleepNote;
      appendToSystem(ctx.messages, block);
    } catch {}
  },

  /** 结算：精力/社交消耗 + 久置复原。 */
  'after-response'() {
    try {
      const c = mergeConfig(cfg());
      if (c.enabled === false) return;
      settleSession(st().getState(), c);
      st().markDirty();
    } catch {}
  },
};
