// image-source.js —— 从 V0.3.1 的消息存档里取出图片字节（供 kb_write 采集入库）
//
// 参考 V0.3.1 原生 skills/reverse-image 的 resolveImageSource：三种来源按优先级取
// （显式 URL > 表情 > 消息里的图），本地文件按魔数判 mime 转 data URL。
// 这里简化为 kb_write 需要的两种：messageId → 图片字节、显式 url → 下载字节。
//
// 契约：调用方必须传 fetchImpl（skill 里是 api.fetch，需 manifest 声明 web_fetch 权限）。

import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES_DEFAULT = 8 * 1024 * 1024;

/** 本地文件 → Buffer（按魔数判类型，别信扩展名）。 */
export function readLocalImage(file) {
  try {
    const buf = fs.readFileSync(file);
    return sniffMime(buf) ? buf : null;
  } catch { return null; }
}

/** 魔数识图：返回 mime 或 null（非图片）。 */
export function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

/**
 * 从一条消息里取图片（V0.3.1 存档结构：entry.media[] = { kind, url, path }）。
 * @returns {Promise<Array<{url, buffer, mime}>>}
 */
export async function imagesFromMessage(ctx, messageId, { fetchImpl, maxBytes = MAX_BYTES_DEFAULT } = {}) {
  const mid = String(messageId ?? '').replace(/^#/, '').trim();
  if (!mid) return [];
  const entry = ctx?.store?.findByMid?.(ctx.chatKey, mid);
  if (!entry) return [];
  const media = (entry.media || []).filter((m) => m?.kind === 'image' || m?.kind === 'face');
  const out = [];
  for (const m of media) {
    const url = String(m.url || '').trim();
    // 1) http(s) 直链 → 下载
    if (/^https?:\/\//i.test(url)) {
      const buf = await downloadImage(url, { fetchImpl, maxBytes });
      if (buf) out.push({ url, buffer: buf, mime: sniffMime(buf) || 'image/jpeg' });
      continue;
    }
    // 2) 本地路径 → 直接读
    if (m.path && fs.existsSync(String(m.path))) {
      const buf = readLocalImage(String(m.path));
      if (buf) out.push({ url: url || ('file://' + String(m.path)), buffer: buf, mime: sniffMime(buf) || 'image/jpeg' });
      continue;
    }
    // 3) data: URL → 解 base64
    if (/^data:image\//i.test(url)) {
      const mm = url.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
      if (mm) {
        const buf = Buffer.from(mm[2], 'base64');
        if (buf.length && sniffMime(buf)) out.push({ url: '', buffer: buf, mime: mm[1] });
      }
    }
  }
  return out;
}

/** 下载图片（带体积上限 + 魔数校验）。 */
export async function downloadImage(url, { fetchImpl, maxBytes = MAX_BYTES_DEFAULT } = {}) {
  const f = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  try {
    const res = await f(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > maxBytes) return null;
    return sniffMime(buf) ? buf : null;      // 挡掉「链接其实返回 HTML 防盗链页」
  } catch { return null; }
}

/** 把 (url, buffer) 归一化成 kb-growth 的 agent-write 期望形状。 */
export function toKbImage({ url, buffer, mime }) {
  return { url: String(url || ''), buffer, mime: mime || sniffMime(buffer) || 'image/jpeg' };
}
