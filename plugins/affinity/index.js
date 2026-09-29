// affinity —— 好感度/熟悉度态度层（宿主 affinity.js 10 模块群 → V0.3.1 本地 JSON 轻版）
//
// 宿主来源：src/affinity.js + affinity-score/state/persona/ingest 等 10 模块（Mongo 后端）。
// 迁移策略：打分/档位/词表/防刷/P8 轮回/P6 响应画像全量照搬宿主实测参数（aff-schema.js），
//   存储改本地 JSON（无 Mongo 依赖，2s 落盘节流 + 失败只打日志不影响聊天，宿主纪律照搬）。
//
// 软依赖：
//   - 宿主 affinity 依赖 getCfg() 取 kbGrowth.admin.writeQq 作管理员名单 —— V0.3.1 由
//     settings.adminUsers 直接配（manifest 字段），缺了 L4「攻击管理员」规则不触发（宿主同款行为）。
//
// ⚠️ affinity.* 是自建能力名 —— 核心不认识。必须由 skills/feeling-skill 用 api.capability()
//   消费（防孤儿能力，见 plugin-development.md §5）。

import { DEFAULT_CONFIG, mergeConfig } from './lib/aff-schema.js';
import { TIERS, tierOf, tierIdOf, scoreFromRaw, responseProfileOf, rebirthPhrase } from './lib/aff-score.js';
import { AffinityStore } from './lib/aff-store.js';
import { applyInbound, materializeState as materializeOf } from './lib/aff-apply.js';
// 数据根目录：必须与正在运行的那份进程完全一致（多实例下插件自己拼会算错根目录，
// 表现是「实例 #2 的数据写进 #1 的目录」，两个机器人互相污染且极难发现）。
// 复用核心导出，唯一真源 —— 官方 conversation-memory 插件同款做法。
import { DATA_DIR } from '../../src/config.js';
import fs from 'node:fs';
import path from 'node:path';


let cfg = () => ({});
let api = null;
let store = null;
let dataDir = null;
let stateCache = null;
let stateCacheAt = 0;

/**
 * 本轮触发内容暂存（V0.3.1 契约：before-context 有 triggerEntries，before-llm-messages 没有）。
 * 在前者收集、后者消费，用完即删（官方 conversation-memory 同款模式）。
 */
const pendingTrigger = new Map();

export function setup(a) {
  api = a;
  cfg = a.config;
  api.log('affinity 已加载（好感度态度层，本地 JSON 存储；宿主实测参数照搬）');
}

export function available() {
  const c = mergeConfig(cfg());
  if (c.enabled === false) return { ok: false, reason: 'affinity.enabled=false' };
  return { ok: true, reason: '本地 JSON，开箱即用' };
}

export async function activate(ctx) {
  dataDir = path.join(DATA_DIR, 'affinity');   // 复用核心 DATA_DIR（多实例下唯一真源，见 config.js 注释）
  store = new AffinityStore({ dataDir });
  stateCache = null;
  api.log?.('affinity: 已激活（' + store.loadAll().length + ' 人，目录 ' + dataDir + '）');
}

export async function deactivate(ctx) {
  try { store?.close(); } catch {}
  store = null;
  stateCache = null;
  api.log?.('affinity: 已停用');
}

export function dispose() {
  try { store?.close(); } catch {}
  store = null;
}

function state() {
  if (!store) { store = new AffinityStore({ dataDir }); }
  return store;
}

const TIER_COLORS = ['#94a3b8', '#7cc4f2', '#4ade80', '#fbbf24', '#fb923c', '#f87171'];
const BUCKET_STEP = ['<30', '30-49', '50-69', '70-89', '90-99', '100'];

// ── 历史档案叠加：读取迁移快照 <dataDir>/affinity/state.json（可选）──────────
// 好感度档案：961 人（2026-09-10~09-23）由 tools/affinity-report.mjs 生成。
// 现网 live 存储只有运行期累积的记录（通常很少），图表直接画会很难看 ——
// 因此面板在有快照时**叠加**它：图表用历史档案，排行用现网 live（更真实）。快照缺失时自动降级。
let snapCache = null;
let snapCacheAt = 0;
function snapshotStats() {
  try {
    const f = path.join(DATA_DIR, 'affinity', 'state.json');
    const st = fs.statSync(f);
    if (snapCache && st.mtimeMs === snapCacheAt) return snapCache;
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const people = (raw && typeof raw.people === 'object') ? raw.people : {};
    const peopleCount = Object.keys(people).length;
    if (!peopleCount) { snapCache = null; return null; }
    const tierCount = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const buckets = { '<30': 0, '30-49': 0, '50-69': 0, '70-89': 0, '90-99': 0, '100': 0 };
    const top = [];
    for (const [personId, v] of Object.entries(people)) {
      const tid = Number(v.tierId ?? tierIdOf(v.score));
      if (tid in tierCount) tierCount[tid] += 1;
      const s = Number(v.score) || 0;
      if (s >= 100) buckets['100'] += 1;
      else if (s >= 90) buckets['90-99'] += 1;
      else if (s >= 70) buckets['70-89'] += 1;
      else if (s >= 50) buckets['50-69'] += 1;
      else if (s >= 30) buckets['30-49'] += 1;
      else buckets['<30'] += 1;
      top.push({ personId, name: String(v.name || ''), score: s, tierId: tid, talkDays: v.talkDays, msgs: v.msgs, atBot: v.atBot, lastTalk: v.lastTalk });
    }
    top.sort((a, b) => (b.score - a.score) || (b.msgs - a.msgs));
    snapCache = {
      mtime: st.mtimeMs,
      counts: raw.counts,
      eventDayRange: raw.eventDayRange,
      generatedAt: raw.generatedAt,
      peopleCount,
      tierCount,
      buckets,
      top: top.slice(0, 20),
    };
    return snapCache;
  } catch { snapCache = null; return null; }
}

/** 现网 live 记录：统一成面板行（materialize 出分数）。 */
function liveRows() {
  const c = mergeConfig(cfg());
  const all = state().loadAll();
  for (const s of all) materializeOf(s, c);
  return all.map((s) => ({
    personId: String(s.person_id ?? ''),
    score: Math.round(s.score ?? 55),
    tier: tierOf(s.score ?? 55, c),
    familiarity: s.familiarity ?? 0,
    rebirth: s.rebirth?.count ?? 0,
    lastTalkAt: s.last_talk_at || null,
    events: Array.isArray(s.events) ? s.events.length : 0,
  }));
}

/** 检索：QQ 前缀（纯数字）或昵称关键字（按「现网优先、档案兜底」排序）。 */
function searchPeople(q, limit = 50) {
  const kw = String(q ?? '').trim();
  const num = /^\d+$/.test(kw);
  const rows = [];
  for (const r of liveRows()) {
    if (!kw || (num ? r.personId.startsWith(kw) : true)) rows.push({ personId: r.personId, name: '', source: '现网', score: r.score, tierName: r.tier.name });
  }
  for (const d of snapshotStats()?.top ?? []) {
    if (!kw || (num ? d.personId.startsWith(kw) : String(d.name || '').includes(kw))) {
      rows.push({ personId: d.personId, name: d.name, source: '档案', score: d.score, tierName: TIERS[Number(d.tierId) ?? tierIdOf(d.score)]?.name || '熟客' });
    }
  }
  const seen = new Set();
  const uni = rows.filter((r) => (seen.has(r.personId) ? false : (seen.add(r.personId), true))).sort((a, b) => b.score - a.score);
  return uni.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

export const providers = {
  /**
   * 查询某人好感度（控制台/技能/提示词注入用）。
   * 入参：{ personId }
   * 返回：{ ok, personId, score, tier, tierName, familiarity, familiarityTier, rebirth, responseProfile }
   */
  'affinity.query': ({ personId }) => {
    const c = mergeConfig(cfg());
    const s = state().getState(personId);
    if (!materializeOf(s, c)) s.score = 55;
    const tier = tierOf(s.score ?? 55, c);
    const rp = responseProfileOf(s.score ?? 55, c);
    return {
      ok: true,
      personId: String(personId ?? ''),
      score: Math.round(s.score ?? 55),
      tier,
      familiarity: s.familiarity ?? 0,
      rebirth: s.rebirth ?? { count: 0 },
      responseProfile: rp,
    };
  },

  /**
   * 模型主动调 set_feeling 的落库入口（宿主 toolWrite 语义：默认关，需 settings.toolWrite=true）。
   * 入参：{ personId, delta, reason, evidenceMessageId? }
   * 返回：{ ok, score, error? }
   */
  'affinity.adjust': ({ personId, delta, reason }) => {
    const c = mergeConfig(cfg());
    if (!c.toolWrite) return { ok: false, error: '好感度写权限没开（默认关闭）。这是有意为之：先看它自己会不会乱调，再决定是否放开。' };
    const d = Number(delta);
    if (!Number.isFinite(d) || Math.abs(d) > 5) return { ok: false, error: '单次不得超过 ±5，reason 必填' };
    if (!String(reason ?? '').trim()) return { ok: false, error: 'reason 必填' };
    const s = state().getState(personId);
    s.rawToday = (s.rawToday || 0) + d;
    s.events = s.events || [];
    s.events.push({ ts: Date.now(), day: new Date().toISOString().slice(0, 10), kind: 'tool', delta: d, applied: true, reason: String(reason).slice(0, 60) });
    s.last_talk_at = new Date().toISOString();
    state().markDirty();
    materializeOf(s, c);
    return { ok: true, score: Math.round(s.score ?? 55) };
  },

  /**
   * 入站消息好感度变化（被核心在消息处理时调用，或技能触发）。
   * 宿主语义：词表反馈（零 token）+ 防刷限额 + 跨档写记忆标记。
   * 入参：{ personId, text, targetsAdmin?, confirmed?, chatKey? }
   * 返回：{ applied, delta, kind?, level?, reason? }
   */
  'affinity.inbound': ({ personId, text, targetsAdmin, confirmed, chatKey } = {}) => {
    const c = mergeConfig(cfg());
    if (c.enabled === false) return { applied: false, reason: '未启用' };
    // 注：即使不注入提示词，词表反馈仍记账（宿主：入站侧纯子串匹配，零 token）
    const s = state().getState(personId);
    const r = applyInbound(s, String(text ?? ''), { cfg: c, targetsAdmin, confirmed, chatKey });
    if (r.applied) state().markDirty();
    return r;
  },

  /**
   * 注入块（宿主 affinity-persona buildInjectBlock/buildGrudgeBlock 语义）：
   * 给提示词组装侧的「我对这人什么感觉」文案。
   * 入参：{ personId, chatKey }
   * 返回：{ block }（空串 = 不注入，宿主 injectOnlyWhenMeaningful 语义）
   */
  'affinity.inject': ({ personId }) => {
    const c = mergeConfig(cfg());
    if (c.enabled === false || c.inject === false) return { block: '' };
    const s = state().getState(personId);
    materializeOf(s, c);
    const tier = tierOf(s.score ?? 55, c);
    // 宿主：熟客档（默认行为）不注入，省 token；只有会改变行为时注入
    if (c.injectOnlyWhenMeaningful !== false && tier.id === 2) return { block: '' };
    const rp = responseProfileOf(s.score ?? 55, c);
    const grudge = tier.id >= 3 ? ['有点烦', '反感', '讨厌'][tier.id - 3] : null;
    let block = '';
    if (grudge) block += '（对 TA 当前态度：' + grudge + '）';
    block += ' 档位=' + tier.name + '（' + tier.id + '）· 响应档位=' + rp.responseTier + '（×' + rp.multiplier + '）';
    const rb = s.rebirth;
    if (rb && rb.count > 0) block += ' · 已轮回 ' + rb.count + ' 次（buff ×' + rb.buffMult + '）';
    return { block: block.trim(), tier: tier.name };
  },

  /**
   * P8 轮回（宿主 rebirth 语义）：好感归零重来。
   * 入参：{ personId, confirm? }
   * 返回：{ ok, count, phrase, error? }
   */
  'affinity.rebirth': ({ personId, confirm } = {}) => {
    const c = mergeConfig(cfg());
    const rb = c.rebirth || {};
    if (!rb.enabled) return { ok: false, error: '轮回未启用（settings.rebirth.enabled）' };
    if (confirm !== true) return { ok: false, error: '需 confirm=true（轮回是硬操作）' };
    const s = state().getState(personId);
    s.rawToday = 0;
    s.events = [];
    s.rebirth = s.rebirth || { count: 0, buffMult: 1, lastAt: null, pending: false };
    s.rebirth.count += 1;
    s.rebirth.buffMult = rb.buffMult || 1.5;
    s.rebirth.lastAt = new Date().toISOString();
    state().markDirty();
    materializeOf(s, c);
    return { ok: true, count: s.rebirth.count, phrase: rebirthPhrase(rb.phrasePool), score: Math.round(s.score ?? 55) };
  },

  /**
   * 控制台「扩展」面板的**写操作**入口（action. 前缀 = 核心 HTTP 放行的写白名单）。
   * op: 'adjust'  → { personId, delta, reason }   手动加减好感
   *     'rebirth' → { personId, confirm:true }    执行轮回（硬操作，必须显式确认）
   * 只是把已有能力按 op 分派，不新造逻辑 —— 控制台和模型走的是同一套实现。
   */
  'action.affinity': (args = {}) => {
    const op = String(args.op || '');
    if (op === 'adjust') return providers['affinity.adjust']({ personId: args.personId, delta: args.delta, reason: args.reason || '控制台手动调整' });
    if (op === 'rebirth') return providers['affinity.rebirth']({ personId: args.personId, confirm: args.confirm === true });
    if (op === 'query') return providers['affinity.query']({ personId: args.personId });
    return { ok: false, error: '未知操作 ' + op + '（支持 adjust / rebirth / query）' };
  },

  /**
   * 汇总统计（面板/控制台用）：现网人数、历史档案分布、TOP 榜。
   * api.capability('affinity.stats')。控制台是档位名唯一合法的出现位置，直接吐内部档位。
   */
  'affinity.stats': () => {
    const snap = snapshotStats();
    const live = liveRows();
    return {
      ok: true,
      live: live.length,
      snapshot: snap ? { people: snap.peopleCount, counts: snap.counts, eventDayRange: snap.eventDayRange } : null,
      liveTop: [...live].sort((a, b) => b.score - a.score).slice(0, 20),
      top: snap?.top ?? [],
    };
  },

  /**
   * 人员检索（面板搜索/控制台）：QQ 号前缀或昵称关键字，现网优先、档案兜底。
   * api.capability('affinity.people', { q, limit })。
   */
  'affinity.people': ({ q = '', limit = 50 } = {}) => {
    const rows = searchPeople(q, limit);
    return { ok: true, total: rows.length, rows };
  },

  /** 控制台「扩展」面板数据（只读）：历史档案图表 + 现网排行 + 搜索；actions = 写通道。 */
  'panel.affinity': (args = {}) => {
    const c = mergeConfig(cfg());
    const snap = snapshotStats();
    const live = liveRows();

    const summary = [
      { label: '历史档案', value: snap ? `${snap.peopleCount} 人` : '无' },
      { label: '现网记录', value: `${live.length} 人` },
      { label: '数据区间', value: snap && snap.eventDayRange ? `${snap.eventDayRange[0]} ~ ${snap.eventDayRange[1]}` : '-' },
      { label: '注入提示词', value: c.inject !== false ? '开' : '关' },
      { label: '成功注入档', value: c.inject === false ? '关' : (c.injectOnlyWhenMeaningful !== false ? '非常客档' : '全部') },
      { label: 'set_feeling 写权限', value: c.toolWrite ? '开' : '关' },
    ];

    const sections = [];
    if (snap) {
      sections.push({
        type: 'donut', title: `档位分布（历史档案 ${snap.peopleCount} 人）`,
        data: TIERS.map((t, i) => ({ label: t.name, value: snap.tierCount[t.id] ?? 0, color: TIER_COLORS[i] ?? '#9ca3af' })).filter((d) => d.value > 0),
      });
      sections.push({
        type: 'bars', title: '分数段分布（历史档案）',
        data: Object.entries(snap.buckets).map(([label, value], i) => ({
          label, value,
          color: `hsl(${120 - i * 21} 70% 55%)`,
        })),
      });
      if (snap.top.length) {
        sections.push({
          type: 'table', title: '历史档案 Top 20（按分数）',
          columns: ['#', '昵称', 'QQ', '分数', '档位', '发言/点名', '最近'],
          rows: snap.top.map((p, i) => [
            String(i + 1),
            p.name || '(无昵称)',
            p.personId,
            String(Math.round(p.score)),
            TIERS[Number(p.tierId) ?? tierIdOf(p.score)]?.name || '熟客',
            `${p.msgs ?? 0} / ${p.atBot ?? 0}`,
            p.lastTalk || '-',
          ]),
        });
      }
    }

    const liveSorted = [...live].sort((a, b) => (b.score - a.score) || (b.events - a.events));
    sections.push({
      type: 'table', title: '现网好感度排行（前 30）',
      columns: ['QQ', '分数', '档位', '熟悉度', '轮回', '事件', '最近'],
      rows: liveSorted.slice(0, 30).map((r) => [
        r.personId || '-',
        String(r.score),
        r.tier.name,
        String(r.familiarity ?? 0),
        String(r.rebirth ?? 0),
        String(r.events ?? 0),
        r.lastTalkAt ? new Date(r.lastTalkAt).toLocaleDateString('zh-CN') : '-',
      ]),
    });

    // 控制台搜索：命中用表格段呈现
    const q = String(args?.q ?? '').trim();
    if (q) {
      const found = searchPeople(q, 50);
      sections.push({
        type: 'table', title: `搜索「${q}」（显示前 ${found.length} 条，现网优先）`,
        columns: ['来源', '昵称', 'QQ', '分数', '档位'],
        rows: found.map((r) => [r.source, r.name || '-', r.personId, String(Math.round(r.score)), r.tierName]),
      });
    }

    return {
      title: '好感度',
      summary,
      sections,
      // 控制台交互（action.* = 核心 HTTP 放行的写白名单；具体实现在 action.affinity）
      actions: [
        {
          type: 'input', label: '调整好感', capability: 'action.affinity', args: { op: 'adjust' },
          fields: [{ name: 'personId', placeholder: 'QQ号' }, { name: 'delta', placeholder: '增减（正负）', value: '5' }],
          submit: '调整',
        },
        {
          type: 'input', label: '执行轮回', capability: 'action.affinity', args: { op: 'rebirth', confirm: true },
          fields: [{ name: 'personId', placeholder: 'QQ号' }], submit: '轮回',
          confirm: '轮回会清空该成员的好感记录并给一次正向增益，确定吗？',
        },
      ],
    };
  },
};
// ── hooks（V0.3.1 官方模式：before-context 收集 → before-llm-messages 注入 → after-response 结算）──
// 这三段是让好感度**真正生效**的接线：没有它们，provider 只是躺在注册表里没人调。
// 约束（plugin-development.md）：钩子 5s 内、不做网络/下载/模型调用、不发消息 —— 这里全是纯本地字符串与 JSON 操作。

/** 把片段并进 system 消息（原地改；官方 conversation-memory 同款写法）。 */
function appendToSystem(messages, text) {
  if (!Array.isArray(messages) || !text) return;
  const sys = messages.find((m) => m && m.role === 'system');
  if (sys && typeof sys.content === 'string') { sys.content += text; return; }
  if (sys && Array.isArray(sys.content)) { sys.content.push({ type: 'text', text }); return; }
  messages.unshift({ role: 'system', content: String(text).trim() });
}

export const hooks = {
  /** 收集本轮触发者与文本，供注入与词表反馈使用。 */
  'before-context'(ctx = {}) {
    try {
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      const texts = [];
      const people = [];
      for (const e of entries) {
        const t = String(e?.text ?? '').trim();
        if (t) texts.push(t);
        const uid = String(e?.senderId ?? '').trim();
        if (uid && !people.includes(uid)) people.push(uid);
      }
      pendingTrigger.set(String(ctx.sessionId || ctx.chatKey || ''), {
        triggerText: texts.join('\n').slice(0, 800),
        personIds: people,
        chatKey: ctx.chatKey,
      });
    } catch { /* 收集失败不影响主流程 */ }
  },

  /** 注入「我对这人什么感觉」+ 跑一遍入站词表反馈（零 token）。 */
  'before-llm-messages'(ctx = {}) {
    try {
      const c = mergeConfig(cfg());
      if (c.enabled === false) return;
      const key = String(ctx.sessionId || ctx.chatKey || '');
      const trig = pendingTrigger.get(key);
      pendingTrigger.delete(key);            // 用完即删，不用 Map 长期持有会话引用
      if (!trig) return;

      const personId = trig.personIds[0] || '';   // 本轮第一说话人（好感度按人算）
      if (!personId) return;

      // 1) 词表反馈（零 token，纯子串匹配）—— 入站即记账
      try {
        const s = state().getState(personId);
        const adminList = String(c.adminUsers ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        const r = applyInbound(s, trig.triggerText, {
          cfg: c,
          targetsAdmin: adminList.includes(personId),
          chatKey: trig.chatKey,
        });
        if (r.applied) state().markDirty();
      } catch { /* 记账失败不影响注入 */ }

      // 2) 注入（宿主 injectOnlyWhenMeaningful：熟客档不注入，省 token）
      if (c.inject === false) return;
      const s2 = state().getState(personId);
      materializeOf(s2, c);
      const tier = tierOf(s2.score ?? 55, c);
      if (c.injectOnlyWhenMeaningful !== false && tier.id === 2) return;
      const rp = responseProfileOf(s2.score ?? 55, c);
      let block = '\n\n【关系温度】' + tier.name + '（' + rp.responseTier + ' 档 · 响应 ×' + rp.multiplier + '）';
      const rb = s2.rebirth;
      if (rb && rb.count > 0) block += ' · 已轮回 ' + rb.count + ' 次';
      appendToSystem(ctx.messages, block);
    } catch { /* 注入失败不影响主流程 */ }
  },

  /** 结算（跨档写记忆等留待后续；这里只落盘）。 */
  'after-response'() {
    try { state().markDirty(); } catch {}
  },
};