// 主动找聊 —— 按目标（单个群 / 单个私聊）主动找人聊天
//
// 背景：早期版本有"主动找聊"（plugins.proactiveChat，含 targets/per目标启停/间隔/
// 每日上限/安静时段/topics/styleHints），移植重构后只剩"冷场时主动找话题"
// （orchestrator 的 proactive：随机挑一个安静的群插句话），
// 单个群、私聊、定时任务这些定制能力整段丢了 —— 本插件把它捡回来。
//
// 配置：读取 skills.proactiveChat（旧版遗留的 plugins.proactiveChat 由
// src/config.js 的 migrateLegacySkills 自动搬过来，幂等且不覆盖新配置）。
//
// 行为（确定性插件，条件满足必发，不经过模型判断）：
//   1. 60s 一轮 tick。
//   2. 每个启用且到期的目标：到点 = 上次发送 + rand(minGapMin, maxGapMin)。
//   3. 遵守：总开关、该目标 enabled、安静时段（quietStart~quietEnd）、每日上限。
//   4. respectRecentReply：目标群里 recentReplySilenceMin 分钟内有新消息就推迟
//      （用 OneBot get_group_msg_history 查最后一条消息时间；查询失败按"无动静"放行）。
//   5. 文案：目标给了 topics/styleHints 时用 LLM 写一句口语开场白（短、不刷屏），
//      失败或无素材时退回模板。scheduledTasks 是每天固定 HH:MM 直发固定文本。
//   6. 发送一律走宿主注入的 ctx.sender（activate 上下文里的 sender），
//      出错只记日志绝不抛出，任何单点失败不影响其它目标。
//
// 状态：lastSent/每日计数持久化到 <DATA_DIR>/proactiveChat-state.json，
//       重启不丢、不重复轰炸。
//
// 安全姿态：默认全关（enable:false, targets 空）。发消息前双重校验 enable，
// 冷却与每日上限在任何路径下都强制执行 —— 宁可少发，绝不刷屏打扰。

import fs from 'node:fs';
import path from 'node:path';
import { chatCompletion } from '../../src/llm.js';
import { DATA_DIR } from '../../src/config.js';

let api = null;            // setup() 注入的 api（config/log/utils）
let sender = null;         // activate() 注入的宿主 sender
let onebot = null;         // activate() 注入（查群列表/历史消息）
let timer = null;
let state = { last: {}, dayCount: {}, lastAnyAt: 0 };
let statePath = '';
let groupCache = { list: null, at: 0 };   // auto 类型判定用，缓存 10 分钟

const TICK_MS = 60_000;
const MIN_GLOBAL_GAP_MS = 5 * 60_000;    // 任意两次主动之间至少隔 5 分钟（防连发感）
const MAX_OPEN_TOPICS = 5;
const MAX_TEXT_LEN = 120;

/* ── 配置读取（合并 manifest 默认值 + 旧版遗留，见 config.js 迁移）────────── */
function conf() {
  const c = (api ? api.config() : {}) || {};
  const num = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };
  const targets = Array.isArray(c.targets) ? c.targets.filter((t) => t && t.qq) : [];
  const tasks = Array.isArray(c.scheduledTasks) ? c.scheduledTasks.filter((t) => t && t.time && t.qq) : [];
  return {
    enable: c.enable === true || c.enabled === true,
    minGapMin: num(c.minGapMin, 60),
    maxGapMin: Math.max(num(c.maxGapMin, 180), num(c.minGapMin, 60)),
    dailyMax: num(c.dailyMax, 3),
    quietStart: num(c.quietStart, 23),
    quietEnd: num(c.quietEnd, 8),
    respectRecentReply: c.respectRecentReply === true,
    recentReplySilenceMin: num(c.recentReplySilenceMin, 30),
    probeProfile: c.probeProfile === true,
    probeQzone: c.probeQzone === true,
    syncMemory: c.syncMemory === true,
    autoConsolidate: c.autoConsolidate === true,
    targets,
    scheduledTasks: tasks
  };
}

/* ── 目标归一化 ─────────────────────────────────────────────────────────── */
function normalizeTarget(t) {
  const num = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };
  const minGap = Math.max(5, num(t.minGapMin, 60));
  const maxGap = Math.max(minGap, num(t.maxGapMin, 180));
  return {
    type: ['group', 'private'].includes(String(t.type || '')) ? String(t.type) : 'auto',
    qq: String(t.qq).trim(),
    name: String(t.name || '').trim(),
    enabled: t.enabled !== false,
    minGapMin: minGap,
    maxGapMin: maxGap,
    dailyMax: Math.max(1, num(t.dailyMax, 3)),
    quietStart: num(t.quietStart, 23),
    quietEnd: num(t.quietEnd, 8),
    topics: Array.isArray(t.topics) ? t.topics.filter((x) => typeof x === 'string' && x.trim()).slice(0, MAX_OPEN_TOPICS) : [],
    styleHints: String(t.styleHints || '').trim()
  };
}

async function resolveChatKey(t) {
  if (t.type !== 'auto' && t.type) return `${t.type}:${t.qq}`;
  // auto：群号在群列表里 → group，否则 private
  try {
    if (!groupCache.list || Date.now() - groupCache.at > 10 * 60_000) {
      const r = await onebot?.call?.('get_group_list', {});
      groupCache.list = Array.isArray(r?.data) ? r.data.map((g) => String(g.group_id)) : [];
      groupCache.at = Date.now();
    }
  } catch { /* 查询失败按私聊处理 */ }
  return groupCache.list.includes(t.qq) ? `group:${t.qq}` : `private:${t.qq}`;
}

/* ── 安静时段 / 每日上限 / 冷却 ────────────────────────────────────────── */
function inQuietHours(quietStart, quietEnd, now = new Date()) {
  const h = now.getHours();
  if (quietStart === quietEnd) return h === quietStart;          // 极端配置：整段 = 单小时
  if (quietStart < quietEnd) return h >= quietStart && h < quietEnd;
  return h >= quietStart || h < quietEnd;                        // 跨零点（如 23~8）
}

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/* ── 群内刚有动静判定（respectRecentReply）────────────────────────────── */
async function hadRecentActivity(chatKey, silenceMin) {
  if (chatKey.startsWith('private:')) return false;             // 私聊无历史接口，按无动静
  try {
    const r = await onebot?.call?.('get_group_msg_history', { group_id: chatKey.split(':')[1], limit: 1, message_seq: 0 });
    const list = Array.isArray(r?.data?.messages) ? r.data.messages : Array.isArray(r?.data) ? r.data : [];
    const last = list
      .filter((m) => m && Number(m.user_id) !== 0)
      .map((m) => Number(m.time || m.timestamp || 0))
      .find((ts) => ts > 0);
    if (!last) return false;
    return Date.now() / 1000 - last < silenceMin * 60;
  } catch { return false; }
}

/* ── 文案 ─────────────────────────────────────────────────────────────── */
async function composeOpener(t) {
  const hasMaterial = t.topics.length > 0 || t.styleHints;
  if (!hasMaterial) return '在吗？忙不忙～' + (t.name ? `（我是给你发这条的 QQ 助手，记得我嘛）` : '');
  try {
    const res = await chatCompletion({
      messages: [
        { role: 'system', content:
          '你是 QQ 上的一个陪聊助手，正在主动给熟人发一条极短的开场白。'
          + '要求：口语、自然、像真人随手发的；字数 ≤ 60；不用反问句堆砌；'
          + '不开场白以外的话题；不要出现"我"之外的第三人称设定。' },
        { role: 'user', content:
          `对方备注：${t.name || '（未知）'}\n`
          + (t.topics.length ? `想聊的话题：${t.topics.join('、')}\n` : '')
          + (t.styleHints ? `风格提示：${t.styleHints}` : '')
          + '\n请只输出开场白正文。' }
      ],
      temperature: 0.9,
      // 不传 overrides：走当前生效 API；返回值是 { message } 不是 choices[]
      maxTokens: 120
    });
    const text = String(res?.message?.content || res?.text || '')
      .replace(/^["'“”]|["'“”]$/g, '')
      .replace(/^(开场白|文案|打招呼)[:：]\s*/i, '')
      .trim();
    if (text) return text.slice(0, MAX_TEXT_LEN);
  } catch { /* LLM 失败回退模板 */ }
  return t.topics[0] ? `最近聊到「${t.topics[0]}」，你有空吗，想听听你的看法～` : '在吗？刚想到你，想随便聊聊～';
}

/* ── 发送 ─────────────────────────────────────────────────────────────── */
async function sendTo(chatKey, text, why) {
  if (!sender || !text) return;
  const now = Date.now();
  if (now - state.lastAnyAt < MIN_GLOBAL_GAP_MS) return;         // 全局防连发（兜底）
  state.lastAnyAt = now;
  try {
    await sender.sendTextBatch(chatKey, text);
    api?.log?.(`已主动找聊 ${chatKey}（${why}）: ${text.slice(0, 24)}`);
    return true;
  } catch (e) {
    api?.error?.(`发送失败 ${chatKey}: ${e?.message ?? e}`);
    state.lastAnyAt = 0;                                          // 失败不占用全局冷却
    return false;
  }
}

/* ── 状态持久化 ────────────────────────────────────────────────────────── */
function loadState() {
  try {
    statePath = path.join(DATA_DIR, 'proactiveChat-state.json');
    if (fs.existsSync(statePath)) {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state = { last: {}, dayCount: {}, lastAnyAt: 0, ...(raw || {}) };
    }
  } catch (e) { api?.warn?.(`状态读取失败（按全新处理）: ${e?.message ?? e}`); }
}

function saveState() {
  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) { /* 持久化失败不致命 */ }
}

/* ── 主循环 ───────────────────────────────────────────────────────────── */
async function tick() {
  const c = conf();
  if (!c.enable) return;
  if (!sender) return;
  const now = new Date();

  // 1) 目标列表：到点 + 准入检查
  for (const raw of c.targets) {
    const t = normalizeTarget(raw);
    if (!t.qq || !t.enabled) continue;
    if (inQuietHours(t.quietStart, t.quietEnd, now)) continue;
    const day = todayKey(now);
    if ((state.dayCount[`${t.qq}|${day}`] || 0) >= t.dailyMax) continue;

    const key = `${t.qq}`;
    const last = state.last[key] || 0;
    const gapMs = (Math.floor(Math.random() * (t.maxGapMin - t.minGapMin + 1)) + t.minGapMin) * 60_000;
    if (now.getTime() - last < gapMs) continue;

    if (c.respectRecentReply && await hadRecentActivity(await resolveChatKey(t), c.recentReplySilenceMin)) continue;

    const chatKey = await resolveChatKey(t);
    const text = await composeOpener(t);
    const ok = await sendTo(chatKey, text, '目标到点');
    if (ok && now.getTime() - last >= gapMs) {
      state.last[key] = now.getTime();
      state.dayCount[`${t.qq}|${day}`] = (state.dayCount[`${t.qq}|${day}`] || 0) + 1;
      saveState();
    }
    break;   // 每轮最多处理一个目标（配合 60s 轮询，天然不过密）
  }

  // 2) 定时任务：到点直发（固定文本，不走 LLM）
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  for (const task of c.scheduledTasks) {
    if (String(task.time) !== hhmm) continue;
    const day = todayKey(now);
    const taskKey = `${task.time}|${task.qq}|${day}`;
    if (state.last[taskKey]) continue;
    const chatKey = `${task.type === 'private' ? 'private' : 'group'}:${task.qq}`;
    const ok = await sendTo(chatKey, String(task.text || ''), '定时任务');
    if (ok) { state.last[taskKey] = now.getTime(); saveState(); }
  }
}

/* ── 生命周期 ─────────────────────────────────────────────────────────── */
export function setup(injected) {
  api = injected;
}

export function activate(ctx) {
  sender = ctx?.sender || null;
  onebot = ctx?.onebot || null;
  loadState();
  if (timer) return;
  const loop = () => {
    timer = setTimeout(loop, TICK_MS);
    try { tick().catch((e) => api?.error?.(`tick 异常: ${e?.message ?? e}`)); } catch (e) { /* tick 内部已兜底 */ }
  };
  timer = setTimeout(loop, 8_000);   // 首次 8s（避开启动高峰）
  api?.log?.('主动找聊已启动（60s 轮询；默认全关，配置里 enable 后才发消息）');
}

export function deactivate() {
  if (timer) clearTimeout(timer);
  timer = null;
  sender = null;
  onebot = null;
}