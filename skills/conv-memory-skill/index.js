// conv-memory-skill —— LLM 型技能：长期印象增查删（宿主 tools.js.orig 375~430 行三工具照搬）
// （原拟命名 conversation-memory-skill，因 skillId 前缀截断后工具 id 将超 64 字符，改短名）
//
// 与 V0.3.1 既有 plugins/conversation-memory（确定性型，16 模块，核心自动巩固/检索）的边界：
//   - 本技能 = LLM 型「模型决定何时查/增/删印象」（registerTool）
//   - 既有插件 = 确定性型「核心自动把逐小时对话压成块并建倒排索引」（capability/hook）
//   - 两者物理隔离共存：技能管 memberImpression（按人的稳定印象），插件管对话考古块。
//   - 本技能的 ctx.memory（append/query/remove）由 V0.3.1 核心提供（skill-development.md §5 ctx 摘要）；
//     若核心没提供 ctx.memory，工具如实报「记忆服务不可用」。

export function setup(api) {
  const ok = (data) => ({ content: typeof data === 'string' ? data : JSON.stringify(data, null, 2) });
  const err = (msg) => ({ content: msg, isError: true });

  api.registerTool({
    id: 'memory_append',
    name: '记印象',
    description: '记一条对群友的长期印象（下次运行会自动看到）。只记「以后和这个人打交道时用得上」的稳定印象：他的身份/关系、说话风格、爱玩的梗、雷点、常聊话题、别踩的坑。太临时的事情不要记。userId 必须填对方 QQ 号（不知道就先查群成员）；target 填备注名/群名片/昵称，用于展示。',
    category: 'memory',
    icon: '📝',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['memberImpression'], description: '固定为 memberImpression' },
        userId: { type: ['integer', 'string'], description: '对方 QQ 号（数字）' },
        target: { type: 'string', description: '对方名字（备注名/群名片/昵称），用于展示' },
        content: { type: 'string', description: '印象内容（≤120 字，稳定、可跨多次聊天使用）' },
      },
      required: ['category', 'userId', 'content'],
    },
    async execute(ctx, args) {
      try {
        if (!ctx.memory?.append) return err('记忆服务不可用（ctx.memory 缺失，V0.3.1 核心未提供）。');
        const userId = String(args.userId ?? '').trim();
        if (!/^\d{1,15}$/.test(userId)) {
          return err('userId 必须是数字 QQ 号（收到：' + JSON.stringify(args.userId) + '）。先查准确 QQ 号再记。');
        }
        const content = String(args.content ?? '').trim();
        if (content.length > 120) return err('印象太长了（>120 字），只记稳定的短句。');
        const entry = ctx.memory.append(ctx.chatKey, 'memberImpression', content, {
          userId,
          target: String(args.target ?? '').trim(),
        });
        return ok({ saved: true, entry });
      } catch (e) {
        return err('记印象失败：' + (e?.message ?? e));
      }
    },
  });

  api.registerTool({
    id: 'memory_query',
    name: '查印象',
    description: '查看当前会话里你对群友的长期印象。不传 userId 返回全部；传 userId 只看某一个人。回答「你记得他吗/他之前说过什么」类问题时用。',
    category: 'memory',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: ['integer', 'string'], description: '可选：只看这个 QQ 号的印象' },
      },
    },
    async execute(ctx, args) {
      try {
        if (!ctx.memory?.query) return err('记忆服务不可用（ctx.memory 缺失）。');
        const mem = ctx.memory.query(ctx.chatKey);
        const userId = String(args.userId ?? '').trim();
        const list = userId
          ? (mem.memberImpression ?? []).filter((e) => String(e.userId) === userId)
          : (mem.memberImpression ?? []);
        if (!list.length) return ok('没有相关印象（还没记过这个人，或都删了）。如实说想不起来，别编。');
        return ok({ memberImpression: list });
      } catch (e) {
        return err('查印象失败：' + (e?.message ?? e));
      }
    },
  });

  api.registerTool({
    id: 'memory_remove',
    name: '删印象',
    description: '删除一条过时/不再准确的对群友印象（用户明确说「忘掉他/删掉这条印象」时调）。userId 优先按 QQ 号删；target 按名字删；两者都不传则删全部印象。这是危险操作，需用户明确要求。',
    category: 'memory',
    icon: '🗑️',
    defaultEnabled: false,
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['memberImpression'], description: '固定为 memberImpression' },
        userId: { type: ['integer', 'string'], description: '对方 QQ 号（优先）' },
        target: { type: 'string', description: '对方名字（没有 QQ 号时用）' },
        content: { type: 'string', description: '可选：只删这条内容' },
      },
      required: ['category'],
    },
    async execute(ctx, args) {
      try {
        if (!ctx.memory?.remove) return err('记忆服务不可用（ctx.memory 缺失）。');
        const removed = ctx.memory.remove(ctx.chatKey, 'memberImpression', {
          userId: String(args.userId ?? '').trim(),
          target: String(args.target ?? '').trim(),
          content: String(args.content ?? '').trim(),
        });
        return ok({ removed });
      } catch (e) {
        return err('删印象失败：' + (e?.message ?? e));
      }
    },
  });
}

export function available() {
  return { ok: true, reason: '工具可用（依赖 V0.3.1 核心的 ctx.memory；缺失时工具如实报错）' };
}
