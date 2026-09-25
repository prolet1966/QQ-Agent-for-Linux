// 知识库（梗库）—— LLM 型技能 + 一个注入钩子
//
// 移植自桌面魔改包 `09-knowledge-memes`。原版是改 `src/tools.js` / `src/orchestrator.js`
// 的**本体修改**；这里改成标准扩展。
//
// ── 类型说明（这是本项目第一个「混合型」，刻意如此）────────────────────────
// 主交互是**两个工具**（存梗 / 搜梗）—— 什么时候记、记什么，只有模型判断得准 → LLM 型，
// 所以放 `skills/`。
// 但「脑内闪过」是**每次收到消息都本地跑一遍**的弱联想，不经过模型决策 → 用
// `before-llm-messages` 钩子实现。两型在代码里本就同构（同一个加载器、同一套清单字段），
// 钩子不是插件专属；这里按**主要机制**归位，并在 README/文档里写明。
//
// ── 为什么闪过只给「梗名」不给全文 ──────────────────────────────────────────
// 每条都灌全文 = 每次运行多花几百 token，且容易把模型带偏到无关话题上。
// 只闪标题，需要细节时它自己会调 memory_meme_search。

import { DATA_DIR } from '../../src/config.js';
import {
  configure, saveMeme, searchMeme, cueMemories, listMemeTips, memeCount, removeMeme, listKnowledge
} from './memes.js';

let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;
  log = (...a) => api.log(...a);
  // 数据目录 + 变更回调都从外面注入：memes.js 不直接依赖核心，
  // 这样它的打分/存取逻辑可以脱离整个应用单独测。
  configure({
    dataDir: DATA_DIR,
    onMemoryChange: (evt) => log(`知识库变更：${evt.type} ${evt.text || ''}`.trim())
  });

  api.registerTool({
    id: 'memory_meme_save',
    name: '记录梗',
    description: '把群里反复出现、以后还会用到的梗 / 口头禅 / 内部笑话 / 短笔记记进知识库。'
      + '只记「可复用」的，一次性的闲聊不要记。原文尽量短（≤60 字，最多 120）。',
    category: 'knowledge',
    icon: '📚',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '梗的原文（短句，越接近群里的说法越好）' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，最多 6 个（如 人名/作品/来源）' },
        note: { type: 'string', description: '一句备注：什么场合用、什么意思' },
        kind: { type: 'string', enum: ['meme', 'note'], description: 'meme=梗（默认）；note=普通短笔记' }
      },
      required: ['text']
    },
    execute(_ctx, args) {
      try {
        const r = saveMeme({
          text: args?.text,
          tags: args?.tags,
          note: args?.note,
          kind: args?.kind === 'note' ? 'note' : 'meme'
        });
        if (!r.ok) return { content: `记录失败：${r.error}`, isError: true };
        return {
          content: r.deduped
            ? `这条知识库里已经有过，已合并（引用次数 ${r.meme.uses}）。`
            : `已记下：${r.meme.text}（当前共 ${memeCount()} 条）`
        };
      } catch (error) {
        return { content: `记录失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'memory_meme_search',
    name: '搜知识库',
    description: '在想不起某个梗/口头禅的来龙去脉时搜知识库。返回原文短句 + 标签 + 备注。'
      + '闲聊时不要频繁搜；提示词里已经闪过「梗名」的，想看细节再搜。',
    category: 'knowledge',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（人物 / 作品 / 台词片段）' },
        limit: { type: 'number', description: '返回几条，默认用设置里的值（5）' }
      },
      required: ['query']
    },
    execute(_ctx, args) {
      try {
        const limit = Math.max(1, Math.min(20, Number(args?.limit) || Number(cfg().searchLimit) || 5));
        const hits = searchMeme(String(args?.query || ''), { limit });
        if (!hits.length) {
          const total = memeCount();
          return { content: total ? `知识库里没有匹配「${args?.query}」的条目（共 ${total} 条）。` : '知识库还是空的，先用 memory_meme_save 记几条。' };
        }
        return { content: JSON.stringify({ count: hits.length, hits }, null, 1) };
      } catch (error) {
        return { content: `搜索失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

/**
 * 常驻提示：把最常用的几条梗名列进提示词，让模型「知道有这么些东西」。
 * 与钩子的「闪过」互补 —— 常驻的是长期高频，闪过的是跟当前话题沾边的。
 */
export function promptSections() {
  const max = Math.max(0, Number(cfg().tipCount) || 0);
  if (!max) return [];
  let tips = [];
  try { tips = listMemeTips({ max }); } catch { return []; }
  if (!tips.length) return [];
  return [{
    id: 'knowledge-memes-tips',
    title: '你记得的梗',
    priority: 28,
    content: `群里常见的梗/口头禅（只给标题，细节用 memory_meme_search 搜）：${tips.join('、')}`
  }];
}

export const hooks = {
  /**
   * 脑内闪过：收到消息时本地比对一次知识库，沾边的把「梗名」补进消息里。
   *
   * 为什么用这个钩子：它是唯一能在**发请求前**改 messages、又能拿到 skillContext 的时机。
   * 只追加一条 system 消息，不改动原有内容 —— 出错也绝不能影响这轮对话，所以整段 try/catch 兜住。
   */
  'before-llm-messages': ({ messages, chatKey } = {}) => {
    try {
      if (cfg().cueEnabled === false) return;
      const text = lastUserText(messages);
      if (!text) return;
      const limit = Math.max(1, Math.min(5, Number(cfg().cueLimit) || 2));
      const cues = cueMemories(text, { limit });
      if (!cues.length) return;
      messages.push({
        role: 'system',
        content: `【脑内闪过】群友这句话让你想起知识库里的：${cues.map((c) => c.text).join('、')}`
          + `（只是联想，未必相关；想用就 memory_meme_search 查细节，别硬扯）`
      });
    } catch (error) {
      log(`脑内闪过失败（不影响本轮对话）：${error?.message ?? error}`);
    }
  }
};

/** 取最后一条 user 消息的纯文本（content 可能是字符串或 parts 数组）。 */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content.slice(0, 2000);
    if (Array.isArray(m.content)) {
      return m.content
        .filter((p) => p?.type === 'text')
        .map((p) => String(p.text || ''))
        .join('\n')
        .slice(0, 2000);
    }
  }
  return '';
}

export const internals = { lastUserText, removeMeme, listKnowledge };
