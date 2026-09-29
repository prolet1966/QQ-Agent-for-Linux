// 文生图 Skill —— 把自然语言描述渲染成图片，并直接发到当前会话。
//
// ── 设计要点（为什么这么写）──────────────────────────────────────────────
//   · Base URL / API Key / 模型 id 全部走配置项，代码里不写死任何地址与密钥
//   · 联网先声明 permissions: ["web_fetch"]，再用 api.fetch（不是全局 fetch）
//   · 配置一律在执行时用 cfg() 读；setup 时快照会导致「改了设置不生效」
//   · 图片交付统一走 ctx.sender.sendImage（自带发送队列 / 限频 / 去重）
//   · available() 必须是同步函数（可用性判定走同步调用链）
//
// ── 为什么要把图片「下载回来再发」（实测教训）────────────────────────────
// 第一版是直接把接口返回的图片 URL 交给协议端，让它自己去下载。
// 实测 gpt-image-2 返回的是海外图床地址（disk.aipais.de），协议端要
// 「下载海外图 → 上传腾讯服务器」走完才响应，整条链路超过 onebot.call()
// 里写死的 15 秒超时 —— 表现为「图画出来了但发送失败：fetch failed」，
// 而那个 15 秒是核心默认值，技能层改不了。
//
// 所以改成：我们自己把图下回来（网络可控、能限量、能校验），转成
// base64:// 交给协议端。协议端只处理本地不到 1MB 数据，不再碰海外网络。
//
// 附带收益：魔数校验能挡掉「图片链接其实返回的是防盗链 HTML 页」，
// 也能在超限时提前拦截，而不是把协议端搞挂。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let cfg = () => ({});
let log = () => {};
let warn = () => {};
// api.fetch：只有清单声明了 permissions: ["web_fetch"] 才是真的 fetch。
// 这是能力引用不是配置，可以 setup 时存；配置仍然每次执行现读。
let apiFetch = null;

const MAX_COUNT = 4;
const MAX_PROMPT_CHARS = 2000;
const DEFAULT_TIMEOUT_MS = 120000;
const MIN_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 600000;
const DEFAULT_MAX_IMAGE_MB = 8;
const MAX_IMAGE_MB_CEIL = 32;
const DEFAULT_MAX_RETRIES = 1;
const RETRY_DELAY_MS = 2500;
// 图片下载超时。为什么和生成超时分开：生成慢是因为模型在画（25~42 秒正常），
// 下载慢纯粹是图床链路问题，两者该用不同的容忍度。
// 45 秒对海外图床偏紧（"响应头秒回、body 慢慢滴"是常态），默认抬到 60 秒且可配。
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60000;
const MIN_DOWNLOAD_TIMEOUT_MS = 5000;
const MAX_DOWNLOAD_TIMEOUT_MS = 300000;
// 下载重试次数。**下载是幂等且免费的**（花钱的只有生成），所以重试是净收益；
// 这一点和"生成超时不重试"（图可能已计费）是相反的，别把两者混为一谈。
const DOWNLOAD_ATTEMPTS = 2;
const DOWNLOAD_RETRY_DELAY_MS = 1200;
const KEEP_FILES = 20;                  // 本地留档保留最近多少张
const RESPONSE_FORMATS = ['auto', 'url', 'b64_json'];

/**
 * 构建标记：加载时打进日志。
 *
 * 为什么需要它：修好 bug 但用户仍报同样错误时，"是修复没生效还是修复不对"
 * 必须能一眼区分。没有这行标记就只能靠推理（本次为此绕了好几轮）。
 * 看到这行日志 = 新代码已加载；看不到 = 进程还是旧的，重启即可。
 */
const BUILD_TAG = 'v1.2.0-local-file-send';

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  warn = api.warn || (() => {});
  apiFetch = api.fetch;
  log(`文生图技能已加载（${BUILD_TAG}）`);

  api.registerTool({
    id: 'draw',                      // 注册后实际是 image-generate__draw
    name: '生成图片',
    description: '文生图：把一段画面描述渲染成图片，并直接发到当前会话。当群友说「画一张…」「帮我画个…」「生成一张…的图」「来张…的图」时用它。prompt 要写清主体 + 风格 + 构图/色调；多个画面用 count。图片由本工具直接发出，不需要再调发送工具。',
    category: 'media',
    icon: '🎨',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述（中英文都可以）：主体、风格、构图、色调' },
        size: { type: 'string', description: '可选：输出尺寸，如 1024x1024 / 1024x1536 / 512x512；留空用设置里的默认尺寸' },
        count: { type: 'number', description: '可选：一次生成几张，1~4，默认 1' }
      },
      required: ['prompt']
    },
    async execute(ctx, args) {
      // ── 1) 先校验参数：模型可能给空值、超长或越界值 ──────────────────────
      const prompt = String(args?.prompt ?? '').trim();
      if (!prompt) return fail('缺少 prompt：请把要画的画面描述写进去');
      if (prompt.length > MAX_PROMPT_CHARS) {
        return fail(`prompt 太长（${prompt.length} 字），请压到 ${MAX_PROMPT_CHARS} 字以内再试`);
      }

      const settings = readSettings();
      const missing = missingConfig(settings);
      if (missing.length) {
        return fail(`文生图还没配置：缺 ${missing.join(' / ')}。请到控制台设置页的「文生图」里填好。`);
      }

      const count = clamp(Number(args?.count) || 1, 1, MAX_COUNT);
      const size = String(args?.size ?? '').trim() || settings.defaultSize;

      try {
        // ── 2) 调接口（瞬时故障自动重试，见 callWithRetry 里的安全性说明）──
        const { payload, retried } = await callWithRetry(settings, buildBody(settings, prompt, size, count));

        // ── 3) 解析出图片引用（可能是 url，也可能是 base64）─────────────────
        const refs = extractImages(payload);
        if (!refs.length) {
          return fail(`接口没有返回图片。原始响应（截断）：${truncate(JSON.stringify(payload), 300)}`);
        }

        // ── 4) 逐张「物化」：下载 / 解码 + 校验 + 落地留档 ──────────────────
        const ready = [];
        const prepFailed = [];
        for (const [index, ref] of refs.entries()) {
          try {
            ready.push(await materialize(settings, ref, index));
          } catch (error) {
            // humanizeError 而不是 describeError：后者会把原始 DOMException
            // 渲染成 `[23] The operation was aborted...` 直接给用户看（真实事故）。
            prepFailed.push(humanizeError(error));
          }
        }
        if (!ready.length) {
          return fail(`图片拿到了但无法使用：${prepFailed.join('；') || '未知原因'}`);
        }

        // ── 5) 逐张发送：一律走 sender（队列 / 限频 / 去重都在它里面）────────
        let sent = 0;
        const sendFailed = [];
        for (const image of ready) {
          try {
            // 优先传本地路径：图已落盘，让协议端自己读文件，body 从 MB 级降到百字节级
            //（见 sender.sendImage 的注释）。dataUrl 作为回退，协议端不同机/路径不可读时用。
            await ctx.sender.sendImage(
              ctx.chatKey,
              { file: image.filePath, dataUrl: image.dataUrl },
              { note: 'AI绘图' }
            );
            sent += 1;
            ctx.session?.sent?.push({
              type: 'image',
              text: '[图片:AI绘图]',
              at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
            });
          } catch (error) {
            // 发送失败时把本地留档路径给出去，省得白画一张
            sendFailed.push(`${humanizeError(error)}（图已存本地：${image.filePath}）`);
          }
        }
        if (sent) {
          log(`生成并发送 ${sent} 张（模型 ${settings.model}${size ? `，尺寸 ${size}` : ''}${retried ? '，重试后成功' : ''}）`);
          try { ctx.emit?.('session-update', ctx.session?.id); } catch { /* 上报失败不影响已发出的图 */ }
        }
        if (!sent) {
          return fail(`图画出来了但发送失败：${sendFailed.join('；')}。`
            + '这通常是协议端到 QQ 的链路问题（不是画图的问题），不要为此重新生成图片 —— 那只会再花一次钱。'
            + '把上面的原因告诉群友即可。');
        }

        const notes = [];
        if (retried) notes.push('（接口第一次失败，重试后成功）');
        if (prepFailed.length) notes.push(`（另有 ${prepFailed.length} 张无效：${prepFailed.join('；')}）`);
        if (sendFailed.length) notes.push(`（另有 ${sendFailed.length} 张发送失败：${sendFailed.join('；')}）`);
        return {
          content: `已生成 ${sent} 张图片并直接发到当前会话（模型 ${settings.model}${size ? `，尺寸 ${size}` : ''}）${notes.join('')}。`
            + '注意：你看不到生成的画面，所以不要描述画面细节、也不要编造内容，更不要再调用发图工具；'
            + '一句自然的收尾就够了。'
        };
      } catch (error) {
        // ── 6) 失败也返回人话，绝不让异常冒泡 ──────────────────────────────
        log(`画图失败：${describeError(error)}`);
        return fail(`画图失败：${humanizeError(error)}`);
      }
    }
  });
}

// ── 供别的 Skill / 核心按能力名取用（它们不需要 import 这个文件）──────────
export const providers = {
  'image.generate': async ({ prompt, size, count } = {}) => {
    try {
      const settings = readSettings();
      const missing = missingConfig(settings);
      if (missing.length) return { ok: false, error: `文生图未配置：缺 ${missing.join(' / ')}` };

      const text = String(prompt || '').trim();
      if (!text) return { ok: false, error: '缺少 prompt' };

      const { payload } = await callWithRetry(
        settings,
        buildBody(settings, text, String(size || '').trim() || settings.defaultSize, clamp(Number(count) || 1, 1, MAX_COUNT))
      );
      const refs = extractImages(payload);
      if (!refs.length) return { ok: false, error: '接口没有返回图片' };

      const images = [];
      const problems = [];
      for (const [index, ref] of refs.entries()) {
        try {
          const done = await materialize(settings, ref, index);
          images.push({ dataUrl: done.dataUrl, filePath: done.filePath, mime: done.mime, bytes: done.bytes });
        } catch (error) {
          // 逐张抛掉原因就等于把排障线索扔了（原写法只回一句"图片拿到了但无法使用"，
          // 用户完全不知道是超时、超限还是防盗链）。这里把每张的原因都带上。
          const reason = humanizeError(error);
          problems.push(`第 ${index + 1} 张：${reason}`);
          warn(`能力调用中有一张图不可用：${reason}`);
        }
      }
      if (!images.length) {
        return { ok: false, error: `图片拿到了但无法使用：${problems.join('；') || '未知原因'}` };
      }
      return { ok: true, images };
    } catch (error) {
      return { ok: false, error: humanizeError(error) };
    }
  }
};

/**
 * 依赖自检：缺配置就直说，别让界面显示「生效中」而调用时才发现画不了。
 * ⚠️ 必须是同步函数 —— 可用性判定走同步调用链，返回 Promise 会被当成「可用」。
 * 这里只读内存里的配置，没有 IO，所以同步判断是安全的。
 */
export function available() {
  const missing = missingConfig(readSettings());
  if (missing.length) return { ok: false, reason: `还没配置：${missing.join(' / ')}（在设置页「文生图」里填）` };
  return { ok: true };
}

/** 动态提示词片段：配置好了才告诉模型「你有画图工具」，没配就不占 token。 */
export function promptSections() {
  if (missingConfig(readSettings()).length) return [];
  return [{
    id: 'image-generate-note',
    title: '文生图',
    priority: 35,
    content: '群友让你画图/生成图片时，用 draw 工具（prompt 写清画面，多张用 count），它会把图直接发到当前会话。'
      + '你看不到生成结果，所以不要描述画面细节，也不要再调发图工具。'
      + '画图又慢又贵，接口失败最多重试一次，不要连着试好几次；发不出去时更不要重新生成。'
  }];
}

// ── 配置读取（每次执行现读，用户改完设置立刻生效）─────────────────────────
function readSettings() {
  const c = cfg() || {};
  const baseUrl = String(c.baseUrl || '').trim();
  const format = String(c.responseFormat || '').trim();
  const retries = (c.maxRetries === undefined || c.maxRetries === null || c.maxRetries === '')
    ? DEFAULT_MAX_RETRIES : Number(c.maxRetries);
  return {
    baseUrl,
    endpoint: resolveEndpoint(baseUrl),
    apiKey: String(c.apiKey || '').trim(),
    model: String(c.model || '').trim(),
    defaultSize: String(c.defaultSize || '').trim(),
    responseFormat: RESPONSE_FORMATS.includes(format) ? format : 'auto',
    extraBody: parseExtraBody(c.extraBody),
    timeoutMs: clamp(Number(c.timeoutMs) || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    downloadTimeoutMs: clamp(
      Number(c.downloadTimeoutMs) || DEFAULT_DOWNLOAD_TIMEOUT_MS,
      MIN_DOWNLOAD_TIMEOUT_MS,
      MAX_DOWNLOAD_TIMEOUT_MS
    ),
    maxRetries: clamp(Number.isFinite(retries) ? retries : DEFAULT_MAX_RETRIES, 0, 3),
    maxImageBytes: clamp(Number(c.maxImageMB) || DEFAULT_MAX_IMAGE_MB, 1, MAX_IMAGE_MB_CEIL) * 1024 * 1024
  };
}

function missingConfig(settings) {
  const missing = [];
  if (!settings.baseUrl) missing.push('Base URL');
  if (!settings.apiKey) missing.push('API Key');
  if (!settings.model) missing.push('模型 id');
  return missing;
}

/** 用户可能填 /v1 也可能填完整地址，这里统一补成 /images/generations。 */
function resolveEndpoint(raw) {
  const url = String(raw || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (/\/images\/generations$/i.test(url)) return url;
  if (/\/v\d+(?:\.\d+)?$/i.test(url)) return `${url}/images/generations`;
  return `${url}/v1/images/generations`;
}

function parseExtraBody(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  const parsed = safeParse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`extraBody 不是合法的 JSON 对象，已忽略：${truncate(text, 80)}`);
    return {};
  }
  return parsed;
}

function buildBody(settings, prompt, size, count) {
  // 顺序有讲究：额外字段放前面，核心字段后面覆盖 ——
  // 免得用户在 extraBody 里手抖把 prompt / model 写没了
  const body = { ...settings.extraBody };
  body.model = settings.model;
  body.prompt = prompt;
  body.n = count;
  if (size) body.size = size;
  if (settings.responseFormat !== 'auto') body.response_format = settings.responseFormat;
  return body;
}

// ── 请求 + 瞬时故障重试 ───────────────────────────────────────────────────
/**
 * 只对「确定没被处理」的失败重试，绝不重试超时和网络中断。
 *
 * 为什么必须这么区分（对用户是钱的问题）：
 *   · 接口明确回 4xx/5xx（比如中转站的「上游服务暂时不可用」）→ 这次请求没被受理，
 *     重试不会产生第二次计费，安全。
 *   · 超时 / 连接中断 → 图**可能已经生成并计费**了，再试就是花双份钱换一张图。
 *     这种情况宁可把失败如实报出去。
 */
async function callWithRetry(settings, body) {
  let lastError = null;
  const attempts = Math.max(1, settings.maxRetries + 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { payload: await requestImages(settings, body), retried: attempt > 1 };
    } catch (error) {
      lastError = error;
      if (error?.retryable !== true || attempt >= attempts) break;
      warn(`第 ${attempt} 次请求失败（${describeError(error)}），${RETRY_DELAY_MS}ms 后重试`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

async function requestImages(settings, body) {
  if (typeof apiFetch !== 'function') {
    throw new Error('联网能力不可用：清单需声明 permissions: ["web_fetch"]');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  let res;
  try {
    res = await apiFetch(settings.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    // 连不上 / 被中断：结果未知，不重试（图可能已经生成并计费）
    if (controller.signal.aborted || isTimeoutLike(error)) {
      throw new Error(`接口超时（${Math.round(settings.timeoutMs / 1000)} 秒没返回）。`
        + '超时不重试：图可能已经生成并计费了，不想让你花两份钱。等一会再决定要不要重来。');
    }
    throw new Error(`连不上接口：${humanizeError(error)}`);
  }
  // ⚠️ 计时器**不能在这里清**（原来写在 finally 里，是个真 bug）。
  // 生成接口常见"响应头先回、结果 JSON 后到"：清早了就等于给读 body 这一步
  // 摘掉超时 —— 对方一卡住，这一轮就**永久挂起**（没有超时、没有报错、会话不返回）。
  // 所以清 timer 的动作放到读完 body 之后。

  let text = '';
  try {
    text = await res.text();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`接口超时（${Math.round(settings.timeoutMs / 1000)} 秒：响应头已返回但响应体没读完）。`
        + '超时不重试：图可能已经生成并计费了，等一会再决定要不要重来。');
    }
    throw new Error(`读取接口响应失败：${humanizeError(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const error = new Error(`接口返回 HTTP ${res.status}：${errorText(text)}`);
    // 明确失败 → 没被受理 → 可以安全重试
    error.retryable = isTransientStatus(res.status, text);
    throw error;
  }

  const json = safeParse(text);
  if (!json || typeof json !== 'object') throw new Error(`接口返回的不是 JSON：${truncate(text, 200)}`);
  return json;
}

/**
 * 判断「这次失败要不要重试」。
 * 5xx / 429 一律可重试；400 要看文案 —— 中转站的「上游服务暂时不可用」也是 400，
 * 但它本质是瞬时故障，和「模型名写错了」这种参数错误必须区别对待。
 */
function isTransientStatus(status, text) {
  if (status === 429) return true;
  if (status >= 500) return true;
  if (status !== 400 && status !== 402 && status !== 408) return false;
  return /上游|暂时不可用|稍后重试|请重试|try again|later|timeout|timed out|overload|繁忙|拥挤|rate.?limit|temporar|upstream|unavailable|无可用|切换固定商家|智能路由/i
    .test(String(text || ''));
}

function errorText(text) {
  const json = safeParse(text);
  const raw = json?.error?.message ?? json?.error ?? json?.message ?? json?.msg ?? json?.detail;
  const message = typeof raw === 'string' ? raw : (raw ? JSON.stringify(raw) : '');
  return truncate(message || String(text || '').trim() || '接口没有返回错误详情', 300);
}

// ── 解析：兼容 url / b64_json / data[].image 等常见形状 ────────────────────
function extractImages(payload) {
  const candidates = [];
  if (Array.isArray(payload)) candidates.push(...payload);
  for (const key of ['data', 'images', 'output', 'results', 'artifacts']) {
    const value = payload?.[key];
    if (Array.isArray(value)) candidates.push(...value);
    else if (value && typeof value === 'object') candidates.push(value);
  }
  const refs = [];
  for (const item of candidates) {
    const ref = toImageRef(item);
    if (ref) refs.push(ref);
  }
  return refs;
}

function toImageRef(item) {
  if (typeof item === 'string') return refFromValue(item);
  if (!item || typeof item !== 'object') return null;

  // base64 优先：接口给的链接常常带防盗链或很快过期
  const rawB64 = firstString(item.b64_json, item.base64, item.image_base64, item.b64);
  if (rawB64) return { kind: 'base64', value: rawB64 };

  const rawUrl = firstString(
    item.url,
    item.image_url && typeof item.image_url === 'object' ? item.image_url.url : item.image_url,
    item.image,
    item.file,
    item.url_path
  );
  return rawUrl ? refFromValue(rawUrl) : null;
}

function refFromValue(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return { kind: 'url', value: text };
  return { kind: 'base64', value: text };   // 裸 base64 或 data:image/png;base64,xxx
}

// ── 物化：把 ref 变成协议端能直接用的 base64:// 数据，并落地留档 ────────────
async function materialize(settings, ref, index) {
  const buffer = ref.kind === 'url'
    ? await downloadImage(ref.value, settings)
    : decodeBase64(ref.value, settings);

  if (!buffer.length) throw new Error('图片内容为空');
  if (buffer.length > settings.maxImageBytes) {
    throw new Error(`图片 ${(buffer.length / 1048576).toFixed(1)}MB 超过上限 `
      + `${(settings.maxImageBytes / 1048576).toFixed(0)}MB。请换更小的尺寸，或换成输出 jpg 的模型/接口。`);
  }

  const mime = detectMime(buffer);
  if (!mime) throw new Error('拿到的不是图片（可能是防盗链页或错误页），已丢弃');

  const filePath = saveLocal(buffer, mime, index);
  return { dataUrl: `base64://${buffer.toString('base64')}`, filePath, mime, bytes: buffer.length };
}

/**
 * 下载一张图（带一次免费重试）。
 *
 * ⚠️ 这里修过一个真实故障：用户看到
 *     「图片拿到了但无法使用：[23] The operation was aborted due to timeout」
 *
 * 根因是**超时作用域**：AbortSignal 的计时覆盖整条请求（响应头 + 响应体），
 * 但原来的 catch 只包住 fetch() 那一步。而"响应头秒回、body 慢慢滴"正是海外图床的常态，
 * 于是 abort 发生在读 body 时，抛出的原始 DOMException（code 23 = TIMEOUT_ERR）
 * 直接漏到用户面前 —— 既看不出是超时，也看不出卡在哪一步。
 *
 * 现在：超时覆盖整个下载，并明确报出**阶段**与**已收字节数**。
 * 这两条信息决定处置方式，不是装饰：
 *   · 响应头都没回  → 多半是路由/被墙，换网络或换图床
 *   · body 只收到一点 → 对方是活的只是慢，调大 downloadTimeoutMs 有意义
 */
async function downloadImage(url, settings) {
  if (typeof apiFetch !== 'function') throw new Error('联网能力不可用');

  const timeoutMs = settings.downloadTimeoutMs;
  let problem = null;

  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    const progress = { bytes: 0 };
    try {
      return await downloadOnce(url, settings, timeoutMs, progress);
    } catch (error) {
      const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      problem = { readable: describeDownloadError(error, timeoutMs, progress.bytes), retryable: error?.retryable === true };

      // 诊断日志：把"原始错误长什么样"落到日志里。
      // 为什么必须记：这类失败在用户端只看到一句人话文案，
      // 而定位根因需要 name/code(23 还是别的)/是否有 cause 链/卡在哪个阶段。
      // 没有这行，下次再出问题只能靠猜（本次就绕了几轮）。
      const o = error?.original || {};
      log(`下载失败诊断：phase=${error?.phase || '?'} bytes=${progress.bytes}`
        + ` name=${o.name || error?.name || '?'} code=${o.code ?? error?.code ?? '?'}`
        + ` phaseTimeout=${!!error?.phaseTimeout} signalAborted=${!!error?.signalAborted}`
        + ` msg=${String(o.message || error?.message || '').slice(0, 160)}`);

      if (!problem.retryable || attempt >= DOWNLOAD_ATTEMPTS) break;
      warn(`${problem.readable}（用了 ${secs}s）→ 重试下载 ${attempt + 1}/${DOWNLOAD_ATTEMPTS}`);
      await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_RETRY_DELAY_MS));
    }
  }

  // 必须让用户和模型都明白：**图已经生成并计费了**，失败只在"下载"这一环。
  // 否则模型的自然反应是"重新生成一张"——那是再花一份钱，而问题根本不在生成。
  log(`图片下载失败，原始链接（可手动重试下载）：${url}`);
  throw new Error(`${problem.readable}。图已生成（可能已计费），**不要重新生成**；`
    + `下载失败不影响图片本身，稍后可用这个链接重取：${url}`);
}

/**
 * 判定一个错误是否为「超时 / 中断」语义（含 cause 链）。
 *
 * ⚠️ 这是真实事故的修复点，两次踩同一处，所以单独抽出来并写清原因。
 *
 * 第一版只认 `controller.signal.aborted`，理由是"信号被我们自己的定时器 abort 了
 * 这件事最确定"。但现实里 abort 还有别的来源：底层 undici、图床侧主动断、代理/中间盒，
 * 以及 fetch 内部对某一段应用的超时。**这些情况下 signal.aborted 仍是 false** ——
 * 于是原始 DOMException 原样漏给用户，看到的就是
 * `[23] The operation was aborted due to timeout`（code 23 = TIMEOUT_ERR）。
 *
 * 所以判定要**同时**看两条证据，任一命中都按超时处理：
 *   a) 信号确实被 abort 了（我们自己的 timer 干的）
 *   b) 错误语义是超时/中断（name / DOMException.code / message，逐层挖 cause）
 *
 * 取舍很明确：宁可把"看起来像超时"的错误当超时处理（给出的建议依然可操作：
 * 调大超时、换图床、手动重取链接），也绝不把原始错误码甩到用户面前 ——
 * 那是完全不可操作的信息，而且和"重新生成一张"之间没有任何提示，
 * 会诱导模型再花一次钱。
 */
function isTimeoutLike(error) {
  const TIMEOUT_CODES = new Set([23, 20]);                  // DOMException: TIMEOUT_ERR / ABORT_ERR
  const TIMEOUT_NAMES = new Set(['TimeoutError', 'AbortError']);
  const TIMEOUT_TEXT = /aborted due to timeout|operation was aborted|timed?\s?out/i;
  let current = error;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (TIMEOUT_NAMES.has(current.name)) return true;
    if (TIMEOUT_CODES.has(current.code)) return true;
    if (TIMEOUT_TEXT.test(String(current.message || ''))) return true;
    current = current.cause;                                // ⚠️ fetch 只给一句 "fetch failed"，真因在 cause 里
  }
  return false;
}

/**
 * 统一的人话入口：超时语义永不裸露原始错误码。
 * 用于所有会写进用户可见文案的地方（工具返回值、能力返回值）。
 */
function humanizeError(error) {
  if (!error) return '未知错误';
  const msg = String(error.message || '');
  // ⚠️ "无信息 message" 必须挖 cause，不能原样返回。
  // fetch 网络层失败时 message 恒为 "fetch failed"，真因（TimeoutError /
  // ECONNREFUSED / socket hang up）全在 cause 里 —— 直接返回 message 等于把
  // 排查线索扔掉（实测：用户看到的就是一句光秃秃的 "fetch failed"）。
  const VAGUE = /^(fetch failed|terminated|other side closed|socket hang up|network error|the operation was aborted)$/i;
  if (msg && !/^\[\d+\]/.test(msg) && !VAGUE.test(msg.trim())) return msg;
  if (isTimeoutLike(error)) return `操作超时（${describeError(error)}）`;
  return describeError(error);
}

/** 把下载失败的原始错误翻译成"能据此做决定"的一句话。 */
function describeDownloadError(error, timeoutMs, receivedBytes) {
  // 条件里带 isTimeoutLike：万一 phaseTimeout 没被标记（abort 来自底层），
  // 也要给出可读的处置建议，而不是把原始错误码透出去。
  if (error?.phaseTimeout || isTimeoutLike(error)) {
    const limit = Math.round(timeoutMs / 1000);
    const where = error?.phase === 'headers'
      ? '没返回响应头，可能是网络到不了图床'
      : `响应体只收到 ${formatBytes(receivedBytes)}，图床太慢，可在设置页调大"下载超时"`;
    return `下载图片超时（${limit} 秒内${where}）`;
  }
  return `下载图片失败：${humanizeError(error)}`;
}

/**
 * 人类可读的字节数。
 * 为什么不能一律用 MB：实测"只下载到 2000 字节"会被渲染成「0.00MB」——
 * 等于什么都没说，用户无法判断是"一个字没收到"还是"收到一多半"。
 */
function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1048576).toFixed(2)}MB`;
}

/**
 * 单次下载。超时**覆盖响应头与响应体两个阶段**。
 * 分阶段标记 phase，让上层能给出不同的处置建议。
 */
async function downloadOnce(url, settings, timeoutMs, progress) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let phase = 'headers';

  // 判定见 isTimeoutLike 的注释：abort 可能不是我们的 timer 触发的，
  // 所以信号与错误语义两条证据都要看。
  const asTimeout = (error) => {
    if (!controller.signal.aborted && !isTimeoutLike(error)) return null;
    const wrapped = new Error(`timeout during ${phase}`);
    wrapped.phaseTimeout = true;
    wrapped.phase = phase;
    wrapped.retryable = true;
    // 把判定依据一起带上：诊断日志需要它，而 controller 只在 downloadOnce 作用域里，
    // 上层拿不到 —— 之前在日志里直接写 controller.signal.aborted 直接抛了
    // ReferenceError，把整条错误处理链搞崩（加日志反而弄坏正常路径，很典型）。
    wrapped.signalAborted = controller.signal.aborted;
    wrapped.original = { name: error?.name, code: error?.code, message: String(error?.message || '').slice(0, 200) };
    return wrapped;
  };

  try {
    let res;
    try {
      res = await apiFetch(url, {
        redirect: 'follow',
        headers: { Accept: 'image/*,*/*;q=0.8' },
        signal: controller.signal
      });
    } catch (error) {
      const timeout = asTimeout(error);
      if (timeout) throw timeout;
      // 连接类错误（ECONNRESET / DNS）也重试：下载幂等且免费
      const wrapped = new Error(humanizeError(error));
      wrapped.retryable = true;
      throw wrapped;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);   // 状态码已明确 → 重试没意义

    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > settings.maxImageBytes) {
      throw new Error(`图片 ${(declared / 1048576).toFixed(1)}MB 超过上限 ${(settings.maxImageBytes / 1048576).toFixed(0)}MB`);
    }

    phase = 'body';
    try {
      return await readLimited(res, settings.maxImageBytes, progress);
    } catch (error) {
      if (error?.tooLarge) throw error;          // 体积超限：换更小尺寸才对，重试无用
      const timeout = asTimeout(error);
      if (timeout) throw timeout;
      const wrapped = new Error(`传输中断（已收到 ${formatBytes(progress.bytes)}）：${humanizeError(error)}`);
      wrapped.retryable = true;
      throw wrapped;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 边读边限流：避免无 content-length 的超大响应把内存打爆。 */
async function readLimited(res, maxBytes, progress = { bytes: 0 }) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buffer = Buffer.from(await res.arrayBuffer());
    progress.bytes = buffer.length;
    if (buffer.length > maxBytes) throw tooLargeError(maxBytes);
    return buffer;
  }
  const reader = res.body.getReader();
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      progress.bytes += value.byteLength;
      if (progress.bytes > maxBytes) {
        throw tooLargeError(maxBytes, true);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { await reader.cancel(); } catch { /* 已读完或已中止（中止时 cancel 也会抛） */ }
  }
  return Buffer.concat(chunks);
}

function tooLargeError(maxBytes, midway = false) {
  const error = new Error(`图片超过体积上限 ${(maxBytes / 1048576).toFixed(0)}MB${midway ? '（下载中途截断）' : ''}`);
  error.tooLarge = true;
  return error;
}

function decodeBase64(value, settings) {
  const text = String(value || '').trim();
  const marked = /^data:[^;,]*;base64,(.*)$/is.exec(text);
  const b64 = (marked ? marked[1] : text).replace(/\s+/g, '');
  if (!b64) throw new Error('图片 base64 为空');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('图片 base64 格式不合法');
  // 先按长度估算，避免为一个超限的大图白白解码出几十 MB 内存
  const estimated = Math.floor(b64.length * 3 / 4);
  if (estimated > settings.maxImageBytes * 1.2) {
    throw new Error(`图片约 ${(estimated / 1048576).toFixed(1)}MB，超过上限 ${(settings.maxImageBytes / 1048576).toFixed(0)}MB`);
  }
  return Buffer.from(b64, 'base64');
}

function detectMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** 本地留档：发送失败时这张图还能捞回来，也方便人工排查。 */
function saveLocal(buffer, mime, index) {
  try {
    const dir = path.join(os.tmpdir(), 'qq-agent-image-generate');
    fs.mkdirSync(dir, { recursive: true });
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${index + 1}.${ext}`;
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, buffer);
    pruneLocal(dir);
    return filePath;
  } catch (error) {
    warn(`本地留档失败（不影响发送）：${error?.message ?? error}`);
    return '(未能留档)';
  }
}

function pruneLocal(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /\.(png|jpg|jpeg|gif|webp)$/i.test(f)).sort();
    for (const stale of files.slice(0, Math.max(0, files.length - KEEP_FILES))) {
      fs.unlinkSync(path.join(dir, stale));
    }
  } catch { /* 清不动就算了，不该影响主流程 */ }
}

// ── 错误描述：把 cause 链挖出来 ───────────────────────────────────────────
/**
 * Node 的 fetch 失败只会给一句「fetch failed」，真正的原因（ECONNRESET /
 * 连接被对端关闭 / DNS 失败）藏在 error.cause 里 —— 不挖出来就没法定位。
 */
function describeError(error, depth = 0) {
  if (!error) return '未知错误';
  if (depth > 3) return String(error?.message ?? error);

  const parts = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current) && parts.length < 4) {
    seen.add(current);
    if (Array.isArray(current.errors) && current.errors.length) {
      for (const inner of current.errors) {
        const text = describeError(inner, depth + 1);
        if (text && !parts.includes(text)) parts.push(text);
      }
      break;
    }
    const code = current.code ? `[${current.code}] ` : '';
    const message = String(current.message || current.name || current).trim();
    const piece = `${code}${message}`.trim();
    if (piece && !parts.includes(piece)) parts.push(piece);
    current = current.cause;
  }
  return parts.join(' ← ') || '未知错误';
}

// ── 小工具（纯函数，方便单测）────────────────────────────────────────────
function fail(message) { return { content: `错误：${message}`, isError: true }; }
function clamp(n, lo, hi) {
  const value = Number.isFinite(n) ? Math.round(n) : lo;
  return Math.min(hi, Math.max(lo, value));
}
function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// 给测试用的出口
export const internals = {
  resolveEndpoint, buildBody, extractImages, detectMime, decodeBase64, clamp,
  readSettings, isTransientStatus, describeError, materialize, readLimited,
  // 导出 downloadImage 是为了让回归测试能用**受控的短超时**验证分阶段报错与重试逻辑；
  // 走工具层跑一次要 11 秒（5s 下限 × 2 次尝试 + 退避），测试会慢到没人愿意跑。
  // 注意它是直接吃 settings 的，所以调用方可以绕过 readSettings 的钳制 ——
  // 配置钳制本身由 readSettings 的断言单独覆盖，两件事分开测。
  downloadImage, downloadOnce, describeDownloadError, formatBytes,
  isTimeoutLike, humanizeError
};
