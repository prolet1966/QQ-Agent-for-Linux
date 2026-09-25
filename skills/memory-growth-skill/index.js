// memory-growth-skill —— LLM 型技能：记忆库工具面（宿主 memory-growth 生命周期语义照搬）
//
// 软依赖：api.capability('memory.recall'/'memory.review'/'memory.lifecycle')
//   —— 这些能力由 plugins/memory-growth 提供。缺插件时能力为 undefined，工具如实报「记忆库未启用」。
//   这是防孤儿能力的关键消费方。

export function setup(api) {
  const recallFn = api.capability('memory.recall');
  const reviewFn = api.capability('memory.review');
  const lifecycleFn = api.capability('memory.lifecycle');

  const ok = (data) => ({ content: typeof data === 'string' ? data : JSON.stringify(data, null, 2) });
  const err = (msg) => ({ content: msg, isError: true });

  api.registerTool({
    id: 'memory_search',
    name: '记忆检索',
    description: '在长期记忆库里按关键词检索很久以前的事（事件/梗/关系）。当前上下文不够、需要回忆很久以前的事时才调，不是每条消息都查。返回带相关度分数的记忆条目；拿不准就说得含糊些，别编造。',
    category: 'memory',
    icon: '🧠',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要回忆的事，用自然语句' },
        topK: { type: 'integer', description: '返回条数，默认 5，最大 10' },
      },
      required: ['query'],
    },
    async execute(ctx, args) {
      try {
        if (!recallFn) return err('记忆库插件未启用（plugins/memory-growth 没装或不可用）。');
        const r = await recallFn({ query: String(args.query ?? '').trim(), chatKey: ctx.chatKey, topK: Math.min(10, Math.max(1, Number(args.topK) || 5)) });
        if (!r.hits?.length) return ok('没有相关记忆。如实说想不起来，不要编造。');
        return ok({
          ok: true,
          count: r.hits.length,
          minScore: r.minScore,
          memories: r.hits.map((h) => ({
            kind: h.kind, content: h.content, score: h.score,
            mention_count: h.mention_count, last_seen_at: h.last_seen_at,
            ...(h.suspect_dup ? { suspect_dup: true } : {}),
            ...(h.conflict_suspect ? { conflict_suspect: true } : {}),
          })),
        });
      } catch (e) {
        return err('记忆检索失败：' + (e?.message ?? e));
      }
    },
  });

  api.registerTool({
    id: 'memory_review',
    name: '记忆审核',
    description: '审核记忆库里的候选记忆：approve 通过转正 / reject 拒绝 / undo 撤销刚通过的。只在你被要求「审核记忆/看看待审的」或用户明确指定某条记忆时调，不要主动批量审核。',
    category: 'memory',
    icon: '✅',
    defaultEnabled: false,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['approve', 'reject', 'undo'], description: 'approve=转正；reject=拒绝；undo=撤销刚转正的' },
        memoryId: { type: 'string', description: '候选记忆 id（mem_ 开头）' },
      },
      required: ['action', 'memoryId'],
    },
    async execute(ctx, args) {
      try {
        if (!reviewFn) return err('记忆库插件未启用，无法审核。');
        const r = await reviewFn({ action: String(args.action).trim(), memoryId: String(args.memoryId ?? '').trim(), chatKey: ctx.chatKey });
        if (!r.ok) return err(r.error || '审核失败');
        return ok('已 ' + ({ approve: '通过', reject: '拒绝', undo: '撤销' })[args.action] + ' 记忆 ' + args.memoryId + '。简短告知即可。');
      } catch (e) {
        return err('审核失败：' + (e?.message ?? e));
      }
    },
  });

  api.registerTool({
    id: 'memory_forget',
    name: '遗忘记忆',
    description: '彻底删除一条或一批记忆（候选 + 正式库一起删，删前写审计）。这是危险操作——只在用户明确说「忘掉 X/删掉这条记忆」时调，不要主动遗忘。删除后找不回。',
    category: 'memory',
    icon: '🗑️',
    defaultEnabled: false,
    parameters: {
      type: 'object',
      properties: {
        memoryIds: { type: 'array', items: { type: 'string' }, description: '要遗忘的记忆 id（mem_ 开头），可给多个' },
      },
      required: ['memoryIds'],
    },
    async execute(ctx, args) {
      try {
        if (!lifecycleFn) return err('记忆库插件未启用，无法遗忘。');
        const ids = Array.isArray(args.memoryIds) ? args.memoryIds.map(String) : [String(args.memoryIds)];
        const r = await lifecycleFn({ op: 'forget', memoryIds: ids });
        if (!r.ok) return err(r.error || '遗忘失败');
        return ok('已遗忘 ' + (r.count ?? 0) + ' 条记忆（已写审计）。简短告知即可。');
      } catch (e) {
        return err('遗忘失败：' + (e?.message ?? e));
      }
    },
  });

  api.registerTool({
    id: 'memory_archive',
    name: '归档旧记忆',
    description: '把久没提起的旧事件沉入归档（不参与检索、数据还在、随时可捞回）。只针对事件类（梗/关系不会过期）。第一次调用是预览（告诉你有几条会归档），用户确认后才真正归档——不要自己决定归档，需用户点头。',
    category: 'memory',
    icon: '📦',
    defaultEnabled: false,
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: '超过 N 天没被提起的事件；不填则只归档指定的 memoryIds' },
        memoryIds: { type: 'array', items: { type: 'string' }, description: '指定要归档的记忆 id（与 days 二选一）' },
      },
    },
    async execute(ctx, args) {
      try {
        if (!lifecycleFn) return err('记忆库插件未启用，无法归档。');
        const r = await lifecycleFn({
          op: 'archive',
          days: args.days != null ? Number(args.days) : undefined,
          memoryIds: Array.isArray(args.memoryIds) && args.memoryIds.length ? args.memoryIds.map(String) : null,
        });
        if (!r.ok) return err(r.error || '归档失败');
        if (r.applied === false) return ok('预览：有 ' + (r.preview ?? r.count) + ' 条旧事件可归档（超过 ' + (args.days ?? '?') + ' 天没被提起）。要真归档请再确认一次。');
        return ok('已归档 ' + (r.count ?? 0) + ' 条旧事件（可捞回）。简短告知即可。');
      } catch (e) {
        return err('归档失败：' + (e?.message ?? e));
      }
    },
  });

  api.registerTool({
    id: 'memory_unarchive',
    name: '捞回归档记忆',
    description: '把已归档的记忆捞回（archived 只是开关，不是删除）。用户说「把之前归档的那条找回来」时调。',
    category: 'memory',
    icon: '↩️',
    defaultEnabled: false,
    parameters: {
      type: 'object',
      properties: {
        memoryIds: { type: 'array', items: { type: 'string' }, description: '要捞回的记忆 id，可给多个' },
      },
      required: ['memoryIds'],
    },
    async execute(ctx, args) {
      try {
        if (!lifecycleFn) return err('记忆库插件未启用，无法捞回。');
        const ids = (Array.isArray(args.memoryIds) ? args.memoryIds : [args.memoryIds]).map(String);
        const r = await lifecycleFn({ op: 'unarchive', memoryIds: ids });
        if (!r.ok) return err(r.error || '捞回失败');
        return ok('已捞回 ' + (r.count ?? 0) + ' 条记忆。');
      } catch (e) {
        return err('捞回失败：' + (e?.message ?? e));
      }
    },
  });

  // ── 固定 / 定期清理（宿主 memoryGrowth.weeklyCleanup / pinnedProtected 的那两个设置）──
  const pinFn = api.capability('memory.lifecycle');       // pin 走同名能力（op:'pin'）
  const cleanupFn = api.capability('memory.cleanup');

  api.registerTool({
    id: 'memory_pin',
    name: '固定记忆',
    description: '把某条记忆「钉住」，让它永远不会被定期清理自动归档（比如重要的约定、称呼、雷点）。用户说「这条别忘」「这个要一直记住」时用。取消传 pinned=false。',
    category: 'memory',
    icon: '📌',
    defaultEnabled: false,
    parameters: {
      type: 'object',
      properties: {
        memoryIds: { type: 'array', items: { type: 'string' }, description: '要固定的记忆 id，可给多个' },
        pinned: { type: 'boolean', description: 'true=钉住（默认），false=取消固定' },
      },
      required: ['memoryIds'],
    },
    async execute(ctx, args) {
      try {
        if (!pinFn) return err('记忆库插件未启用，无法固定。');
        const ids = (Array.isArray(args.memoryIds) ? args.memoryIds : [args.memoryIds]).map(String);
        const want = args.pinned !== false;
        const r = await pinFn({ op: want ? 'pin' : 'unpin', memoryIds: ids });
        if (!r?.ok) return err(r?.error || '固定失败');
        return ok('已' + (want ? '固定' : '取消固定') + ' ' + (r.count ?? 0) + ' 条记忆。');
      } catch (e) { return err('固定失败：' + (e?.message ?? e)); }
    },
  });

  api.registerTool({
    id: 'memory_cleanup',
    name: '清理冷记忆',
    description: '手动跑一次「定期清理」：把很久没被提到、也没固定过的记忆归档（不是删除，可 memory_unarchive 找回）。管理员说「清理一下记忆库」「把没用的记忆收拾收拾」时用。门槛（冷多少天 / 提及次数）在插件设置里。',
    category: 'memory',
    icon: '🧹',
    defaultEnabled: false,
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        if (!cleanupFn) return err('记忆库插件未启用，无法清理。');
        const r = await cleanupFn();
        if (!r?.ok) return err(r?.error || '清理失败');
        return ok(r.archived > 0
          ? '已归档 ' + r.archived + ' 条冷记忆（冷于 ' + r.days + ' 天 / 提及 ≤ ' + r.maxMention + ' 次）。'
          : '没有需要归档的冷记忆（门槛：冷于 ' + r.days + ' 天 / 提及 ≤ ' + r.maxMention + ' 次）。');
      } catch (e) { return err('清理失败：' + (e?.message ?? e)); }
    },
  });
}

export function available() {
  return { ok: true, reason: '工具可用（能力由 plugins/memory-growth 软依赖提供，缺时工具如实报错）' };
}
