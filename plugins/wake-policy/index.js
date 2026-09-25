// wake-policy —— 唤醒策略（补齐宿主有、V0.3.1 核心档位判定没有的「按人/按群」规则）
//
// V0.3.1 的档位判定只认四种信号：被艾特 / 全局关键词 / 随机 / 全部响应。
// 宿主的这三类策略它认不出来：
//   1. alwaysReplyUsers   这几个人说话必回
//   2. keywordsByUser     这个人有自己的关键词表（全局词表之外）
//   3. aliases/groupAliases  机器人还有别的名字（核心只认 selfNickname/botName）
//
// 实现方式：提供 `wake.rule` 能力，核心在建等待会话前问一圈（见 orchestrator #predictTier）。
// **只做"追加响应"** —— 返回 respond=true 才生效；返回 false 一律忽略，
// 保证一个配置写错的插件不会让机器人彻底不吭声。

import { decide } from './lib/wake-rules.js';

let cfg = () => ({});

/**
 * 能力声明：V0.3.1 的写法是 `export const providers = { '能力名': fn }`，
 * 由 plugin-loader 收集进 skillManager（**没有** `api.capability.define` 这个方法 —— 踩过）。
 */
export const providers = {
  /** 核心在 #predictTier 里逐个调用；返回 { respond:true, reason } 才生效。 */
  'wake.rule': (ctx = {}) => rule(ctx),
};

export function setup(api) {
  cfg = api.config;
  api.log('wake-policy 已加载（必回名单 / 按人关键词 / 别名，三条按人规则；默认全空 = 不影响）');
}

function rule(ctx = {}) {
  const c = cfg();
  const settings = {
    alwaysReplyUsers: c.alwaysReplyUsers ?? '',
    keywordsByUser: c.keywordsByUser ?? '',
    aliases: c.aliases ?? '',
    groupAliases: c.groupAliases ?? '',
    wakeCount: c.wakeCount ?? 0,
  };
  return decide({ entries: ctx.entries || [], chatKey: ctx.chatKey || '', settings });
}

export function available() {
  const c = cfg();
  const n = [c.alwaysReplyUsers, c.keywordsByUser, c.aliases, c.groupAliases]
    .filter((x) => String(x ?? '').trim()).length;
  return { ok: true, reason: n ? ('已配置 ' + n + ' 条规则') : '规则为空（等同未启用，不影响核心判定）' };
}

export function dispose() {}
