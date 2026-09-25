// 回忆工具（LLM 型 / skills/）
//
// ── 为什么是技能，而不是插件 ──────────────────────────────────────────────
// 这三个工具的共同点：**用不用、什么时候用，由模型决定**。没人问旧事时，
// 它们一次也不会被调用 —— 这正是 skills/（LLM 型）的定义。
// 真正的确定性部分（后台巩固、每轮注入）在 plugins/conversation-memory/。
//
// 实现全部来自插件暴露的能力（memory.search / memory.archive / memory.status），
// 这里只做"参数校验 + 把结果转成模型能读的话"，**不重复实现任何检索逻辑**：
// 两份实现迟早会漂移，而记忆中漂移的后果是"搜到的和刚写的对不上"，极难排查。
//
// 依赖声明用 manifest.requires（硬依赖）：插件被关掉时，这三个工具会自动变成
// 不可用，并在设置页给出准确原因「缺少能力 memory.search：…」，
// 而不是让模型调用后收到一句莫名其妙的报错。

let api = null;

/** 能力调用统一走这里：兼容"能力没装/抛错"两种情况，永远返回一个形状。 */
async function callCapability(name, args) {
  if (!api || typeof api.capability !== 'function') {
    return { ok: false, error: '能力查询不可用' };
  }
  try {
    const r = await api.capability(name, args);
    if (!r || typeof r !== 'object') return { ok: false, error: `能力 ${name} 没有返回结果` };
    return r;
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function asText(value) {
  return JSON.stringify(value, null, 1);
}

export function setup(a) {
  api = a;

  api.registerTool({
    id: 'memory_search',
    name: '检索长期记忆',
    description:
      '在长期对话记忆里按关键词检索很久以前的聊天碎片（日块索引）。平常不要调用；只有当前上下文不够、需要回忆很久以前的事、或用户问"你还记得…"时才调。返回的是压缩碎片不是完整录像。搜不到就如实说想不起来，不要编造。',
    category: 'knowledge',
    requires: ['memory.search'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，中文即可，例如「生日 聚餐」。可用空格分隔多个词。' },
        chatKey: { type: 'string', description: '可选，限定 group:群号 / private:QQ号；不填则全库检索。' },
        limit: { type: 'number', description: '返回块数，默认 5，最多 12。' }
      },
      required: ['query']
    },
    async execute(ctx, args) {
      const query = String(args?.query ?? '').trim();
      if (!query) return { content: '需要一个检索关键词。', isError: true };

      const r = await callCapability('memory.search', {
        query,
        chatKey: args?.chatKey || ctx?.chatKey || null,
        limit: args?.limit
      });
      if (!r.ok) return { content: `检索失败：${r.error || '未知原因'}`, isError: true };
      const hits = Array.isArray(r.hits) ? r.hits : [];
      if (!hits.length) {
        return { content: '没有命中长期记忆。可以换个关键词再试，或者直接承认想不起来（不要编造）。' };
      }
      return { content: asText({ ok: true, hits }) };
    }
  });

  api.registerTool({
    id: 'memory_archive',
    name: '翻阅聊天归档',
    description:
      '按天/时段打开完整聊天归档（原始存档切片，支持分页）。先用 memory_search 命中、拿到具体日期后再用 mode=day 调这一天；不确定有哪些天就 mode=list。一次最多约 40 条，用 offset/nextOffset 往前翻。',
    category: 'knowledge',
    requires: ['memory.archive'],
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['list', 'day', 'range', 'count'],
          description: 'list=列出有哪些天；day=读某一天；range=读一个区间；count=统计某词出现次数。'
        },
        chatKey: { type: 'string', description: 'group:群号 / private:QQ号；不填用当前会话。' },
        day: { type: 'string', description: 'YYYY-MM-DD，mode=day 时必填。' },
        dayFrom: { type: 'string', description: 'YYYY-MM-DD，mode=range 的起始日。' },
        dayTo: { type: 'string', description: 'YYYY-MM-DD，mode=range 的结束日。' },
        offset: { type: 'number', description: '分页偏移，默认 0。' },
        limit: { type: 'number', description: '本页条数，默认 40。' },
        query: { type: 'string', description: '可选：只保留含该词的行。' }
      },
      required: ['mode']
    },
    async execute(ctx, args) {
      const r = await callCapability('memory.archive', {
        mode: args?.mode || 'list',
        chatKey: args?.chatKey || ctx?.chatKey || null,
        day: args?.day,
        dayFrom: args?.dayFrom,
        dayTo: args?.dayTo,
        offset: args?.offset,
        limit: args?.limit,
        query: args?.query
      });
      if (!r.ok) return { content: `读取归档失败：${r.error || '未知原因'}`, isError: true };

      if ((args?.mode || 'list') === 'list') {
        return {
          content: asText({
            ok: true,
            chatKey: r.chatKey,
            note: '用 memory_archive(mode=day, day=...) 读完整一天；用 offset 翻页。',
            days: r.days
          })
        };
      }
      return { content: asText(r) };
    }
  });

  api.registerTool({
    id: 'memory_status',
    name: '查看记忆索引状态',
    description: '查看长期记忆索引规模（块数/词项数）与成本护栏当日用量。只在排查"记忆是不是没生效"时用，闲聊不要调用。',
    category: 'knowledge',
    requires: ['memory.status'],
    parameters: { type: 'object', properties: {} },
    async execute() {
      const r = await callCapability('memory.status', {});
      if (!r.ok) return { content: `读取状态失败：${r.error || '未知原因'}`, isError: true };
      return { content: asText(r) };
    }
  });
}
