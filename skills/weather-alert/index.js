// 灾害天气预警 —— 查中央气象台正在生效的台风/寒潮/暴雨/高温等预警信号。
//
// ── 数据源 ────────────────────────────────────────────────────────────
//   中央气象台（nmc.cn）公开接口，无需密钥：
//     https://www.nmc.cn/rest/findAlarm?pageNo=1&pageSize=N
//   返回 { msg, code, data:{ page:{ count, list:[{alertid, issuetime, title, url, pic}] } } }
//   · title 形如「广东省深圳市气象台发布台风蓝色预警信号」（地区 + 灾种 + 等级）
//   · url 是相对路径，拼上 https://www.nmc.cn 才是可点的详情页
//
// ── 为什么只做"查询型" ────────────────────────────────────────────────
//   setup(api) 里拿不到 sender/onebot，技能无法定时主动往群里推送预警；
//   提示词片段（promptSections）又必须是同步的，不能在里面预取网络数据。
//   所以：群友问 / 群里聊到灾害天气时，由模型调用本工具查询并转述。

let cfg = () => ({});
let log = () => {};

/** 缓存：{ ts, list, total } —— 缓存期内不重复打气象台接口。total 是全国生效总数。 */
let cache = { ts: 0, list: [], total: 0 };

/** 常见灾种关键词（用于类型识别与摘要聚合）。 */
const KNOWN_TYPES = [
  '台风', '寒潮', '暴雨', '暴雪', '大风', '高温', '低温', '霜冻', '大雾', '霾',
  '沙尘暴', '雷电', '冰雹', '道路结冰', '干旱', '山洪', '地质灾害', '森林火险',
  '强对流', '雷雨大风', '洪涝', '内涝'
];

/** IP 定位缓存：{ ts, province, city } —— 出口 IP 不会频繁变，缓存 6 小时。 */
let locCache = { ts: 0, province: '', city: '' };

/** 预警等级权重：数字越大越紧急。 */
const LEVELS = [
  { name: '红色', weight: 4 },
  { name: '橙色', weight: 3 },
  { name: '黄色', weight: 2 },
  { name: '蓝色', weight: 1 }
];

// ── 纯函数（便于测试） ────────────────────────────────────────────────────

/** 从标题里认出预警等级（红/橙/黄/蓝），认不出返回空串。 */
export function pickLevel(title) {
  const t = String(title ?? '');
  for (const lv of LEVELS) {
    if (t.includes(lv.name)) return lv.name;
  }
  return '';
}

/** 等级权重（排序用；无等级为 0）。 */
export function levelWeight(title) {
  const name = pickLevel(title);
  const hit = LEVELS.find((l) => l.name === name);
  return hit ? hit.weight : 0;
}

/** 从标题里认出灾种（台风/寒潮/…），认不出返回空串。 */
export function pickType(title) {
  const t = String(title ?? '');
  // 长的优先匹配，避免「雷雨大风」被认成「大风」
  const sorted = [...KNOWN_TYPES].sort((a, b) => b.length - a.length);
  for (const type of sorted) {
    if (t.includes(type)) return type;
  }
  return '';
}

/** 多个关键词任一命中即算命中；空条件表示不限制。 */
export function matchesAny(title, keywords) {
  const list = (Array.isArray(keywords) ? keywords : String(keywords ?? '').split(/[,，|]/))
    .map((s) => String(s ?? '').trim())
    .filter(Boolean);
  if (!list.length) return true;
  const t = String(title ?? '');
  return list.some((k) => t.includes(k));
}

/** 按地区 / 灾种过滤预警列表，并按等级、时间排序。 */
export function filterAlerts(list, { regions = '', types = '', limit = 5 } = {}) {
  const regionsArr = String(regions ?? '').split(/[,，|]/).map((s) => s.trim()).filter(Boolean);
  const typesArr = String(types ?? '').split(/[,，|]/).map((s) => s.trim()).filter(Boolean);

  const hit = (list || [])
    .filter((a) => matchesAny(a?.title, regionsArr))
    .filter((a) => matchesAny(a?.title, typesArr))
    .sort((a, b) => {
      const w = levelWeight(b?.title) - levelWeight(a?.title);
      if (w !== 0) return w;
      return String(b?.issuetime ?? '').localeCompare(String(a?.issuetime ?? ''));
    });

  const max = Math.min(Math.max(1, Number(limit) || 5), 20);
  return hit.slice(0, max);
}

/** 预警发布时间距今多久（小时/分钟），给人看的相对时间。 */
export function agoText(issuetime, now = Date.now()) {
  const t = String(issuetime ?? '').replace(/\//g, '-').replace(' ', 'T');
  const ts = new Date(t).getTime();
  if (!Number.isFinite(ts)) return '';
  const min = Math.round((now - ts) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

// ── 本地定位（"默认查本地"的关键）─────────────────────────────────────────
//
// 优先级：用户点名了哪个地区 > 设置里填的本地地区 > 按出口 IP 自动定位 > 全国。
// 自动定位只是兜底（IP 归属可能不准），所以设置里填了就以填的为准。

/** 解析 myip.ipip.net 的返回：location = [国家, 省, 市, 区, 运营商]。纯函数，便于测试。 */
export function parseIpLocation(json) {
  const loc = json?.data?.location;
  if (!Array.isArray(loc)) return { province: '', city: '' };
  return { province: String(loc[1] ?? '').trim(), city: String(loc[2] ?? '').trim() };
}

/** 自动定位所在城市；失败返回空串（由调用方回落到全国，绝不因此报错）。 */
async function locateLocal(fetchFn) {
  if (locCache.city && Date.now() - locCache.ts < 6 * 3600 * 1000) return locCache;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    let json = null;
    try {
      const r = await fetchFn('https://myip.ipip.net/json', {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 QQ-Agent' }
      });
      json = await r.json();
    } finally {
      clearTimeout(timer);
    }
    const { province, city } = parseIpLocation(json);
    if (province || city) {
      locCache = { ts: Date.now(), province, city };
      log(`自动定位到：${province}${city ? ' ' + city : ''}`);
      return locCache;
    }
  } catch (error) {
    log(`自动定位失败：${error?.name === 'AbortError' ? '超时' : (error?.message ?? error)}`);
  }
  return { province: '', city: '' };
}

/** 决定这次查哪个地区：点名 > 设置的本地地区 > IP 自动定位 > 全国。 */
async function resolveRegion(input, fetchFn) {
  const c = cfg();
  const asked = String(input ?? '').trim();
  if (asked) return { region: asked, province: '', source: `地区：${asked}` };

  const local = String(c.localRegion ?? c.focusRegions ?? '').trim();
  if (local) return { region: local, province: '', source: `本地：${local}` };

  if (c.autoLocate !== false) {
    const { province, city } = await locateLocal(fetchFn);
    if (city) return { region: city, province, source: `本地：${city}（自动定位）` };
    if (province) return { region: province, province, source: `本地：${province}（自动定位）` };
  }
  return { region: '', province: '', source: '全国' };
}

/** 单条预警格式化成一行（标题 + 时间 + 详情链接）。 */
export function formatAlert(a, now = Date.now()) {
  const title = String(a?.title ?? '未知预警');
  const time = String(a?.issuetime ?? '');
  const ago = agoText(time, now);
  const url = a?.url ? `https://www.nmc.cn${String(a.url).startsWith('/') ? '' : '/'}${a.url}` : '';
  return `· ${title}${time ? `（${time}${ago ? '，' + ago : ''}）` : ''}${url ? `\n  详情：${url}` : ''}`;
}

/** 全国速览：按灾种聚合计数，并挑出最紧急的几条。 */
export function digest(list, topN = 6) {
  const byType = new Map();
  for (const a of list || []) {
    const type = pickType(a?.title) || '其它';
    const lv = pickLevel(a?.title);
    const cur = byType.get(type) || { type, count: 0, levels: {} };
    cur.count += 1;
    if (lv) cur.levels[lv] = (cur.levels[lv] || 0) + 1;
    byType.set(type, cur);
  }
  const types = [...byType.values()].sort((a, b) => b.count - a.count);
  const urgent = (list || [])
    .slice()
    .sort((a, b) => {
      const w = levelWeight(b?.title) - levelWeight(a?.title);
      if (w !== 0) return w;
      return String(b?.issuetime ?? '').localeCompare(String(a?.issuetime ?? ''));
    })
    .slice(0, Math.max(1, Number(topN) || 6));
  return { types, urgent };
}

// ── 抓取 ──────────────────────────────────────────────────────────────────

/**
 * 拉最新预警列表（带缓存 + 超时；失败抛错由调用方转成友好文案）。
 *
 * minSize：本次至少需要抓多少条。按灾种查询时传大一点 —— 全国同时生效的预警
 * 常有几百条，只抓默认的一百条会把"较早发布但仍在生效"的台风/寒潮漏掉。
 */
async function fetchAlerts(fetchFn, minSize = 0) {
  const c = cfg();
  const ttl = Math.max(0, Number(c.cacheSec) || 0) * 1000;
  if (cache.list.length && ttl > 0 && Date.now() - cache.ts < ttl && cache.list.length >= (minSize || 0)) {
    return cache.list;
  }

  const size = Math.min(Math.max(Number(minSize) || 0, Number(c.pageSize) || 100, 1), 200);
  const url = `https://www.nmc.cn/rest/findAlarm?pageNo=1&pageSize=${size}&_=${Date.now()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetchFn(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 QQ-Agent',
        'Referer': 'https://www.nmc.cn/publish/alarm.html'
      }
    });
    if (!r.ok) throw new Error(`气象台接口返回 ${r.status}`);
    const json = await r.json();
    const list = json?.data?.page?.list;
    if (!Array.isArray(list)) throw new Error('气象台返回数据格式异常');
    cache = { ts: Date.now(), list, total: Number(json?.data?.page?.count) || list.length };
    log(`已抓取 ${list.length} 条预警（全国生效 ${cache.total} 条）`);
    return list;
  } finally {
    clearTimeout(timer);
  }
}

// ── Skill 生命周期 ────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;

  // ── 工具 1：按地区/灾种查询预警 ─────────────────────────────────────
  api.registerTool({
    id: 'weather_alert',
    name: '查询灾害天气预警',
    description: '查询中央气象台正在生效的灾害天气预警（台风、寒潮、暴雨、暴雪、高温、大风、大雾、沙尘暴、道路结冰、地质灾害等）。默认查本地（设置里填的地区，或按网络出口自动定位的城市）；只有当群友点名了别的省市时，才把那个地区传给 region。type 传灾种（如「台风」「寒潮」）。',
    category: 'query',
    icon: '🌀',
    parameters: {
      type: 'object',
      properties: {
        region: { type: 'string', description: '地区关键词，如「深圳」「广东」「浙江」。**仅在群友点名了别的地区时才传**；没点名就留空，让它查本地' },
        type: { type: 'string', description: '灾种关键词，如「台风」「寒潮」「暴雨」「高温」；留空表示不限灾种' },
        limit: { type: 'number', description: '最多返回几条（1-20，默认 5）' }
      }
    },
    async execute(ctx, args) {
      try {
        // 没点名地区时按"本地"查：设置里填的优先，否则用出口 IP 自动定位
        const { region, province, source: src } = await resolveRegion(args?.region, api.fetch);
        let source = src;
        const type = String(args?.type ?? '').trim();
        // 指定了地区或灾种就把抓取量拉满：全国同时生效几百条预警，只抓一百条
        // 会把"发布稍早但仍在生效"的本地预警/台风寒潮漏掉
        const list = await fetchAlerts(api.fetch, (type || region) ? 200 : 0);
        const limit = args?.limit ?? 5;
        let hit = filterAlerts(list, { regions: region, types: type, limit });

        // 城市查不到时降级到省：很多预警由省级/市级台发布，标题里未必带市名
        if (!hit.length && province && region !== province) {
          const wider = filterAlerts(list, { regions: province, types: type, limit });
          if (wider.length) {
            hit = wider;
            source = `本地：${province}（${region} 无预警，已扩大到省级）`;
          }
        }

        if (!hit.length) {
          const what = type ? `${type} ` : '';
          return { content: `当前${source}没有${what}正在生效的预警信号。` };
        }
        const head = `当前${source}生效预警 ${hit.length} 条${type ? `（灾种：${type}）` : ''}：`;
        return {
          content: `${head}\n${hit.map((a) => formatAlert(a)).join('\n')}\n请用简洁口语转述，并保留详情链接；不要编造预警内容。`
        };
      } catch (error) {
        return { content: `查询预警失败：${error?.name === 'AbortError' ? '请求气象台超时' : (error?.message ?? error)}`, isError: true };
      }
    }
  });

  // ── 工具 2：全国预警速览 ────────────────────────────────────────────
  api.registerTool({
    id: 'weather_alert_digest',
    name: '全国预警速览',
    description: '汇总全国当前生效的灾害天气预警：按灾种统计数量，并列出最紧急（红/橙）的几条。群友问「全国天气怎么样」「现在有哪些预警」「台风寒潮情况」时使用。',
    category: 'query',
    icon: '📊',
    parameters: {
      type: 'object',
      properties: {
        topN: { type: 'number', description: '列出最紧急的几条（1-10，默认 6）' }
      }
    },
    async execute(ctx, args) {
      try {
        const list = await fetchAlerts(api.fetch);
        if (!list.length) return { content: '当前中央气象台没有任何生效中的灾害天气预警。' };
        const { types, urgent } = digest(list, args?.topN ?? 6);
        const total = cache.total || list.length;
        const stat = types.slice(0, 12)
          .map((t) => {
            const lv = Object.entries(t.levels).sort((a, b) => levelWeight(`【${b[0]}`) - levelWeight(`【${a[0]}`))
              .map(([k, v]) => `${k}${v}`).join('/');
            return `${t.type} ${t.count} 条${lv ? `（${lv}）` : ''}`;
          })
          .join('、');
        return {
          content: `全国当前生效预警共 ${total} 条（本次分析最新 ${list.length} 条）。分类：${stat}。\n最紧急的 ${urgent.length} 条：\n${urgent.map((a) => formatAlert(a)).join('\n')}\n请用简洁口语概括，重点提示红/橙色预警；不要编造预警内容。`
        };
      } catch (error) {
        return { content: `汇总预警失败：${error?.name === 'AbortError' ? '请求气象台超时' : (error?.message ?? error)}`, isError: true };
      }
    }
  });
}

export function available() { return true; }

export const internals = {
  pickLevel, levelWeight, pickType, matchesAny, filterAlerts, agoText, formatAlert, digest, parseIpLocation
};
