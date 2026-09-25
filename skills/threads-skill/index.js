// threads-skill —— LLM 型技能：讨论线工具（宿主 tools.js 的 note_discussion 照搬）
//
// 软依赖 plugins/threads 的 threads.record / threads.select。
// 缺插件时能力为 undefined，工具如实报「讨论线未启用」，不崩。

export function setup(api) {
  const recordFn = api.capability('threads.record');
  const selectFn = api.capability('threads.select');
  const ok = (d) => ({ content: typeof d === 'string' ? d : JSON.stringify(d, null, 2) });
  const err = (m) => ({ content: m, isError: true });

  api.registerTool({
    id: 'note_discussion',
    name: '记讨论线索',
    description: '记下群里「聊到一半、还没结论」的话题，下次能自然接上。当一段对话明显没聊完（约了回头说、问题没人答、话题被打断）时记一条。topic 写短标题（如「周末去哪玩」），summary 一句话写聊到哪了，tags 给几个关键词方便日后命中。已完结的话题传 resolved=true（会把它标记为不再提起）。',
    category: 'memory',
    icon: '🧵',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '线索短标题（4~12 字，同一话题要写一样的词才会合并）' },
        summary: { type: 'string', description: '一句话：聊到哪了、还差什么' },
        tags: { type: 'array', items: { type: 'string' }, description: '关键词（可选，1~4 个）' },
        participants: { type: 'array', items: { type: 'string' }, description: '参与人的 QQ 号（可选）' },
        resolved: { type: 'boolean', description: '传 true 表示这条线索已经聊完了，不再提起' },
      },
      required: ['topic'],
    },
    async execute(ctx, args) {
      if (!recordFn) return err('讨论线未启用（需要启用 plugins/threads 插件）。');
      try {
        const r = recordFn({
          chatKey: ctx.chatKey,
          topic: String(args.topic ?? '').trim(),
          summary: String(args.summary ?? '').trim(),
          tags: Array.isArray(args.tags) ? args.tags : [],
          participants: Array.isArray(args.participants) ? args.participants.map(String) : [],
          unresolved: args.resolved === true ? 0 : 50,
        });
        return ok({ ok: true, total: r?.total ?? null, note: args.resolved === true ? '已标记聊完，不再提起。' : '记下了。' });
      } catch (e) { return err('记线索失败：' + (e?.message ?? e)); }
    },
  });

  api.registerTool({
    id: 'list_discussions',
    name: '看讨论线索',
    description: '查看当前群「聊到一半」的线索清单（含分数分层）。想知道有哪些话题没聊完、或想挑一个接话时用。',
    category: 'memory',
    icon: '📋',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      if (!selectFn) return err('讨论线未启用（需要启用 plugins/threads 插件）。');
      try {
        const r = selectFn({ chatKey: ctx.chatKey });
        return ok({
          总数: r?.total ?? 0,
          活跃层: (r?.active || []).map((x) => ({ 话题: x.topic, 分数: x.score })),
          沉睡层: (r?.dormant || []).map((x) => ({ 话题: x.topic, 分数: x.score })),
        });
      } catch (e) { return err('查线索失败：' + (e?.message ?? e)); }
    },
  });
}

export function available() {
  return { ok: true, reason: '工具可用（讨论线的记录与查看）' };
}
