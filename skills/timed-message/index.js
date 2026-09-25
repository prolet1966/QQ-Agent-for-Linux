// 定时消息 —— 到点把指定内容**原样**发到群里（不加任何前缀）。
//
// ── 和「日程表」插件的分工 ──────────────────────────────────────────────
//   日程表（skills/schedule）走核心提醒系统：到点发「⏰ 提醒：xxx」，
//   重启不丢、不用自己发，但文案被强制加前缀 —— 适合"提醒我去做某事"。
//   本插件反过来：**内容必须原样发出**（早安、公告、周报提醒这类），
//   所以不能用核心 reminders（它会加前缀），只能自己发。
//
// ── 自己发就得解决"谁来发" ──────────────────────────────────────────────
//   setup(api) 里没有 sender/onebot，activate() 拿到的是空对象 {}，
//   app.js 里的 sender 是局部变量、没挂到全局 —— 都拿不到。
//   唯一能拿到 sender 的地方是**工具 execute 的 ctx**。所以：
//     ① 第一次调用本插件任意工具时，把 ctx.sender 存到模块变量；
//     ② 顺手提供一个 media.download provider：它每条带链接的消息都会被调用，
//        入参里就有 sender —— 这是重启后"不用等人来用工具"就能自愈的通道。
//        我们只是偷看一眼 sender，然后返回 { skip: true } 把机会让给真正的
//        下载插件（media-links.js:82 见到 skip 就继续问下一个提供者）。
//     ③ 兜底：promptSections 发现"有到点未发的"，提示模型调 timed_msg_flush 补发。
//
// ── 关机期间错过的怎么办 ────────────────────────────────────────────────
//   重启后如果一条消息已经过期很久（默认超过 10 分钟），就**不补发**，
//   直接跳到下一次（重复）/标记作废（一次性）—— 否则凌晨三点重启会
//   突然把昨天一整天的"早安""晚报"全刷一遍。
//
// ── 数据 ────────────────────────────────────────────────────────────────
//   <DATA_DIR>/skills/timed-message/messages.json（复用核心 DATA_DIR，多实例安全）。
//
// ⚠️ 全程只读核心模块，不写任何已有文件。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

let cfg = () => ({});
let log = () => {};

const dataFile = () => path.join(DATA_DIR, 'skills', 'timed-message', 'messages.json');

/** 工具 ctx / provider 入参里才拿得到 sender，存下来给后台轮询用。 */
const captured = { sender: null };
/** 正在发送中的 id，防止模型并发调 flush 时同一条发两遍。 */
const inflight = new Set();
let timer = null;

// ── 时间解析（与 skills/schedule 同源，为保持插件自包含复制了一份） ───────

const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const WEEK = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 末: 6 };

export function normText(s) {
  return String(s ?? '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cnNum(s) {
  const t = String(s ?? '').trim();
  if (!t) return NaN;
  if (/^\d{1,2}$/.test(t)) return Number(t);
  if (t === '十') return 10;
  const tens = t.match(/^([二三四]?)十([一二三四五六七八九])?$/);
  if (tens) return (tens[1] ? CN[tens[1]] : 1) * 10 + (tens[2] ? CN[tens[2]] : 0);
  if (Object.prototype.hasOwnProperty.call(CN, t)) return CN[t];
  return NaN;
}

export function parseClock(text) {
  const t = normText(text);
  const iso = t.match(/(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[:：]\s*\d{2})?/);
  // 写了冒号就是 24 小时制：07:00 就是早上七点
  if (iso && Number(iso[1]) <= 23 && Number(iso[2]) <= 59) return { h: Number(iso[1]), m: Number(iso[2]), is24: true };
  const cn = t.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[点时]\s*(半|一刻|(\d{1,2}|[一二三四五六七八九十]{1,3})\s*分?)?/);
  if (cn) {
    const h = cnNum(cn[1]);
    if (Number.isFinite(h) && h <= 23) {
      let m = 0;
      if (cn[2] === '半') m = 30;
      else if (cn[2] === '一刻') m = 15;
      else if (cn[3]) m = cnNum(cn[3]);
      return { h, m: Number.isFinite(m) ? Math.min(59, m) : 0, is24: false };
    }
  }
  return null;
}

export function applyMeridian(h, m, text, policy = 'pm', is24 = false) {
  const t = normText(text);
  let hh = h;
  if (/凌晨|清晨|早上|早晨|上午/.test(t)) { if (hh === 12) hh = 0; }
  else if (/中午|晌午|正午/.test(t)) { if (hh < 12) hh = 12; }
  else if (/下午|傍晚|晚上|夜里|夜晚|半夜|今晚|明晚/.test(t)) { if (hh < 12) hh += 12; }
  else if (!is24 && policy === 'pm' && hh >= 1 && hh <= 7) hh += 12;
  return { h: Math.min(23, Math.max(0, hh)), m: Math.min(59, Math.max(0, m)) };
}

/** 只管小时/分钟偏移；按天偏移留给 parseDay，否则「3天后 09:00」会丢掉时刻。 */
export function parseOffset(text) {
  const t = normText(text);
  if (/(?:^|[^\d])半\s*个?\s*小时/.test(t)) return 30 * 60000;
  const h = t.match(/(\d{1,3}|[一二三四五六七八九十]{1,3})\s*(?:个小时|小时|钟头|h)\s*[后後]?/i);
  if (h) { const n = cnNum(h[1]); if (Number.isFinite(n)) return n * 3600000; }
  const mi = t.match(/(\d{1,3}|[一二三四五六七八九十]{1,3})\s*分钟\s*[后後]?/);
  if (mi) { const n = cnNum(mi[1]); if (Number.isFinite(n)) return n * 60000; }
  return 0;
}

export function parseDay(text, now = Date.now()) {
  const t = normText(text);
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const full = t.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/);
  if (full) { d.setFullYear(Number(full[1]), Number(full[2]) - 1, Number(full[3])); return { date: d, fromWeekday: false, next: false }; }
  const md = t.match(/(?:^|[^\d:])(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/);
  if (md) {
    const mo = Number(md[1]);
    const da = Number(md[2]);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      d.setMonth(mo - 1, da);
      if (d.getTime() < new Date(now).setHours(0, 0, 0, 0)) d.setFullYear(d.getFullYear() + 1);
      return { date: d, fromWeekday: false, next: false };
    }
  }
  if (/大后天/.test(t)) d.setDate(d.getDate() + 3);
  else if (/后天/.test(t)) d.setDate(d.getDate() + 2);
  else if (/明日|明天/.test(t)) d.setDate(d.getDate() + 1);
  else if (/今天|今日|今晚|今早|今夜|今晨/.test(t)) { /* 今天 */ }
  else {
    const rel = t.match(/(\d{1,3}|[一二三四五六七八九十]{1,3})\s*(?:天|日)\s*[后後]/);
    if (rel) { const n = cnNum(rel[1]); if (Number.isFinite(n)) { d.setDate(d.getDate() + n); return { date: d, fromWeekday: false, next: false }; } }
    const wm = t.match(/(下)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天末1-7])/);
    if (wm) {
      const target = /[1-7]/.test(wm[2]) ? Number(wm[2]) % 7 : WEEK[wm[2]];
      let diff = target - d.getDay();
      if (wm[1] === '下') diff += 7;
      if (diff < 0) diff += 7;
      d.setDate(d.getDate() + diff);
      return { date: d, fromWeekday: true, next: wm[1] === '下' };
    }
  }
  return { date: d, fromWeekday: false, next: false };
}

export function parseRepeat(text) {
  const t = normText(text);
  if (/每\s*个?\s*工作日|工作日|(?:周|星期)一到(?:周|星期)五/.test(t)) return { type: 'weekdays' };
  const wm = t.match(/每\s*(?:周|星期|礼拜)\s*([一二三四五六日天末1-7])/);
  if (wm) return { type: 'weekly', weekday: /[1-7]/.test(wm[1]) ? Number(wm[1]) % 7 : WEEK[wm[1]] };
  if (/每\s*(?:周|星期|礼拜)/.test(t)) return { type: 'weekly' };
  const mm = t.match(/每\s*(?:个?月|月)\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[号日]/);
  if (mm) { const day = cnNum(mm[1]); if (Number.isFinite(day)) return { type: 'monthly', day }; }
  const im = t.match(/每\s*隔?\s*(\d{1,3})\s*天/);
  if (im) return { type: 'interval', days: Math.max(1, Number(im[1])) };
  if (/每天|每日|天天/.test(t)) return { type: 'daily' };
  return null;
}

export function nextAfter(at, repeat) {
  const d = new Date(at);
  const type = repeat?.type;
  if (type === 'daily' || type === 'interval') {
    d.setDate(d.getDate() + Math.max(1, Number(repeat.days) || 1));
  } else if (type === 'weekly') {
    const target = Number.isFinite(repeat.weekday) ? repeat.weekday : d.getDay();
    d.setDate(d.getDate() + 1);
    let g = 0;
    while (d.getDay() !== target && g < 10) { d.setDate(d.getDate() + 1); g += 1; }
  } else if (type === 'weekdays') {
    d.setDate(d.getDate() + 1);
    let g = 0;
    while ((d.getDay() === 0 || d.getDay() === 6) && g < 10) { d.setDate(d.getDate() + 1); g += 1; }
  } else if (type === 'monthly') {
    const day = Math.min(31, Math.max(1, Number(repeat.day) || d.getDate()));
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  } else {
    d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

/** 把起始时间对到重复规则上（「每月 5 号」句子里是没有日期的）。 */
export function alignFirst(at, repeat, now = Date.now()) {
  let t = Number(at);
  if (!Number.isFinite(t) || !repeat) return t;
  const d = new Date(t);
  if (repeat.type === 'weekly' && Number.isFinite(repeat.weekday)) {
    let g = 0;
    while (d.getDay() !== repeat.weekday && g < 10) { d.setDate(d.getDate() + 1); g += 1; }
    t = d.getTime();
  } else if (repeat.type === 'monthly' && Number.isFinite(repeat.day)) {
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(Math.max(1, repeat.day), last));
    t = d.getTime();
  } else if (repeat.type === 'weekdays') {
    let g = 0;
    while ((d.getDay() === 0 || d.getDay() === 6) && g < 10) { d.setDate(d.getDate() + 1); g += 1; }
    t = d.getTime();
  }
  let g = 0;
  while (t <= now && g < 500) { t = nextAfter(t, repeat); g += 1; }
  return t;
}

export function parseWhen(input, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const s = opts.settings ?? {};
  const t = normText(input);
  if (!t) return { ok: false, error: '没给时间' };

  const repeat = parseRepeat(t);
  const offset = parseOffset(t);
  if (offset > 0) return { ok: true, at: alignFirst(now + offset, repeat, now), repeat, past: false };

  const day = parseDay(t, now);
  const clock = parseClock(t);
  const hasDateWord = /(今天|今日|今晚|明天|明日|后天|大后天|\d{4}|周|星期|礼拜|天后|日後)/.test(t)
    || Boolean(t.match(/(?:^|[^\d:])(\d{1,2})\s*[-/.月]\s*(\d{1,2})/));
  const hasTimeWord = Boolean(clock) || /\d{1,2}\s*[:：]\s*\d{2}/.test(t)
    || /(上午|下午|早上|晚上|中午|凌晨|傍晚|夜里|点半|点整)/.test(t);
  if (!hasDateWord && !hasTimeWord) {
    return { ok: false, error: `没认出时间：${t}。可以写「明天上午九点」「9月24日 15:00」「每天 09:00」，或直接给 ISO 时间「2026-09-24T09:00:00」。` };
  }

  let h;
  let mi;
  if (clock) {
    const a = applyMeridian(clock.h, clock.m, t, s.ambiguousHour || 'pm', clock.is24);
    h = a.h;
    mi = a.m;
  } else {
    h = Number(s.defaultHour ?? 9);
    mi = Number(s.defaultMinute ?? 0);
  }
  const at0 = new Date(day.date);
  at0.setHours(h, mi, 0, 0);
  if (!Number.isFinite(at0.getTime())) return { ok: false, error: '算出来的时间不合法' };
  let at = at0.getTime();
  if (day.fromWeekday && !day.next && at <= now) at = new Date(at).setDate(new Date(at).getDate() + 7);
  if (!hasDateWord && s.rollToTomorrow !== false && at <= now) at = new Date(at).setDate(new Date(at).getDate() + 1);
  at = alignFirst(at, repeat, now);
  return { ok: true, at, repeat, past: at <= now };
}

export function formatAt(ms, now = Date.now()) {
  const d = new Date(ms);
  if (!Number.isFinite(ms)) return '时间未定';
  const base = `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day0 = new Date(now); day0.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - day0.getTime()) / 86400000);
  const rel = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : diff === -1 ? '昨天' : '';
  return rel ? `${base}（${rel}）` : base;
}

export function describeRepeat(repeat) {
  if (!repeat) return '';
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  switch (repeat.type) {
    case 'daily': return '每天';
    case 'weekdays': return '每个工作日';
    case 'weekly': return Number.isFinite(repeat.weekday) ? `每${names[repeat.weekday]}` : '每周';
    case 'monthly': return `每月 ${repeat.day} 号`;
    case 'interval': return `每隔 ${repeat.days} 天`;
    default: return '重复';
  }
}

// ── 存储 ──────────────────────────────────────────────────────────────────

export function loadData(file = dataFile()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && Array.isArray(raw.items)) return raw;
  } catch { /* 第一次用，没有文件很正常 */ }
  return { version: 1, items: [] };
}

export function saveData(data, file = dataFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 1)}\n`, 'utf8');
    return true;
  } catch (error) {
    log(`定时消息写入失败：${error?.message ?? error}`);
    return false;
  }
}

function newId() {
  return `tm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 这条消息的下一次发送时间。 */
export function dueOf(it) {
  return it?.repeat ? (it.nextAt || it.at) : it.at;
}

/** 推进到严格晚于 now 的那一次。 */
export function advancePast(t, repeat, now) {
  let x = Number(t);
  let g = 0;
  while (x <= now && g < 500) { x = nextAfter(x, repeat); g += 1; }
  return x;
}

// ── 发送 ──────────────────────────────────────────────────────────────────

/**
 * 把到点的消息发出去。核心逻辑，纯到可以直接测。
 * 成功才推进/标记完成；失败累计到 maxFails 就停用，避免无限重试。
 */
export async function flushDue(opts = {}) {
  const now = opts.now ?? Date.now();
  const s = opts.settings ?? cfg();
  const sender = opts.sender ?? captured.sender;
  const d = opts.data ?? loadData();
  if (!sender?.sendTextBatch) return { sent: 0, skipped: 0, failed: 0, reason: '拿不到发送通道（还没人用过本插件或群里还没出现过链接）' };

  const catchUp = Math.max(0, Number(s.catchUpMs) || 600000);
  const maxFails = Math.max(1, Number(s.maxFails) || 3);
  const items = d.items
    .filter((it) => it.enabled !== false && !it.done)
    .sort((a, b) => dueOf(a) - dueOf(b));
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let changed = false;

  for (const it of items) {
    const at = dueOf(it);
    if (!(at > 0) || now < at) continue;
    if (inflight.has(it.id)) continue;

    // 错过太久：不补发，直接推进/作废
    if (now - at > catchUp) {
      if (it.repeat) it.nextAt = advancePast(at, it.repeat, now);
      else it.done = true;
      skipped += 1;
      changed = true;
      continue;
    }

    inflight.add(it.id);
    try {
      await sender.sendTextBatch(it.chatKey, [it.content]);
      it.lastSentAt = now;
      it.sentCount = (it.sentCount ?? 0) + 1;
      it.fails = 0;
      sent += 1;
      changed = true;
      if (it.repeat) it.nextAt = advancePast(at, it.repeat, now);
      else it.done = true;
      log(`已发送定时消息：${it.chatKey} ${JSON.stringify(it.content).slice(0, 40)}`);
    } catch (error) {
      it.fails = (it.fails ?? 0) + 1;
      failed += 1;
      changed = true;
      if (it.fails >= maxFails) {
        it.enabled = false;
        log(`定时消息连续失败 ${it.fails} 次，已停用：${it.id}（${error?.message ?? error}）`);
      } else {
        log(`定时消息发送失败（第 ${it.fails} 次）：${error?.message ?? error}`);
      }
    } finally {
      inflight.delete(it.id);
    }
  }

  if (changed && !opts.data) saveData(d);
  return { sent, skipped, failed, reason: '' };
}

function startTicker() {
  if (timer || !captured.sender) return;              // 没有发送通道，起了也没用
  const ms = Math.max(5000, Number(cfg().tickMs) || 20000);
  timer = setInterval(() => {
    flushDue().catch((error) => log(`定时消息轮询出错：${error?.message ?? error}`));
  }, ms);
  timer.unref?.();
  const first = setTimeout(() => {
    flushDue().catch((error) => log(`定时消息轮询出错：${error?.message ?? error}`));
  }, 1500);
  first.unref?.();
  log(`定时消息轮询已启动：每 ${Math.round(ms / 1000)} 秒检查一次`);
}

function captureSender(sender) {
  if (!sender?.sendTextBatch) return false;
  captured.sender = sender;
  startTicker();
  return true;
}

/**
 * 借 media.download 通道偷看一眼 sender：每条带链接的消息核心都会调用它，
 * 入参里就有 sender —— 这是重启后不用等人来用工具就能自愈的通道。
 * 返回 skip 表示"不是我的活"，真正的下载插件照常接手（media-links.js:82）。
 */
export const providers = {
  'media.download': async ({ sender, kind, chatId } = {}) => {
    try {
      if (sender) captureSender(sender);
      if (kind && chatId) { /* 只是备用，当前用不上 */ }
    } catch { /* 偷看失败无所谓，不影响别人下载 */ }
    return { skip: true };
  }
};

// ── 工具用到的查询 ────────────────────────────────────────────────────────

export function findItem(items, query) {
  const q = String(query ?? '').trim();
  if (!q) return { match: null, candidates: [] };
  const alive = items.filter((it) => !it.done && it.enabled !== false);
  const exact = alive.find((it) => it.id === q || it.id.endsWith(q));
  if (exact) return { match: exact, candidates: [exact] };
  const idx = Number(q);
  if (Number.isFinite(idx) && idx >= 1 && idx <= alive.length) {
    const sorted = [...alive].sort((a, b) => dueOf(a) - dueOf(b));
    return { match: sorted[idx - 1], candidates: [sorted[idx - 1]] };
  }
  const hits = alive.filter((it) => String(it.content ?? '').includes(q));
  if (hits.length === 1) return { match: hits[0], candidates: hits };
  return { match: null, candidates: hits };
}

export function renderList(items, now = Date.now()) {
  if (!items.length) return '当前没有定时消息。';
  return items.map((it, i) => {
    const when = formatAt(dueOf(it), now);
    const rep = describeRepeat(it.repeat);
    const content = String(it.content ?? '').replace(/\s+/g, ' ').trim();
    const preview = content.length > 30 ? `${content.slice(0, 30)}…` : content;
    return `${i + 1}. ${when}${rep ? ` · ${rep}` : ''}${it.sentCount ? ` · 已发${it.sentCount}次` : ''} — ${preview}  [${it.id}]`;
  }).join('\n');
}

/** "123456" → "group:123456"；已经带冒号就原样用。 */
export function resolveChatKey(target, fallback = '') {
  const t = String(target ?? '').trim();
  if (!t) return fallback;
  if (t.includes(':')) return t;
  if (/^\d+$/.test(t)) return `group:${t}`;
  return t;
}

// ── Skill 生命周期 ────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;

  api.registerTool({
    id: 'timed_msg_add',
    name: '添加定时消息',
    description: '存一段话，到指定时间由机器人原样发到群里（内容不加任何前缀）。支持重复：每天九点发早安、每周五下午五点发周报提醒、每月 1 号发公告。',
    category: 'utility',
    icon: '⏲️',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '到点要发的原文。说发什么就发什么，不会加前缀。可以多行。' },
        at: { type: 'string', description: '时间。中文或 ISO 都行：明天上午九点 / 9月24日 15:00 / 每天 09:00 / 每周五 17:00 / 2026-09-24T09:00:00' },
        repeat: { type: 'string', description: '可省略。at 里已经写了「每天」「每周五」就不用填；单独填时写 daily / weekly / monthly / weekdays' },
        target: { type: 'string', description: '可省略。默认发到当前群。要发到别的群就填群号或 group:群号' }
      },
      required: ['content', 'at']
    },
    async execute(ctx, args) {
      try {
        captureSender(ctx?.sender);
        const s = cfg();
        const content = String(args?.content ?? '').trim();
        if (!content) return { content: '得先说要发什么内容。', isError: true };

        const parsed = parseWhen(String(args?.at ?? '').trim(), { now: Date.now(), settings: s });
        if (!parsed.ok) return { content: parsed.error, isError: true };
        let repeat = parsed.repeat;
        if (!repeat && args?.repeat) {
          repeat = /^weekly$/i.test(String(args.repeat)) ? { type: 'weekly' } : { type: String(args.repeat).toLowerCase() };
        }

        const item = {
          id: newId(),
          content,
          chatKey: resolveChatKey(args?.target, ctx.chatKey),
          at: parsed.at,
          repeat: repeat ?? null,
          nextAt: parsed.at,
          createdAt: Date.now(),
          createdBy: String(ctx.selfId ?? ''),
          sentCount: 0,
          lastSentAt: 0,
          fails: 0,
          enabled: true
        };
        const data = loadData();
        data.items.push(item);
        saveData(data);

        const when = formatAt(item.at);
        const rep = describeRepeat(item.repeat);
        log(`新增定时消息：${when}${rep ? ` [${rep}]` : ''} → ${item.chatKey}`);
        return { content: `已设定：${when}${rep ? `，${rep}` : ''} 发到 ${item.chatKey}\n内容：${content.replace(/\n/g, '\\n')}\n编号 ${item.id}。到点我会原样发出，不用你再提醒。` };
      } catch (error) {
        return { content: `添加定时消息失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'timed_msg_list',
    name: '查看定时消息',
    description: '列出已经设定的定时消息。默认只看还没发的，也可以看全部。',
    category: 'utility',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'future=还没发的（默认）／all=全部（含已发过的一次性）' }
      }
    },
    async execute(ctx, args) {
      try {
        captureSender(ctx?.sender);
        const s = cfg();
        const scope = String(args?.scope ?? 'future').toLowerCase();
        const now = Date.now();
        let items = loadData().items.filter((it) => it.enabled !== false);
        if (scope !== 'all') items = items.filter((it) => !it.done);
        items = items.sort((a, b) => dueOf(a) - dueOf(b)).slice(0, Math.max(1, Number(s.listLimit) || 20));
        return { content: renderList(items, now) };
      } catch (error) {
        return { content: `查看定时消息失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'timed_msg_del',
    name: '删除定时消息',
    description: '删掉一条定时消息。可以按编号删，也可以按内容关键词删。',
    category: 'utility',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '编号（如 tm_ab12x）、内容关键词，或列表里的序号（1/2/3）' }
      },
      required: ['query']
    },
    async execute(ctx, args) {
      try {
        captureSender(ctx?.sender);
        const data = loadData();
        const { match, candidates } = findItem(data.items, args?.query);
        if (!match) {
          if (candidates.length > 1) {
            return { content: `有 ${candidates.length} 条都匹配「${args?.query}」，说清楚删哪条：\n${renderList(candidates)}`, isError: true };
          }
          return { content: `没找到匹配「${args?.query}」的定时消息。可以用 timed_msg_list 先看看有哪些。`, isError: true };
        }
        data.items = data.items.filter((it) => it.id !== match.id);
        saveData(data);
        log(`删除定时消息：${match.id}`);
        return { content: `已删除：${formatAt(dueOf(match))} 的那条（${String(match.content).replace(/\s+/g, ' ').slice(0, 30)}）。` };
      } catch (error) {
        return { content: `删除定时消息失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'timed_msg_flush',
    name: '补发到点的定时消息',
    description: '检查有没有已经到点但还没发出去的定时消息（多半是机器人重启期间错过的），有就立刻补发。系统提示出现「有 N 条定时消息已到点」时必须调用。',
    category: 'utility',
    icon: '📤',
    parameters: { type: 'object', properties: {} },
    async execute(ctx, args) {
      try {
        captureSender(ctx?.sender);
        const r = await flushDue({ sender: ctx?.sender, now: Date.now(), settings: cfg() });
        if (r.reason) return { content: `暂时发不出去：${r.reason}。稍后再试或等机器人被消息唤醒。`, isError: true };
        if (!r.sent && !r.skipped && !r.failed) return { content: '没有到点未发的定时消息。' };
        const bits = [];
        if (r.sent) bits.push(`补发 ${r.sent} 条`);
        if (r.skipped) bits.push(`跳过 ${r.skipped} 条（错过太久）`);
        if (r.failed) bits.push(`${r.failed} 条发送失败`);
        return { content: `${bits.join('，')}。` };
      } catch (error) {
        return { content: `补发失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

/** 有到点未发的就提醒模型去补发 —— 这是重启后除链接通道外的另一条自愈路径。 */
export function promptSections(ctx) {
  try {
    const now = Date.now();
    const items = loadData().items.filter((it) => it.enabled !== false && !it.done && dueOf(it) <= now + 60000);
    if (!items.length) return [];
    const inHere = ctx?.chatKey ? items.filter((it) => it.chatKey === ctx.chatKey) : [];
    const list = inHere.length ? inHere : items;
    return [{
      id: 'timed-message-pending',
      title: '定时消息',
      priority: 46,
      content: `有 ${list.length} 条定时消息已经到点但还没发出（通常是机器人重启期间错过的）。请立即调用 timed_msg_flush 工具补发，不要自己复述或改写内容。`
    }];
  } catch {
    return [];
  }
}

/** 热重载失败时核心会补一次 activate（plugin-loader.js:375），把轮询接回去。 */
export function activate() {
  if (!timer && captured.sender) startTicker();
}

export function deactivate() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function available() { return true; }

export const internals = {
  normText, cnNum, parseClock, applyMeridian, parseOffset, parseDay, parseRepeat,
  nextAfter, alignFirst, parseWhen, formatAt, describeRepeat, loadData, saveData,
  dueOf, advancePast, flushDue, findItem, renderList, resolveChatKey, dataFile,
  captured, inflight
};
