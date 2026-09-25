// emotion-skill —— LLM 型技能：情绪/本体状态工具（清单 §4.1 情感工具 set_emotion/set_mood 语义）
// 软依赖：api.capability('bodystate.*') —— 由 plugins/body-state 提供。缺插件时工具如实报「本体状态未启用」。

export function setup(api) {
  const setEmotionFn = api.capability('bodystate.set-emotion');
  const setAxesFn = api.capability('bodystate.set-axes');
  const statusFn = api.capability('bodystate.status');
  const ok = (d) => ({ content: typeof d === 'string' ? d : JSON.stringify(d, null, 2) });
  const err = (m) => ({ content: m, isError: true });

  api.registerTool({
    id: 'set_emotion',
    name: '记情绪',
    description: '记录当前 21 格情绪之一（如 anger 愤怒 / joy 喜悦 / curiosity 好奇），让后续回应带上这个情绪色彩。你明显产生某种强烈情绪时才调，别每句话都记。',
    category: 'memory',
    icon: '😤',
    parameters: {
      type: 'object',
      properties: {
        emotion: { type: 'string', description: '情绪 id，21 格之一：anger/sadness/joy/anger/anxiety/fear/envy/boredom/loneliness/irritation/depression/happiness/gratitude/hope/pride/smugness/excitement/curiosity/surprise/shame/guilt/disgust' },
        value: { type: 'number', description: '强度 0~100，可选（缺省 +20）' },
      },
      required: ['emotion'],
    },
    async execute(ctx, args) {
      try {
        if (!setEmotionFn) return err('本体状态插件未启用（plugins/body-state 没装或未激活）。');
        const r = await setEmotionFn({ emotion: String(args.emotion ?? '').trim(), value: args.value });
        if (!r.ok) return err(r.error || '记情绪失败');
        return ok('已记情绪「' + r.name + '」（' + r.current + '）。该干嘛干嘛，别声张。');
      } catch (e) { return err('记情绪失败：' + (e?.message ?? e)); }
    },
  });

  api.registerTool({
    id: 'set_mood',
    name: '调本体状态',
    description: '更新本体状态三维（精力/社交/心情，各 0~1）。你状态明显变化时用（累瘫了 energy 调低、想找人聊 social 调高）。不是每条消息都调。',
    category: 'memory',
    icon: '🌡️',
    parameters: {
      type: 'object',
      properties: {
        energy: { type: 'number', description: '精力 0~1（累瘫=0，精神=1）' },
        social: { type: 'number', description: '社交意愿 0~1（不想说=0，想聊=1）' },
        mood: { type: 'number', description: '心情 0~1（烦=0，嗨=1）' },
      },
    },
    async execute(ctx, args) {
      try {
        if (!setAxesFn) return err('本体状态插件未启用。');
        const r = await setAxesFn({ energy: args.energy, social: args.social, mood: args.mood });
        if (!r.ok) return err(r.error || '调状态失败');
        return ok('状态已更新（精力 ' + r.axes.energy + ' / 社交 ' + r.axes.social + ' / 心情 ' + r.axes.mood + '）。');
      } catch (e) { return err('调状态失败：' + (e?.message ?? e)); }
    },
  });

  api.registerTool({
    id: 'mood_state',
    name: '查本体状态',
    description: '查当前本体状态全貌：三维（精力/社交/心情）+ 21 格情绪当前值 + 五条聚合 + 行为概率 + 温度。想知道「她现在状态怎样」时用。只读。',
    category: 'memory',
    icon: '📊',
    parameters: {},
    async execute(ctx) {
      try {
        if (!statusFn) return err('本体状态插件未启用。');
        const r = await statusFn({});
        if (!r.ok) return err(r.error || '查状态失败');
        return ok({
          axes: r.axes,
          topEmotions: Object.entries(r.emotions).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5),
          aggregates: r.aggregates,
          wakeProbability: r.wakeProbability,
          temperature: r.temperature,
          sleepNote: r.sleepNote,
        });
      } catch (e) { return err('查状态失败：' + (e?.message ?? e)); }
    },
  });
}

export function available() {
  return { ok: true, reason: '工具可用（能力由 plugins/body-state 软依赖提供，缺时工具如实报错）' };
}
