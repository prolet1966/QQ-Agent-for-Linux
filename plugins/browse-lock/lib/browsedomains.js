// browsedomains.js —— 浏览锁定的纯函数（宿主 03-image-browse/safe-fetch.js 照搬）
// 把「机器人能上哪些网站」收窄到一份域名清单。只作用于"主动上网"的工具
// （web_fetch / web_search / send_image / search_images），不碰 QQ 自己的图源（表情包、群聊图片）。

/**
 * 把用户填的域名/网址清洗成纯主机名：去协议、去 user@、去路径、去通配符前缀、去 www.、去端口、小写。
 * www. 是约定俗成的主机前缀：用户粘 www.xxx.com 时本意是整个站；去掉它 includeSubdomains 才能同时覆盖两边。
 */
export function normalizeDomain(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^[^/@]*@/, '')
    .replace(/[/?#].*$/, '')
    .replace(/^\*\./, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/** 从配置段算出当前锁定状态：{ enabled, domains[], includeSubdomains }。 */
export function lockStateFrom(sec = {}) {
  const domains = [...new Set((Array.isArray(sec.domains) ? sec.domains : [])
    .map(normalizeDomain)
    .filter(Boolean))];
  return {
    enabled: sec.enabled === true && domains.length > 0,
    domains,
    includeSubdomains: sec.includeSubdomains !== false,
  };
}

/** 主机名是否被允许（未启用锁定时一律允许）。 */
export function hostAllowed(host, state) {
  const st = state || { enabled: false, domains: [], includeSubdomains: true };
  if (!st.enabled) return true;
  const h = normalizeDomain(host);
  if (!h) return false;
  return st.domains.some((d) => h === d || (st.includeSubdomains && h.endsWith('.' + d)));
}

/** 从一个字符串里挑出主机名（可以是 URL、裸域名、或含域名的句子）。 */
export function hostOf(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  try {
    if (/^[a-z]+:\/\//i.test(s)) return new URL(s).hostname;
  } catch { /* 落下去当裸域名处理 */ }
  // 从文本里抓第一个像域名的 token
  const m = s.match(/(?:https?:\/\/)?([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/i);
  return m ? m[1] : '';
}

/** 把 argsRaw（JSON 字符串或对象）里所有像 URL 的值挑出来。 */
export function urlsInArgs(argsRaw) {
  let obj = argsRaw;
  if (typeof argsRaw === 'string') {
    try { obj = JSON.parse(argsRaw); } catch { obj = null; }
  }
  const out = [];
  const walk = (v, depth = 0) => {
    if (depth > 4 || v == null) return;
    if (typeof v === 'string') {
      if (/^https?:\/\//i.test(v.trim())) out.push(v.trim());
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === 'object') { for (const x of Object.values(v)) walk(x, depth + 1); }
  };
  walk(obj);
  return out;
}
