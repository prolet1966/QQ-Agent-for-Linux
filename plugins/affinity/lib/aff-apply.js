// aff-apply.js —— 好感度/熟悉度应用层（宿主 ingest 事件 + apply 语义照搬，本地版）
// 入站消息 → 抽事件 → 防刷限额 → 落库 → 物化状态。失败只打日志。
import { DEFAULT_CONFIG } from './aff-schema.js';
import { judgeNegative, judgePositive, decayFactor, dayKeyOf, round, scoreFromRaw } from './aff-score.js';

/**
 * 处理一条入站消息的好感度变化。
 * @param {object} state 该人的状态对象（aff-store getState 返回）
 * @param {string} text  入站文本
 * @param {object} ctx   { cfg, targetsBot, targetsAdmin, todayEvents }
 * @returns {object} { applied, delta, reason, level?, kind? }
 */
export function applyInbound(state, text, ctx = {}) {
  const cfg = ctx.cfg || DEFAULT_CONFIG;
  const now = Date.now();
  const day = dayKeyOf(now);
  const events = (state.events = state.events || []);

  // 找当日已记事件（防刷窗口）
  const todayEvents = events.filter((e) => e.day === day);
  const countKind = (k) => todayEvents.filter((e) => e.kind === k).length;
  const dayPositive = todayEvents.filter((e) => e.delta > 0).reduce((a, e) => a + e.delta, 0);
  const dayNegative = todayEvents.filter((e) => e.delta < 0).reduce((a, e) => a + e.delta, 0);

  let applied = null;

  // 1) 道歉（正向，单独算）
  const pos = judgePositive(text, cfg);
  if (pos && pos.kind === 'apology') {
    if (dayPositive < (cfg.limits.perDayPositive || 8)) {
      applied = { kind: 'apology', delta: pos.weight, reason: '道歉和解', hits: pos.hits };
    }
  }
  // 2) 其它正向（受 perDayPositive + 同类每日限额）
  if (!applied && pos) {
    const capKey = pos.kind === 'help' ? 'helpPerDay' : (pos.kind === 'intimate' ? 'intimatePerDay' : 'praisePerDay');
    const dailyCap = (cfg.limits && cfg.limits[capKey]) || 3;
    if (countKind(pos.kind) < dailyCap && dayPositive < (cfg.limits.perDayPositive || 8)) {
      applied = { kind: pos.kind, delta: pos.weight, reason: pos.kind, hits: pos.hits };
    }
  }
  // 3) 负向（分级，L3/L4 需二次确认，负向不打折）
  if (!applied) {
    const neg = judgeNegative(text, {
      lexicon: cfg.lexicon,
      weights: cfg.weights,
      targetsAdmin: !!ctx.targetsAdmin,
      targetsBot: !!ctx.targetsBot,
      isRepeat: todayEvents.some((e) => e.kind === 'slight'),
      isMemeRepeat: todayEvents.some((e) => e.kind === 'meme'),
    });
    if (neg) {
      const doubleCheck = (cfg.limits.requireDoubleCheck || [3, 4]).includes(neg.level);
      const confirmed = ctx.confirmed !== false && !doubleCheck;
      const cap = confirmed ? (cfg.limits.perEventMaxConfirmed || 20) : (cfg.limits.perEventMax || 8);
      // 单事件受 perEventMax 限制；当日负向累计超 perDayNegative 下限则当天不再加深（宿主防刷，负向不打折指单次不递减）
      const dayNegAbs = Math.abs(dayNegative);
      const negFloor = Math.abs(cfg.limits.perDayNegative || -25);
      let finalDelta = Math.max(-cap, neg.delta);
      if (dayNegAbs + Math.abs(finalDelta) > negFloor) finalDelta = -(negFloor - dayNegAbs); // 截断到当日下限
      if (finalDelta === 0) return { applied: false, delta: 0, reason: '当日负向已达下限' };
      applied = { kind: neg.kind, delta: finalDelta, reason: neg.reason, level: neg.level, id: neg.id, hits: neg.hits };
    }
  }

  if (!applied) return { applied: false, delta: 0, reason: '无命中' };

  // 落事件
  events.push({
    ts: now,
    day,
    kind: applied.kind,
    delta: applied.delta,
    applied: true,
    reason: applied.reason,
    hits: applied.hits || [],
    ...(applied.level ? { level: applied.level, id: applied.id } : {}),
  });

  // 更新 raw（带衰减由物化时算，这里直接累加当日 delta 到 raw 的"当日增量"）
  state.rawToday = (state.rawToday || 0) + applied.delta;
  state.last_talk_at = new Date(now).toISOString();
  state.updated_at = new Date(now).toISOString();

  // 跨档检测（宿主：档位变化时自动往该群记忆追加印象 —— 由插件钩子在注入侧消费）
  return {
    applied: true,
    delta: applied.delta,
    kind: applied.kind,
    level: applied.level,
    reason: applied.reason,
    hits: applied.hits,
  };
}

/**
 * 物化：raw（带半衰期衰减）→ 0~100 分。调用方在读取状态时算。
 */
export function materializeState(state, cfg) {
  const c = cfg || DEFAULT_CONFIG;
  const now = Date.now();
  // raw = **只**由事件账本算（每条事件带自己的半衰期衰减）。
  let raw = 0;
  for (const e of (state.events || [])) {
    const age = now - (Number(e.ts) || now);
    raw += e.delta * decayFactor(age, c.halfLifeDays || 90);
  }
  // ⚠️ rawToday 是"今天净增"的**派生快照**，只给面板和日上限阅读用，
  //    绝不能再加进 raw —— 今天的事件本来就在 events 里，再加一遍就是双倍计分。
  //
  //    这个 bug 真实发生过且很难看出来：控制台调 +5 之后分数纹丝不动，
  //    因为 raw 被算成了 10 左右，而 raw≈10.17 正好映射到基线 55 分 ——
  //    看上去"没生效"，实际是"加了两倍但起点本身就是基线"。
  const day = new Date(now).toISOString().slice(0, 10);
  state.rawToday = round((state.events || [])
    .filter((e) => String(e.day || '') === day)
    .reduce((a, e) => a + (Number(e.delta) || 0), 0), 3);
  state.raw = round(raw, 3);
  state.score = scoreFromRaw(raw, c);
  return state;
}
