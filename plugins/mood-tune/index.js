// mood-tune —— 心情微调层（宿主 mood-tune.js 照搬）
//
// 宿主来源：src/mood-tune.js（75 行纯函数，依赖 affinity-schema / affinity-score，批 1 已迁）。
// 一句话：按"她今天的全局心情档"微调群聊随机插话概率（random-only）或有效档位（full）。
//   四条硬护栏结构上碰不到（私聊必响应 / @必响应 / 叫别人不响应 / alwaysReplyUsers 优先）。
//
// 软依赖：读宿主 affinity 插件的状态（本地 JSON）。无 affinity 时 globalMoodOf 返回基准档，
//   微调系数 = 1（无变化，不卡聊天）。
//
// ⚠️ mood.* 是自建能力名 —— 核心不认识。由 skills/mood-skill 的 set_mood 工具消费
//   （api.capability('mood.tune')），防孤儿能力（plugin-development.md §5）。

import { globalMoodOf, chimInFactorFor, applyMoodToStore, GUARDRAILS } from './lib/mood.js';
import { AffinityStore } from '../affinity/lib/aff-store.js';
import { DEFAULT_CONFIG, mergeConfig } from '../affinity/lib/aff-schema.js';
// 数据根目录：必须与正在运行的那份进程完全一致（多实例下插件自己拼会算错根目录，
// 表现是「实例 #2 的数据写进 #1 的目录」，两个机器人互相污染且极难发现）。
// 复用核心导出，唯一真源 —— 官方 conversation-memory 插件同款做法。
import { DATA_DIR } from '../../src/config.js';
import path from 'node:path';


let cfg = () => ({});
let api = null;
let affinityStore = null;
const pendingTrigger = new Map();

export function setup(a) {
  api = a;
  cfg = a.config;
  api.log('mood-tune 已加载（心情微调层，四条护栏；宿主 mood-tune.js 照搬）');
}

export function available() {
  return { ok: true, reason: '纯函数 + 软依赖 affinity 状态，开箱即用' };
}

export function activate(ctx) {
  // 软依赖：affinity 插件的本地状态（缺了 globalMoodOf 回落基准档，不崩）
  try {
    const dataDir = path.join(DATA_DIR, 'affinity');
    affinityStore = new AffinityStore({ dataDir });
    api.log?.('mood-tune: 已挂接 affinity 状态（' + affinityStore.loadAll().length + ' 人）');
  } catch (e) {
    affinityStore = null;
    api.warn?.('mood-tune: affinity 状态不可用 → 心情微调降级为系数 1（' + e?.message + '）');
  }
}

export function deactivate(ctx) {
  affinityStore = null;
  api.log?.('mood-tune: 已停用');
}

export function dispose() {
  affinityStore = null;
}

function globalTierId() {
  const c = mergeConfig(cfg());
  if (!affinityStore) return { tierId: c.tierIdOf ? undefined : 3, value: c.baseline, count: 0 };
  const states = affinityStore.loadAll();
  return globalMoodOf(states, c);
}

export const providers = {
  /**
   * 心情微调（宿主 applyMoodToStore 语义照搬）。
   * 入参：{ store, chatKey }（store = 宿主档位对象，含 randomPercent / contextTier）
   * 返回：{ cfg, factor, changed, reason }
   */
  'mood.tune': ({ store, chatKey }) => {
    const c = cfg();
    const g = globalTierId();
    const tierId = g.tierId ?? 3;
    return applyMoodToStore(store, { cfg: c, chatKey, globalTierId: tierId });
  },

  /** 查当前全局心情档（控制台/技能用）。 */
  'mood.status': () => {
    const c = mergeConfig(cfg());
    const g = globalTierId();
    return { ok: true, tierId: g.tierId ?? 3, value: g.value ?? c.baseline, count: g.count ?? 0, factor: chimInFactorFor(g.tierId ?? 3, c), guardrails: GUARDRAILS };
  },
};
// ── hooks：心情 → 提示词的软影响 ──────────────────────────────────────
// V0.3.1 核心没有"调整随机插话概率"的能力点（宿主是改 store.randomPercent），
// 所以这里改为**注入一条心情基调**，由模型自己把握活跃度 —— 同样达到"心情影响行为"的效果，
// 且不破四条硬护栏（私聊必响应 / @必响应 / 叫别人不响应 / alwaysReplyUsers 优先）。
function appendToSystem(messages, text) {
  if (!Array.isArray(messages) || !text) return;
  const sys = messages.find((m) => m && m.role === 'system');
  if (sys && typeof sys.content === 'string') { sys.content += text; return; }
  if (sys && Array.isArray(sys.content)) { sys.content.push({ type: 'text', text }); return; }
  messages.unshift({ role: 'system', content: String(text).trim() });
}

export const hooks = {
  'before-llm-messages'(ctx = {}) {
    try {
      const c = cfg();
      if (c.moodEnabled === false || c.enabled === false) return;
      const g = globalTierId();
      const tier = g.tierId ?? 3;
      const factor = chimInFactorFor(tier, c);
      // 只在中/低档给基调（3 档是中性，不注入 —— 省 token，宿主 injectOnlyWhenMeaningful 精神）
      if (tier === 3) return;
      const vibe = tier >= 5 ? '今天心情很好，可以活泼主动一点，多接几句话'
        : tier === 4 ? '今天心情不错，正常聊就好'
        : tier === 2 ? '今天有点懒，话少一点，别太主动'
        : '今天状态不太好，能简短就简短，少主动搭话';
      appendToSystem(ctx.messages, '\n\n【今日基调】' + vibe + '（心情档 ' + tier + '/6，插话系数 ×' + factor + '）');
    } catch { /* 注入失败不影响主流程 */ }
  },
};
