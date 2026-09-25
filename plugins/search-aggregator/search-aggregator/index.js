// search-aggregator —— 多引擎搜索聚合层（宿主 search-aggregator.js 语义照搬）
//
// 宿主来源：部署版 src/search-aggregator.js（18.4KB，mode=aggregate，
//   引擎 bing + so360 + baiduWeb + sogou 免 key，并行 + RRF 融合 + 共识加权 + 域/引擎多样性）。
// 配置：宿主 node tools/set-search-config.mjs 写 data/config.json 的 search 段；
//   V0.3.1 形态由本插件 settings 承载（宿主默认值照搬）。
//
// 软依赖消费方：
//   - skills/search-aggregator-skill（web_search_agg 工具）
//   - plugins/kb-growth 的 knowledge.recall 联网兜底（宿主里 fallback 走多引擎）
//   - skills/image-gen-skill 的「先检索再生图」
// ⚠️ search.aggregate 是自建能力名 —— 核心不认识。必须由上述消费方用 api.capability() 取用，
//   否则审计报孤儿能力（见 plugin-development.md §5）。

import {
  aggregate,
  bingHtml,
  so360Html,
  baiduWebHtml,
  sogouHtml,
  sanitizeQuery,
  normalizeUrl,
  hostOf,
} from './lib/aggregate.js';

let cfg = () => ({});

export function setup(api) {
  cfg = api.config;
  api.log('search-aggregator 已加载（' + (cfg().engines || 'bing,so360,baiduWeb,sogou').split(',').map((s) => s.trim()).filter(Boolean).join('/') + '）');
}

export function available() {
  return { ok: true, reason: '免 key 引擎，开箱即用' };
}

export function dispose() {}

export const providers = {
  /**
   * 多引擎聚合搜索（宿主 aggregate() 语义照搬）：
   *   并行打所有配置引擎 → 归一化 → URL 去重 → RRF 融合 → 共识加权 → 域多样性截断。
   *   某引擎超时/失败只丢它（Promise.allSettled），不影响整体；聚合结果为空退回第一个可用引擎。
   * 入参：{ query, maxResults? }
   * 返回：{ results: [{ url, title, snippet, engines:[命中它的引擎], score }], enginesUsed, ms, allFailed }
   */
  'search.aggregate': async ({ query, maxResults } = {}) => {
    const c = cfg();
    const clean = sanitizeQuery(query);
    if (!clean) return { results: [], enginesUsed: [], ms: 0, allFailed: true, error: '空查询' };
    const engines = String(c.engines || 'bing,so360,baiduWeb,sogou').split(',').map((s) => s.trim()).filter(Boolean);
    const timeoutMs = Number(c.timeoutMs) || 8000;
    const limit = Math.min(20, Number(maxResults) || Number(c.maxResults) || 8);
    const t0 = Date.now();

    const engineFns = { bingHtml, so360Html, baiduWebHtml, sogouHtml };
    const settled = await Promise.allSettled(
      engines.map((name) => engineFns[name]?.(clean, { timeoutMs })),
    );
    const engineResults = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === 'fulfilled' && Array.isArray(s.value)) engineResults.push({ engine: engines[i], items: s.value });
    }

    const r = aggregate(engineResults, {
      k: Number(c.rrfK) || 60,
      consensusBoost: Number(c.consensusBoost) || 0.25,
      maxPerDomain: Number(c.maxPerDomain) || 3,
      maxResults: limit,
    });
    return {
      results: r.items,
      enginesUsed: engineResults.map((e) => e.engine),
      ms: Date.now() - t0,
      allFailed: !engineResults.length,
      ...(r.items.length === 0 && engineResults.length ? { note: '聚合结果为空（各引擎都无命中）' } : {}),
    };
  },
};
