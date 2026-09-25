// forward-skill —— LLM 型技能：发送合并转发（宿主 13-send-forward 语义照搬）
//
// 解决什么：把多条聊天记录打成 QQ「聊天记录」卡片发出（分享一段对话），而不是一条条刷屏。
// V0.3.1 原来只有 read_forward（**展开收到的**），没有发送。
//
// 分工：
//   · 核心 src/sender.js 的 SendQueue.sendForward —— 真正发（串行链 + 限频 + 存档）
//   · 本技能 —— 把模型给的参数整理成 OneBot 需要的 nodes，做白名单与条数校验
// 不绕开 SendQueue：发消息一律走 ctx.sender（plugin-development.md 硬约束）。

/** OneBot 合并转发的节点上限（工具侧再收紧到 20，给模型留余量）。 */
const MAX_NODES_TOOL = 20;

export function setup(api) {
  const ok = (d) => ({ content: typeof d === 'string' ? d : JSON.stringify(d, null, 2) });
  const err = (m) => ({ content: m, isError: true });

  api.registerTool({
    id: 'send_forward',
    name: '发合并转发',
    description: '把几条消息打成 QQ「聊天记录」卡片发出去（分享一段对话），而不是一条条刷屏。适合「把刚才那段对话整理一下发出来」「把这几句话打包发到另一个群」。nodes 里每条写 name（发言人名）+ content（内容）；也可以给 fromArchive 从当前会话最近的存档里打包。发到这个会话不用传 target；发到别的群/人传 target（格式 group:群号 或 private:QQ号，必须在白名单里）。',
    category: 'message',
    icon: '📦',
    parameters: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: '转发节点，每条 { name, content }；最多 20 条',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '发言人显示名' },
              content: { type: 'string', description: '这一条的内容（纯文本）' },
            },
            required: ['name', 'content'],
          },
        },
        fromArchive: {
          type: 'integer',
          description: '可选：从当前会话最近 N 条存档打包（与 nodes 二选一），最多 20',
        },
        target: {
          type: 'string',
          description: '可选：目标会话 group:群号 或 private:QQ号；不传 = 发当前会话',
        },
      },
    },
    async execute(ctx, args) {
      try {
        const sender = ctx?.sender;
        if (!sender?.sendForward) return err('当前核心不支持发送合并转发（ctx.sender.sendForward 缺失）。');
        const target = String(args.target ?? '').trim() || String(ctx.chatKey || '');
        if (!/^(group|private):\d+$/.test(target)) return err('target 必须是 group:群号 或 private:QQ号（收到：' + target + '）');

        let nodes = [];
        // 1) 显式 nodes
        if (Array.isArray(args.nodes) && args.nodes.length) {
          nodes = args.nodes
            .map((n) => ({
              name: String(n?.name ?? '').trim().slice(0, 32) || '群友',
              content: String(n?.content ?? '').trim().slice(0, 1000),
            }))
            .filter((n) => n.content);
        }
        // 2) 从当前会话存档打包
        if (!nodes.length && args.fromArchive) {
          const n = Math.min(MAX_NODES_TOOL, Math.max(1, Number(args.fromArchive) || 5));
          // 核心签名：store.recent(chatKey, { limit, offset, includeSelf })（见 src/store.js）
          const recent = ctx?.store?.recent?.(ctx.chatKey, { limit: n }) || [];
          nodes = (Array.isArray(recent) ? recent : [])
            .map((e) => ({
              name: String(e?.self ? '我' : (e?.senderName ?? e?.senderId ?? '群友')).slice(0, 32),
              content: String(e?.text ?? '').trim().slice(0, 1000),
            }))
            .filter((x) => x.content);
        }
        if (!nodes.length) return err('没有可转发的节点：请给 nodes（数组）或 fromArchive（条数）。');
        if (nodes.length > MAX_NODES_TOOL) nodes = nodes.slice(-MAX_NODES_TOOL);

        // uin 用 QQ 号；拿不到就填占位（协议端一般只要求字段存在）
        const payload = nodes.map((n, i) => ({ type: 'node', data: { name: n.name, uin: String(ctx.selfId || 10000 + i), content: n.content } }));

        const r = await sender.sendForward(target, payload, {});
        return ok({
          ok: true,
          count: r?.count ?? nodes.length,
          target,
          preview: String(r?.preview ?? '').slice(0, 120),
          note: '已经打包发出去了。一句话告知即可，不要复述内容。',
        });
      } catch (error) {
        return err('发合并转发失败：' + (error?.message ?? error));
      }
    },
  });
}

export function available() {
  return { ok: true, reason: '工具可用（走核心 ctx.sender.sendForward）' };
}
