// search-aggregator-skill —— LLM 型技能：聚合搜索工具（宿主 30 工具里的联网兜底提为独立技能）
//
// 软依赖：api.capability('search.aggregate') —— 能力由 plugins/search-aggregator 提供。
//   缺插件时能力为 undefined，工具如实报「聚合搜索未启用」。
//   这是防孤儿能力的关键消费方（search.aggregate 是自建能力名，核心不认识）。

export function setup(api) {
  const aggFn = api.capability('search.aggregate');

  const ok = (data) => ({ content: typeof data === 'string' ? data : JSON.stringify(data, null, 2) });
  const err = (msg) => ({ content: msg, isError: true });

  api.registerTool({
    id: 'web_search_agg',
    name: '多引擎聚合搜索',
    description: '多引擎并行搜索（bing/so360/baiduWeb/sogou 免 key），RRF 融合 + 共识加权 + 域多样性，比单引擎更稳更全。用户说「搜一下 / 查资料 / 看看有没有这回事」且需要多个来源交叉验证时用；单纯闲聊或本地知识库能答的别用它（先 kb_recall）。',
    category: 'web',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，越具体越准' },
        maxResults: { type: 'integer', description: '最多返回几条，默认 8，最大 15' },
      },
      required: ['query'],
    },
    async execute(ctx, args) {
      try {
        if (!aggFn) return err('聚合搜索插件未启用（plugins/search-aggregator 没装或不可用）。');
        const query = String(args.query ?? '').trim();
        if (!query) return err('要指定 query');
        const limit = Math.min(15, Math.max(1, Number(args.maxResults) || 8));
        const r = await aggFn({ query, maxResults: limit });
        if (r.allFailed || !r.results?.length) {
          return err('各引擎都没搜到结果（' + (r.error || '可能无网络或全部超时') + '）。换个关键词试试。');
        }
        const out = r.results.map((x, i) =>
          (i + 1) + '. ' + x.title + '（' + x.engines.join('/') + ' 命中）\n   ' + x.url + (x.snippet ? '\n   ' + x.snippet : ''),
        );
        return ok('搜到 ' + r.results.length + ' 条（引擎 ' + r.enginesUsed.join('/') + '，' + r.ms + 'ms）：\n' + out.join('\n\n') + '\n引用时注明来源 URL。');
      } catch (error) {
        return err('聚合搜索失败：' + (error?.message ?? error));
      }
    },
  });
}

export function available() {
  return { ok: true, reason: '工具可用（能力由 plugins/search-aggregator 软依赖提供，缺时工具如实报错）' };
}
