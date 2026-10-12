import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { createDesktopProxy } from '../src/desktop-proxy.js';
import { createSnowlumaProxy } from '../src/snowluma-proxy.js';
import { createCredentialFilter } from '../scripts/server/snowluma-launcher.mjs';

const listen = (server, host = '127.0.0.1') => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, host, () => { server.off('error', reject); resolve(server.address().port); });
});
const close = (server) => new Promise((resolve) => server?.close(() => resolve()));
const waitFor = async (fn, ms = 1500) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('等待连接状态超时'); await new Promise((resolve) => setTimeout(resolve, 10)); } };
function deniedSocket(url, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers }); socket.on('error', () => {});
    socket.once('open', () => { socket.terminate(); reject(new Error('未授权 WebSocket 已连接')); });
    socket.once('unexpected-response', (_req, res) => { res.resume(); const code = res.statusCode; socket.terminate(); resolve(code); });
    setTimeout(() => { socket.terminate(); reject(new Error('WebSocket 拒绝响应超时')); }, 2000).unref();
  });
}

test('both proxy URL boundaries reject malformed HTTP and Upgrade targets before checking access', async () => {
  const guards = { enabled: () => { throw new Error('invalid URL reached access check'); }, authorize: () => false, originAllowed: () => false };
  for (const proxy of [createDesktopProxy(guards), createSnowlumaProxy({ ...guards, getDir: () => '', getPort: () => 5099 })]) {
    for (const target of ['http://%', 'http://[', 'http://localhost:invalid']) {
      const response = { writeHead(code) { this.code = code; }, end(body) { this.body = body; } };
      assert.equal(await proxy.handle({ url: target }, response), true);
      assert.equal(response.code, 400); assert.equal(response.body, 'Bad Request');
      const socket = { on() {}, end(value) { this.response = value; } };
      assert.equal(proxy.upgrade({ url: target }, socket, Buffer.alloc(0)), true);
      assert.match(socket.response, /^HTTP\/1\.1 400 Bad Request/);
    }
    proxy.close();
  }
});

test('desktop proxy is authenticated, loopback-fixed, strips QQA cookies and logout closes WebSocket', async () => {
  let authenticated = true; let upstream; let panel; let proxy; let wss; const clients = new Set();
  try {
    upstream = http.createServer((req, res) => {
      assert.equal(req.headers.host, '127.0.0.1:6080'); assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined);
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'upstream=secret; Path=/' }); res.end('desktop');
    });
    wss = new WebSocketServer({ noServer: true });
    upstream.on('upgrade', (req, socket, head) => { assert.equal(req.url, '/websockify'); assert.equal(req.headers.cookie, undefined); wss.handleUpgrade(req, socket, head, (client) => { clients.add(client); client.on('close', () => clients.delete(client)); wss.emit('connection', client, req); }); });
    await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(6080, '127.0.0.1', resolve); });
    proxy = createDesktopProxy({ enabled: () => true, authorize: (req) => authenticated && /(?:^|;\s*)qqa_session=ok(?:;|$)/.test(req.headers.cookie || ''), originAllowed: (req) => req.headers.origin !== 'http://evil.invalid' });
    panel = http.createServer((req, res) => proxy.handle(req, res)); panel.on('upgrade', (req, socket, head) => proxy.upgrade(req, socket, head));
    const port = await listen(panel);
    const good = await fetch(`http://127.0.0.1:${port}/qq-desktop/index.html`, { headers: { cookie: 'qqa_session=ok; other=x', origin: `http://127.0.0.1:${port}` } });
    assert.equal(good.status, 200); assert.equal(await good.text(), 'desktop'); assert.equal(good.headers.get('set-cookie'), null);
    const denied = await fetch(`http://127.0.0.1:${port}/qq-desktop/index.html`, { headers: { cookie: 'qqa_session=bad', origin: `http://127.0.0.1:${port}` } }); assert.equal(denied.status, 403);
    const cross = await fetch(`http://127.0.0.1:${port}/qq-desktop/index.html`, { headers: { cookie: 'qqa_session=ok', origin: 'http://evil.invalid' } }); assert.equal(cross.status, 403);
    assert.equal(await deniedSocket(`ws://127.0.0.1:${port}/qq-desktop/websockify`, { cookie: 'qqa_session=bad' }), 403);
    assert.equal(await deniedSocket(`ws://127.0.0.1:${port}/qq-desktop/websockify`, { cookie: 'qqa_session=ok', origin: 'http://evil.invalid' }), 403);
    const sockets = Array.from({ length: 4 }, () => new WebSocket(`ws://127.0.0.1:${port}/qq-desktop/websockify`, { headers: { cookie: 'qqa_session=ok', origin: `http://127.0.0.1:${port}` } }));
    await Promise.all(sockets.map((socket) => new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); })));
    assert.equal(await deniedSocket(`ws://127.0.0.1:${port}/qq-desktop/websockify`, { cookie: 'qqa_session=ok', origin: `http://127.0.0.1:${port}` }), 403);
    authenticated = false; proxy.revalidate(); await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.once('close', resolve)))); await waitFor(() => clients.size === 0);
  } finally { proxy?.close(); for (const client of wss?.clients || []) client.terminate(); wss?.close(); panel?.closeAllConnections(); upstream?.closeAllConnections(); await close(panel); await close(upstream); }
});

test('SnowLuma proxy has same-origin/cookie isolation, a fixed upstream and an eight-connection cap', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-snow-proxy-')); let upstream; let panel; let proxy; const clients = new Set(); let authenticated = true;
  try {
    await fs.writeFile(path.join(dir, 'package.json'), '{"version":"1.14.22"}');
    upstream = http.createServer((req, res) => { assert.equal(req.headers.cookie, 'snow=x'); assert.equal(req.headers.host, `127.0.0.1:${upstream.address().port}`); res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'snow=x; Path=/' }); res.end('<img src="/assets/a.png">'); });
    const wss = new WebSocketServer({ noServer: true }); upstream.on('upgrade', (req, socket, head) => { assert.equal(req.headers.cookie, 'snow=x'); wss.handleUpgrade(req, socket, head, (client) => { clients.add(client); client.on('close', () => clients.delete(client)); wss.emit('connection', client, req); }); });
    await listen(upstream); proxy = createSnowlumaProxy({ getDir: () => dir, getPort: () => upstream.address().port, enabled: () => true, authorize: (req) => authenticated && /qqa_session=ok/.test(req.headers.cookie || ''), originAllowed: (req) => req.headers.origin !== 'http://evil.invalid' });
    panel = http.createServer((req, res) => proxy.handle(req, res)); panel.on('upgrade', (req, socket, head) => proxy.upgrade(req, socket, head)); const port = await listen(panel);
    const response = await fetch(`http://127.0.0.1:${port}/snowluma/`, { headers: { cookie: 'qqa_session=ok; snow=x', origin: `http://127.0.0.1:${port}` } }); assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /Path=\/snowluma\//); assert.match(await response.text(), /\/snowluma\/assets/);
    const denied = await fetch(`http://127.0.0.1:${port}/snowluma/`, { headers: { cookie: 'qqa_session=ok', origin: 'http://evil.invalid' } }); assert.equal(denied.status, 403);
    assert.equal(await deniedSocket(`ws://127.0.0.1:${port}/snowluma/ws`, { cookie: 'qqa_session=bad' }), 403);
    assert.equal(await deniedSocket(`ws://127.0.0.1:${port}/snowluma/ws`, { cookie: 'qqa_session=ok', origin: 'http://evil.invalid' }), 403);
    const sockets = Array.from({ length: 8 }, () => new WebSocket(`ws://127.0.0.1:${port}/snowluma/ws`, { headers: { cookie: 'qqa_session=ok; snow=x', origin: `http://127.0.0.1:${port}` } }));
    await Promise.all(sockets.map((socket) => new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); })));
    assert.equal(await deniedSocket(`ws://127.0.0.1:${port}/snowluma/ws`, { cookie: 'qqa_session=ok', origin: `http://127.0.0.1:${port}` }), 403);
    authenticated = false; proxy.revalidate(); await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.once('close', resolve)))); await waitFor(() => clients.size === 0); wss.close();
  } finally { proxy?.close(); for (const client of clients) client.terminate(); panel?.closeAllConnections(); upstream?.closeAllConnections(); await close(panel); await close(upstream); await fs.rm(dir, { recursive: true, force: true }); }
});

test('closing or revoking either proxy interrupts HTTP streams and permits the console to stop', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-proxy-stop-'));
  await fs.writeFile(path.join(dir, 'package.json'), '{"version":"1.14.22"}');
  try {
    for (const [type, action] of [['desktop', 'close'], ['snowluma', 'close'], ['desktop', 'revalidate'], ['snowluma', 'revalidate']]) {
      let upstream; let panel; let proxy; let request;
      try {
        let upstreamClosed;
        const closed = new Promise((resolve) => { upstreamClosed = resolve; });
        upstream = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ready\n\n'); res.on('close', upstreamClosed); });
        await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(type === 'desktop' ? 6080 : 0, '127.0.0.1', resolve); });
        let authenticated = true;
        const guards = { enabled: () => true, authorize: () => authenticated, originAllowed: () => true };
        proxy = type === 'desktop' ? createDesktopProxy(guards) : createSnowlumaProxy({ ...guards, getPort: () => upstream.address().port, getDir: () => dir });
        panel = http.createServer((req, res) => proxy.handle(req, res)); const port = await listen(panel);
        const response = await new Promise((resolve, reject) => {
          request = http.get(`http://127.0.0.1:${port}/${type === 'desktop' ? 'qq-desktop' : 'snowluma'}/stream`, resolve); request.on('error', reject);
        });
        let responseClosed; const interrupted = new Promise((resolve) => { responseClosed = resolve; });
        response.on('close', responseClosed); response.on('error', () => {}); response.resume();
        if (action === 'revalidate') { authenticated = false; proxy.revalidate(); } else proxy.close();
        let timer;
        try { await Promise.race([Promise.all([interrupted, closed, close(panel)]), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${type} stream blocked console stop`)), 1000); })]); }
        finally { clearTimeout(timer); }
      } finally { request?.destroy(); proxy?.close(); panel?.closeAllConnections(); upstream?.closeAllConnections(); await close(panel); await close(upstream); }
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('SnowLuma upstream interruption closes a streamed response without an unhandled error', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-proxy-abort-')); let upstream; let panel; let proxy; let request;
  try {
    await fs.writeFile(path.join(dir, 'package.json'), '{"version":"1.14.22"}');
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ready\n\n');
      const timer = setTimeout(() => res.destroy(), 25); res.on('close', () => clearTimeout(timer));
    });
    await listen(upstream);
    proxy = createSnowlumaProxy({ enabled: () => true, authorize: () => true, originAllowed: () => true, getPort: () => upstream.address().port, getDir: () => dir });
    panel = http.createServer((req, res) => proxy.handle(req, res)); const port = await listen(panel);
    await new Promise((resolve, reject) => {
      request = http.get(`http://127.0.0.1:${port}/snowluma/api/events`, (response) => {
        response.on('error', () => {}); response.once('close', resolve); response.resume();
      }); request.on('error', reject);
    });
  } finally { request?.destroy(); proxy?.close(); panel?.closeAllConnections(); upstream?.closeAllConnections(); await close(panel); await close(upstream); await fs.rm(dir, { recursive: true, force: true }); }
});

test('expired console sessions terminate both HTTP streams on periodic revalidation', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-proxy-expiry-'));
  await fs.writeFile(path.join(dir, 'package.json'), '{"version":"1.14.22"}');
  try {
    for (const type of ['desktop', 'snowluma']) {
      let upstream; let panel; let proxy; let request;
      try {
        let validUntil = Date.now() + 60_000;
        upstream = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ready\n\n'); });
        await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(type === 'desktop' ? 6080 : 0, '127.0.0.1', resolve); });
        const guards = { enabled: () => true, authorize: () => Date.now() < validUntil, originAllowed: () => true };
        proxy = type === 'desktop' ? createDesktopProxy(guards) : createSnowlumaProxy({ ...guards, getPort: () => upstream.address().port, getDir: () => dir });
        panel = http.createServer((req, res) => proxy.handle(req, res)); const port = await listen(panel);
        const response = await new Promise((resolve, reject) => { request = http.get(`http://127.0.0.1:${port}/${type === 'desktop' ? 'qq-desktop' : 'snowluma'}/events`, resolve); request.on('error', reject); });
        response.on('error', () => {}); response.resume();
        t.mock.timers.tick(15_000); assert.equal(response.destroyed, false, 'a valid session should keep its stream');
        const interrupted = new Promise((resolve) => response.once('close', resolve)); validUntil = 0;
        t.mock.timers.tick(15_000);
        await interrupted;
      } finally { request?.destroy(); proxy?.close(); panel?.closeAllConnections(); upstream?.closeAllConnections(); await close(panel); await close(upstream); }
    }
  } finally { t.mock.timers.reset(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('SnowLuma launcher writes initial password only to a mode-600 file and bounds/redacts output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-launcher-')), passwordFile = path.join(dir, 'config', 'qqa-initial-password.txt');
  try {
    const filter = createCredentialFilter(passwordFile); const chunks = []; filter.on('data', (chunk) => chunks.push(chunk));
    filter.write(Buffer.from('prefix initial cred')); filter.write(Buffer.from('entials: password=split-secret\n')); filter.write(Buffer.from('token=abc api_key=hidden\n')); filter.write(Buffer.from('x'.repeat(100000) + 'password=lost\n')); filter.end(); await new Promise((resolve) => filter.on('end', resolve));
    const output = Buffer.concat(chunks).toString(); assert(!output.includes('split-secret')); assert(!output.includes('hidden')); assert(!output.includes('lost')); assert.ok(output.split('\n').every((line) => Buffer.byteLength(line) <= 16 * 1024));
    assert.equal((await fs.readFile(passwordFile, 'utf8')).trim(), 'split-secret'); if (process.platform !== 'win32') assert.equal((await fs.stat(passwordFile)).mode & 0o777, 0o600);
    const script = await fs.readFile(new URL('../scripts/server/temporary-desktop.sh', import.meta.url), 'utf8'); assert.match(script, /-localhost/); assert.match(script, /127\.0\.0\.1:6080\s+127\.0\.0\.1:5901/);
    const service = await fs.readFile(new URL('../scripts/server/qq-agent-desktop.service', import.meta.url), 'utf8'); assert.match(service, /^RuntimeMaxSec=15min$/m); assert.match(service, /^KillMode=control-group$/m); assert.doesNotMatch(service, /^\[Install\]$/m);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('launcher real child saves bootstrap password without sending it to either journal and removes it after rotation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-launcher-child-'));
  const launcher = fileURLToPath(new URL('../scripts/server/snowluma-launcher.mjs', import.meta.url));
  async function run() {
    const child = spawn(process.execPath, [launcher], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }); const output = [];
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => output.push(chunk));
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0); return Buffer.concat(output).toString();
  }
  try {
    await fs.mkdir(path.join(dir, 'config')); await fs.writeFile(path.join(dir, 'config', 'webui.json'), '{"mustChangePassword":true}');
    await fs.writeFile(path.join(dir, 'index.mjs'), `process.stdout.write('initial credentials: password=stdout-secret\\n'); process.stderr.write('token=stderr-secret\\n');`);
    const output = await run(); assert(!output.includes('stdout-secret')); assert(!output.includes('stderr-secret'));
    const passwordFile = path.join(dir, 'config', 'qqa-initial-password.txt'); assert.equal((await fs.readFile(passwordFile, 'utf8')).trim(), 'stdout-secret');
    await fs.writeFile(path.join(dir, 'config', 'webui.json'), '{"mustChangePassword":false}'); await fs.writeFile(path.join(dir, 'index.mjs'), `console.log('ready');`);
    await run(); await assert.rejects(fs.access(passwordFile));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('credential filter output remains bounded under slow journal backpressure and a 32 MiB no-newline record', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-launcher-pressure-'));
  try {
    const filter = createCredentialFilter(path.join(dir, 'password.txt')); let written = 0, maxReadable = 0, maxWritable = 0;
    const output = new Writable({ highWaterMark: 1024, write(chunk, _encoding, callback) { written += chunk.length; setTimeout(callback, 1); } });
    const finished = new Promise((resolve, reject) => { output.on('finish', resolve); output.on('error', reject); filter.on('error', reject); }); filter.pipe(output);
    for (let i = 0; i < 512; i++) {
      const ok = filter.write(Buffer.alloc(64 * 1024, 120)); maxReadable = Math.max(maxReadable, filter.readableLength); maxWritable = Math.max(maxWritable, filter.writableLength);
      if (!ok) await new Promise((resolve) => filter.once('drain', resolve));
    }
    filter.end('\n'); await finished; assert.ok(written <= 16 * 1024 + 1); assert.ok(maxReadable <= 16 * 1024 + 1); assert.ok(maxWritable <= 64 * 1024);
    const boundary = createCredentialFilter(path.join(dir, 'boundary.txt')), chunks = []; boundary.on('data', (chunk) => chunks.push(chunk));
    boundary.write('x'.repeat(16384 - ' initial credentials: password=sec'.length) + ' initial credentials: password=sec'); boundary.write('ret\n'); boundary.end(); await new Promise((resolve) => boundary.on('end', resolve));
    assert(!Buffer.concat(chunks).toString().includes('secret')); await assert.rejects(fs.access(path.join(dir, 'boundary.txt')));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
