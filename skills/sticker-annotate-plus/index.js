// sticker-annotate-plus —— LLM 型技能：批量补表情备注（宿主 04-sticker-plus 的 annotateMissing 语义）
//
// 宿主的 annotateMissing 是「UI 一键补备注」→ 后台状态机批量取图 → 视觉模型 → 写备注。
// V0.3.1 已有全部零件（list_stickers / get_sticker_image / sticker_note），
// 但 get_sticker_image **一次只能看一张** —— 补 20 张要 20 次往返。
//
// 本技能补的就是这一段：一次把 N 张「还没备注」的表情图一起返回（走 parts），
// 模型看过之后用核心既有的 sticker_note 逐个写备注。
// 不重复实现取图/存库 —— 都走 ctx.stickers（核心的真源）。

export function setup(api) {
  const ok = (d) => ({ content: typeof d === 'string' ? d : JSON.stringify(d, null, 2) });
  const err = (m) => ({ content: m, isError: true });

  api.registerTool({
    id: 'annotate_stickers',
    name: '批量补表情备注',
    description: '把「还没备注」的收藏表情一次取出来看（图直接给你）。群友说「帮我把表情备注补一下」「这些表情你都认识吗」时用：本工具返回若干张表情的图片和它们的 id，你看完后用 sticker_note 逐个写理解。比一张张 get_sticker_image 快得多。',
    category: 'sticker',
    icon: '🏷️',
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '一次最多取几张未备注的表情，默认 8，最大 16' },
        onlyMissing: { type: 'boolean', description: '只取没有备注的，默认 true' },
      },
    },
    async execute(ctx, args) {
      try {
        const stickers = ctx?.stickers;
        if (!stickers) return err('表情库不可用（ctx.stickers 缺失）');
        // 触发一次 sync 拿新鲜条目（与核心 list 同源）
        try { await stickers.list('', 1); } catch { /* 同步失败就用现有条目 */ }
        const entries = Array.isArray(stickers.entries) ? stickers.entries : [];
        if (!entries.length) return err('表情库是空的（收藏里还没有表情）。');

        const onlyMissing = args.onlyMissing !== false;
        const limit = Math.min(16, Math.max(1, Number(args.limit) || 8));
        const hasNote = (e) => Boolean(String(e?.localNote || e?.desc || '').trim());
        const pool = onlyMissing ? entries.filter((e) => !hasNote(e)) : entries;
        if (!pool.length) return ok('所有表情都已经有备注了（共 ' + entries.length + ' 个），没有需要补的。');

        const picked = pool.slice(0, limit);
        const download = ctx?.downloadImageAsDataUrl || null;
        // 图走 parts（宿主/核心的约定：base64 绝不能当文本塞进 content）
        const parts = [{ type: 'text', text: '以下是 ' + picked.length + ' 个' + (onlyMissing ? '还没有备注的' : '') + '表情（共 ' + pool.length + ' 个待处理）。请逐个看懂它们，然后用 sticker_note 给每个 id 写一句备注（含义/用法/标签）：' }];
        const ids = [];
        let got = 0;
        for (const e of picked) {
          ids.push({ id: String(e.id || ''), desc: String(e.desc || e.localNote || '') });
          const u = String(e.url || '');
          if (!u) continue;
          let dataUrl = null;
          try {
            if (/^data:image\//i.test(u)) dataUrl = u;
            else if (typeof download === 'function') dataUrl = await download(u);
            else {
              // 走核心的 api.fetch（manifest 已声明 web_fetch）
              const res = await api.fetch(u, { signal: AbortSignal.timeout(20000) });
              if (res.ok) {
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length && buf.length < 8 * 1024 * 1024) dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
              }
            }
          } catch { /* 单张失败跳过 */ }
          if (dataUrl) { parts.push({ type: 'image_url', image_url: { url: dataUrl } }); got++; }
        }
        parts.push({ type: 'text', text: '（取到 ' + got + '/' + picked.length + ' 张图）待补 id 清单：' + ids.map((x) => x.id).join(', ') + '。看完请对每个 id 调 sticker_note。' });
        return { content: parts };
      } catch (e) {
        return err('批量补备注失败：' + (e?.message ?? e));
      }
    },
  });
}

export function available() {
  return { ok: true, reason: '工具可用（复用核心 ctx.stickers 与 sticker_note）' };
}
