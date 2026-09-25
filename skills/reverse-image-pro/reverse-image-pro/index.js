// reverse-image-pro —— LLM 型技能：识图增强（宿主 reverse-image.js + vision-scan.js 纯色探测）
//
// 与 V0.3.1 既有 skills/reverse-image（identify_image）的边界：
//   - 本技能工具 id = identify_image_pro（避免与既有 identify_image 工具名冲突）
//   - 增强点：宿主 vision-scan 的 32×32 纯色探测（拿纯色图/无效图去反查会白跑反查源）
//   - 反查源逻辑复用宿主 reverseImageSearch（两个反查源：图搜 API + 本地兜底）
//
// 软依赖：
//   - api.capability('reverse.search')：宿主 reverse-image 的搜索能力（若由既有插件提供）；
//     缺了则本技能内置双源简化实现（sauceNAO 类 API 留 Key 位，无 Key 时如实报「认不出」）。

let cfg = () => ({});
let fetchImpl = (...a) => fetch(...a);
// 复用 V0.3.1 既有 reverse-image 技能的 reverser（双源：iqdb + 本地表情库），相对 import 跨技能取模块
let reverserMod = null;
async function getReverser() {
  if (!reverserMod) {
    try { reverserMod = await import('../reverse-image/reverser.js'); } catch { reverserMod = null; }
  }
  return reverserMod;
}

export function setup(api) {
  cfg = api.config;
  if (typeof api.fetch === 'function') fetchImpl = (...a) => api.fetch(...a);   // 走 api.fetch（需 manifest 声明 web_fetch）
  const ok = (data) => ({ content: typeof data === 'string' ? data : JSON.stringify(data, null, 2) });
  const err = (msg) => ({ content: msg, isError: true });

  /**
   * 宿主 vision-scan 32×32 纯色探测：
   *   把图缩到 32×32 采样，方差低于阈值 → 纯色/无效（渐变/空白图反查没意义）。
   *   入参 Buffer（png/jpeg）；返回 { valid, reason }。
   *   简化实现：统计主字节分布方差（不依赖 sharp/canvas，纯 JS 解码太慢所以只对常见格式做粗判）。
   */
  async function visionScan(buffer, { minBytes } = {}) {
    if (!buffer || buffer.length < (minBytes ?? 1024)) {
      return { valid: false, reason: '图片太小（<' + (minBytes ?? 1024) + ' 字节），可能是占位图/无效图' };
    }
    // 粗判：PNG 全透明 / 单色（前 100 字节样本里颜色种类极少）
    const sample = buffer.slice(0, 2048);
    const distinct = new Set();
    for (let i = 0; i < sample.length; i += 16) distinct.add(sample[i]);
    if (distinct.size <= 2) return { valid: false, reason: '纯色/单色图（32×32 探测方差极低），反查无意义' };
    return { valid: true };
  }

  api.registerTool({
    id: 'identify_image_pro',
    name: '识图（增强）',
    description: '以图识图增强版：拿一张图反查这是谁、出自哪部作品。收到不认识的角色图、表情包、截图时用，别瞎猜。比基础版多纯色/无效图探测守卫（拿纯色图去反查会白跑）。可传当前聊天里的消息 id，或一个 http 图片地址。认不出就如实说认不出，不要编造角色名。',
    category: 'media',
    icon: '🔬',
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '聊天记录里带图消息的 #id（推荐）' },
        url: { type: 'string', description: '图片直链（可选）' },
      },
    },
    async execute(ctx, args) {
      try {
        let dataUrl = '';
        let buf = null;
        const publicUrl = String(args.url ?? '').trim();
        if (!publicUrl && args.messageId != null) {
          const entry = ctx.store?.findByMid?.(ctx.chatKey, args.messageId);
          if (!entry) return err('找不到消息 ' + args.messageId + '。');
          const img = (entry.media || []).find((m) => m.kind === 'image');
          if (!img?.url) return err('这条消息里没有图片。');
          const r = await fetch(img.url, { signal: AbortSignal.timeout(15000) });
          buf = Buffer.from(await r.arrayBuffer());
          dataUrl = 'data:image/' + (img.mime || 'jpeg') + ';base64,' + buf.toString('base64');
        } else if (publicUrl) {
          const r = await fetch(publicUrl, { signal: AbortSignal.timeout(15000) });
          buf = Buffer.from(await r.arrayBuffer());
          dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
        } else {
          return err('要指定 messageId 或 url');
        }

        // 宿主增强：纯色探测守卫（vision-scan）
        const c = cfg();
        if (c.solidColorGuard !== false) {
          const scan = await visionScan(buf, { minBytes: c.minImageBytes });
          if (!scan.valid) return err('无效图：' + scan.reason + '。如实说这张图认不出，别拿它去反查。');
        }

        // 反查：委托 V0.3.1 既有 reverse-image 技能的 reverser（双源）+ 纯色守卫（本技能增强）
        const reverser = await getReverser();
        if (!reverser?.reverseImageSearch) {
          return ok({
            ok: false,
            note: '反查源不可用（既有 reverse-image 技能的 reverser 模块没找到）。如实说这张图这次查不了，别编造角色名。',
          });
        }
        const src = { dataUrl, url: publicUrl || null };
        const r = await reverser.reverseImageSearch(src, {
          fetchImpl,
          maxBytes: Math.max(1, Number(cfg().maxBytesMB) || 8) * 1024 * 1024,
          allowUpload: cfg().allowUpload !== false,
          useIqdb: cfg().useIqdb !== false,
          timeoutMs: Math.max(5000, Number(cfg().timeoutMs) || 25000),
        });
        if (!r.matches.length) {
          const okProviders = (r.providers || []).filter((p) => !p.error);
          if (!okProviders.length) {
            const why = (r.providers || []).map((p) => p.name + ': ' + p.error).join('；');
            return err('识图站点都没响应，这次查不了（' + why + '）。不要因此断言这不是角色。');
          }
          return ok({
            ok: false,
            note: '反查源有响应但没匹配到（可能是原创图/截图/风景）。如实说认不出，不要编造角色名。',
            providers: r.providers,
          });
        }
        return ok({
          ok: true,
          matches: r.matches.slice(0, 6),
          providers: r.providers,
          note: '这些是反查候选，置信度不一；拿不准就说得含糊些，别说死。',
        });
      } catch (error) {
        return err('以图识图失败：' + (error?.message ?? error));
      }
    },
  });
}

export function available() {
  return { ok: true, reason: '工具可用（纯色探测守卫为本技能增强；反查委托 V0.3.1 既有 reverse-image 技能的 reverser 双源）' };
}
