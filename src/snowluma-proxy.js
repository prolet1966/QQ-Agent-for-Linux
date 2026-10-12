// Fixed loopback destination. Path rewriting is scoped to the supported bundle;
// future bundles require their own browser compatibility checks.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const PREFIX = '/snowluma';
const MAX_REWRITE_BYTES = 2 * 1024 * 1024;
export function rewriteSnowlumaAsset(body, contentType) {
  let text = body.toString('utf8');
  if (/html/.test(contentType)) {
    text = text.replace(/(src|href)=(['"])\/(?!\/)/g, `$1=$2${PREFIX}/`);
  } else if (/javascript/.test(contentType)) {
    text = text.replace(/(['"`])\/(api\/|assets\/|avatar\/|ui-asset\/|logo\.png|favicon\.svg|ws\b)/g, `$1${PREFIX}/$2`);
    // The pinned 1.14.22 Vite preload helper joins a root slash to its
    // relative dependency table. Rewrite that helper as well as URL literals,
    // otherwise navigating beyond login requests lazy CSS from /assets/.
    text = text.replace('function(e){return`/`+e}', `function(e){return\`${PREFIX}/\`+e}`);
    // Application navigation uses public pathnames for labels, while the
    // router now owns a basepath. Its direct history calls need that prefix.
    text = text.replaceAll('select:e=>e.location.pathname', `select:e=>e.location.pathname.replace(/^\\/snowluma(?=\\/|$)/,"")||"/"`);
    text = text.replaceAll('window.location.assign(`/`)', `window.location.assign(\`${PREFIX}/\`)`);
    text = text.replaceAll('window.history.replaceState({},``,`/`)', `window.history.replaceState({},\`\`,\`${PREFIX}/\`)`);
    text = text.replaceAll('`/onboarding?mode=developer`', `\`${PREFIX}/onboarding?mode=developer\``);
    text = text.replaceAll('`/settings?tab=developer`', `\`${PREFIX}/settings?tab=developer\``);
    text = text.replaceAll('e.pathname===`/onboarding`', `e.pathname===\`${PREFIX}/onboarding\``);
    text = text.replaceAll('t.startsWith(`/onboarding`)', `t.startsWith(\`${PREFIX}/onboarding\`)`);
    // SnowLuma 1.14.22 uses TanStack Router. Give its route tree a base path.
    text = text.replace(/\{routeTree:/g, `{basepath:${JSON.stringify(PREFIX)},routeTree:`);
  } else if (/css/.test(contentType)) {
    text = text.replace(/url\((['"]?)\/(?!\/)/g, `url($1${PREFIX}/`);
  }
  return Buffer.from(text);
}

export function snowlumaProxySupported(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version === '1.14.22'; } catch { return false; }
}

export function createSnowlumaProxy({ getPort, getDir, authorize, originAllowed, enabled }) {
  const sockets = new Map();
  const requests = new Map();
  function canAccess(req) { return enabled() && authorize(req) && originAllowed(req); }
  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { res.writeHead(400); res.end('Bad Request'); return true; }
    if (!url.pathname.startsWith(`${PREFIX}/`) && url.pathname !== PREFIX) return false;
    if (!canAccess(req)) { res.writeHead(403); res.end('请登录 QQA 控制台并使用同源管理入口'); return true; }
    if (!snowlumaProxySupported(getDir())) { res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' }); res.end('此 WebUI 版本尚未验证代理兼容性。请通过 SSH 本地转发访问 127.0.0.1:5099。'); return true; }
    if (url.pathname === PREFIX) { res.writeHead(302, { location: `${PREFIX}/` }); res.end(); return true; }
    const port = getPort();
    const headers = { ...req.headers, host: `127.0.0.1:${port}`, 'accept-encoding': 'identity' };
    if (headers.cookie) headers.cookie = headers.cookie.split(';').map(v => v.trim()).filter(v => !/^qqa_session=/i.test(v)).join('; ');
    delete headers['x-console-token']; delete headers['x-forwarded-for']; delete headers['x-real-ip'];
    if (headers.origin) headers.origin = `http://127.0.0.1:${port}`;
    if (headers.referer) headers.referer = `http://127.0.0.1:${port}/`;
    const upstream = http.request({ hostname: '127.0.0.1', port, path: url.pathname.slice(PREFIX.length) + url.search, method: req.method, headers }, response => {
      const outgoing = { ...response.headers, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
      response.on('error', () => res.destroy());
      if (outgoing['set-cookie']) outgoing['set-cookie'] = outgoing['set-cookie'].map(v => v.replace(/;\s*Path=\//i, `; Path=${PREFIX}/`));
      if (outgoing.location?.startsWith('/') && !outgoing.location.startsWith('//')) outgoing.location = PREFIX + outgoing.location;
      const type = String(outgoing['content-type'] || '');
      const rewriting = /html|javascript|css/.test(type);
      if (!rewriting) { res.writeHead(response.statusCode, outgoing); response.pipe(res); return; }
      let bytes = 0; const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_REWRITE_BYTES) { response.destroy(); if (!res.headersSent) res.writeHead(502); res.end('WebUI asset exceeds proxy limit'); }
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (res.writableEnded) return;
        const data = rewriteSnowlumaAsset(Buffer.concat(chunks), type);
        delete outgoing['content-length']; delete outgoing.etag; delete outgoing['content-encoding']; delete outgoing['transfer-encoding'];
        res.writeHead(response.statusCode, { ...outgoing, 'content-length': data.length }); res.end(data);
      });
    });
    const expiry = setInterval(() => { if (!canAccess(req)) { res.destroy(); upstream.destroy(); } }, 15000); expiry.unref();
    requests.set(upstream, { req, res });
    upstream.on('close', () => { clearInterval(expiry); requests.delete(upstream); });
    upstream.setTimeout(15000, () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); if (!res.writableEnded) res.end('SnowLuma WebUI 未就绪，请查看协议端诊断'); });
    req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy());
    req.pipe(upstream); return true;
  }
  function upgrade(req, socket, head) {
    try { new URL(req.url, 'http://localhost'); }
    catch {
      socket.on('error', () => socket.destroy());
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return true;
    }
    if (!req.url?.startsWith(`${PREFIX}/`)) return false;
    if (!canAccess(req) || sockets.size >= 8 || !snowlumaProxySupported(getDir())) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return true; }
    const port = getPort();
    const headers = { ...req.headers, host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
    if (headers.cookie) headers.cookie = headers.cookie.split(';').map(v => v.trim()).filter(v => !/^qqa_session=/i.test(v)).join('; ');
    delete headers['x-console-token']; delete headers['x-forwarded-for']; delete headers['x-real-ip'];
    const request = http.request({ hostname: '127.0.0.1', port, path: req.url.slice(PREFIX.length), headers });
    const expiry = setInterval(() => { if (!canAccess(req)) socket.destroy(); }, 15000); expiry.unref();
    sockets.set(socket, req); socket.on('close', () => { clearInterval(expiry); sockets.delete(socket); request.destroy(); });
    socket.on('error', () => request.destroy());
    request.on('upgrade', (response, remote, remoteHead) => {
      request.setTimeout(0); remote.setTimeout(0);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).filter(([key]) => key !== 'set-cookie').map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead); if (head.length) remote.write(head);
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy()); socket.on('close', () => remote.destroy());
      socket.pipe(remote).pipe(socket);
    });
    request.on('response', response => { response.resume(); socket.destroy(); }); request.on('error', () => socket.destroy());
    request.setTimeout(15000, () => request.destroy()); request.end(); return true;
  }
  function revalidate() {
    for (const [socket, req] of sockets) if (!canAccess(req)) socket.destroy();
    for (const [request, { req, res }] of requests) if (!canAccess(req)) { res.destroy(); request.destroy(); }
  }
  return { handle, upgrade, revalidate, close() {
    for (const socket of sockets.keys()) socket.destroy(); sockets.clear();
    for (const [request, { res }] of requests) { res.destroy(); request.destroy(); } requests.clear();
  } };
}
