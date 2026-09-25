// mood-tune lib —— 宿主 mood-tune.js 纯函数照搬（V0.3.1 形态：依赖已迁的 aff-schema / aff-score）
// 四条硬护栏（结构上碰不到，宿主原样保留）：
//   1. 私聊必响应（randomPercent 只改群聊随机档）
//   2. 被 @ 必响应（@ 的判定在宿主档位系统，心情不碰）
//   3. 叫别人的消息一律不响应
//   4. alwaysReplyUsers 优先于随机
// 本模块只改 randomPercent（random-only）或 contextTier ±1（full 模式），绝不破护栏。

import { mergeConfig } from '../../affinity/lib/aff-schema.js';
import { num, clamp, tierIdOf } from '../../affinity/lib/aff-score.js';

export const GUARDRAILS = [
  '私聊必响应（resolveContextTier 对 private: 直接返回 tier4）',
  '被 @ 必响应（atMe → tier1，不吃随机概率）',
  '叫别人的消息一律不响应（addressedToOthers → tier0）',
  'alwaysReplyUsers 指定用户优先（早于随机骰子）',
];

/** 全体当日心情的中位数 → 全局心情档（1~6）。0 人时回落基准分。 */
export function globalMoodOf(states, cfg) {
  const vals = (states || [])
    .map((s) => num(s && s.daily && s.daily.value, NaN))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!vals.length) {
    const base = mergeConfig(cfg).baseline;
    return { value: base, tierId: tierIdOf(base), count: 0 };
  }
  const mid = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
  return { value: Math.round(mid * 10) / 10, tierId: tierIdOf(mid), count: vals.length };
}

/** 全局心情档 → 插话概率系数（mood.chimInFactor 表，宿主参数照搬）。 */
export function chimInFactorFor(tierId, cfg) {
  const c = mergeConfig(cfg);
  const key = String(clamp(num(tierId, 3), 1, 6));
  const table = c.mood && c.mood.chimInFactor ? c.mood.chimInFactor : {};
  return num(table[key], 1);
}

/**
 * 修正 store 配置（宿主 applyMoodToStore 语义照搬）。
 * 入参：{ store, cfg, chatKey, globalTierId }
 * 返回：{ cfg, factor, changed, reason }
 */
export function applyMoodToStore(store, opts = {}) {
  const s = store && typeof store === 'object' ? { ...store } : {};
  const chatKey = String(opts.chatKey || '');
  const c = mergeConfig(opts.cfg);
  if (chatKey.startsWith('private:')) {
    return { cfg: store, factor: 1, changed: false, reason: '私聊不修正（护栏 1）' };
  }
  const mode = String((c.mood && c.mood.tierShift) || 'random-only');
  if (mode !== 'full' && mode !== 'random-only') {
    return { cfg: store, factor: 1, changed: false, reason: '未开启心情修正' };
  }
  const tierId = num(opts.globalTierId, 3);
  const factor = chimInFactorFor(tierId, c);
  const rp = num(s.randomPercent, 0);
  if (!(rp > 0)) return { cfg: store, factor, changed: false, reason: '当前档位不掷随机（无需修正）' };
  const tuned = clamp(rp * factor, 0, 100);
  s.randomPercent = Math.round(tuned * 10) / 10;
  if (mode === 'random-only') {
    return { cfg: s, factor, changed: Math.abs(s.randomPercent - rp) > 0.01, reason: '心情档' + tierId + ' ×' + factor + '（只改随机概率）' };
  }
  const baseTier = num(s.contextTier, 4);
  const shift = tierId >= 5 ? 1 : tierId <= 2 ? -1 : 0;
  const nt = clamp(Math.round(baseTier + shift), 1, 4);
  const changed = nt !== baseTier;
  s.contextTier = nt;
  return { cfg: s, factor, changed: changed || Math.abs(s.randomPercent - rp) > 0.01, reason: '心情档 ' + tierId + ' → 有效档位 ' + baseTier + '→' + nt };
}
