// meme-lib —— LLM 型技能：梗库工具面（宿主 memes.js 工具面照搬）
//
// 软依赖：api.capability('meme.data'/'meme.cue') —— 能力由 plugins/meme-engine 提供。
//   缺插件时能力为 undefined，工具如实报「梗库未启用」（防孤儿能力消费方）。

export function setup(api) {
  const dataFn = api.capability('meme.data');
  const cueFn = api.capability('meme.cue');

  const ok = (data) => ({ content: typeof data === 'string' ? data : JSON.stringify(data, null, 2) });
  const err = (msg) => ({ content: msg, isError: true });

  api.registerTool({
    id: 'meme_save',
    name: '存梗',
    description: '把群里可复用的梗、口头禅、内部笑话、外号、短笔记存进梗库，以后闲聊能自动联想。原文不超过 60 字，只存以后还用得上的，不要存临时话题。自动推断标签（称呼/口头禅/黑话/梗图/典故/群梗）并语义去重。',
    category: 'media',
    icon: '😄',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '梗或笔记原文（不超过 60 字）' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签（不填则自动推断）' },
        note: { type: 'string', description: '可选补充说明（谁说的、什么场合）' },
      },
      required: ['text'],
    },
    async execute(ctx, args) {
      try {
        if (!dataFn) return err('梗库插件未启用（plugins/meme-engine 没装或不可用）。');
        const text = String(args.text ?? '').trim();
        if (!text) return err('要指定 text');
        if (text.length > 60) return err('梗原文太长了（>60 字），只存以后还用得上的短梗。');
        // 走 dataFn 的 importFromMemory 同路（内存 items + 持久化）
        const r = await dataFn({ op: 'save', text, tags: Array.isArray(args.tags) ? args.tags : [], note: args.note });
        if (!r.ok) return err(r.error || '存梗失败');
        return ok(r.deduped ? '这条梗库里已经有了（已刷新使用次数），不用重复记。' : '已存进梗库。用一句自然的话说一声就好，别念技术细节。');
      } catch (e) {
        return err('存梗失败：' + (e?.message ?? e));
      }
    },
  });

  api.registerTool({
    id: 'meme_search',
    name: '搜梗',
    description: '在梗库里搜梗、口头禅、外号。当群里提到某个说法你不确定是什么意思、或想引用以前的内部笑话时用。返回带真实使用次数（uses）与录入次数（saves）的条目。',
    category: 'media',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的说法或关键词' },
        limit: { type: 'integer', description: '返回条数，默认 5，最大 10' },
      },
      required: ['query'],
    },
    async execute(ctx, args) {
      try {
        if (!dataFn) return err('梗库插件未启用。');
        const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
        // 先取列表，再用 cueFn 做语义联想排序
        const listR = await dataFn({ op: 'list' });
        if (!listR.ok || !listR.items?.length) return ok('梗库是空的。别硬猜含义，就当普通话说。');
        let hits = listR.items;
        if (cueFn) {
          const cueR = await cueFn({ text: String(args.query ?? ''), limit: limit * 3 });
          if (cueR.cues?.length) {
            const order = new Map(cueR.cues.map((c, i) => [c.text, i]));
            hits = [...listR.items].sort((a, b) => (order.get(a.text) ?? 999) - (order.get(b.text) ?? 999));
          }
        } else {
          const q = String(args.query ?? '').toLowerCase();
          hits = listR.items.filter((m) => m.text.toLowerCase().includes(q) || (m.tags ?? []).some((t) => t.includes(q)));
        }
        const top = hits.slice(0, limit);
        if (!top.length) return ok('梗库里没有相关条目。别硬猜含义，就当普通话说。');
        return ok({
          ok: true,
          total: listR.count,
          hits: top.map((m) => ({ text: m.text, tags: m.tags, uses: m.uses, saves: m.saves, locked: m.locked })),
        });
      } catch (e) {
        return err('搜梗库失败：' + (e?.message ?? e));
      }
    },
  });

  api.registerTool({
    id: 'meme_import',
    name: '收编记忆库梗',
    description: '把记忆库里已审核通过的梗（kind=meme 条目）批量搬进梗库（自动三道闸：像不像梗→语义去重≥0.90→截断到停顿）。只推荐不自动入库——需用户确认后执行。收编时顺手整库标签归一。',
    category: 'media',
    icon: '📥',
    defaultEnabled: false,
    parameters: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: '用户已确认收编。未确认时不要调。' },
      },
      required: ['confirm'],
    },
    async execute(ctx, args) {
      try {
        if (!dataFn) return err('梗库插件未启用。');
        if (args.confirm !== true) return err('这是推荐操作：请让用户确认后再传 confirm=true。收编会把记忆库的梗搬进梗库（自动去重）。');
        const r = await dataFn({ op: 'importFromMemory' });
        if (!r.ok) return err(r.error || '收编失败');
        return ok('收编 ' + (r.imported ?? 0) + ' 条新梗、去重 ' + (r.deduped ?? 0) + ' 条、跳过 ' + (r.skipped ?? 0) + ' 条（事件味）。简短告知即可。');
      } catch (e) {
        return err('收编失败：' + (e?.message ?? e));
      }
    },
  });

  api.registerTool({
    id: 'meme_admin',
    name: '梗库管理台',
    description: '梗库管理台（管理员用）：淘汰（prune，locked 永不淘汰）、锁定/停用（flags）、真实使用统计（noteUse）、发现高频短句候选（suggest，只推荐不自动入库）。不要主动淘汰，需用户点头。',
    category: 'media',
    icon: '🛠️',
    defaultEnabled: false,
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['prune', 'flags', 'noteUse', 'suggest', 'list'], description: 'prune=淘汰超限；flags=锁定/停用；noteUse=记真实使用；suggest=发现候选；list=列全部' },
        targetId: { type: 'string', description: 'flags 时：目标梗 id' },
        locked: { type: 'boolean', description: 'flags：是否锁定（locked 永不淘汰）' },
        disabled: { type: 'boolean', description: 'flags：是否停用（停用的不再被联想）' },
      },
      required: ['op'],
    },
    async execute(ctx, args) {
      try {
        if (!dataFn) return err('梗库插件未启用。');
        const r = await dataFn({
          op: args.op,
          id: args.targetId,
          locked: args.locked,
          disabled: args.disabled,
        });
        if (!r.ok) return err(r.error || '操作失败');
        if (args.op === 'prune') return ok('淘汰 ' + (r.pruned ?? 0) + ' 条（现余 ' + r.kept + ' 条）。');
        if (args.op === 'noteUse') return ok('记了 ' + (r.count ?? 0) + ' 条真实使用。');
        if (args.op === 'list') return ok({ count: r.count, items: r.items?.slice(0, 50) });
        return ok('完成：' + JSON.stringify(r).slice(0, 200));
      } catch (e) {
        return err('管理台操作失败：' + (e?.message ?? e));
      }
    },
  });
}

export function available() {
  return { ok: true, reason: '工具可用（能力由 plugins/meme-engine 软依赖提供，缺时工具如实报错）' };
}
