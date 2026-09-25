// knowledge-verify —— LLM 型技能：知识库工具面（宿主 tools.js 的 kb_recall/kb_write/kb_crawl 照搬）
//
// 软依赖：api.capability('knowledge.recall' / 'knowledge.agent-write' / 'knowledge.crawl')
//   —— 这些能力由 plugins/kb-growth 提供。缺插件时能力为 undefined，工具如实报「知识库未启用」。
//   这是防孤儿能力的关键消费方（plugin-development.md §5：自建能力名必须有人用 api.capability 消费）。

import { imagesFromMessage, toKbImage } from './lib/image-source.js';

export function setup(api) {
  // 软依赖取用（有就拿到，没有就是 undefined；抛错也被吞掉）
  const recallFn = api.capability('knowledge.recall');
  const writeFn = api.capability('knowledge.agent-write');
  const crawlFn = api.capability('knowledge.crawl');
  // 取图要联网下载（api.fetch 需 manifest 声明 permissions: ["web_fetch"]）
  const fetchImpl = typeof api.fetch === 'function' ? api.fetch : globalThis.fetch;

  const ok = (data) => ({ content: typeof data === 'string' ? data : JSON.stringify(data, null, 2) });
  const err = (msg) => ({ content: msg, isError: true });

  api.registerTool({
    id: 'kb_recall',
    name: '知识库检索',
    description: '知识库检索（本地优先 + 联网兜底）。凡是需要事实依据的问题（XX 是什么 / 为什么 / 怎么算 / 有没有这回事）先用它：先查本地知识库（200ms 内出结果），命中不足会自动联网搜索（3s 上限）。它比直接 web_search 更快，且会把搜到的好资料沉淀进知识库，越用越全。返回里的「检索资料」段落可直接引用，注明来源；若返回「暂无，已记录」，如实说不知道，不要编造。',
    category: 'knowledge',
    icon: '📚',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的问题或关键词，用自然问句即可' },
        topK: { type: 'integer', description: '可选：本地资料条数，默认 5，最大 8' },
      },
      required: ['query'],
    },
    async execute(ctx, args) {
      try {
        if (!recallFn) return err('知识库插件未启用（plugins/kb-growth 没装或不可用），无法检索。可改用 web_search。');
        const query = String(args.query ?? '').trim();
        if (!query) return err('要指定 query');
        const r = await recallFn({ query, chatKey: ctx.chatKey, topK: Math.min(8, Math.max(1, Number(args.topK) || 5)) });
        const out = [];
        if (r.context) out.push(r.context);
        else out.push(String(r.note ?? '暂无，已记录。'));
        out.push('（来源：' + r.source + '｜置信度 ' + r.confidence + '｜总耗时 ' + r.latency_ms + 'ms' + (r.degraded ? '｜已降级' : '') + '）');
        if (r.source === 'kb' || r.source === 'kb+web') {
          out.push('以上资料可直接引用；如与问题明显不符或涉及实时数据，再用 web_search 补一次。');
        }
        return ok(out.join('\n'));
      } catch (error) {
        return err('知识库检索失败：' + (error?.message ?? error));
      }
    },
  });

  api.registerTool({
    id: 'kb_write',
    name: '知识库写入',
    description: '把知识写进本地知识库（只有管理员能用，其他人调用会被拒绝）。管理员说「把这段记进知识库 / 追加到 XX 词条 / 把这几张图收进 XX 词条」时用。action=append 会并进已有词条（用 target_title 指定），找不到就新建；action=create 直接新建。要采集聊天记录里的图片，把对应消息的 #数字 填进 image_message_ids。正文至少 40 字。写入的是正式库，写完立刻能被 kb_recall 检索到。管理员没点名某个已存在词条时不要用 append，直接用 create。',
    category: 'knowledge',
    icon: '✍️',
    defaultEnabled: false,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'append'], description: 'append=追加到已有词条（需 target_title）；create=新建词条' },
        title: { type: 'string', description: '词条标题。新建时必填；追加时若没给 target_title，用它来定位词条' },
        content: { type: 'string', description: '要写入的正文（中文，至少 40 字）。只采集图片、不写正文时可省略' },
        target_title: { type: 'string', description: 'action=append 时：要追加到哪个已有词条' },
        image_message_ids: { type: 'array', items: { type: ['integer', 'string'] }, description: '要一并收进该词条的图片所在消息 id（#数字），可给多张' },
        source_url: { type: 'string', description: '可选：内容来源链接' },
      },
    },
    async execute(ctx, args) {
      try {
        if (!writeFn) return err('知识库插件未启用，无法写入。');
        const action = String(args.action ?? '').trim().toLowerCase() === 'append' ? 'append' : 'create';
        // 采集消息里的图片：image_message_ids → 存档取图 → 下载/读取字节（宿主 messageImageBuffers 的 V0.3.1 等价实现）
        let images = [];
        const mids = Array.isArray(args.image_message_ids) ? args.image_message_ids : [];
        if (mids.length) {
          const maxImages = 8;
          for (const mid of mids.slice(0, maxImages)) {
            try {
              const got = await imagesFromMessage(ctx, mid, { fetchImpl, maxBytes: 8 * 1024 * 1024 });
              for (const g of got) images.push(toKbImage(g));
            } catch { /* 单张取图失败不阻断写入 */ }
            if (images.length >= maxImages) break;
          }
          images = images.slice(0, maxImages);
        }
        const r = await writeFn({
          action,
          title: String(args.title ?? '').trim(),
          content: String(args.content ?? '').trim(),
          targetTitle: String(args.target_title ?? '').trim() || null,
          sourceUrl: String(args.source_url ?? '').trim(),
          images,
          requester: ctx.requesterId,
          chatKey: ctx.chatKey,
        });
        if (!r.ok) return err(r.error);
        return ok({
          action: r.action,
          chunks: r.chunks,
          chunksSkipped: r.chunksSkipped,
          deduped: r.deduped,
          images: r.images,
          detail: [
            r.chunks ? '新增 ' + r.chunks + ' 个分块' : '',
            r.chunksSkipped ? r.chunksSkipped + ' 个与已有内容相同已跳过' : '',
            r.deduped ? '正文与已有内容完全相同、没有重复写入' : '',
            r.images ? '采集 ' + r.images + ' 张图片' : '',
          ].filter(Boolean).join('；') || '写完了',
          note: '用一句话把结果告诉管理员即可，不要念技术细节。',
        });
      } catch (error) {
        return err('写入知识库失败：' + (error?.message ?? error));
      }
    },
  });

  api.registerTool({
    id: 'kb_crawl',
    name: '爬取网页入库',
    description: '爬取一个网页 URL 的正文和图片，写入本地知识库（只有管理员能用）。管理员说「把 XX 网站/链接的内容收进知识库」「爬一下这个 URL」时用。正文会写入正式库（立刻可被 kb_recall 检索）。url 必填；title 可选（不填则自动提取）；max_images 可选，默认 3，最大 8。',
    category: 'knowledge',
    icon: '🕸️',
    defaultEnabled: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要爬取的网页 URL（http/https）' },
        title: { type: 'string', description: '可选：词条标题（不填则从页面自动提取）' },
        max_images: { type: 'integer', description: '可选：最多爬取图片数，默认 3，最大 8' },
      },
      required: ['url'],
    },
    async execute(ctx, args) {
      try {
        if (!crawlFn) return err('知识库插件未启用，无法爬取。');
        const url = String(args.url ?? '').trim();
        if (!url || !/^https?:\/\//i.test(url)) return err('url 必须是 http/https 链接');
        const r = await crawlFn({
          url,
          title: String(args.title ?? '').trim(),
          maxImages: Math.min(8, Math.max(1, Number(args.max_images) || 3)),
          requester: ctx.requesterId,
          chatKey: ctx.chatKey,
        });
        if (!r.ok) return err(r.error);
        return ok({
          docId: r.docId,
          title: r.title,
          chunks: r.chunks,
          images: r.images,
          note: '已经把这篇文章收进知识库了，一句话告诉管理员即可。',
        });
      } catch (error) {
        return err('爬取失败：' + (error?.message ?? error));
      }
    },
  });
}

export function available() {
  return { ok: true, reason: '工具可用（能力由 plugins/kb-growth 软依赖提供，缺时工具如实报错）' };
}
