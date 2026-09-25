// wake-rules.js —— 唤醒策略的纯函数（可单测）
// 覆盖宿主有、V0.3.1 核心档位判定没有的三类「按人/按群」规则：
//   1. alwaysReplyUsers  这几个人说话必回
//   2. keywordsByUser    这个人有自己的关键词表（全局词表之外）
//   3. aliases/groupAliases  机器人还有别的名字（核心只认 selfNickname/botName）

/** 逗号/换行/空格分隔的清单 → 去空去重数组。 */
export function parseList(raw) {
  return [...new Set(String(raw ?? '')
    .split(/[,\n\u3001\uff0c]+/)
    .map((x) => x.trim())
    .filter(Boolean))];
}

/**
 * 解析「按人关键词」：支持两种写法
 *   JSON: {"10001": ["早安","在吗"]}
 *   行式: 10001: 早安,在吗
 */
export function parseKeywordsByUser(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return {};
  const out = {};
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      for (const [k, v] of Object.entries(obj)) {
        const list = Array.isArray(v) ? v : parseList(v);
        if (k && list.length) out[String(k).trim()] = list.map((x) => String(x).trim()).filter(Boolean);
      }
      return out;
    } catch { /* 落到行式解析 */ }
  }
  for (const line of s.split(/\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const qq = line.slice(0, i).trim();
    const list = parseList(line.slice(i + 1));
    if (qq && list.length) out[qq] = list;
  }
  return out;
}

/** 解析「按群别名」：{"878335260": ["浅羽","羽"]}。 */
export function parseGroupAliases(raw) {
  const s = String(raw ?? '').trim();
  if (!s || !s.startsWith('{')) return {};
  try {
    const obj = JSON.parse(s);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const list = Array.isArray(v) ? v : parseList(v);
      if (k && list.length) out[String(k).trim()] = list.map((x) => String(x).trim()).filter(Boolean);
    }
    return out;
  } catch { return {}; }
}

/** 文本里是否出现某个别名（大小写不敏感）。 */
export function textHasAlias(text, alias) {
  const a = String(alias ?? '').trim();
  if (!a) return false;
  return String(text ?? '').toLowerCase().includes(a.toLowerCase());
}

/**
 * 判定这批消息是否命中「按人/按群」的唤醒规则。
 * @returns {{respond:boolean, reason?:string, count?:number}}
 */
export function decide({ entries = [], chatKey = '', settings = {} } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return { respond: false };

  const always = new Set(parseList(settings.alwaysReplyUsers));
  const kwByUser = parseKeywordsByUser(settings.keywordsByUser);
  const aliases = parseList(settings.aliases);
  const groupAliases = parseGroupAliases(settings.groupAliases);
  const gid = String(chatKey).startsWith('group:') ? String(chatKey).slice(6) : '';
  const extraAliases = aliases.concat(gid && groupAliases[gid] ? groupAliases[gid] : []);
  const replyCount = Math.max(0, Number(settings.wakeCount) || 0);

  // 1) 别名被叫（相当于"被艾特"）
  if (extraAliases.length) {
    const hit = list.find((e) => !e?.self && extraAliases.some((a) => textHasAlias(e?.text, a)));
    if (hit) {
      const which = extraAliases.find((a) => textHasAlias(hit?.text, a));
      return { respond: true, reason: '别名被叫（' + which + '）', count: replyCount || undefined };
    }
  }
  // 2) 必回名单
  if (always.size) {
    const hit = list.find((e) => !e?.self && always.has(String(e?.senderId ?? '')));
    if (hit) return { respond: true, reason: '必回名单（' + hit.senderId + '）', count: replyCount || undefined };
  }
  // 3) 按人关键词
  const userKeys = Object.keys(kwByUser);
  if (userKeys.length) {
    for (const e of list) {
      if (e?.self) continue;
      const kws = kwByUser[String(e?.senderId ?? '')];
      if (!kws || !kws.length) continue;
      const hit = kws.find((k) => textHasAlias(e?.text, k));
      if (hit) return { respond: true, reason: '按人关键词（' + e.senderId + '：' + hit + '）', count: replyCount || undefined };
    }
  }
  return { respond: false };
}
