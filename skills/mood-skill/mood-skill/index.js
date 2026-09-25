// mood-skill —— LLM 型技能：心情工具（宿主 set_mood 语义 + mood-tune 消费方）
//
// 软依赖：api.capability('mood.tune' / 'mood.status') —— 由 plugins/mood-tune 提供。
//   缺插件时能力为 undefined，工具如实报「心情层未启用」（防孤儿能力消费方）。

export function setup(api) {
  const tuneFn = api.capability('mood.tune');
  const statusFn = api.capability('mood.status');
  const ok = (data) => ({ content: typeof data === 'string' ? data : JSON.stringify(data, null, 2) });
  const err = (msg) => ({ content: msg, isError: true });

  api.registerTool({
    id: 'mood_status',
    name: '查心情',
    description: '查当前全局心情档（1~6）与插话概率系数。想知道「她现在心情怎样、会不会更活跃」时用。只读。',
    category: 'message',
    icon: '🌤️',
    parameters: {},
    async execute(ctx) {
      try {
        if (!statusFn) return err('心情层未启用（plugins/mood-tune 没装或未激活）。');
        const r = await statusFn({});
        if (!r.ok) return err(r.error || '查心情失败');
        return ok({ 心情档: r.tierId, 价值: r.value, 人数: r.count, 插话系数: r.factor });
      } catch (e) {
        return err('查心情失败：' + (e?.message ?? e));
      }
    },
  });
}

export function available() {
  return { ok: true, reason: '工具可用（能力由 plugins/mood-tune 软依赖提供，缺时工具如实报错）' };
}
