// proactive-chat —— 主动开场/连发窗口（宿主阶段二 12 号 burst-wake 语义照搬）
//
// 宿主来源：qq-agent-plugins/src/proactive-chat + orchestrator scheduleWake 改造。
// 核心语义：
//   1. 禁言守卫：触发条件「发送被拒且 result=120 / send group message rejected」→
//      查 get_group_member_info 拿 shut_up_timestamp → 记 mutedUntil → 本轮立刻收工 →
//      解禁前 scheduleWake/wake 直接跳过（消息沉底、不叫模型）。宿主：守卫后第一次撞上
//      只用 1 次模型调用就收工（之前 6 个会话白跑 2~8 轮）。
//   2. 自适应连发窗口：scheduleWake 改成 burstWindowSec 内连发 minGapSec 以上 → 主动接话。
//
// 本插件是「纯钩子」确定性插件：after-response（记连发节奏 / 禁言守卫）+ before-context（禁言时跳过 run）。
// 原 proactive.schedule 自建能力名核心无消费点，按 plugin-development.md §5 降级为普通导出
//   （proactiveStatus 顶层函数，供控制台/审计查询，manifest 不再声明 capabilities，避开孤儿审计）。

let cfg = () => ({});
let banStateFn = null;          // 软依赖 chat.ban-state（来自 plugins/ban-state）
let lastBurst = [];             // 最近连发时间戳
let mutedUntil = {};            // chatKey → 解禁时间戳
let mutedReason = {};

let api = null;

export function setup(a) {
  api = a;
  cfg = a.config;
  banStateFn = api.capability('chat.ban-state');   // 软依赖，缺了降级（守卫不生效但聊天正常）
  api.log('proactive-chat 已加载（禁言守卫 + 自适应连发窗口）');
}

export function available() {
  return { ok: true, reason: banStateFn ? '禁言守卫就绪' : '禁言守卫降级（chat.ban-state 缺失）' };
}

export async function activate(ctx) {
  lastBurst = [];
  mutedUntil = {};
  mutedReason = {};
  api.log?.('proactive-chat: 已激活（连发窗口 ' + (cfg().burstWindowSec ?? 180) + 's）');
}

export async function deactivate(ctx) {
  lastBurst = [];
  mutedUntil = {};
  mutedReason = {};
  api.log?.('proactive-chat: 已停用，连发/禁言状态清理');
}

export function dispose() {
  lastBurst = [];
  mutedUntil = {};
  mutedReason = {};
}

/** 判断某群现在是否被禁言（禁言守卫）。 */
function isMuted(chatKey, ctx) {
  const until = mutedUntil[chatKey];
  if (until && Date.now() < until) return { muted: true, until, reason: mutedReason[chatKey] };
  if (banStateFn) {
    try {
      const r = banStateFn({ chatKey, action: 'check' });
      if (r?.muted) {
        mutedUntil[chatKey] = r.mutedUntil ?? Date.now() + 3600_000;
        mutedReason[chatKey] = 'ban-state 插件报告禁言';
        return { muted: true, until: mutedUntil[chatKey], reason: 'ban-state' };
      }
    } catch {}
  }
  return { muted: false };
}

/** 记录一次连发（after-response 钩子调用）。 */
function recordBurst(chatKey, at = Date.now()) {
  const windowStart = at - (cfg().burstWindowSec ?? 180) * 1000;
  lastBurst = [...lastBurst.filter((t) => t >= windowStart), at];
}


export const hooks = {
  /**
   * 响应后：记录连发节奏（供 proactive.schedule 判断）。
   * 宿主：被禁言的发送失败时记 mutedUntil（守卫核心）。
   */
  'after-response': ({ response, session }) => {
    const chatKey = session?.chatKey;
    if (!chatKey) return;
    // 禁言守卫：发送被拒且 result=120 / send group message rejected
    const rejected = response?.rejected || response?.muted;
    if (rejected && String(response?.error ?? '').match(/result=120|send group message rejected|禁言/)) {
      mutedUntil[chatKey] = Date.now() + (Number(response?.shutUpSeconds) || 3600) * 1000;
      mutedReason[chatKey] = response?.errorReason ?? '禁言';
      api_log('proactive-chat: 禁言守卫触发 ' + chatKey + ' → ' + new Date(mutedUntil[chatKey]).toLocaleTimeString('zh-CN') + ' 解禁');
      return;
    }
    // 正常响应 → 记连发
    recordBurst(chatKey);
  },

  /**
   * 提示词组装前：若被禁言，把「静音中」信息注入 ctx（宿主：消息沉底、不叫模型）。
   */
  'before-context': (ctxArg) => {
    const chatKey = ctxArg?.chatKey;
    if (!chatKey) return;
    const m = isMuted(chatKey);
    if (m.muted && ctxArg?.triggerEntries) {
      // 宿主：禁言时消息沉底，不叫模型（在 orchestrator 层跳过 run）
      ctxArg.skipRun = true;
      ctxArg.skipReason = '禁言中（' + new Date(m.until).toLocaleTimeString('zh-CN') + ' 解禁），消息沉底不叫模型';
    }
  },
};

function api_log(msg) {
  try { console.log('[skill:proactive-chat]', msg); } catch {}
}

/**
 * 主动开场状态查询（供控制台/审计，普通导出非 provider —— 核心无消费点，见 manifest _note）。
 * 宿主 scheduleWake 语义：判断「现在该不该主动接话」。
 * 入参：{ chatKey, now? }
 * 返回：{ shouldProactive, reason, mutedUntil? }
 */
export function proactiveStatus({ chatKey, now = Date.now() } = {}) {
  const m = isMuted(chatKey);
  if (m.muted) return { shouldProactive: false, reason: '禁言中（' + new Date(m.until).toLocaleTimeString('zh-CN') + ' 解禁）', mutedUntil: m.until };
  const c = cfg();
  if (!c.enabled) return { shouldProactive: false, reason: '未启用' };
  const windowStart = now - (c.burstWindowSec ?? 180) * 1000;
  const recentBurst = lastBurst.filter((t) => t >= windowStart).length;
  if (recentBurst >= (c.maxConsecutive ?? 3)) return { shouldProactive: false, reason: '已达连发上限' };
  const lastAt = lastBurst[lastBurst.length - 1] ?? 0;
  if (now - lastAt < (c.minGapSec ?? 20) * 1000 && lastAt > 0) return { shouldProactive: false, reason: '未到最小间隔' };
  return { shouldProactive: true, reason: '群聊热，可主动接话' };
}

