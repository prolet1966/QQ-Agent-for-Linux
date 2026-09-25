// setu Pixiv 搜索基础设施（从 setu.js 提取）：搜索缓存、429 重试、多实例轮换、标签补全、候选取图。
// 依赖：config.js（常量）、safe-fetch.js、downloader.js（fetchWithProxyFallback, sleep）、filters.js（过滤函数）
import { safeFetch, safeFetchBinary } from '../../src/safe-fetch.js';
import { fetchWithProxyFallback, sleep } from './downloader.js';
import {
  buildSearchWord, isMultiPersonIllust, isMaleCharacterIllust, isHorrorIllust,
  isR18Illust, isR15Illust, isR0Only, hasQualityTag, illustScore, isMultiCharacterIllust
} from './filters.js';
import {
  PIXIV_HEADERS, PIXIV_SEARCH_MAX_BYTES, SEARCH_CACHE_TTL_MS, SEARCH_CACHE_MAX,
  AUTOCOMPLETE_CACHE_MAX, BOORU_SEARCH_CACHE_TTL, BOORU_SEARCH_CACHE_MAX,
  BOORU_TAG_SAMPLE_SIZE, EXTRA_SEARCH_TAGS, PIXIV_PAGE_SIZE
} from './config.js';

// ── Pixiv 工具函数 ──────────────────────────────────────────────────────

/** 从 Pixiv 图片 URL 提取作品 ID（artwork_id）。 */
export function pixivArtworkId(url) {
  const m = String(url || '').match(/\/(\d{5,})_p\d/);
  return m ? m[1] : null;
}

/** 从 Pixiv 帖子提取原图 URL（image_urls.large）。 */
export function pixivImageUrl(illust) {
  return String(illust?.image_urls?.large || '');
}

/** 从 cfg 读 PXVE 基础配置（baseUrl / timeoutMs / proxyUrl），带默认值。 */
export function pixivCfg(booru) {
  const base = String(booru?.baseUrl || 'https://api.cocomi.eu.org/api/pixiv').trim().replace(/\/+$/, '');
  const timeoutMs = Number(booru?.timeoutMs) > 0 ? Number(booru.timeoutMs) : 25000;
  const proxyUrl = String(booru?.proxyUrl || '').trim() || undefined;
  return { base, timeoutMs, proxyUrl };
}

/** 判断字符串是否含中日韩文字（决定是否需要走标签补全解析）。 */
export function hasCJK(s) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(s);
}

// ── 搜索缓存 ──────────────────────────────────────────────

const SEARCH_CACHE = new Map();

function searchCacheCleanup() {
  if (SEARCH_CACHE.size < SEARCH_CACHE_MAX) return;
  const now = Date.now();
  for (const [k, v] of SEARCH_CACHE) {
    if (v.expiresAt <= now) SEARCH_CACHE.delete(k);
  }
}

/**
 * 带 429 重试 + 多实例轮换 + 5 分钟缓存的 PXVE 搜索。
 * 社区代理会限速（120 req/min/IP），收到 429 先轮换实例，全部 429 才指数退避重试（最多 3 轮）。
 */
export async function fetchPixivSearch(cfg, word, page, order) {
  const { base, timeoutMs, proxyUrl } = pixivCfg(cfg.booru);
  const instances = [base];
  for (const inst of (cfg.booru?.instances || [])) {
    const cleaned = String(inst || '').trim().replace(/\/+$/, '');
    if (cleaned && !instances.includes(cleaned)) instances.push(cleaned);
  }
  const cacheKey = `${word}|${page}|${order || 'default'}`;
  const cached = SEARCH_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  console.log(`[setu] fetchPixivSearch 开始: word=${word} page=${page} order=${order} instances=${instances.length} proxyUrl=${proxyUrl}`);
  const backoffs = [5000, 15000, 30000];
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    for (const instBase of instances) {
      try {
        const u = new URL(`${instBase}/search`);
        u.searchParams.set('word', word);
        u.searchParams.set('page', String(page));
        if (order && order !== 'default') u.searchParams.set('order', order);
        const url = u.toString();
        console.log(`[setu] fetchPixivSearch 请求: ${url.slice(0, 100)}`);
        const bin = await fetchWithProxyFallback(
          (u, p) => safeFetchBinary(u, PIXIV_SEARCH_MAX_BYTES, { timeoutMs, headers: PIXIV_HEADERS, proxy: p }),
          url,
          proxyUrl
        );
        console.log(`[setu] fetchPixivSearch 响应: ${bin.buffer.length} bytes`);
        const data = JSON.parse(bin.buffer.toString('utf8'));
        searchCacheCleanup();
        SEARCH_CACHE.set(cacheKey, { data, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
        return data;
      } catch (error) {
        const msg = String(error?.message ?? error);
        console.warn(`[setu] fetchPixivSearch 失败: ${msg}`);
        // 可轮换/重试的故障 = 限流 429/403/5xx + 网络类失败 + 非法响应（HTML 错误页会让 JSON.parse 抛
        // "Unexpected token"）。之前只认 HTTP 状态码 —— 主实例网络抖动一次就放弃所有备用实例与退避。
        if (!/429|403|500|502|503|timeout|timed out|超时|ECONN|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|fetch failed|socket hang up|非 JSON|Unterminated|Unexpected/i.test(msg)) throw error;
      }
    }
    if (attempt < backoffs.length - 1) {
      console.warn(`[setu] PXVE ${instances.length} 个实例全部失败（限速/网络），${backoffs[attempt]/1000}s 后重试 (${attempt+1}/${backoffs.length})`);
      await sleep(backoffs[attempt]);
    }
  }
  throw new Error('PXVE 搜索不可用：全部实例限速或网络失败，多次重试后仍无响应');
}

// ── 标签补全缓存 ──────────────────────────────────────────────────────────

const AUTOCOMPLETE_CACHE = new Map();
export { AUTOCOMPLETE_CACHE };

function cacheAutocomplete(query, tag) {
  if (AUTOCOMPLETE_CACHE.size >= AUTOCOMPLETE_CACHE_MAX) {
    const first = AUTOCOMPLETE_CACHE.keys().next().value;
    if (first !== undefined) AUTOCOMPLETE_CACHE.delete(first);
  }
  AUTOCOMPLETE_CACHE.set(query, tag);
}
export { cacheAutocomplete };

/**
 * 调 PXVE 标签补全接口，把中文关键词解析成 Pixiv 标签。
 * 返回第一个匹配的标签名，或 null（无匹配 / 请求失败）。
 */
export async function pixivAutocomplete(cfg, query) {
  const raw = String(query || '').trim();
  if (!raw) return null;
  const cached = AUTOCOMPLETE_CACHE.get(raw);
  if (cached !== undefined) return cached;
  const { base, timeoutMs, proxyUrl } = pixivCfg(cfg.booru);
  let url;
  try {
    const u = new URL(`${base}/search_autocomplete`);
    u.searchParams.set('word', raw);
    url = u.toString();
  } catch { return null; }
  const backoffs = [1000, 2000, 4000];
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    try {
      const r = await fetchWithProxyFallback(
        (u, p) => safeFetch(u, { timeoutMs, headers: PIXIV_HEADERS, proxy: p }),
        url,
        proxyUrl
      );
      const d = JSON.parse(r.body || '');
      const tag = d?.tags?.[0]?.name;
      const result = tag && String(tag).trim() ? String(tag).trim() : null;
      cacheAutocomplete(raw, result);
      return result;
    } catch (error) {
      const msg = String(error?.message ?? error);
      if (/429/.test(msg)) {
        console.warn(`[setu] 补全接口限速 HTTP 429，${backoffs[attempt]/1000}s 后重试 (${attempt+1}/${backoffs.length})`);
        await sleep(backoffs[attempt]);
        continue;
      }
      return null;
    }
  }
  console.warn(`[setu] 补全接口限速，${backoffs.length} 次重试后仍为 HTTP 429`);
  return null;
}

// ── 标签解析 ──────────────────────────────────────────────────────────

/** 中文关键词 → booru 英文标签。映射表未命中则原样下发。 */
export function mapKeywordToTags(keyword, tagMap) {
  const raw = String(keyword || '').trim();
  if (!raw) return '';
  const map = tagMap && typeof tagMap === 'object' ? tagMap : {};
  if (map[raw] && String(map[raw]).trim()) return String(map[raw]).trim();
  return raw;
}

/** 解析搜索标签：tagMap 快路径 → 原样下发。 */
export async function resolveSearchTag(cfg, query) {
  const mapped = mapKeywordToTags(query, cfg.booru?.tagMap);
  return mapped || query;
}

/** 把 CJK 关键词翻译补全成日文标签（仅用于原样搜索 0 条时的兜底重试）。 */
export async function translateTag(cfg, query) {
  if (!hasCJK(query)) return null;
  return await pixivAutocomplete(cfg, query);
}

// ── 标签查询 ──────────────────────────────────────────────────────────

/**
 * 查一个标签在图库里有没有内容（只查，不下图）。
 */
export async function lookupBooruTag(cfg, query, category) {
  const booru = cfg.booru || {};
  if (booru.enabled === false) return { found: false, reason: '关键词搜图功能已关闭' };
  const raw = String(query || '').trim();
  if (!raw) return { found: false, reason: '标签不能为空' };

  const resolved = await resolveSearchTag(cfg, raw);
  const { base } = pixivCfg(booru);
  try { new URL(base); } catch { return { found: false, reason: 'setu.booru.baseUrl 不是合法 URL' }; }
  let d;
  try {
    d = await fetchPixivSearch(cfg, resolved, 1);
  } catch (error) {
    return { found: false, reason: `搜索请求失败：${error?.message ?? error}` };
  }
  const illusts = Array.isArray(d.illusts) ? d.illusts : [];
  if (!illusts.length) {
    return { found: false, postCount: 0, query: raw, resolvedTags: resolved, tags: [], sampleSources: [] };
  }

  const tags = [];
  const seen = new Set();
  const sources = [];
  for (const il of illusts.slice(0, BOORU_TAG_SAMPLE_SIZE)) {
    for (const t of (il.tags || [])) {
      const name = String(t?.name || '').trim();
      if (name && !seen.has(name)) { seen.add(name); tags.push(name); }
    }
    const id = il.id;
    if (id && sources.length < 2) {
      const src = `https://www.pixiv.net/artworks/${id}`;
      if (!sources.includes(src)) sources.push(src);
    }
  }

  return {
    query: raw,
    resolvedTags: resolved,
    found: true,
    postCount: illusts.length,
    tags,
    sampleSources: sources
  };
}

// ── Booru 页面抓取 ──────────────────────────────────────────────────────────

/**
 * 抓一页 Pixiv 搜索结果，返回**按质量排序**的原图 URL 列表。失败返回 []。
 */
export async function fetchBooruPage(cfg, tags, limit, offset, soloOnly, femaleOnly, noHorror, singleCharacterOnly) {
  const { base } = pixivCfg(cfg.booru);
  const page = Math.floor(Math.max(0, offset) / PIXIV_PAGE_SIZE) + 1;
  const sortOrder = cfg.booru?.sortOrder || 'popular';
  const searchWord = buildSearchWord(tags, soloOnly, femaleOnly, cfg.booru?.qualityTags);
  let url;
  try {
    url = `${base}/search?word=${encodeURIComponent(searchWord)}&page=${page}`;
  } catch {
    throw new Error('setu.booru.baseUrl 不是合法 URL');
  }
  let d;
  let usedFallback = false;
  try {
    d = await fetchPixivSearch(cfg, searchWord, page, sortOrder);
  } catch (error) {
    if (sortOrder && sortOrder !== 'default') {
      try {
        d = await fetchPixivSearch(cfg, searchWord, page);
        usedFallback = true;
        console.log(`[setu] 「${searchWord}」page=${page}：order=${sortOrder} 失败，去掉 order 重试成功`);
      } catch (error2) {
        console.warn(`[setu] Pixiv 搜索失败「${searchWord}」page=${page}: ${error?.message ?? error}`);
        return [];
      }
    } else {
      console.warn(`[setu] Pixiv 搜索失败「${searchWord}」page=${page}: ${error?.message ?? error}`);
      return [];
    }
  }
  if (!Array.isArray(d.illusts) || !d.illusts.length) {
    if (sortOrder && sortOrder !== 'default') {
      try {
        const retry = await fetchPixivSearch(cfg, searchWord, page);
        if (Array.isArray(retry.illusts) && retry.illusts.length) {
          d = retry;
          usedFallback = true;
          console.log(`[setu] 「${searchWord}」page=${page}：order=${sortOrder} 返回 0 条，去掉 order 重试成功`);
        } else {
          console.log(`[setu] 「${searchWord}」page=${page}：order=${sortOrder} 返回 0 条，去掉 order 重试也 0 条`);
        }
      } catch {
        console.log(`[setu] 「${searchWord}」page=${page}：order=${sortOrder} 返回 0 条，去掉 order 重试失败`);
      }
    }
    if ((!Array.isArray(d.illusts) || !d.illusts.length) && soloOnly) {
      try {
        const searchWordNoSolo = buildSearchWord(tags, false, femaleOnly, cfg.booru?.qualityTags);
        const retry = await fetchPixivSearch(cfg, searchWordNoSolo, page);
        if (Array.isArray(retry.illusts) && retry.illusts.length) {
          d = retry;
          usedFallback = true;
          console.log(`[setu] 「${searchWord}」page=${page}：solo 返回 0 条，去掉 solo 重试成功（客户端过滤兜底）`);
        } else {
          console.log(`[setu] 「${searchWord}」page=${page}：solo 返回 0 条，去掉 solo 重试也 0 条`);
        }
      } catch {
        console.log(`[setu] 「${searchWord}」page=${page}：solo 返回 0 条，去掉 solo 重试失败`);
      }
    }
  }
  let illusts = Array.isArray(d.illusts) ? d.illusts : [];
  const rawCount = illusts.length;
  if (soloOnly) illusts = illusts.filter((il) => !isMultiPersonIllust(il));
  const afterSolo = illusts.length;
  if (femaleOnly) illusts = illusts.filter((il) => !isMaleCharacterIllust(il));
  const afterFemale = illusts.length;
  if (noHorror) illusts = illusts.filter((il) => !isHorrorIllust(il));
  const afterHorror = illusts.length;
  const nsfwOff = cfg.send?.nsfwAllowed === false;
  if (nsfwOff) {
    illusts = illusts.filter((il) => !isR18Illust(il));
    const afterR18 = illusts.length;
    if (cfg.booru?.strictSfw !== false) {
      illusts = illusts.filter((il) => !isR15Illust(il));
      const afterR15 = illusts.length;
      if (rawCount > 0) {
        console.log(`[setu] 搜索「${searchWord}」page=${page}: 原始=${rawCount} → solo后=${afterSolo} → female后=${afterFemale} → horror后=${afterHorror} → r18后=${afterR18} → r15后=${afterR15}`);
      }
    } else if (rawCount > 0) {
      console.log(`[setu] 搜索「${searchWord}」page=${page}: 原始=${rawCount} → solo后=${afterSolo} → female后=${afterFemale} → horror后=${afterHorror} → r18后=${afterR18}`);
    }
  } else if (rawCount > 0) {
    console.log(`[setu] 搜索「${searchWord}」page=${page}: 原始=${rawCount} → solo后=${afterSolo} → female后=${afterFemale} → horror后=${afterHorror}`);
  }
  if (cfg.booru?.onlyR0) {
    illusts = illusts.filter((il) => isR0Only(il));
    const afterR0 = illusts.length;
    if (rawCount > 0) {
      console.log(`[setu] 搜索「${searchWord}」page=${page}: R-0白名单后=${afterR0}`);
    }
  }
  const blockedTags = Array.isArray(cfg.booru?.blockedTags) ? cfg.booru.blockedTags : [];
  if (blockedTags.length > 0) {
    const blockedSet = new Set(blockedTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean));
    illusts = illusts.filter((il) => {
      const names = new Set((il?.tags || []).map((t) => String(t?.name || '').trim().toLowerCase()));
      for (const t of blockedSet) if (names.has(t)) return false;
      return true;
    });
    const afterBlocked = illusts.length;
    if (rawCount > 0) {
      console.log(`[setu] 搜索「${searchWord}」page=${page}: 自定义屏蔽标签后=${afterBlocked}`);
    }
  }
  const qualityTags = String(cfg.booru?.qualityTags || '').trim();
  if (qualityTags) {
    illusts = illusts.filter((il) => hasQualityTag(il, qualityTags));
    const afterQuality = illusts.length;
    if (rawCount > 0) {
      console.log(`[setu] 搜索「${searchWord}」page=${page}: 质量标签后=${afterQuality}`);
    }
  }
  if (singleCharacterOnly) {
    illusts = illusts.filter((il) => !isMultiCharacterIllust(il));
    const afterSingleChar = illusts.length;
    if (rawCount > 0) {
      console.log(`[setu] 搜索「${searchWord}」page=${page}: 单角色过滤后=${afterSingleChar}`);
    }
  }
  if (cfg.booru?.preferQuality !== false) {
    illusts.sort((a, b) => illustScore(b) - illustScore(a));
  }
  const urls = [];
  for (const il of illusts) {
    const u = pixivImageUrl(il);
    if (!/^https?:\/\//.test(u)) continue;
    urls.push(u);
    if (urls.length >= limit) break;
  }
  return urls;
}

// ── 候选取图 ──────────────────────────────────────────────────────────

const searchCache = new Map();

function booruSearchCacheCleanup() {
  if (searchCache.size < BOORU_SEARCH_CACHE_MAX) return;
  const now = Date.now();
  for (const [key, val] of searchCache) {
    if (now - val.ts >= BOORU_SEARCH_CACHE_TTL) searchCache.delete(key);
  }
}

function randomSearchWord(tags, usedSet) {
  const available = EXTRA_SEARCH_TAGS.filter(t => !usedSet.has(t));
  if (!available.length) {
    usedSet.clear();
    return `${tags} ${EXTRA_SEARCH_TAGS[Math.floor(Math.random() * EXTRA_SEARCH_TAGS.length)]}`;
  }
  const pick = available[Math.floor(Math.random() * available.length)];
  usedSet.add(pick);
  return `${tags} ${pick}`;
}

/**
 * 候选取图：多抓几页凑够 candidates×want 个 URL，去重后返回。
 */
export async function fetchBooruCandidates(cfg, source, tags, want, soloOnly, femaleOnly, noHorror, singleCharacterOnly) {
  const per = Math.max(1, Math.trunc(Number(cfg.booru?.candidates) || 12));
  const need = Math.min(90, per * want);
  const sortOrder = cfg.booru?.sortOrder || 'popular';
  const usedTags = new Set();

  const cacheKey0 = `${tags}|${soloOnly}|${femaleOnly}|${noHorror}|${singleCharacterOnly}|${sortOrder}`;
  const cached0 = searchCache.get(cacheKey0);
  if (cached0 && Date.now() - cached0.ts < BOORU_SEARCH_CACHE_TTL) {
    const fresh0 = cached0.urls.filter((u) => !source.isRecent(u));
    if (fresh0.length >= need) return fresh0;
    if (fresh0.length > 0) {
      console.log(`[setu] 「${tags}」原始缓存仅 ${fresh0.length} 条新鲜 URL（需 ${need}），补充搜索...`);
    }
  }

  async function searchWithWord(word) {
    const collected = [];
    const MAX_PAGES = 12;
    for (let page = 1; page <= MAX_PAGES && collected.length < need; page++) {
      const batch = await fetchBooruPage(cfg, word, PIXIV_PAGE_SIZE, (page - 1) * PIXIV_PAGE_SIZE, soloOnly, femaleOnly, noHorror, singleCharacterOnly);
      if (!batch.length) break;
      for (const u of batch) {
        if (collected.includes(u) || source.isRecent(u)) continue;
        collected.push(u);
        if (collected.length >= need) break;
      }
      if (batch.length < PIXIV_PAGE_SIZE) break;
    }
    return collected;
  }

  let collected = [];
  if (!cached0 || Date.now() - cached0.ts >= BOORU_SEARCH_CACHE_TTL) {
    collected = await searchWithWord(tags);
    if (collected.length > 0) {
      booruSearchCacheCleanup();
      searchCache.set(cacheKey0, { urls: collected, ts: Date.now() });
    }
  } else {
    collected = cached0.urls.filter((u) => !source.isRecent(u));
  }
  if (collected.length >= need) return collected;

  for (let attempt = 0; attempt < 3 && collected.length < need; attempt++) {
    const word = randomSearchWord(tags, usedTags);
    const cacheKey = `${word}|${soloOnly}|${femaleOnly}|${noHorror}|${singleCharacterOnly}|${sortOrder}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < BOORU_SEARCH_CACHE_TTL) {
      const fresh = cached.urls.filter((u) => !source.isRecent(u));
      if (fresh.length > 0) {
        console.log(`[setu] 「${tags}」去重耗尽（已有${collected.length}条），附加标签「${word}」缓存命中 ${fresh.length} 条新鲜 URL`);
        collected.push(...fresh);
        continue;
      }
    }
    const more = await searchWithWord(word);
    if (more.length > 0) {
      booruSearchCacheCleanup();
      searchCache.set(cacheKey, { urls: more, ts: Date.now() });
      console.log(`[setu] 「${tags}」去重耗尽（已有${collected.length}条），附加标签「${word}」搜到 ${more.length} 条新鲜 URL`);
      collected.push(...more);
    }
  }
  return collected;
}
