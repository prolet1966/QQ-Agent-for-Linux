import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ConsoleAuth } from '../src/console-auth.js';
import { sameOriginAllowed } from '../src/runtime.js';
import { SseHub } from '../src/sse.js';
import { createSnowlumaProxy } from '../src/snowluma-proxy.js';

test('initial password survives restart, password rotation revokes sessions, environment password never persists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-auth-'));
  try {
    const auth = new ConsoleAuth(dir, { password: undefined }); await auth.init(() => {});
    const password = (await fs.readFile(auth.initialFile, 'utf8')).trim();
    const req = { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    assert(await auth.verify(req, password));
    const res = { setHeader(key, value) { this.cookie = value; } };
    auth.newSession(req, res); req.headers.cookie = res.cookie;
    assert(auth.authorized(req));
    const restarted = new ConsoleAuth(dir, { password: undefined }); await restarted.init(() => {});
    assert(await restarted.verify(req, password)); assert(!restarted.authorized(req));
    const json = (res, code, body) => { res.code = code; res.body = body; };
    await auth.handle(req, res, '/api/auth/password', { json, originAllowed: () => true, readBody: async () => ({ oldPassword: password, password: 'rotated-password-1234' }) });
    assert.equal(res.code, 200); assert(!auth.authorized(req)); await assert.rejects(fs.access(auth.initialFile));
    assert(await auth.verify(req, 'rotated-password-1234'));
    for (let i = 0; i < 5; i++) assert(!await auth.verify(req, 'invalid'));
    await assert.rejects(auth.verify(req, 'rotated-password-1234'), e => e.status === 429);
    const envDir = path.join(dir, 'env'); const envAuth = new ConsoleAuth(envDir, { password: 'environment-password-1234' }); await envAuth.init();
    assert(await envAuth.verify(req, 'environment-password-1234')); await assert.rejects(fs.access(envAuth.file));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('remote console permits configured exact origin and rejects cross-site, mismatched ports, schemes and DNS rebinding', () => {
  const cfg = { server: { publicHost: '47.109.97.184:3210', allowedOrigins: [] } };
  const req = { socket: {}, headers: { host: '47.109.97.184:3210', origin: 'http://47.109.97.184:3210' } };
  assert(sameOriginAllowed(req, cfg));
  for (const origin of ['http://evil.invalid', 'https://47.109.97.184:3210', 'http://47.109.97.184:3211']) {
    assert(!sameOriginAllowed({ ...req, headers: { ...req.headers, origin } }, cfg));
  }
  assert(!sameOriginAllowed({ ...req, headers: { host: 'evil.invalid' } }, cfg));
  assert(!sameOriginAllowed({ ...req, headers: { ...req.headers, 'sec-fetch-site': 'cross-site' } }, cfg));
});

test('slow SSE consumers are disconnected without retaining pending writes', () => {
  const hub = new SseHub();
  const res = { writableNeedDrain: true, writableLength: 0, destroy() { this.destroyed = true; } };
  hub.clients.add(res); hub.emit('status', { ready: true });
  assert(res.destroyed); assert.equal(hub.clients.size, 0); assert.equal(hub.dropped, 1);
});

test('SnowLuma proxy rewrites chunked assets, scopes cookies and strips console credentials', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-proxy-'));
  let upstream; let panel; let proxy;
  try {
    await fs.writeFile(path.join(dir, 'package.json'), '{"version":"1.14.22"}');
    upstream = http.createServer((req, res) => {
      assert(!String(req.headers.cookie || '').includes('qqa_session'));
      assert.equal(req.url, '/assets/app.js');
      res.writeHead(200, { 'content-type': 'application/javascript', 'set-cookie': 'snow_test=x; Path=/; HttpOnly' });
      res.write('const r={routeTree:tree};'); res.end('fetch(`/api/ui`);');
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    proxy = createSnowlumaProxy({ getDir: () => dir, getPort: () => upstream.address().port, authorize: () => true, originAllowed: () => true, enabled: () => true });
    panel = http.createServer((req, res) => proxy.handle(req, res));
    await new Promise(resolve => panel.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${panel.address().port}/snowluma/assets/app.js`, { headers: { cookie: 'qqa_session=secret;snow_test=present' } });
    assert.equal(response.status, 200); assert(!response.headers.has('transfer-encoding'));
    assert.match(response.headers.get('set-cookie'), /Path=\/snowluma\//);
    const text = await response.text(); assert.match(text, /basepath:"\/snowluma"/); assert.match(text, /fetch\(`\/snowluma\/api\/ui`\)/);
  } finally {
    proxy?.close(); for (const server of [panel, upstream]) if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    await fs.rm(dir, { recursive: true, force: true });
  }
});
