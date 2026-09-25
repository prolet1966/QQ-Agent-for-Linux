// setu 下载基础设施（从 setu.js 提取）：CDN 镜像管理、代理回退、临时文件、图片下载、去重源。
// 依赖：config.js（常量）、util.js（detectImageMime）、safe-fetch.js（safeFetchBinary）
import fs from 'node:fs';
import path from 'node:path';
import { safeFetchBinary } from '../../src/safe-fetch.js';
// detectMime：项目的图片类型嗅探（按魔数判断，不看扩展名）。
// 原社区版从 util.js 取 detectImageMime，本项目该函数位于 image-type.js 且名为 detectMime。
import { detectMime } from '../../src/image-type.js';
import {
  TMP_DIR, TMP_MAX_AGE_MS, IMAGE_UA, IMAGE_REFERER,
  PXIMG_MIRRORS, PXIMG_BAD_TTL_MS, PROXY_DOWN_COOLDOWN_MS, DEDUP_FILE
} from './config.js';

// ── 图片完整性校验 ──────────────────────────────────────────────────

/**
 * 验证图片文件完整性（检查文件尾标记）。
 * 不完整的图片（下载中断）文件头正常但文件尾缺失，QQ 会显示"加载不完全"。
 */
export function validateImageIntegrity(buf) {
  if (!buf || buf.length < 12) return false;
  const mime = detectMime(buf);
  if (!mime) return false;
  if (mime === 'image/jpeg') {
    const end = buf.length;
    for (let i = end - 2; i >= Math.max(0, end - 64); i--) {
      if (buf[i] === 0xff && buf[i + 1] === 0xd9) return true;
    }
    return false;
  }
  if (mime === 'image/png') {
    const t = buf.length;
    if (t < 12) return false;
    // PNG 以 IEND chunk 结尾：长度(00 00 00 00) + "IEND"(49 45 4E 44) + CRC(AE 42 60 82，IEND 的 CRC 是固定值)。
    // 'I' 最早出现在 t-8（恰好结尾）处，尾部有冗余字节时更靠前 —— 从 t-8 向前扫到 72 字节窗口，
    // 对 i 要求 i≥4（i-4 是长度字段下标）且 i+7≤t-1。
    for (let i = t - 8; i >= Math.max(4, t - 72); i--) {
      if (buf[i - 4] === 0x00 && buf[i - 3] === 0x00 && buf[i - 2] === 0x00 && buf[i - 1] === 0x00
        && buf[i] === 0x49 && buf[i + 1] === 0x45 && buf[i + 2] === 0x4e && buf[i + 3] === 0x44
        && buf[i + 4] === 0xae && buf[i + 5] === 0x42 && buf[i + 6] === 0x60 && buf[i + 7] === 0x82) return true;
    }
    return false;
  }
  if (mime === 'image/gif') {
    return buf[buf.length - 1] === 0x3b;
  }
  if (mime === 'image/webp') {
    return buf.length >= 8;
  }
  return true;
}

// ── Pixiv CDN 镜像管理 ────────────────────────────────────────────────────

let pximgGood = null;
const pximgBad = new Map();

function pximgIsBad(host) {
  const at = pximgBad.get(host);
  if (at === undefined) return false;
  if (Date.now() - at > PXIMG_BAD_TTL_MS) { pximgBad.delete(host); return false; }
  return true;
}

function pximgHostOf(url) {
  try { return new URL(String(url)).hostname || ''; } catch { return ''; }
}

function isPximgHost(host) {
  return /\.pximg\.net$/i.test(host);
}

function markPximgHit(url) {
  const h = pximgHostOf(url);
  if (!isPximgHost(h)) return;
  pximgGood = h;
  pximgBad.delete(h);
}

function markPximgMiss(url) {
  const h = pximgHostOf(url);
  if (!isPximgHost(h)) return;
  pximgBad.set(h, Date.now());
}

/**
 * 展开一条图片 URL 的下载尝试序列：[{ url, proxy }]。
 * 非 Pixiv CDN 来源原样返回单条，不启用镜像。
 * 配了代理时先走「代理 + 原始域名」，代理不通再逐个镜像直连；没配代理时镜像优先、原始域名兜底。
 */
export function pximgAttempts(url, proxy, pxveOrigin) {
  let u;
  try { u = new URL(String(url)); } catch { return [{ url: String(url), proxy: proxy || undefined }]; }
  if (!isPximgHost(u.hostname)) return [{ url: String(url), proxy: proxy || undefined }];

  const p = `${u.pathname}${u.search}`;
  const hosts = [];
  if (pximgGood && !pximgIsBad(pximgGood)) hosts.push(pximgGood);
  for (const h of PXIMG_MIRRORS) if (!hosts.includes(h)) hosts.push(h);
  if (!hosts.includes(u.hostname)) hosts.push(u.hostname);

  const out = [];
  if (pxveOrigin) {
    out.push({ url: `${pxveOrigin}/pximg${p}`, proxy: undefined });
    const pidMatch = u.pathname.match(/\/(\d+)_p(\d+)/);
    if (pidMatch) {
      out.push({ url: `${pxveOrigin}/pid/${pidMatch[1]}_${pidMatch[2]}_o`, proxy: undefined });
    }
    if (proxy) {
      out.push({ url: `${pxveOrigin}/pximg${p}`, proxy });
      if (pidMatch) out.push({ url: `${pxveOrigin}/pid/${pidMatch[1]}_${pidMatch[2]}_o`, proxy });
    }
  }
  if (proxy) out.push({ url: `https://${u.hostname}${p}`, proxy });
  for (const h of hosts) {
    if (pximgIsBad(h) && h !== pximgGood) continue;
    out.push({ url: `https://${h}${p}`, proxy: undefined });
  }
  return out.length ? out : [{ url: String(url), proxy: undefined }];
}

// ── 代理回退 ──────────────────────────────────────────────────────────

const PROXY_DOWN_MAP = new Map();

/**
 * 代理优先、直连兜底：本机代理没起（ECONNREFUSED）时不要整条链路报废，直连再试一次。
 * fetcher(url, proxy) 必须是返回 Promise 的函数；两次都失败时抛出最后一次错误。
 */
export async function fetchWithProxyFallback(fetcher, url, proxy) {
  if (!proxy) {
    return fetcher(url, undefined);
  }
  const downUntil = PROXY_DOWN_MAP.get(proxy);
  if (downUntil && downUntil > Date.now()) {
    return fetcher(url, undefined);
  }
  if (downUntil !== undefined) PROXY_DOWN_MAP.delete(proxy);
  try {
    return await fetcher(url, proxy);
  } catch (error) {
    const msg = String(error?.message ?? error);
    const connFail = /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|代理连接失败|connect/i.test(msg);
    if (connFail) PROXY_DOWN_MAP.set(proxy, Date.now() + PROXY_DOWN_COOLDOWN_MS);
    console.warn(`[setu] 代理请求失败，改直连 ${String(url).slice(0, 100)}: ${msg}${connFail ? '（代理疑似未开，60s 内跳过代理直连）' : ''}`);
    return await fetcher(url, undefined);
  }
}

// ── 临时文件管理 ──────────────────────────────────────────────────────────

/** 清理过期的临时图（best-effort，任何异常都吞掉，不能影响取图主流程）。 */
export function sweepTmp() {
  try {
    const cutoff = Date.now() - TMP_MAX_AGE_MS;
    for (const name of fs.readdirSync(TMP_DIR)) {
      const full = path.join(TMP_DIR, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch { /* 单文件失败忽略 */ }
    }
  } catch { /* 目录不存在等 */ }
}

/**
 * 把原图转成可发送的载荷。
 * payloadMode='file'（默认）：写本地临时文件，返回 { payload: 绝对路径, file: 同一路径 }。
 * payloadMode='base64'：返回 { payload: 'base64://...', file: null }。
 */
export function savePayload(buffer, mode) {
  if (mode === 'base64') return { payload: `base64://${buffer.toString('base64')}`, file: null };
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    sweepTmp();
    // 按真实内容定扩展名：GIF/PNG/WebP 存成 .jpg 会被依赖扩展名的协议端误判
    const mime = detectMime(buffer);
    const ext = mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : mime === 'image/webp' ? 'webp' : 'jpg';
    const file = path.join(TMP_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    fs.writeFileSync(file, buffer);
    return { payload: file, file };
  } catch (error) {
    console.warn(`[setu] 临时文件写入失败，退回 base64 内联: ${error?.message ?? error}`);
    return { payload: `base64://${buffer.toString('base64')}`, file: null };
  }
}

// ── 图片下载 ──────────────────────────────────────────────────────────

/**
 * 下载单张原图，返回 { payload, file, bytes, mime }。失败返回 null。
 * opts.referer 按图片来源定制（cnmiw 用 weibo 的 Referer，booru 用站点自身页面）；
 * opts.timeoutMs 可覆盖默认下载超时（外部图床响应慢，不宜用过长超时拖住整个批次）；
 * opts.proxy 提供时走 HTTP 代理隧道（直连被墙的图源）。
 */
export async function downloadImage(url, cfg, opts = {}) {
  const maxBytes = Math.max(1, Math.trunc(Number(cfg.send?.maxImageBytes) || 8 * 1024 * 1024));
  const defaultTimeout = Number(cfg.api?.downloadTimeoutMs) > 0 ? Number(cfg.api.downloadTimeoutMs) : 30000;
  const timeoutMs = opts.timeoutMs > 0 ? Math.trunc(opts.timeoutMs) : defaultTimeout;
  const pxveOrigin = cfg.booru?.baseUrl ? (() => { try { return new URL(cfg.booru.baseUrl).origin; } catch { return null; } })() : null;
  let buffer;
  const attempts = pximgAttempts(url, opts.proxy, pxveOrigin);
  console.log(`[setu] downloadImage 开始: url=${String(url).slice(0, 80)} | attempts=${attempts.length} | pxveOrigin=${pxveOrigin}`);
  for (let ai = 0; ai < attempts.length; ai++) {
    const attempt = attempts[ai];
    console.log(`[setu] attempt[${ai}]: url=${String(attempt.url).slice(0, 100)} | proxy=${attempt.proxy ? '有' : '无'}`);
    try {
      const isPxveProxy = pxveOrigin && String(attempt.url).startsWith(pxveOrigin);
      const headers = isPxveProxy
        ? { 'user-agent': IMAGE_UA, origin: 'https://pixiv.pictures', referer: 'https://pixiv.pictures/' }
        : { referer: opts.referer || IMAGE_REFERER, 'user-agent': IMAGE_UA };
      const fetchOpts = { headers, timeoutMs, proxy: attempt.proxy };
      let fetchResult;
      if (isPxveProxy) {
        const backoffs = [5000, 15000, 30000];
        for (let ri = 0; ri < backoffs.length; ri++) {
          try {
            fetchResult = await safeFetchBinary(attempt.url, maxBytes, fetchOpts);
            break;
          } catch (e) {
            const msg = String(e?.message ?? e);
            if (/429|403|503/.test(msg)) {
              console.warn(`[setu] PXVE 图片代理返回 HTTP ${msg.match(/\d{3}/)?.[0] || '?'}，${backoffs[ri]/1000}s 后重试 (${ri+1}/${backoffs.length})`);
              await sleep(backoffs[ri]);
            } else throw e;
          }
        }
        if (!fetchResult) throw new Error('PXVE 图片代理限速，多次重试后仍为 HTTP 429/403/503');
      } else {
        fetchResult = await safeFetchBinary(attempt.url, maxBytes, fetchOpts);
      }
      buffer = fetchResult.buffer;
      // 完整性通过才给镜像记好评：坏图/中断的下载不能巩固镜像选择
      if (validateImageIntegrity(buffer)) { markPximgHit(attempt.url); break; }
      console.warn(`[setu] 图片不完整（下载中断） ${String(attempt.url).slice(0, 120)}: ${buffer?.length ?? 0} bytes`);
      buffer = null;
    } catch (error) {
      markPximgMiss(attempt.url);
      console.warn(`[setu] 图片下载失败 ${String(attempt.url).slice(0, 120)}: ${error?.message ?? error}`);
    }
  }
  if (!buffer || !buffer.length) return null;
  const { payload, file } = savePayload(buffer, cfg.send?.payloadMode);
  return { payload, file, bytes: buffer.length, mime: detectMime(buffer) || 'image/jpeg' };
}

// ── 去重源 ──────────────────────────────────────────────────────────

/** 跨运行共享的冷却 + 去重状态（进程级单例，去重持久化到磁盘，重启不清空）。 */
export class SetuSource {
  constructor() {
    this.lastSendAt = 0;
    this.inFlightSince = 0;   // 进行中请求的占位（并发闸门，见 tryBeginSend）
    this.sentSet = new Set();
    this.sentOrder = [];
    this._loadDedup();
  }

  _loadDedup() {
    try {
      if (fs.existsSync(DEDUP_FILE)) {
        const raw = fs.readFileSync(DEDUP_FILE, 'utf8');
        const urls = JSON.parse(raw);
        if (Array.isArray(urls)) {
          for (const u of urls) {
            if (typeof u === 'string' && u) {
              this.sentSet.add(u);
              this.sentOrder.push(u);
            }
          }
          console.log(`[setu] 已加载去重记录：${this.sentSet.size} 条`);
        }
      }
    } catch (err) {
      console.warn(`[setu] 加载去重记录失败：${err.message}`);
    }
  }

  _saveDedup() {
    try {
      fs.writeFileSync(DEDUP_FILE, JSON.stringify(this.sentOrder), 'utf8');
    } catch (err) {
      console.warn(`[setu] 保存去重记录失败：${err.message}`);
    }
  }

  cooldownActive(send) {
    const ms = Math.max(0, Number(send?.cooldownMs) || 0);
    return ms > 0 && Date.now() - this.lastSendAt < ms;
  }

  /**
   * 冷却检查 + 占位，**必须原子完成**（单线程 JS 内同步执行，天然原子）。
   * 之前"入口检查 cooldownActive → 全部下载完成才 markSent"是两步，
   * 两个并发请求会在对方的下载窗口内都通过检查，冷却防刷屏被穿透。
   * 占位有效期即冷却窗口本身：请求挂死也不会永久锁死发图。
   */
  tryBeginSend(send) {
    const ms = Math.max(0, Number(send?.cooldownMs) || 0);
    const now = Date.now();
    if (ms > 0) {
      if (now - this.lastSendAt < ms) return false;
      if (this.inFlightSince && now - this.inFlightSince < ms) return false;
    }
    if (!this.inFlightSince) this.inFlightSince = now;
    return true;
  }

  /** 释放占位。成功路径在调用方已 markSent（占位不算冷却的起点），失败/放弃只放闸门。 */
  releaseHold() { this.inFlightSince = 0; }

  markSent() { this.lastSendAt = Date.now(); }
  isRecent(url) { return this.sentSet.has(url); }
  remember(url, max) {
    if (this.sentSet.has(url)) return;
    this.sentSet.add(url);
    this.sentOrder.push(url);
    const cap = Math.max(1, Math.trunc(Number(max) || 500));
    while (this.sentOrder.length > cap) {
      this.sentSet.delete(this.sentOrder.shift());
    }
    this._saveDedup();
  }
}

export const defaultSetuSource = new SetuSource();

// ── 候选按序下载 ──────────────────────────────────────────────────────────

/**
 * 候选按序下载：从质量最优的候选开始（调用方保证 urls 已按优先级排序），
 * 一批 max(limit, 4) 个并行下载（4 = 超采兜底，Pixiv 原图有下载失败率），
 * 成功者**按质量顺序**取用；不足 limit 张时继续下一批，直到候选用尽。
 */
export async function pickBestImages(urls, limit, downloadOne, isAcceptable, onAccepted) {
  const picked = [];
  let cursor = 0;
  while (picked.length < limit && cursor < urls.length) {
    const batch = urls.slice(cursor, cursor + Math.max(limit, 4));
    cursor += batch.length;
    const results = await Promise.all(batch.map(async (url) => {
      try {
        return { url, got: await downloadOne(url) };
      } catch {
        return { url, got: null };
      }
    }));
    for (const { url, got } of results) {
      if (picked.length >= limit) break;
      if (!got || !isAcceptable(got)) continue;
      picked.push({ url, got });
      onAccepted?.(url);
    }
  }
  return picked;
}

// ── 延时工具 ──────────────────────────────────────────────────────────

/** 延时 ms 毫秒（用于 429 限速重试）。 */
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
