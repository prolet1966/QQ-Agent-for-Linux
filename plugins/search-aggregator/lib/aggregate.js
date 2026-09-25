// aggregate.js - multi-engine search aggregation (host search-aggregator.js semantics)
//
// Engines: bing / so360 / baiduWeb / sogou (all key-free, out of the box).
// Pipeline: parallel fetch (Promise.allSettled) -> normalize -> URL dedup -> RRF fusion
//   -> consensus boost -> domain diversity truncate.
//   A failed/timed-out engine only loses its share; empty aggregate falls back to first engine.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export function sanitizeQuery(query) {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function normalizeUrl(u) {
  return String(u ?? '').trim();
}

export function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return String(url ?? ''); }
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

async function fetchText(url, { timeoutMs = 8000 } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

/** Parse search-result anchors out of arbitrary engine HTML (generic fallback). */
function parseResultAnchors(html) {
  const out = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 20) {
    const url = m[1];
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeEntities(m[2]);
    if (!title || title.length < 4) continue;
    // snippet: look for a <p> or <span> nearby
    const near = html.slice(m.index, m.index + 600);
    const p = near.match(/<(?:p|span|div)[^>]*>([\s\S]{20,})<\/?/g);
    const snippet = p ? decodeEntities(p[p.length - 1].replace(/<[^>]+>/g, ' ')).slice(0, 300) : '';
    out.push({ url, title, snippet });
  }
  return out;
}

export async function bingHtml(query, { timeoutMs = 8000 } = {}) {
  const html = await fetchText('https://cn.bing.com/search?q=' + encodeURIComponent(query), { timeoutMs });
  const out = [];
  const re = /<li class="b_algo">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 12) {
    const block = m[1];
    const a = block.match(/<h2>.*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/s);
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/s);
    if (a) out.push({
      url: a[1],
      title: decodeEntities(a[2]),
      snippet: p ? decodeEntities(p[1]).slice(0, 300) : '',
    });
  }
  return out.length ? out : parseResultAnchors(html);
}

export async function so360Html(query, { timeoutMs = 8000 } = {}) {
  const html = await fetchText('https://www.so.com/s?ie=utf-8&q=' + encodeURIComponent(query), { timeoutMs });
  return parseResultAnchors(html).slice(0, 12);
}

export async function baiduWebHtml(query, { timeoutMs = 8000 } = {}) {
  const html = await fetchText('https://www.baidu.com/s?wd=' + encodeURIComponent(query), { timeoutMs });
  return parseResultAnchors(html).slice(0, 12);
}

export async function sogouHtml(query, { timeoutMs = 8000 } = {}) {
  const html = await fetchText('https://www.sogou.com/web?query=' + encodeURIComponent(query), { timeoutMs });
  return parseResultAnchors(html).slice(0, 12);
}

/**
 * RRF fusion + consensus boost + domain diversity (host aggregate() semantics).
 * engineResults: [{ engine, items: [{url,title,snippet}] }]
 */
export function aggregate(engineResults, { k = 60, consensusBoost = 0.25, maxPerDomain = 3, maxResults = 8 } = {}) {
  const byUrl = new Map();
  for (const { engine, items } of engineResults) {
    items.forEach((item, rank) => {
      const key = normalizeUrl(item.url);
      if (!key) return;
      const rrfGain = 1 / (k + rank + 1);   // host: rank (0-based) into RRF
      const rec = byUrl.get(key) || { url: key, title: item.title, snippet: item.snippet, engines: [], rrf: 0 };
      rec.engines.push(engine);
      rec.rrf += rrfGain;
      if (!rec.title && item.title) rec.title = item.title;
      if (!rec.snippet && item.snippet) rec.snippet = item.snippet;
      byUrl.set(key, rec);
    });
  }
  let items = [...byUrl.values()];
  // consensus boost: same URL from N engines -> (1 + boost*(N-1))
  items = items.map((r) => ({ ...r, score: r.rrf * (1 + consensusBoost * (r.engines.length - 1)) }));
  // domain diversity: at most maxPerDomain per host
  const perDomain = new Map();
  const out = [];
  items.sort((a, b) => b.score - a.score);
  for (const r of items) {
    const h = hostOf(r.url) || '_';
    const n = perDomain.get(h) || 0;
    if (n >= maxPerDomain) continue;
    perDomain.set(h, n + 1);
    out.push({ url: r.url, title: r.title, snippet: r.snippet, engines: r.engines, score: Math.round(r.score * 10000) / 10000 });
    if (out.length >= maxResults) break;
  }
  return { items: out };
}
