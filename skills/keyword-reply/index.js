// 关键词自动回复 —— 命中关键词时自动发出预设回复，规则可在设置里自由增删。
//
// ── 机制说明 ──────────────────────────────────────────────────────────
//   · LLM 型技能：由模型判断何时调用。关键词表通过 promptSections **写进系统提示词**，
//     模型每轮都能看到"有哪些关键词"，命中几乎是必然的。
//   · 但**是否命中由工具做精确匹配**，不是让模型自己编：模型只负责把消息原文传进来，
//     匹配（包含/全等、大小写）与取文案都在本文件里完成 —— 因此回复文案永远与配置一致。
//   · 回复由工具直接发出（ctx.sender，走队列/限频/去重），工具返回后模型不再复述。
//
// ── 规则格式 ──────────────────────────────────────────────────────────
//   关键词1|关键词2=回复内容          # 多个关键词共用一条回复
//   # 开头是注释                      # 空行与注释行忽略
//   回复内容里可用 {nick} 引用说话人昵称

let cfg = () => ({});
let log = () => {};

/** chatKey::关键词 -> 上次触发时间戳（冷却用）。 */
const lastHitAt = new Map();

/** 解析规则表：一行一条 `关键词|关键词=回复`，# 开头为注释。纯函数，便于测试。 */
export function parseRules(raw) {
  const out = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const s = String(line).trim();
    if (!s || s.startsWith('#')) continue;
    const idx = s.indexOf('=');
    if (idx <= 0) continue;                       // 没有等号 = 这行不是规则
    const reply = s.slice(idx + 1).trim();
    const keywords = s.slice(0, idx)
      .split(/[|｜]/)
      .map((k) => k.trim())
      .filter(Boolean);
    if (!keywords.length || !reply) continue;
    out.push({ keywords, reply });
  }
  return out;
}

/** 在规则表里找第一条命中的规则。纯函数，便于测试。 */
export function matchRule(text, rules, { ignoreCase = true, mode = 'contains' } = {}) {
  const norm = (s) => (ignoreCase ? String(s ?? '').toLowerCase() : String(s ?? ''));
  const t = norm(text).trim();
  if (!t) return null;
  for (const rule of rules) {
    for (const kw of rule.keywords) {
      const k = norm(kw);
      if (!k) continue;
      const hit = mode === 'equals' ? t === k : t.includes(k);
      if (hit) return { rule, keyword: kw };
    }
  }
  return null;
}

/** 替换回复里的 {nick} 占位符；没给昵称就去掉占位符（不留空括号）。纯函数，便于测试。 */
export function fillPlaceholders(reply, nickname) {
  const nick = String(nickname ?? '').trim();
  return String(reply ?? '').replace(/\{nick\}/g, nick || '你');
}

/** 冷却判断：同一个会话 + 同一个关键词，在窗口期内不重复触发。 */
function isCooling(chatKey, keyword, cooldownSec, now = Date.now()) {
  const sec = Math.max(0, Number(cooldownSec) || 0);
  if (!sec) return false;
  const key = `${chatKey}::${keyword}`;
  const last = lastHitAt.get(key);
  if (last == null) return false;
  if (now - last >= sec * 1000) return false;
  return true;
}

function markHit(chatKey, keyword, now = Date.now()) {
  lastHitAt.set(`${chatKey}::${keyword}`, now);
  if (lastHitAt.size > 500) {                     // 长期不重启时别让 Map 无限涨
    const oldest = [...lastHitAt.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) lastHitAt.delete(oldest[0]);
  }
}

export function setup(api) {
  cfg = api.config;
  log = api.log;

  // ── 工具 1：命中关键词 → 发送预设回复 ────────────────────────────────
  api.registerTool({
    id: 'keyword_reply',
    name: '关键词自动回复',
    description: '当用户消息命中已配置的关键词时，自动发送该关键词对应的预设回复。把用户消息原文传给 text，说话人昵称传给 nickname；能确定其 QQ 号时传 userId 可以在回复里 @ 对方。命中后工具会自己发出回复，你不要再另写内容。',
    category: 'messaging',
    icon: '🔑',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '用户消息的原文（用于匹配关键词，必填）' },
        nickname: { type: 'string', description: '说话人的昵称，用于替换回复里的 {nick}（可选）' },
        userId: { type: 'string', description: '说话人的 QQ 号，用于在回复里 @ 对方（可选）' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      try {
        const c = cfg();
        const rules = parseRules(c.rules);
        if (!rules.length) {
          return { content: '当前没有配置任何关键词规则，请在「关键词自动回复」设置里添加。' };
        }
        const hit = matchRule(String(args?.text ?? ''), rules, {
          ignoreCase: c.ignoreCase !== false,
          mode: c.matchMode === 'equals' ? 'equals' : 'contains'
        });
        if (!hit) {
          return { content: `这条消息没有命中任何关键词，请用正常语气回复。已配置的关键词：${rules.flatMap((r) => r.keywords).join('、')}` };
        }
        if (isCooling(ctx.chatKey, hit.keyword, c.cooldownSec)) {
          return { content: `关键词「${hit.keyword}」刚刚触发过（冷却 ${c.cooldownSec} 秒内不重复），本次不发送，请用正常语气回复。` };
        }
        markHit(ctx.chatKey, hit.keyword);

        const message = fillPlaceholders(hit.rule.reply, args?.nickname);
        const options = String(args?.userId ?? '').trim()
          ? { atUserId: String(args.userId).trim() }
          : {};
        await ctx.sender.sendTextBatch(ctx.chatKey, [message], options);
        log(`${ctx.chatKey} 命中「${hit.keyword}」→ ${message}`);
        return { content: `已发送关键词回复：${message}。不要再复述一遍。` };
      } catch (error) {
        return { content: `关键词回复失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 工具 2：列出已配置的关键词 ────────────────────────────────────────
  api.registerTool({
    id: 'keyword_reply_list',
    name: '查看关键词列表',
    description: '列出当前已配置的关键词自动回复规则。当用户问「有哪些关键词」「自动回复有什么」「你会对什么词有反应」时使用。',
    category: 'query',
    icon: '📋',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const rules = parseRules(cfg().rules);
        if (!rules.length) return { content: '当前没有配置任何关键词规则。' };
        const lines = rules.map((r, i) => `${i + 1}. ${r.keywords.join(' / ')} → ${r.reply}`);
        return { content: `已配置 ${rules.length} 条关键词自动回复：\n${lines.join('\n')}` };
      } catch (error) {
        return { content: `读取关键词规则失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

export function available() { return true; }

// 动态提示词片段：把当前配置的关键词原样注入系统提示词 —— 模型看得见才会去匹配。
export function promptSections() {
  try {
    const rules = parseRules(cfg().rules);
    if (!rules.length) return [];
    const keywords = rules.flatMap((r) => r.keywords).slice(0, 60).join('、');
    return [{
      id: 'keyword-reply-list',
      title: '关键词自动回复（当前配置）',
      priority: 46,
      content: `当前已配置的关键词：${keywords}。当用户消息包含其中任一个时，**必须**调用 keyword_reply 工具，把消息原文传给 text、说话人昵称传给 nickname。工具会自动发出预设回复，你不要自己另写内容，也不要复述已发出的回复。`
    }];
  } catch {
    return [];
  }
}

export const internals = { parseRules, matchRule, fillPlaceholders, isCooling, markHit };
