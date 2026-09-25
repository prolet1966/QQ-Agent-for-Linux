// search-fallback.js —— 内置联网兜底（宿主多引擎聚合搜索的简化版；软依赖被 search-aggregator 插件覆盖）
// 宿主版：bing/so360/baiduWeb/sogou 并行 + RRF 融合 + 共识加权（见 F:\Agnes\v031-split\plugins\search-aggregator）。
// 这里提供无该插件时的降级路径：单次 bing 搜索，超时返回 null。
export async function searchWebFallback({ query, maxResults = 4 } = {}) {
  try {
    const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query);
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) return { results: [], ms: 0, timedOut: false };
    const html = await res.text();
    const re = /<li class="b_algo">[\s\S]*?<h2>.*?<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>.*?<p>(.*?)<\/p>/g;
    const results = [];
    let m;
    while ((m = re.exec(html)) && results.length < maxResults) {
      results.push({
        url: m[1],
        title: m[2].replace(/<[^>]+>/g, '').trim(),
        snippet: m[3].replace(/<[^>]+>/g, '').slice(0, 300),
      });
    }
    return { results, ms: 0, timedOut: false };
  } catch (e) {
    return { results: [], ms: 0, timedOut: /timeout/i.test(String(e?.message ?? e)) };
  }
}
