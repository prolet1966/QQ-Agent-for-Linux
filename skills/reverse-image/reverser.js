// 以图识图（反查来源）—— 上传到临时图床后走百度识图 / IQDB。
//
// ── 从哪来 ────────────────────────────────────────────────────────────────
// 移植自桌面魔改包 `10-reverse-image/src/reverse-image.js`。
// 改动点：① fetch 由调用方注入（默认 api.fetch，受 web_fetch 权限约束），
//        ② 上传图床可配置关闭（默认开，因为 QQ 图链接常常取不到、不开就没法用），
//        ③ 超时/大小上限做成参数，便于按配置调。
//
// ── 与相邻能力的分工 ──────────────────────────────────────────────────────
//   `search_images`（核心工具）     —— 按关键词**找**图并发出去
//   `identify_image`（本模块）      —— 拿一张**已有的图**反查它是谁/出自哪
// 两者不重叠：一个是从无到有，一个是从有到"知道这是什么"。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** data URL → { mime, buf }。 */
export function dataUrlToBuffer(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) throw new Error('不是 base64 data URL');
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}

/** 拼 multipart body（不引第三方库，重复三次不值得）。 */
function multipart(fields) {
  const boundary = `----qqagent${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const parts = [];
  for (const f of fields) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`
      + (f.filename ? `; filename="${f.filename}"` : '')
      + (f.mime ? `\r\nContent-Type: ${f.mime}` : '') + '\r\n\r\n'
    ));
    parts.push(Buffer.isBuffer(f.value) ? f.value : Buffer.from(String(f.value)));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

/**
 * 上传拿临时公网 URL。
 * sm.ms 优先（国内相对可达），catbox 兜底 —— 两个都失败才抛错。
 */
export async function uploadForReverse(buf, mime, { fetchImpl = fetch, timeoutMs = 45000 } = {}) {
  const ext = /png/i.test(mime) ? 'png' : /webp/i.test(mime) ? 'webp' : /gif/i.test(mime) ? 'gif' : 'jpg';
  const filename = `rev.${ext}`;

  // ① sm.ms
  try {
    const { boundary, body } = multipart([{ name: 'smfile', filename, mime, value: buf }]);
    const res = await fetchImpl('https://sm.ms/api/v2/upload', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'user-agent': UA },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const j = await res.json().catch(() => null);
    const link = j?.data?.url || j?.images;
    if (typeof link === 'string' && /^https?:/i.test(link)) return link;
  } catch { /* 换 catbox */ }

  // ② catbox
  const { boundary, body } = multipart([
    { name: 'reqtype', value: 'fileupload' },
    { name: 'fileToUpload', filename, mime, value: buf }
  ]);
  const res = await fetchImpl('https://catbox.moe/user/api.php', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'user-agent': UA },
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = (await res.text()).trim();
  if (!/^https?:\/\//i.test(text)) throw new Error(`上传图床失败：${text.slice(0, 80) || res.status}`);
  return text;
}

/** 百度识图：解析结果页里的标题/链接。 */
async function searchBaidu(publicUrl, { fetchImpl, timeoutMs }) {
  const u = new URL('https://graph.baidu.com/s');
  for (const [k, v] of Object.entries({
    newjson: '1', fm: 'index', app_id: '3001000001', client_type: 'web',
    force_pc: '1', image: publicUrl, op_type: '1', similar: '1'
  })) u.searchParams.set(k, v);
  const res = await fetchImpl(u.toString(), {
    headers: { 'user-agent': UA, referer: 'https://graph.baidu.com/', accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`百度识图 HTTP ${res.status}`);
  const html = await res.text();
  const matches = [];
  const seen = new Set();
  const push = (title, url = '') => {
    const t = String(title || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!t || t.length < 2 || seen.has(t)) return;
    // 过滤导航项与"没找到"类文案 —— 它们不是识别结果
    if (/^(百度|首页|登录|设置|关于|更多|上一篇|下一篇|相关搜索|未找到|没有找到|暂无|抱歉)/i.test(t)) return;
    if (/未找到|没有相关|无结果/i.test(t)) return;
    seen.add(t);
    matches.push({ title: t.slice(0, 80), url: String(url || '').slice(0, 120), source: 'baidu' });
  };
  for (const m of html.matchAll(/data-title="([^"]{4,80})"/g)) push(m[1]);
  for (const m of html.matchAll(/"title"\s*:\s*"([^"]{4,80})"/g)) push(m[1]);
  for (const m of html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*title="([^"]{4,80})"/g)) push(m[2], m[1]);
  const gm = html.match(/generalData[\s\S]{0,2000}?title['":\s]+['"]([^'"]{4,60})/i);
  if (gm) push(gm[1]);
  return { matches: matches.slice(0, 8), provider: 'baidu' };
}

/** IQDB：二次元向兜底（国外源，连不上是常态，失败不算错）。 */
async function searchIqdb(publicUrl, { fetchImpl, timeoutMs }) {
  const res = await fetchImpl(`https://iqdb.org/?url=${encodeURIComponent(publicUrl)}`, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`IQDB HTTP ${res.status}`);
  const html = await res.text();
  const matches = [];
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>[\s\S]*?<strong>([^<]*)<\/strong>/gi;
  let m;
  while ((m = re.exec(html)) && matches.length < 5) {
    const title = String(m[2] || '').trim();
    if (!title || /iqdb\.org/i.test(m[1])) continue;
    matches.push({ title, url: m[1], source: 'iqdb' });
  }
  return { matches };
}

/**
 * 以图搜图入口。
 * @param {object} input { dataUrl?, url? }
 * @param {object} deps  { fetchImpl, maxBytes, allowUpload, useIqdb, timeoutMs }
 * @returns {Promise<{publicUrl, uploaded, matches, providers, note?}>}
 */
export async function reverseImageSearch({ dataUrl, url } = {}, {
  fetchImpl = fetch, maxBytes = 8 * 1024 * 1024, allowUpload = true,
  useIqdb = true, timeoutMs = 25000
} = {}) {
  let publicUrl = String(url || '').trim();
  let uploaded = false;
  let note = '';

  // 本地图（dataUrl）必须先换到公网才能被识图站点读取。
  // 图床关掉时明确告知原因，而不是含糊地报"失败"。
  if (!publicUrl && dataUrl) {
    if (!allowUpload) {
      throw new Error('这张图只有本地数据、没有公网地址，而"上传到图床"被设置关闭了（设置 → 以图识图 → 允许上传图床）');
    }
    const { buf, mime } = dataUrlToBuffer(dataUrl);
    if (buf.length > maxBytes) {
      throw new Error(`图片太大（${(buf.length / 1024 / 1024).toFixed(1)}MB > ${(maxBytes / 1024 / 1024).toFixed(0)}MB）`);
    }
    publicUrl = await uploadForReverse(buf, mime, { fetchImpl, timeoutMs: timeoutMs * 2 });
    uploaded = true;
    note = '图片已上传到临时图床以完成反查（图床只保留一段时间）';
  }
  if (!publicUrl) throw new Error('需要 dataUrl 或 url 之一');

  const providers = [];
  try {
    const b = await searchBaidu(publicUrl, { fetchImpl, timeoutMs });
    providers.push({ name: 'baidu', count: b.matches.length, matches: b.matches });
  } catch (e) {
    providers.push({ name: 'baidu', error: String(e?.message ?? e), matches: [] });
  }
  if (useIqdb) {
    try {
      const iq = await searchIqdb(publicUrl, { fetchImpl, timeoutMs });
      providers.push({ name: 'iqdb', count: iq.matches.length, matches: iq.matches });
    } catch (e) {
      // IQDB 是国外源，连不上很常见 —— 只在百度也没结果时才算"整体失败"
      providers.push({ name: 'iqdb', error: String(e?.message ?? e), matches: [] });
    }
  }

  const all = providers.flatMap((p) => p.matches || []);
  const seen = new Set();
  const matches = [];
  for (const m of all) {
    const k = `${m.title}|${m.url}`;
    if (seen.has(k)) continue;
    seen.add(k);
    matches.push(m);
  }

  return {
    publicUrl,
    uploaded,
    matches: matches.slice(0, 8),
    providers: providers.map((p) => ({
      name: p.name,
      count: (p.matches || []).length,
      ...(p.error ? { error: p.error } : {})
    })),
    ...(note ? { note } : {})
  };
}
