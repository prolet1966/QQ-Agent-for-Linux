// feeling-skill —— LLM 型技能：好感度工具面（宿主 set_feeling / affinity_check 语义照搬）
//
// 软依赖：api.capability('affinity.adjust' / 'affinity.query' / 'affinity.rebirth')
//   —— 能力由 plugins/affinity 提供。缺插件时能力为 undefined，工具如实报「好感度未启用」。
//   这是防孤儿能力的关键消费方。

export function setup(api) {
  const adjustFn = api.capability('affinity.adjust');
  const queryFn = api.capability('affinity.query');
  const rebirthFn = api.capability('affinity.rebirth');

  const ok = (data) => ({ content: typeof data === 'string' ? data : JSON.stringify(data, null, 2) });
  const err = (msg) => ({ content: msg, isError: true });

  api.registerTool({
    id: 'set_feeling',
    name: '调好感度',
    description: '微调你对某人的好感度（-5 ~ +5），并写清理由。只在「对方做了明确让关系变好/变坏的举动」时用，一次最多 ±5，必须写理由，别乱调。此工具受 settings.toolWrite 控制（默认关，管理员在控制台开启后模型才能调）。',
    category: 'memory',
    icon: '💗',
    defaultEnabled: false,
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '对方 QQ 号' },
        delta: { type: 'number', description: '加/减多少分，范围 -5 ~ 5' },
        reason: { type: 'string', description: '为什么调：一句话说明对方做了什么' },
      },
      required: ['userId', 'delta', 'reason'],
    },
    async execute(ctx, args) {
      try {
        if (!adjustFn) return err('好感度插件未启用（plugins/affinity 没装或未激活），无法调好感度。');
        const r = await adjustFn({
          personId: String(args.userId ?? '').trim(),
          delta: Number(args.delta),
          reason: String(args.reason ?? '').trim(),
        });
        if (!r.ok) return err(r.error);
        return ok('好感度已调整（现 ' + r.score + ' 分）。简短告知即可，别声张。');
      } catch (e) {
        return err('调好感度失败：' + (e?.message ?? e));
      }
    },
  });

  api.registerTool({
    id: 'check_affinity',
    name: '查好感度',
    description: '查某人跟你的关系温度：0~100 分、档位（生客/客人/熟客/常客/茶友/座上宾）、熟悉度、响应档位。想知道「这个人跟我熟不熟、该用什么态度」时用。只读，不调分。',
    category: 'memory',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'QQ 号；不填则查当前跟你说话的人' },
      },
    },
    async execute(ctx, args) {
      try {
        if (!queryFn) return err('好感度插件未启用，无法查。');
        const who = String(args.userId ?? '').trim() || String(ctx?.requesterId ?? '');
        if (!who) return err('要指定 userId 或当前说话人');
        const r = await queryFn({ personId: who });
        if (!r.ok) return err('查不到这个人（还没记过）');
        return ok({
          personId: r.personId,
          score: r.score,
          tier: r.tier?.name,
          familiarity: r.familiarity,
          rebirthCount: r.rebirth?.count ?? 0,
          responseTier: r.responseProfile?.responseTier,
        });
      } catch (e) {
        return err('查好感度失败：' + (e?.message ?? e));
      }
    },
  });

  api.registerTool({
    id: 'do_rebirth',
    name: '轮回（好感归零）',
    description: '把某人的好感记录清空重来（P8 轮回），带正向增益 buff。这是硬操作——只在管理员明确说「把 TA 的重来/抹掉印象」时调，需 confirm=true。',
    category: 'memory',
    icon: '♻️',
    defaultEnabled: false,
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '要轮回的人的 QQ 号' },
        confirm: { type: 'boolean', description: '必须 true 才执行（防误触）' },
      },
      required: ['userId', 'confirm'],
    },
    async execute(ctx, args) {
      try {
        if (!rebirthFn) return err('好感度插件未启用，无法轮回。');
        if (args.confirm !== true) return err('这是硬操作：请让用户明确确认后再传 confirm=true。');
        const r = await rebirthFn({ personId: String(args.userId ?? '').trim(), confirm: true });
        if (!r.ok) return err(r.error || '轮回失败');
        return ok('已轮回（第 ' + r.count + ' 次，buff ×' + (r.phrase ? '' : '') + '）。' + (r.phrase ? r.phrase : '') + ' 当前 ' + r.score + ' 分。简短告知即可。');
      } catch (e) {
        return err('轮回失败：' + (e?.message ?? e));
      }
    },
  });
}

export function available() {
  return { ok: true, reason: '工具可用（能力由 plugins/affinity 软依赖提供，缺时工具如实报错）' };
}
