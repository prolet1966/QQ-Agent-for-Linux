// 免费模型自动探测 —— 找出「现在真的能白嫖出图」的接口，配置好并轮换着用。
//
// ── 为什么单独一个文件 ───────────────────────────────────────────────────
// 探测要联网、要并发、要退避、要落盘；出图主流程（index.js 的请求/下载/发送）
// 已经 800 行且每一步都涉及钱。把探测混进去会让那条流程没法读，也没法单测。
//
// ── 三条硬规则（都跟钱有关，改动前先读完）─────────────────────────────
//   1. **只把「探测时真的出了一张图」的源放进池子**。不看文档、不信静态清单 ——
//      平台的免费层随时可能改成要 key、限流、或者悄悄下线（实测 kontext 就是
//      500：只有 enter.pollinations.ai 的 stars 用户能用）。
//   2. **池子里不写明文 key**，只记「key 该从哪取」（env:XXX / settings:xxx），
//      用的时候现取现用。池子文件在 DATA_DIR 下，会被备份/同步流程扫到。
//   3. **探测不到就如实置空**，绝不悄悄回落到用户手填的接口。回落 = 可能拿
//      付费模型出图，而用户明确要求"探测不到就不用付费模型"。
//
// ── 为什么大部分源要用户自己的 key ──────────────────────────────────────
// 免注册就能用的公开免费层只有 Pollinations 这类聚合站（实测本机可达、200、
// 约 1~2 秒出图）。硅基流动/智谱/百炼的"免费档"都必须有账号 key —— 程序不能
// 也不该替用户注册账号。所以这类源只在**本机已经有 key**（环境变量或设置项
// freeKeys）时才进池，并且明确标注 tier=free-quota 让人知道它的成本性质。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from '../../src/config.js';

// ── 探测参数（刻意用最小图：便宜、快、够证明"能出图"）──────────────────────
const PROBE_PROMPT = 'a red apple on a white table';
const PROBE_SEED = 20260929;          // 固定 seed：同 seed 才能识别"别名后端"
const PROBE_SIZE = { w: 128, h: 128 };
const PROBE_TIMEOUT_MS = 25000;
const PROBE_MIN_BYTES = 512;          // 小于这个数基本不是有效图片
const POOL_VERSION = 1;

/** 冷却与失效：一次失败不要立刻放弃，也不要永久拉黑。 */
const FAIL_COOLDOWN_BASE_MS = 5 * 60 * 1000;      // 第 1 次失败冷却 5 分钟
const FAIL_COOLDOWN_MAX_MS = 60 * 60 * 1000;      // 最多冷却 1 小时
const FAIL_DISABLE_AFTER = 3;                      // 连挂 3 次 → 标记不可用，等下次探测
// 限流/配额是另一回事：**源还活着**，只是刚被用太勤。冷却要久得多，但绝不能
// 因为"用得太勤"就把它判成不可用 —— 那等于自己把唯一的免费源关掉了。
// （实测 Pollinations 匿名层连着出 3 张就回 402，所以冷却从 15 分钟起步。）
const THROTTLE_COOLDOWN_BASE_MS = 15 * 60 * 1000;
const THROTTLE_COOLDOWN_MAX_MS = 3 * 60 * 60 * 1000;
const KEY_QUOTA_REVALIDATE_MS = 24 * 3600 * 1000; // 要花额度的源，24 小时才复探一次
/**
 * 免 key 源的"礼貌间隔"。
 *
 * 实测（2026-09-29）：Pollinations 匿名层是**按张算额度**的 —— 1 张 256 小图
 * (5.2s) + 1 张 512 (3.6s) 之后，接下来三次 512 全是秒回 402 `{}`。也就是
 * 大约十几秒到几十秒才有一张的额度。所以：
 *   · 每成功出一张，slotReadyAt 往后推 POLITE_GAP_MS（下次出图前先等一等）；
 *   · 探测本身也占一张（128×128），探完同样要等 —— 否则"探测成功 + 紧接着那次
 *     画图"必然 402，用户第一次用就撞墙；
 *   · 真撞到 402 时只先等 QUOTA_SLOT_MS（90 秒），**并且只有"礼貌间隔已经
 *     等过了还是 402"才算升级**（连续撞墙说明匿名额度窗口比我们想的更小）。
 * 这个间隔是"软"的：源仍然算可用（available 照常显示），只是取用时稍等。
 */
const POLITE_GAP_MS = 12 * 1000;
const QUOTA_SLOT_MS = 90 * 1000;
const POLITE_GAP_MAX_WAIT_MS = 60 * 1000;   // 最多为礼貌间隔等这么久，超了就直接试
/** 探测刚成功过、后来又失效的宽限期：瞬时失败不清空，24 小时后再看。 */
const PROBE_GRACE_MS = 6 * 3600 * 1000;
/** 瞬时失败（网络/超时/限流）：不该抹掉一个刚刚还好用的源。 */
const TRANSIENT_PROBE_RE = /超时|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|connect|网络|连接|reset|\b5\d\d\b|\b429\b|\b402\b|限流|配额|quota|rate|busy|繁忙/i;
/**
 * 免 key 源的探测重试间隔。
 *
 * 实测（2026-09-29）：免 key 源的匿名额度大约 5~15 秒一张，所以**探测必须能重试** ——
 * 单次探测失败有相当概率只是"这 15 秒里额度用完了"或"Cloudflare 边缘抖了一下"，
 * 一次失败就判死刑的话，唯一的免费源会被这种噪声停摆整整一个探测周期（默认 1 小时），
 * 用户那边表现就是"明明有免费模型，却一直说没探测到"。
 * 间隔取 5s / 15s，正好落在匿名额度窗口的量级上。
 * ⚠️ 只对瞬时失败重试：401/403（要 key）、连接被拒这类确定性问题重试只是白烧时间。
 */
const PROBE_RETRY_DELAYS = [5000, 15000];
/** 空池（可用 0 个）且上次失败属瞬时 → 提前复探，别干等一整个周期。 */
export const EMPTY_POOL_RETRY_MS = 3 * 60 * 1000;
/** 确定性失败（免费层没了/要钱/没权限）：立刻判死，不给宽限。 */
const DEFINITIVE_PROBE_RE = /\b40[13]\b|需要.*key|需.*授权|未授权|免费.*(关闭|结束|取消|不再)|requires?.*(paid|subscription|key)/i;
/** 只是被限流/配额挡了一下 —— 源本身没坏，不该判死。 */
const THROTTLE_RE = /\b402\b|\b429\b|限流|配额|quota|rate.?limit|too many/i;

/**
 * 免费源清单。
 *
 * kind：
 *   'image-get'  GET {url}/{prompt}?w&h&model → 直接返回图片字节（非 OpenAI 协议）
 *   'openai'     POST {baseUrl}/images/generations（OpenAI 兼容）
 *
 * tier：
 *   'keyless'     完全零配置（免注册、免 key）
 *   'free-quota'  平台免费档，需要用户自己的 key（探测会消耗极少量免费额度）
 */
export const FREE_SOURCES = [
  {
    id: 'pollinations-flux',
    name: 'FLUX',
    provider: 'Pollinations',
    tier: 'keyless',
    free: true,
    kind: 'image-get',
    url: 'https://image.pollinations.ai/prompt/{prompt}',
    model: 'flux',
    // 实测（2026-09-29，同 prompt+seed 逐个比对字节）：
    //   flux / turbo / sana / gptimage / qwen-image / flux-realism / 不传 model
    //   → 返回的是**字节完全相同**的一张图（JPEG magic ffd8，md5 一致）。
    //   也就是说这个免费层**忽略 model 参数**，所有模型名共用一个后端 ——
    //   所以清单里只留 flux 一条：多留的每条探测都要白烧一张免费额度
    //   （而这个匿名层实测连出 3 张就开始回 402 限流）。
    //   哪天它开始真的按 model 分流，往下加一条即可，别名去重会自动放它进池。
    //   另：kontext 会明确 500（只有 enter.pollinations.ai 的 stars 付费档能用），
    //   新端点 gen.pollinations.ai 已经要 key（401），都不算免费源。
    note: '公开免费层，免注册免 key，实测约 1~3 秒出图。注意它有匿名限流，短时间连出多张会回 402。',
    sizes: ['512x512', '768x768', '1024x1024', '1024x1536']
  },
  {
    id: 'siliconflow-flux-schnell',
    name: 'FLUX.1-schnell',
    provider: '硅基流动 SiliconFlow',
    tier: 'free-quota',
    free: true,
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'black-forest-labs/FLUX.1-schnell',
    keySlot: 'siliconflow',
    envKeys: ['SILICONFLOW_API_KEY'],
    note: '1~4 步快速出图，硅基流动免费档（约 $0.0014/张）。需要你自己的 key。',
    sizes: ['512x512', '768x768', '1024x1024', '1024x1536']
  },
  {
    id: 'siliconflow-kolors',
    name: 'Kolors（可图）',
    provider: '硅基流动 SiliconFlow',
    tier: 'free-quota',
    free: true,
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Kwai-Kolors/Kolors',
    keySlot: 'siliconflow',
    envKeys: ['SILICONFLOW_API_KEY'],
    note: '快手可图，中文提示友好，硅基流动免费档。需要你自己的 key。',
    sizes: ['512x512', '768x768', '1024x1024']
  },
  {
    id: 'zhipu-cogview',
    name: 'CogView-4',
    provider: '智谱 AI',
    tier: 'free-quota',
    free: true,
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'cogview-4',
    keySlot: 'zhipu',
    envKeys: ['ZHIPUAI_API_KEY'],
    note: 'GLM 系文生图，智谱开放平台注册送额度，额度用完即止（不会自动扣费充值）。',
    sizes: ['1024x1024']
  },
  {
    id: 'dashscope-qwen-image',
    name: 'Qwen-Image（通义千问）',
    provider: '阿里云百炼',
    tier: 'free-quota',
    free: true,
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-image',
    keySlot: 'dashscope',
    envKeys: ['DASHSCOPE_API_KEY'],
    note: '中文提示词最强的一档，百炼新用户有免费额度；额度用完需自行充值（探测只出 512 小图）。',
    sizes: ['512x512', '1024x1024', '1328x1328']
  },
  {
    id: 'hunyuan-image',
    name: '混元文生图',
    provider: '腾讯云',
    tier: 'free-quota',
    free: true,
    kind: 'openai',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    model: 'hunyuan-image',
    keySlot: 'hunyuan',
    envKeys: ['HUNYUAN_API_KEY', 'TENCENTCLOUD_SECRET_ID'],
    note: '腾讯混元生图，新用户有免费额度。混元比其它家慢（实测探测 ~1.2s 才连上）。',
    sizes: ['1024x1024']
  },
  {
    id: 'modelscope-qwen-image',
    name: 'Qwen-Image（魔搭）',
    provider: 'ModelScope 魔搭',
    tier: 'free-quota',
    free: true,
    kind: 'openai',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    model: 'Qwen/Qwen-Image',
    keySlot: 'modelscope',
    envKeys: ['MODELSCOPE_API_KEY', 'MODELSCOPE_TOKEN'],
    note: '魔搭社区免费推理 API，匿名不可用，需要免费 token。',
    sizes: ['512x512', '1024x1024']
  }
];

// ── 池子读写 ──────────────────────────────────────────────────────────────
function poolFile() {
  return path.join(DATA_DIR, 'image-generate', 'free-pool.json');
}

function emptyPool() {
  return { version: POOL_VERSION, updatedAt: '', cursor: 0, sources: [] };
}

/** 读池子。任何异常都退回空池 —— 池子是缓存，不是权威，坏了不该拖垮出图。 */
export function loadPool() {
  try {
    const raw = fs.readFileSync(poolFile(), 'utf8');
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object') return emptyPool();
    return {
      version: Number(json.version) || POOL_VERSION,
      updatedAt: String(json.updatedAt || ''),
      cursor: Number(json.cursor) || 0,
      sources: Array.isArray(json.sources) ? json.sources : []
    };
  } catch {
    return emptyPool();
  }
}

export function savePool(pool) {
  try {
    const file = poolFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 600：池子里有 key 的**来源描述**，虽然不含明文，也别让别的账号读到
    fs.writeFileSync(file, JSON.stringify(pool, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function clearPool() {
  try { fs.unlinkSync(poolFile()); } catch { /* 本来就没有也算清干净了 */ }
  return emptyPool();
}

function findEntry(pool, id) {
  return (pool.sources || []).find((s) => s.id === id) || null;
}

// ── key 解析：环境变量优先，其次用户填的 freeKeys ────────────────────────────
/**
 * @returns {{ key: string, from: string }} from 形如 'env:SILICONFLOW_API_KEY'
 *          / 'settings:freeKeys.siliconflow' / ''（不需要 key）
 */
export function resolveKey(source, settings = {}) {
  if (!source?.requiresKey && source?.tier !== 'free-quota') return { key: '', from: '' };
  for (const name of source.envKeys || []) {
    const value = String(process.env[name] || '').trim();
    if (value) return { key: value, from: `env:${name}` };
  }
  const slot = String(source.keySlot || '').trim();
  if (slot) {
    const bag = settings?.freeKeys;
    let map = {};
    if (typeof bag === 'string') { try { map = JSON.parse(bag) || {}; } catch { map = {}; } }
    else if (bag && typeof bag === 'object') map = bag;
    const value = String(map[slot] || '').trim();
    if (value) return { key: value, from: `settings:freeKeys.${slot}` };
  }
  return { key: '', from: '' };
}

// ── 单源探测 ──────────────────────────────────────────────────────────────
/**
 * 真的出一张图（128×128）来判断能不能用。
 * 只探 HTTP 状态码是自欺欺人：平台经常先回 200 再在 body 里说"要登录"。
 */
/**
 * 401/403 = 这个端点要我们没有的凭据（免费层改成要 key 了 / 额度要付费开）。
 * 归类成 needsKey，UI 才能给出"去填 key"而不是"网络不通"的提示 —— 这两个的
 * 下一步动作完全不同，不该混成一句话。
 */
function authVerdict(status) {
  return (status === 401 || status === 403) ? { ok: false, needsKey: true } : { ok: false };
}

export async function probeSource(source, { fetch: doFetch, settings = {}, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const base = {
    id: source.id, name: source.name, provider: source.provider, tier: source.tier,
    kind: source.kind, model: source.model, baseUrl: source.baseUrl || '', url: source.url || '',
    free: true, checkedAt: new Date().toISOString()
  };

  if (typeof doFetch !== 'function') return { ...base, ok: false, reason: '宿主未授权联网（清单需声明 web_fetch）' };

  const { key, from } = resolveKey(source, settings);
  if (source.tier === 'free-quota' && !key) {
    return { ...base, ok: false, needsKey: true, keyFrom: '', reason: `需要你自己的 key（设置项 freeKeys.${source.keySlot || '?'} 或环境变量 ${(source.envKeys || []).join('/')}）` };
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    if (source.kind === 'image-get') {
      const url = source.url.replace('{prompt}', encodeURIComponent(PROBE_PROMPT))
        + `?width=${PROBE_SIZE.w}&height=${PROBE_SIZE.h}&model=${encodeURIComponent(source.model)}`
        + `&nologo=true&seed=${PROBE_SEED}`;
      const res = await doFetch(url, { signal: timeout, redirect: 'follow' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ...base, ...authVerdict(res.status), keyFrom: from, ms: Date.now() - started, reason: `HTTP ${res.status}：${truncate(errorText(text), 120)}` };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < PROBE_MIN_BYTES) {
        return { ...base, ok: false, keyFrom: from, ms: Date.now() - started, reason: `只回了 ${buf.length} 字节，不像图片` };
      }
      return {
        ...base, ok: true, keyFrom: from, ms: Date.now() - started,
        bytes: buf.length,
        mime: String(res.headers.get('content-type') || '').split(';')[0] || '',
        // 指纹用来识别"别名后端"：同 seed 同 prompt 返回同一张图 = 同一个模型
        fingerprint: createHash('md5').update(buf).digest('hex')
      };
    }

    // OpenAI 兼容：POST /images/generations
    const endpoint = `${String(source.baseUrl || '').replace(/\/+$/, '')}/images/generations`;
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: source.model, prompt: PROBE_PROMPT, n: 1, size: '512x512', response_format: 'b64_json' }),
      signal: timeout
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return { ...base, ...authVerdict(res.status), keyFrom: from, ms: Date.now() - started, reason: `HTTP ${res.status}：${truncate(errorText(text), 120)}` };
    }
    const json = safeParse(text);
    const first = json?.data?.[0];
    if (!first || (!first.b64_json && !first.url)) {
      return { ...base, ok: false, keyFrom: from, ms: Date.now() - started, reason: `接口没返回图片：${truncate(text, 120)}` };
    }
    return {
      ...base, ok: true, keyFrom: from, ms: Date.now() - started,
      fingerprint: first.b64_json
        ? createHash('md5').update(String(first.b64_json).slice(0, 4096)).digest('hex')
        : `url:${first.url}`
    };
  } catch (error) {
    const reason = /abort|timeout/i.test(String(error?.name || '') + String(error?.message || ''))
      ? `探测超时（${Math.round(timeoutMs / 1000)} 秒）`
      : truncate(describeCause(error), 140);
    return { ...base, ok: false, keyFrom: from, ms: Date.now() - started, reason };
  }
}

// ── 全量发现 ──────────────────────────────────────────────────────────────
/**
 * 并发探测所有候选源，写回池子。
 *
 * @param {object}   opts
 * @param {Function} opts.fetch   宿主的 api.fetch
 * @param {object}   opts.settings 当前技能设置（取 freeKeys）
 * @param {number}   opts.minIntervalMs  池子还在有效期内就整体跳过（省流量）
 * @param {boolean}  opts.force   忽略有效期，强制重探
 * @returns {Promise<{ pool: object, probed: number, reused: number, available: number, skipped: boolean }>}
 */
/**
 * 带重试的单源探测。
 *
 * 重试只加在"**瞬时**失败"上，且只对免 key 源有意义：
 *   · 免 key 源：探测失败多半是"这 15 秒额度用完了"或边缘节点抖了一下，
 *     等 5~15 秒再试大概率就通了（代价只是多等一会儿，不花钱）。
 *   · 要 key 的源：额度/配额是按天的，失败基本是确定性原因（key 错、模型名错），
 *     重试既没用又会白烧用户额度 —— 一律不重试。
 */
async function probeWithRetry(source, opts) {
  let result = await probeSource(source, opts);
  const retryable = source.tier === 'keyless'
    && !result.ok
    && !result.needsKey
    && TRANSIENT_PROBE_RE.test(String(result.reason || ''));
  if (!retryable) return result;
  for (const delay of PROBE_RETRY_DELAYS) {
    await new Promise((r) => setTimeout(r, delay));
    const again = await probeSource(source, opts);
    if (again.ok) return { ...again, retried: true };
    result = again;
    if (!TRANSIENT_PROBE_RE.test(String(result.reason || ''))) break;
  }
  return result;
}

export async function discoverFree({ fetch: doFetch, settings = {}, minIntervalMs = 0, force = false } = {}) {
  const prev = loadPool();
  if (!force && prev.updatedAt && Date.now() - Date.parse(prev.updatedAt) < minIntervalMs) {
    return { pool: prev, probed: 0, reused: prev.sources.length, available: healthyCount(prev), skipped: true };
  }

  // 要花额度的源不必每次都重探：上次成功过就沿用（24 小时内），省免费额度
  const fresh = new Map();
  for (const entry of prev.sources || []) {
    const age = Date.now() - Date.parse(entry.lastOkAt || entry.checkedAt || 0);
    const limit = entry.tier === 'free-quota' ? KEY_QUOTA_REVALIDATE_MS : minIntervalMs || 0;
    if (entry.ok && Number.isFinite(age) && age >= 0 && age < limit) fresh.set(entry.id, entry);
  }

  const results = await Promise.all(FREE_SOURCES.map(async (source) => {
    const cached = fresh.get(source.id);
    if (cached) return { ...cached, reused: true };
    const probed = await probeWithRetry(source, { fetch: doFetch, settings });
    const old = findEntry(prev, source.id);
    // 宽限：刚刚（6 小时内）还好用、这次因为网络/限流没探通 —— 继续用着它。
    // 不这么做的后果很实际：一次抖动就把唯一的免费源踢出池子，用户那边直接
    // "未探测到免费模型"没法画图（实测 Pollinations 一限流就 402 + 连不上）。
    if (!probed.ok && old?.ok && !DEFINITIVE_PROBE_RE.test(String(probed.reason || ''))) {
      const lastOk = Date.parse(old.lastOkAt || '');
      if (Number.isFinite(lastOk) && Date.now() - lastOk < PROBE_GRACE_MS) {
        const minsAgo = Math.max(1, Math.round((Date.now() - lastOk) / 60000));
        return {
          ...probed, ok: true, degraded: true,
          reason: `${minsAgo} 分钟前刚探通，本次探测失败（${truncate(probed.reason, 80)}），继续沿用`,
          fails: 0, cooldownUntil: 0, throttles: 0,
          lastOkAt: old.lastOkAt, aliasOf: ''
        };
      }
    }
    // 保留轮换状态，别让每次探测把冷却/失败计数清零
    return {
      ...probed,
      degraded: false,
      fails: probed.ok ? 0 : (old?.fails || 0),
      throttles: probed.ok ? 0 : (old?.throttles || 0),
      cooldownUntil: probed.ok ? 0 : (old?.cooldownUntil || 0),
      lastOkAt: probed.ok ? new Date().toISOString() : (old?.lastOkAt || ''),
      aliasOf: ''
    };
  }));

  // 别名去重：同一次探测里指纹相同 = 同一个后端，轮换没有意义，只留第一个
  const seen = new Map();
  for (const entry of results) {
    if (!entry.ok || !entry.fingerprint) continue;
    const first = seen.get(entry.fingerprint);
    if (first) {
      entry.ok = false;
      entry.aliasOf = first;
      entry.reason = `与「${first}」是同一后端（别名），不重复入池`;
    } else {
      seen.set(entry.fingerprint, entry.name || entry.id);
    }
  }

  // 探测**本身也占一张**免 key 额度。探完把取用时间往后推一个礼貌间隔，否则
  // "探测成功 → 紧接着用户第一次画图"这一对里必有一个吃 402（首次使用就撞墙）。
  // ⚠️ degraded（本次没探通、沿用上次结果）的条目不要改 reason —— 那会把
  // "沿用 X 分钟前的成功结果"这个关键信息覆盖成一个看起来很正常的原因。
  const probedAt = Date.now();
  for (const entry of results) {
    if (!entry.ok || entry.tier !== 'keyless' || entry.aliasOf) continue;
    entry.slotReadyAt = Math.max(Number(entry.slotReadyAt) || 0, probedAt + POLITE_GAP_MS);
    if (!entry.degraded) entry.reason = '刚探测通过（已用掉一次匿名额度），稍等片刻即可出图';
  }

  const pool = {
    version: POOL_VERSION,
    updatedAt: new Date().toISOString(),
    cursor: Number(prev.cursor) || 0,
    sources: results.map(({ reused, ...rest }) => rest)
  };
  savePool(pool);
  return {
    pool,
    probed: results.filter((r) => !r.reused).length,
    reused: results.filter((r) => r.reused).length,
    available: healthyCount(pool),
    skipped: false
  };
}

function healthyCount(pool) {
  const now = Date.now();
  return (pool.sources || []).filter((s) => s.ok && !s.aliasOf
    && !(s.cooldownUntil && s.cooldownUntil > now)).length;
}

// ── 轮换 ──────────────────────────────────────────────────────────────────
/**
 * 按轮换顺序取接下来要用的源，并把游标往前推一格 —— 每次出图自动换下一个，
 * 免费额度和限流就被平摊到所有可用免费模型上（次第用之）。
 *
 * @param {number} limit 本次最多取几个（第一个失败就顺延到下一个）
 * @returns {object[]} 池条目数组（顺序即尝试顺序）
 */
export function pickRotated(pool, limit = 1) {
  const now = Date.now();
  const healthy = (pool?.sources || []).filter((s) => s.ok && !s.aliasOf && !s.needsKey
    && !(s.cooldownUntil && s.cooldownUntil > now));
  if (!healthy.length) return [];
  const n = healthy.length;
  const start = ((Number(pool.cursor) || 0) % n + n) % n;
  const take = Math.max(1, Math.min(limit, n));
  const out = [];
  for (let i = 0; i < take; i += 1) out.push(healthy[(start + i) % n]);
  pool.cursor = (start + 1) % n;      // 游标推进：下次从下一个开始
  return out;
}

export function markSuccess(pool, id) {
  const entry = findEntry(pool, id);
  if (!entry) return pool;
  entry.fails = 0;
  entry.throttles = 0;
  entry.cooldownUntil = 0;
  entry.ok = true;
  entry.degraded = false;
  entry.lastOkAt = new Date().toISOString();
  entry.reason = entry.aliasOf ? entry.reason : '可用';
  // 免 key 源刚出了一张图 → 匿名额度要缓一下（下一次取用先等 POLITE_GAP_MS）
  if (entry.tier === 'keyless') entry.slotReadyAt = Date.now() + POLITE_GAP_MS;
  savePool(pool);
  return pool;
}

/**
 * 失败处理。免费源失败只浪费几十秒、不花钱，所以可以放心顺延到下一个 ——
 * 但要把「限流」和「坏了」分开：
 *   · 限流/配额（402/429/…）→ 源还活着，只是要等：先等 90 秒再取，**且只有
 *     "礼貌间隔已经等过了还是 402"才升级**（连着撞墙说明匿名额度窗口更小）。
 *   · 真故障 → 指数退避；连挂 3 次才标记不可用，等下次探测再复活。
 */
export function markFailure(pool, id, reason) {
  const entry = findEntry(pool, id);
  if (!entry) return pool;
  const text = String(reason || '');
  entry.lastError = truncate(text, 160);
  entry.checkedAt = new Date().toISOString();

  if (THROTTLE_RE.test(text)) {
    // 刚成功过（3 分钟内）却撞上限流 → 多半就是"刚用掉一张"，等一下就好，不升级
    const lastOk = Date.parse(entry.lastOkAt || '');
    const justUsed = Number.isFinite(lastOk) && Date.now() - lastOk < 3 * 60 * 1000;
    if (!justUsed) entry.throttles = (Number(entry.throttles) || 0) + 1;
    entry.fails = 0;
    entry.ok = true;              // 源还在，只是现在不让我们用
    const cool = justUsed
      ? QUOTA_SLOT_MS
      : Math.min(THROTTLE_COOLDOWN_MAX_MS, THROTTLE_COOLDOWN_BASE_MS * Math.max(1, entry.throttles));
    // 402 是**秒回**的（实测 1.8s），所以别用硬冷却把源整个踢出池子（那会让
    // available 归零、UI 报"没有可用源"）。软间隔 + 仍在池里才是对的。
    entry.slotReadyAt = Date.now() + cool;
    entry.cooldownUntil = 0;
    entry.reason = `被限流/配额限制，${Math.round(cool / 1000)} 秒后再试`
      + (entry.throttles > 1 ? `（连续第 ${entry.throttles} 次）` : '');
    savePool(pool);
    return pool;
  }

  entry.throttles = 0;
  entry.fails = (Number(entry.fails) || 0) + 1;
  const cooldown = Math.min(FAIL_COOLDOWN_MAX_MS, FAIL_COOLDOWN_BASE_MS * (2 ** (entry.fails - 1)));
  entry.cooldownUntil = Date.now() + cooldown;
  if (entry.fails >= FAIL_DISABLE_AFTER) {
    entry.ok = false;
    entry.reason = `连续 ${entry.fails} 次失败：${entry.lastError}`;
  } else {
    entry.reason = `第 ${entry.fails} 次失败，冷却 ${Math.round(cooldown / 60000)} 分钟`;
  }
  savePool(pool);
  return pool;
}

/** 取用某个源之前还要为礼貌间隔等多久（毫秒；0 = 不用等）。 */
export function slotWaitMs(pool, id) {
  const entry = findEntry(pool, id);
  const wait = (Number(entry?.slotReadyAt) || 0) - Date.now();
  return wait > 0 ? Math.min(wait, POLITE_GAP_MAX_WAIT_MS) : 0;
}

/** 免 key 源在一次调用里连出多张时，两张之间的间隔（毫秒）。 */
export function politeGapMs(pool, id) {
  const entry = findEntry(pool, id);
  return entry?.tier === 'keyless' ? POLITE_GAP_MS : 0;
}

// ── 给 UI 的摘要（不含任何 key 明文）──────────────────────────────────────
export function poolSummary(pool = loadPool()) {
  const now = Date.now();
  const sources = (pool.sources || []).map((s) => ({
    id: s.id, name: s.name, provider: s.provider, model: s.model, tier: s.tier,
    kind: s.kind, baseUrl: s.baseUrl || '', needsKey: !!s.needsKey, keyFrom: s.keyFrom || '',
    ok: !!s.ok && !s.aliasOf, aliasOf: s.aliasOf || '', degraded: !!s.degraded,
    reason: s.reason || (s.ok ? '可用' : '未探测'),
    ms: Number(s.ms) || 0,
    cooling: !!(s.cooldownUntil && s.cooldownUntil > now),
    cooldownLeftMin: s.cooldownUntil && s.cooldownUntil > now
      ? Math.max(1, Math.round((s.cooldownUntil - now) / 60000)) : 0,
    // 软间隔：源仍算可用，只是取用前要等几秒（免 key 源的匿名额度按张算）
    waitSec: s.slotReadyAt && s.slotReadyAt > now
      ? Math.ceil((s.slotReadyAt - now) / 1000) : 0,
    lastOkAt: s.lastOkAt || '', checkedAt: s.checkedAt || ''
  }));
  const healthy = sources.filter((s) => s.ok && !s.cooling);
  const cooling = sources.filter((s) => s.cooling);
  return {
    updatedAt: pool.updatedAt || '',
    cursor: Number(pool.cursor) || 0,
    available: healthy.length,
    cooling: cooling.length,
    total: sources.length,
    // 一个都用不了时，把"为什么"算清楚 —— 用户看到的应该是「限流了，等 12 分钟」
    // 而不是笼统的"未探测到免费模型"，两者的下一步动作完全不同
    hint: healthy.length ? '' : hintFor(sources, cooling),
    order: healthy.map((s) => s.id),
    current: healthy.length ? healthy[Number(pool.cursor) % healthy.length]?.id || '' : '',
    sources
  };
}

function hintFor(sources, cooling) {
  if (!sources.length) return '还没探测过，点「立即探测」试一次。';
  if (cooling.length) {
    const mins = Math.max(...cooling.map((s) => s.cooldownLeftMin));
    return `免费源都在冷却中（限流或刚才失败过），最早 ${mins} 分钟后可用 —— 源没坏，不用改配置。`;
  }
  if (sources.every((s) => s.needsKey)) {
    return '免 key 的源没探通，剩下的都要你自己的 key：'
      + '把 key 填进设置项「免费额度平台 Key」（或用环境变量），再点「立即探测」。';
  }
  if (sources.some((s) => s.aliasOf)) return '探到的源都指向同一个后端，没有可轮换的免费模型。';
  return '未探测到可用的免费模型（网络不通，或这些平台的免费层已关闭）。';
}

// ── 小工具 ────────────────────────────────────────────────────────────────
function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function errorText(text) {
  const json = safeParse(text);
  const raw = json?.error?.message ?? json?.error ?? json?.message ?? json?.msg ?? json?.detail;
  return typeof raw === 'string' ? raw : (raw ? JSON.stringify(raw) : '');
}
/** fetch 失败只有一句 "fetch failed"，真原因在 cause 链里。 */
function describeCause(error, depth = 0) {
  if (!error || depth > 3) return String(error?.message ?? error ?? '未知错误');
  const code = error.code ? `[${error.code}] ` : '';
  const own = `${code}${String(error.message || error.name || error)}`.trim();
  const cause = error.cause ? ` ← ${describeCause(error.cause, depth + 1)}` : '';
  return `${own}${cause}`.trim();
}
