// 日程表 —— 自己添加日程，到点自动在群里提醒。
//
// ── "到时间自动提醒"是怎么做到的 ───────────────────────────────────────
//   核心里已经有一套提醒调度器（src/reminders.js + Orchestrator.startReminderLoop）：
//     ctx.reminders.add({ chatKey, text, dueAt })  → 落盘 data/reminders.json
//     → 每 20 秒扫一次到点的 → sender.sendTextBatch 发到原会话 → 成功后才标记完成
//   好处：进程重启不丢、发送失败下一轮自动重试、和机器人发言共享限频/去重/切分。
//   所以本插件**一行定时器都不用写**就能到点推送 —— 添加日程时顺手往核心塞一条。
//
//   唯一需要自己轮询的是**重复日程**：核心的提醒是一次性的，触发完就没了，
//   而且没有任何回调通知"我刚发过了"。所以本插件起一个 30 秒的 tick 负责
//   "把重复日程推进到下一次，并给下一次再塞一条核心提醒"。
//   注意：这个 tick 只做推进，**不自己发消息**，发送始终由核心完成 ——
//   这样就不会出现"核心发一遍、我又发一遍"的双份提醒。
//   就算 tick 没起来（比如刚重启还没人用过日程），核心里那条提醒照样会准时发，
//   只是不会自动续上下一次而已，属于优雅降级。
//
// ── 时间怎么解析 ────────────────────────────────────────────────────────
//   交给模型算时间戳不靠谱（它不知道现在几点、也容易算错时区），
//   所以本插件自己解析中文时间：明天/后天/下周三/9月24日/下午三点半/2026-09-24 15:00。
//   解析不了就明确报错，让模型改传 ISO。
//
// ── 数据 ────────────────────────────────────────────────────────────────
//   <DATA_DIR>/skills/schedule/schedules.json（多实例安全，DATA_DIR 复用核心导出）。
//
// ⚠️ 全程只读核心模块，不写任何已有文件。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

let cfg = () => ({});
let log = () => {};

const dataFile = () => path.join(DATA_DIR, 'skills', 'schedule', 'schedules.json');

/** 工具 ctx 里才拿得到的东西，第一次调用工具时存下来给后台轮询用。 */
const captured = { reminders: null, sender: null, chatKey: '' };
let timer = null;

// ── 时间解析（纯函数） ────────────────────────────────────────────────────

const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const WEEK = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 末: 6 };

/** 全角转半角 + 压空格。 */
export function normText(s) {
  return String(s ?? '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 中文数字 → 阿拉伯数字（够用范围：1-39，覆盖小时/分钟/日期）。 */
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

/** 从文本里抠出"几点几分"。认 15:00、三点半、下午3点20、十点。 */
export function parseClock(text) {
  const t = normText(text);
  const iso = t.match(/(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[:：]\s*\d{2})?/);
  if (iso) {
    const h = Number(iso[1]);
    const m = Number(iso[2]);
    // 写了冒号就是 24 小时制：07:00 就是早上七点，不能再按"三点=下午"那套加成 19:00
    if (h <= 23 && m <= 59) return { h, m, is24: true };
  }
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

/**
 * 处理上午/下午这类修饰语，以及"三点"这种没说明上午下午的。
 * is24（写成 07:00 这种）时不做"小数字算下午"的猜测。
 */
export function applyMeridian(h, m, text, policy = 'pm', is24 = false) {
  const t = normText(text);
  let hh = h;
  if (/凌晨|清晨|早上|早晨|上午/.test(t)) {
    if (hh === 12) hh = 0;
  } else if (/中午|晌午|正午/.test(t)) {
    if (hh < 12) hh = 12;
  } else if (/下午|傍晚|晚上|夜里|夜晚|半夜|今晚|明晚/.test(t)) {
    if (hh < 12) hh += 12;
  } else if (!is24 && policy === 'pm' && hh >= 1 && hh <= 7) {
    hh += 12;                                       // "三点开会" 默认按下午三点
  }
  return { h: Math.min(23, Math.max(0, hh)), m: Math.min(59, Math.max(0, m)) };
}

/**
 * "3小时后""半小时后""10分钟后" → 毫秒偏移；认不出来返回 0。
 * 只管小时/分钟：按天偏移要留给 parseDay，否则「3天后 09:00」里的 09:00 会被吃掉。
 */
export function parseOffset(text) {
  const t = normText(text);
  if (/(?:^|[^\d])半\s*个?\s*小时/.test(t)) return 30 * 60000;
  const h = t.match(/(\d{1,3}|[一二三四五六七八九十]{1,3})\s*(?:个小时|小时|钟头|h)\s*[后後]?/i);
  if (h) {
    const n = cnNum(h[1]);
    if (Number.isFinite(n)) return n * 3600000;
  }
  const mi = t.match(/(\d{1,3}|[一二三四五六七八九十]{1,3})\s*分钟\s*[后後]?/);
  if (mi) {
    const n = cnNum(mi[1]);
    if (Number.isFinite(n)) return n * 60000;
  }
  return 0;
}

/**
 * 抠出日期。返回 { date(当天 00:00), fromWeekday, next }。
 * fromWeekday=来自"周三"这类说法；next=带"下"字（下周三）。
 * 认 明天/后天/下周三/9月24日/2026-09-24。
 */
export function parseDay(text, now = Date.now()) {
  const t = normText(text);
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const none = { date: d, fromWeekday: false, next: false };

  const full = t.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/);
  if (full) {
    d.setFullYear(Number(full[1]), Number(full[2]) - 1, Number(full[3]));
    return { date: d, fromWeekday: false, next: false };
  }
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
  else if (/今天|今日|今晚|今早|今夜|今晨/.test(t)) { /* 就是今天 */ }
  else {
    const rel = t.match(/(\d{1,3}|[一二三四五六七八九十]{1,3})\s*(?:天|日)\s*[后後]/);
    if (rel) {
      const n = cnNum(rel[1]);
      if (Number.isFinite(n)) { d.setDate(d.getDate() + n); return { date: d, fromWeekday: false, next: false }; }
    }
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
  return none;
}

/** 认重复规则：每天 / 每个工作日 / 每周一 / 每月 5 号 / 每隔 3 天。 */
export function parseRepeat(text) {
  const t = normText(text);
  if (/每\s*个?\s*工作日|工作日|(?:周|星期)一到(?:周|星期)五/.test(t)) return { type: 'weekdays' };
  const wm = t.match(/每\s*(?:周|星期|礼拜)\s*([一二三四五六日天末1-7])/);
  if (wm) return { type: 'weekly', weekday: /[1-7]/.test(wm[1]) ? Number(wm[1]) % 7 : WEEK[wm[1]] };
  if (/每\s*(?:周|星期|礼拜)/.test(t)) return { type: 'weekly' };        // 星期几由起始日期决定
  const mm = t.match(/每\s*(?:个?月|月)\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[号日]/);
  if (mm) {
    const day = cnNum(mm[1]);
    if (Number.isFinite(day)) return { type: 'monthly', day };
  }
  const im = t.match(/每\s*隔?\s*(\d{1,3})\s*天/);
  if (im) return { type: 'interval', days: Math.max(1, Number(im[1])) };
  if (/每天|每日|天天/.test(t)) return { type: 'daily' };
  return null;
}

/** 由某次发生时间推出下一次。 */
export function nextAfter(at, repeat, now = Date.now()) {
  const d = new Date(at);
  const type = repeat?.type;
  if (type === 'daily' || type === 'interval') {
    d.setDate(d.getDate() + Math.max(1, Number(repeat.days) || 1));
  } else if (type === 'weekly') {
    const target = Number.isFinite(repeat.weekday) ? repeat.weekday : d.getDay();
    d.setDate(d.getDate() + 1);
    let guard = 0;
    while (d.getDay() !== target && guard < 10) { d.setDate(d.getDate() + 1); guard += 1; }
  } else if (type === 'weekdays') {
    d.setDate(d.getDate() + 1);
    let guard = 0;
    while ((d.getDay() === 0 || d.getDay() === 6) && guard < 10) { d.setDate(d.getDate() + 1); guard += 1; }
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

/**
 * 把起始时间对到重复规则上，并保证它落在未来。
 * 「每月 5 号 10:00」光看时间是看不出 5 号在哪的（句子里没有日期），
 * 得按规则对齐；对齐后要是已经过去了，就顺推到下一次。
 */
export function alignFirst(at, repeat, now = Date.now()) {
  let t = Number(at);
  if (!Number.isFinite(t) || !repeat) return t;
  const d = new Date(t);
  if (repeat.type === 'weekly' && Number.isFinite(repeat.weekday)) {
    let guard = 0;
    while (d.getDay() !== repeat.weekday && guard < 10) { d.setDate(d.getDate() + 1); guard += 1; }
    t = d.getTime();
  } else if (repeat.type === 'monthly' && Number.isFinite(repeat.day)) {
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(Math.max(1, repeat.day), last));
    t = d.getTime();
  } else if (repeat.type === 'weekdays') {
    let guard = 0;
    while ((d.getDay() === 0 || d.getDay() === 6) && guard < 10) { d.setDate(d.getDate() + 1); guard += 1; }
    t = d.getTime();
  }
  let guard = 0;
  while (t <= now && guard < 500) { t = nextAfter(t, repeat, now); guard += 1; }
  return t;
}

/** 总入口：一句话 → 时间戳 + 重复规则。 */
export function parseWhen(input, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const s = opts.settings ?? {};
  const t = normText(input);
  if (!t) return { ok: false, error: '没给时间' };

  const repeat = parseRepeat(t);

  // ① "3小时后""10分钟后""3天后" 这类直接是偏移量
  const offset = parseOffset(t);
  if (offset > 0) {
    const at = alignFirst(now + offset, repeat, now);
    return { ok: true, at, repeat, hasClock: true, past: false, offset };
  }

  // ② 日期 + 时刻
  const day = parseDay(t, now);
  const clock = parseClock(t);
  const hasDateWord = /(今天|今日|今晚|明天|明日|后天|大后天|\d{4}|周|星期|礼拜|天后|日後)/.test(t)
    || Boolean(t.match(/(?:^|[^\d:])(\d{1,2})\s*[-/.月]\s*(\d{1,2})/));
  const hasTimeWord = Boolean(clock)
    || /\d{1,2}\s*[:：]\s*\d{2}/.test(t)
    || /(上午|下午|早上|晚上|中午|凌晨|傍晚|夜里|点半|点整)/.test(t);

  if (!hasDateWord && !hasTimeWord) {
    return { ok: false, error: `没认出时间：${t}。可以写「明天下午三点」「9月24日 15:00」「每周一 09:30」这类，或直接给 ISO 时间「2026-09-24T15:00:00」。` };
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

  // ③ "周三 09:00" 而今天就是周三且 09:00 已过 → 按下周三算
  if (day.fromWeekday && !day.next && at <= now) at = new Date(at).setDate(new Date(at).getDate() + 7);

  // ④ "三点开会"而今天三点已过 → 明天三点
  if (!hasDateWord && s.rollToTomorrow !== false && at <= now) {
    at = new Date(at).setDate(new Date(at).getDate() + 1);
  }

  // ⑤ 对到重复规则上（每月 5 号 / 每周一 这类）
  at = alignFirst(at, repeat, now);

  return { ok: true, at, repeat, hasClock: Boolean(clock), past: at <= now };
}

/** 人类可读时间：9月24日 15:00（明天）。 */
export function formatAt(ms, now = Date.now()) {
  const d = new Date(ms);
  if (!Number.isFinite(ms)) return '时间未定';
  const date = `${d.getMonth() + 1}月${d.getDate()}日`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const base = `${date} ${time}`;
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

/** 提醒文案：核心会在前面加「⏰ 提醒：」。 */
export function renderReminderText(item, tpl = '{title}{note}') {
  const note = item?.note ? `（${item.note}）` : '';
  return String(tpl ?? '{title}{note}')
    .replace(/\{title\}/g, item?.title ?? '')
    .replace(/\{note\}/g, note)
    .replace(/\{time\}/g, formatAt(item?.repeat ? item.nextAt ?? item.at : item.at));
}

// ── 存储 ──────────────────────────────────────────────────────────────────

export function loadData(file = dataFile()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && Array.isArray(raw.items)) return raw;
  } catch {
    /* 第一次用，没有文件很正常 */
  }
  return { version: 1, items: [] };
}

export function saveData(data, file = dataFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 1)}\n`, 'utf8');
    return true;
  } catch (error) {
    log(`日程写入失败：${error?.message ?? error}`);
    return false;
  }
}

function newId() {
  return `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 往核心提醒系统塞一条（真正负责"到点发消息"的是它）。 */
export function seedReminder(reminders, item, settings = cfg()) {
  if (!reminders?.add || !item?.chatKey) return '';
  try {
    const entry = reminders.add({
      chatKey: item.chatKey,
      text: renderReminderText(item, settings.reminderText),
      dueAt: item.repeat ? (item.nextAt || item.at) : item.at,
      createdBy: String(item.createdBy ?? '')
    });
    return entry?.id ?? '';
  } catch (error) {
    log(`写入核心提醒失败：${error?.message ?? error}`);
    return '';
  }
}

// ── 后台轮询：只推进重复日程，不自己发消息 ────────────────────────────────

/**
 * 一轮检查。核心提醒系统可用时只做"把重复日程推进到下一次并补一条提醒"；
 * 拿不到核心提醒系统（老版本/被裁掉）时才自己用 sender 发，保证功能不塌。
 */
export async function tick(opts = {}) {
  const now = opts.now ?? Date.now();
  const s = opts.settings ?? cfg();
  const reminders = opts.reminders ?? captured.reminders;
  const sender = opts.sender ?? captured.sender;
  const data = opts.data ?? loadData();
  const stale = Math.max(0, Number(s.staleMs) || 7200000);
  const keepMs = Math.max(0, Number(s.keepDays) || 30) * 86400000;
  let changed = false;
  let advanced = 0;
  let sent = 0;
  let pruned = 0;

  for (const it of data.items) {
    if (it.enabled === false || it.done) continue;
    const dueAt = it.repeat ? (it.nextAt || it.at) : it.at;
    if (!(dueAt > 0) || now < dueAt) continue;      // 还没到点

    if (reminders?.add) {
      if (!it.repeat) continue;                     // 一次性的早塞进核心了，交给它发
      // 关机太久错过的那次作废，别让核心补一条几天前的提醒
      if (now - dueAt > stale && it.coreReminderId && reminders.cancel) {
        try { reminders.cancel(it.coreReminderId); } catch { /* 已经没了 */ }
      }
      let t = dueAt;
      let guard = 0;
      while (t <= now && guard < 500) { t = nextAfter(t, it.repeat, now); guard += 1; }
      it.nextAt = t;
      it.coreReminderId = seedReminder(reminders, it, s);
      advanced += 1;
      changed = true;
    } else if (sender?.sendTextBatch) {
      // 兜底：没有核心提醒系统，自己发
      try {
        await sender.sendTextBatch(it.chatKey, [`⏰ 提醒：${renderReminderText(it, s.reminderText)}`]);
        it.firedAt = now;
        it.firedCount = (it.firedCount ?? 0) + 1;
        sent += 1;
        changed = true;
        if (it.repeat) {
          let t = dueAt;
          let guard = 0;
          while (t <= now && guard < 500) { t = nextAfter(t, it.repeat, now); guard += 1; }
          it.nextAt = t;
        } else {
          it.done = true;
        }
      } catch (error) {
        log(`兜底发送日程提醒失败：${error?.message ?? error}`);
      }
    }
  }

  if (keepMs > 0) {
    const before = data.items.length;
    data.items = data.items.filter((it) => {
      if (it.repeat || !it.done) return true;
      return !(it.firedAt && now - it.firedAt > keepMs);
    });
    pruned = before - data.items.length;
    if (pruned) changed = true;
  }

  if (changed && !opts.data) saveData(data);
  return { advanced, sent, pruned, changed };
}

/** 起后台轮询。只有拿到过 ctx（里面有 reminders/sender）才有意义。 */
function startTicker() {
  if (timer) return;
  const ms = Math.max(5000, Number(cfg().tickMs) || 30000);
  timer = setInterval(() => {
    tick().catch((error) => log(`日程轮询出错：${error?.message ?? error}`));
  }, ms);
  timer.unref?.();
  const first = setTimeout(() => {
    tick().catch((error) => log(`日程轮询出错：${error?.message ?? error}`));
  }, 1500);
  first.unref?.();
  log(`日程轮询已启动：每 ${Math.round(ms / 1000)} 秒检查重复日程`);
}

/** 第一次拿到工具 ctx 时启动轮询（ctx 里才有 reminders / sender）。 */
function ensureTicker(ctx) {
  if (ctx?.reminders) captured.reminders = ctx.reminders;
  if (ctx?.sender) captured.sender = ctx.sender;
  if (ctx?.chatKey) captured.chatKey = ctx.chatKey;
  startTicker();
}

// ── 工具用到的查询 ────────────────────────────────────────────────────────

/** 按 id / 关键词 / 序号找一条日程。 */
export function findItem(items, query, now = Date.now()) {
  const q = String(query ?? '').trim();
  if (!q) return { match: null, candidates: [] };
  const alive = items.filter((it) => !it.done && it.enabled !== false);
  const exact = alive.find((it) => it.id === q || it.id.endsWith(q));
  if (exact) return { match: exact, candidates: [exact] };

  const idx = Number(q);
  if (Number.isFinite(idx) && idx >= 1 && idx <= alive.length) {
    const sorted = [...alive].sort((a, b) => (a.repeat ? a.nextAt : a.at) - (b.repeat ? b.nextAt : b.at));
    return { match: sorted[idx - 1], candidates: [sorted[idx - 1]] };
  }

  const hits = alive.filter((it) => String(it.title ?? '').includes(q) || String(it.note ?? '').includes(q));
  if (hits.length === 1) return { match: hits[0], candidates: hits };
  return { match: null, candidates: hits };
}

/** 列出日程（默认只看还没过的）。 */
export function listSchedules(items, opts = {}) {
  const now = opts.now ?? Date.now();
  const scope = opts.scope ?? 'future';
  const limit = Math.max(1, Number(opts.limit) || 20);
  const due = (it) => (it.repeat ? (it.nextAt || it.at) : it.at);
  let list = items.filter((it) => it.enabled !== false && !it.done);
  if (scope === 'future') list = list.filter((it) => due(it) >= now);
  else if (scope === 'today') list = list.filter((it) => {
    const d = new Date(due(it));
    const t = new Date(now);
    return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
  });
  else if (scope === 'week') list = list.filter((it) => due(it) >= now && due(it) <= now + 7 * 86400000);
  list.sort((a, b) => due(a) - due(b));
  return list.slice(0, limit);
}

/** 渲染成给模型/群友看的文字。 */
export function renderList(items, now = Date.now()) {
  if (!items.length) return '当前没有待办日程。';
  return items.map((it, i) => {
    const when = formatAt(it.repeat ? (it.nextAt || it.at) : it.at, now);
    const rep = describeRepeat(it.repeat);
    const note = it.note ? ` · ${it.note}` : '';
    return `${i + 1}. ${it.title} — ${when}${rep ? ` · ${rep}` : ''}${note}  [${it.id}]`;
  }).join('\n');
}

// ── Skill 生命周期 ────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;

  api.registerTool({
    id: 'schedule_add',
    name: '添加日程',
    description: '添加一个日程/提醒，到时间机器人会自动在当前群提醒。支持一次性（明天下午三点开会）和重复（每周一 09:30 晨会、每月 5 号交房租）。',
    category: 'utility',
    icon: '📅',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '日程标题，例如「项目例会」「交房租」' },
        at: { type: 'string', description: '时间。中文或 ISO 都行：明天下午三点 / 9月24日 15:00 / 每周一 09:30 / 2026-09-24T15:00:00' },
        repeat: { type: 'string', description: '可省略。at 里已经写了「每天」「每周一」这类就不用填；单独填时写 daily / weekly / monthly / weekdays' },
        note: { type: 'string', description: '可省略。备注，会跟提醒一起发出去' }
      },
      required: ['title', 'at']
    },
    async execute(ctx, args) {
      try {
        ensureTicker(ctx);
        const s = cfg();
        const title = String(args?.title ?? '').trim();
        if (!title) return { content: '得先说日程叫什么。', isError: true };

        const raw = String(args?.at ?? '').trim();
        const parsed = parseWhen(raw || String(args?.repeat ?? ''), { now: Date.now(), settings: s });
        if (!parsed.ok) return { content: parsed.error, isError: true };
        let repeat = parsed.repeat;
        if (!repeat && args?.repeat) {
          const w = /^weekly$/i.test(String(args.repeat)) ? { type: 'weekly' } : null;
          repeat = w || { type: String(args.repeat).toLowerCase() };
        }

        const now = Date.now();
        const item = {
          id: newId(),
          title,
          note: String(args?.note ?? '').trim(),
          chatKey: ctx.chatKey,
          createdBy: String(ctx.selfId ?? ''),
          createdAt: now,
          at: parsed.at,
          repeat: repeat ?? null,
          nextAt: parsed.at,
          coreReminderId: '',
          firedAt: 0,
          firedCount: 0,
          enabled: true
        };
        const data = loadData();
        data.items.push(item);
        item.coreReminderId = seedReminder(captured.reminders, item, s);
        saveData(data);

        const when = formatAt(item.at, now);
        const rep = describeRepeat(item.repeat);
        const tail = parsed.past ? '（这个时间点已经过了，会马上提醒一次）' : '';
        log(`新增日程：${title} @ ${when}${rep ? ` [${rep}]` : ''}`);
        return { content: `已添加日程：${title} — ${when}${rep ? `，${rep}` : ''}${item.note ? `，备注：${item.note}` : ''}${tail}\n编号 ${item.id}。到点我会在群里提醒，不用你再问。` };
      } catch (error) {
        return { content: `添加日程失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'schedule_list',
    name: '查看日程',
    description: '列出已经添加的日程。默认只看还没到时间的，也可以看今天/本周/全部。',
    category: 'utility',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'future=还没到的（默认）／today=今天的／week=未来七天／all=全部' }
      }
    },
    async execute(ctx, args) {
      try {
        ensureTicker(ctx);
        const s = cfg();
        const scope = String(args?.scope ?? 'future').toLowerCase();
        const items = listSchedules(loadData().items, { scope: ['today', 'week', 'all'].includes(scope) ? scope : 'future', limit: s.listLimit ?? 20 });
        return { content: renderList(items) };
      } catch (error) {
        return { content: `查看日程失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'schedule_del',
    name: '删除日程',
    description: '删掉一条日程。可以按编号删，也可以按标题关键词删（比如「删掉明天的会议」传「会议」）。同时会撤掉还没发出的提醒。',
    category: 'utility',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '日程编号（如 s_ab12x）、标题关键词，或列表里的序号（1/2/3）' }
      },
      required: ['query']
    },
    async execute(ctx, args) {
      try {
        ensureTicker(ctx);
        const data = loadData();
        const { match, candidates } = findItem(data.items, args?.query);
        if (!match) {
          if (candidates.length > 1) {
            return { content: `有 ${candidates.length} 条都匹配「${args?.query}」，说清楚要删哪条：\n${renderList(candidates)}`, isError: true };
          }
          return { content: `没找到匹配「${args?.query}」的日程。可以用 schedule_list 先看看有哪些。`, isError: true };
        }
        if (match.coreReminderId && captured.reminders?.cancel) {
          try { captured.reminders.cancel(match.coreReminderId); } catch { /* 已经触发了 */ }
        }
        data.items = data.items.filter((it) => it.id !== match.id);
        saveData(data);
        log(`删除日程：${match.title}（${match.id}）`);
        return { content: `已删除日程：${match.title}（${formatAt(match.repeat ? match.nextAt : match.at)}）。` };
      } catch (error) {
        return { content: `删除日程失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

/** 动态提示词片段：告诉模型现在几点，方便它算 ISO 兜底。 */
export function promptSections(ctx) {
  try {
    const now = new Date();
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${names[now.getDay()]} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return [{
      id: 'schedule-now',
      title: '当前时间',
      priority: 40,
      content: `现在是 ${stamp}。解析日程时间时以此为基准（「下周三」「明天下午三点」都要按这个算）。`
    }];
  } catch {
    return [];
  }
}

/**
 * 热重载失败时核心会补一次 activate（plugin-loader.js:375），
 * 这时把后台轮询接回去；平时由工具 ctx 触发启动，这里就是个兜底。
 */
export function activate() {
  if (!timer && (captured.reminders || captured.sender)) startTicker();
}

/** 禁用插件 / 热重载时收干净，别留定时器。 */
export function deactivate() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function available() { return true; }

export const internals = {
  normText, cnNum, parseClock, applyMeridian, parseOffset, parseDay, parseRepeat,
  alignFirst, nextAfter, parseWhen, formatAt, describeRepeat, renderReminderText,
  loadData, saveData, seedReminder, tick, findItem, listSchedules, renderList,
  dataFile, captured
};
