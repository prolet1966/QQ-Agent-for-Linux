import http from 'node:http';
// A temporary QQ display shares the authenticated console origin. The target
// is fixed and loopback-only; neither URLs nor request bodies select a server.
export function createDesktopProxy({ authorize, originAllowed, enabled }) {
  const prefix = '/qq-desktop';
  const sockets = new Map();
  const requests = new Map();
  const headersFor = req => {
    const headers = { ...req.headers, host: '127.0.0.1:6080' };
    for (const name of ['cookie', 'authorization', 'x-console-token', 'x-forwarded-for', 'x-real-ip']) delete headers[name];
    return headers;
  };
  const allowed = req => enabled() && authorize(req) && originAllowed(req);
  function handle(req, res) {
    let pathname;
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; }
    catch { res.writeHead(400); res.end('Bad Request'); return true; }
    if (pathname !== prefix && !pathname.startsWith(prefix + '/')) return false;
    if (!allowed(req)) { res.writeHead(403); res.end('请登录 QQA 控制台'); return true; }
    if (pathname === prefix) { res.writeHead(302, { location: prefix + '/vnc.html?autoconnect=1&resize=scale&path=qq-desktop/websockify' }); res.end(); return true; }
    const upstream = http.request({ hostname: '127.0.0.1', port: 6080, path: req.url.slice(prefix.length), method: req.method, headers: headersFor(req) }, response => {
      const headers = { ...response.headers, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
      delete headers['set-cookie'];
      res.writeHead(response.statusCode, headers); response.pipe(res);
      response.on('error', () => res.destroy());
    });
    const expiry = setInterval(() => { if (!allowed(req)) { res.destroy(); upstream.destroy(); } }, 15000); expiry.unref();
    requests.set(upstream, { req, res });
    upstream.on('close', () => { clearInterval(expiry); requests.delete(upstream); });
    upstream.setTimeout(15000, () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); if (!res.writableEnded) res.end('临时 QQ 登录窗口未启动，请先在协议页点击打开登录窗口'); });
    req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream); return true;
  }
  function upgrade(req, socket, head) {
    let pathname;
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; }
    catch {
      socket.on('error', () => socket.destroy());
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return true;
    }
    if (!pathname.startsWith(prefix + '/')) return false;
    if (!allowed(req) || sockets.size >= 4 || !req.url.split('?')[0].endsWith('/websockify')) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return true; }
    sockets.set(socket, req);
    const upstream = http.request({ hostname: '127.0.0.1', port: 6080, path: '/websockify', headers: headersFor(req) });
    const expiry = setInterval(() => { if (!allowed(req)) socket.destroy(); }, 15000); expiry.unref();
    socket.on('close', () => { clearInterval(expiry); sockets.delete(socket); upstream.destroy(); });
    socket.on('error', () => upstream.destroy());
    upstream.setTimeout(15000, () => upstream.destroy());
    upstream.on('upgrade', (response, remote, remoteHead) => {
      upstream.setTimeout(0); remote.setTimeout(0);
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).filter(([k]) => k !== 'set-cookie').map(([k,v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (head.length) remote.write(head); if (remoteHead.length) socket.write(remoteHead);
      remote.on('error', () => socket.destroy()); socket.on('close', () => remote.destroy()); socket.pipe(remote).pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); upstream.on('response', response => { response.resume(); socket.destroy(); }); upstream.end(); return true;
  }
  function revalidate() {
    for (const [socket, req] of sockets) if (!allowed(req)) socket.destroy();
    for (const [request, { req, res }] of requests) if (!allowed(req)) { res.destroy(); request.destroy(); }
  }
  return { handle, upgrade, revalidate, close() {
    for (const socket of sockets.keys()) socket.destroy(); sockets.clear();
    for (const [request, { res }] of requests) { res.destroy(); request.destroy(); } requests.clear();
  } };
}
