// 以图识图（LLM 型技能）
//
// 移植自桌面魔改包 `10-reverse-image`。魔改包原版是直接改 `src/tools.js`（本体修改）；
// 这里改成标准扩展：注册一个工具，其余不动核心。
//
// ── 为什么是 LLM 型（skills/）而不是确定性型 ────────────────────────────────
// "这张图我不认识，要不要查一下" 完全取决于模型对场景的理解（是不是在问"这是谁"、
// 是不是群友发了张梗图）。没有可写成确定条件的触发时机，硬做成确定性型会导致
// 每来一张图都去调一次识图站（既慢又烧配额）。所以：注册工具，由模型决定。

import fs from 'node:fs';
import { reverseImageSearch } from './reverser.js';
import { localStickerPath } from '../../src/sticker-manager.js';

let cfg = () => ({});
let fetchImpl = (...a) => fetch(...a);

export function setup(api) {
  cfg = api.config;
  // 走 api.fetch：清单里声明了 permissions:["web_fetch"] 才拿得到真 fetch，
  // 否则这个函数会 reject —— 与核心的安全机制保持同一口径。
  if (typeof api.fetch === 'function') fetchImpl = (...a) => api.fetch(...a);

  api.registerTool({
    id: 'identify_image',
    name: '以图识图',
    description: '拿一张图反查它是谁、出自哪部作品/哪张表情包。当你不认识群友发的图、'
      + '不确定某个角色或来源时用它，别凭感觉猜。传 messageId（那条消息的 #数字）、'
      + 'stickerId（表情库里的 id）、或 url（图片地址）三者之一。',
    category: 'media',
    icon: '🔎',
    requiresVision: false,
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '那条带图/表情的消息 id（聊天记录里的 #数字）' },
        stickerId: { type: 'string', description: '表情库里的 id（list_stickers 返回的那个）' },
        url: { type: 'string', description: '图片的 http(s) 地址（与前两个二选一）' }
      }
    },
    async execute(ctx, args) {
      try {
        const src = await resolveImageSource(ctx, args);
        if (!src) {
          return {
            content: '没找到可反查的图片：请传 messageId（带图消息的 #数字）、stickerId、或 url 三者之一。',
            isError: true
          };
        }

        const r = await reverseImageSearch(src, {
          fetchImpl,
          maxBytes: Math.max(1, Number(cfg().maxBytesMB) || 8) * 1024 * 1024,
          allowUpload: cfg().allowUpload !== false,
          useIqdb: cfg().useIqdb !== false,
          timeoutMs: Math.max(5000, Number(cfg().timeoutMs) || 25000)
        });

        // 全站都失败 → 明确说"查不了"，别让模型以为"没结果 = 不是角色"
        const okProviders = r.providers.filter((p) => !p.error);
        if (!r.matches.length && !okProviders.length) {
          const why = r.providers.map((p) => `${p.name}: ${p.error}`).join('；');
          return { content: `识图站点都没响应，这次查不了（${why}）。不要因此断言"这不是角色"。`, isError: true };
        }
        if (!r.matches.length) {
          return ok({
            result: '没查到匹配结果',
            hint: '识图站返回了但没有可比对的条目。可以直接跟群友说不认识，别硬猜。',
            providers: r.providers,
            ...(r.note ? { note: r.note } : {})
          });
        }
        return ok({
          result: '疑似来源（按站点返回顺序，未必准）',
          matches: r.matches,
          providers: r.providers,
          ...(r.note ? { note: r.note } : {})
        });
      } catch (error) {
        return { content: `识图失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

function ok(payload) {
  return { content: JSON.stringify(payload, null, 1) };
}

/**
 * 从三种入参解出"可以交给识图站的东西"。
 * 返回 { url } 或 { dataUrl }；都没有返回 null。
 * 优先级：显式 url > 表情 > 消息里的图。
 */
async function resolveImageSource(ctx, args) {
  const direct = String(args?.url || '').trim();
  if (/^https?:\/\//i.test(direct)) return { url: direct };
  if (/^data:/i.test(direct)) return { dataUrl: direct };

  const stickerId = String(args?.stickerId || '').trim();
  if (stickerId) {
    const sticker = await ctx?.stickers?.find?.(stickerId);
    if (sticker) {
      if (/^https?:\/\//i.test(String(sticker.url || ''))) return { url: String(sticker.url) };
      // 收藏的表情多数是本地文件：读成 dataUrl（也顺带绕开了"本地路径不能给远端"的问题）
      const local = localStickerPath(sticker.url);
      if (local) return { dataUrl: fileToDataUrl(local) };
    }
  }

  const mid = String(args?.messageId ?? '').replace(/^#/, '').trim();
  if (mid) {
    const entry = ctx?.store?.findByMid?.(ctx.chatKey, mid);
    const media = (entry?.media || []).find((m) => m?.kind === 'image' || m?.kind === 'face');
    if (media) {
      if (/^https?:\/\//i.test(String(media.url || ''))) return { url: String(media.url) };
      if (media.path && fs.existsSync(String(media.path))) return { dataUrl: fileToDataUrl(String(media.path)) };
      // 消息里的图没有直链：让 OneBot 现取一个（get_image 在不同协议端叫法不一，失败就放弃）
      const got = await tryOnebotImage(ctx, media);
      if (got) return got;
    }
  }
  return null;
}

/** 本地文件 → data URL（按魔数判 mime，别信扩展名）。 */
function fileToDataUrl(file) {
  const buf = fs.readFileSync(file);
  let mime = 'image/jpeg';
  if (buf.length > 12) {
    if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
    else if (buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
    else if (buf.toString('ascii', 0, 3) === 'GIF') mime = 'image/gif';
    else if (buf.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  }
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** 用 OneBot 的 get_image 现取图片地址（协议端实现不一，逐个试，全失败返回 null）。 */
async function tryOnebotImage(ctx, media) {
  const key = String(media.file || media.url || '').trim();
  if (!key || !ctx?.onebot?.call) return null;
  try {
    const r = await ctx.onebot.call('get_image', { file: key });
    const u = r?.url ?? r?.data?.url ?? r?.file ?? r?.data?.file;
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) return { url: u };
  } catch { /* 拿不到就算了，由调用方报"没找到可反查的图片" */ }
  return null;
}

export const internals = { resolveImageSource, fileToDataUrl };
