import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-server-'));
const port = 33210 + Math.floor(Math.random() * 300);
const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: {
  ...process.env, QQ_AGENT_MODE: 'server', QQ_AGENT_PRESET: 'server-2c2g', QQ_AGENT_DATA_DIR: dataDir,
  QQ_AGENT_PORT: String(port), QQ_AGENT_BIND_HOST: '127.0.0.1', QQ_AGENT_PUBLIC_HOST: `127.0.0.1:${port}`,
  QQ_AGENT_CONSOLE_PASSWORD: 'test-console-password-123'
}, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
async function request(url, options) { return fetch(`http://127.0.0.1:${port}${url}`, options); }
async function rawRequest(target, upgrade = false) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1'); let text = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('raw request did not close')); }, 3000);
    socket.setEncoding('utf8'); socket.on('data', chunk => { text += chunk; });
    socket.on('error', reject);
    socket.on('close', () => { clearTimeout(timer); resolve(text); });
    socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: ${upgrade ? 'Upgrade' : 'close'}\r\n${upgrade ? 'Upgrade: websocket\r\n' : ''}\r\n`));
  });
}
try {
  let response;
  for (let i = 0; i < 80; i++) {
    try { response = await request('/api/auth/session'); break; } catch { await delay(100); }
  }
  assert(response, `server did not listen: ${output.slice(-2000)}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).authenticated, false);
  for (const target of ['http://%', 'http://[', 'http://localhost:invalid']) {
    for (const upgrade of [false, true]) {
      assert.match(await rawRequest(target, upgrade), /^HTTP\/1\.1 400 Bad Request/, `malformed ${upgrade ? 'upgrade' : 'HTTP'} target must be rejected`);
      assert.equal(child.exitCode, null, output.slice(-2000));
      const alive = await request('/api/auth/session'); assert.equal(alive.status, 200); assert.equal((await alive.json()).authenticated, false);
    }
  }
  assert.equal((await request('/api/runtime')).status, 401);
  assert.equal((await request('/api/events')).status, 401);
  assert.equal((await request('/api/ui-bg')).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-console-password-123' }) })).status, 403);
  response = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-console-password-123' }) });
  assert.equal(response.status, 200, output.slice(-2000));
  const cookie = response.headers.get('set-cookie'); assert.match(cookie, /^qqa_session=/);
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  response = await request('/api/runtime', { headers: { cookie } });
  assert.equal(response.status, 200); const runtime = await response.json();
  assert.equal(runtime.mode, 'server'); assert.equal(runtime.preset, 'server-2c2g'); assert.equal(runtime.extensions.bundled, false);
  assert.equal(runtime.store.backend, 'sqlite');
  assert.equal(runtime.incoming.maxEventBytes, 4 * 1024 * 1024);
  assert.equal(runtime.incoming.maxBytes, 64 * 1024 * 1024);
  assert.equal((await request('/api/runtime/incoming/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await request('/api/runtime/incoming/retry', { method: 'POST', headers: { cookie, origin: 'https://evil.invalid', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await request('/api/runtime/incoming/retry', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"limit":101}' })).status, 400);
  response = await request('/api/runtime/incoming/retry', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"limit":10}' });
  assert.equal(response.status, 200); assert.equal((await response.json()).retried, 0);
  assert.equal((await request('/api/config', { headers: { cookie, origin: 'https://evil.invalid' } })).status, 403);
  const dataEntries = await fs.readdir(dataDir);
  response = await request('/api/reset-data', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 409); assert.match((await response.json()).error, /停止 QQA 核心服务.*备份/);
  assert.deepEqual(await fs.readdir(dataDir), dataEntries, 'online reset must preserve all live state');
  assert.equal((await request('/api/runtime', { headers: { cookie } })).status, 200);
  assert.equal((await request('/api/auth/password', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 409);
  await assert.rejects(fs.access(path.join(dataDir, 'console-auth.json')));
  const sse = await request('/api/events', { headers: { cookie } }); assert.equal(sse.status, 200);
  const reader = sse.body.getReader(); assert.match(Buffer.from((await reader.read()).value).toString(), /event: hello/); await reader.cancel();
  response = await request('/api/sessions?limit=999999'); assert.equal(response.status, 401);
  response = await request('/api/sessions?limit=999999&offset=0', { headers: { cookie } }); assert.equal((await response.json()).limit, 500);
  response = await request('/', { headers: { cookie } }); assert.equal(response.status, 200); assert.match(await response.text(), /QQ Agent|QQA/);
  response = await request('/api/auth/logout', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' }); assert.equal(response.status, 200);
  assert.equal((await request('/api/runtime', { headers: { cookie } })).status, 401);
  console.log('server auth/runtime smoke passed');
} finally {
  const ended = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  let deadline;
  await Promise.race([ended, new Promise(resolve => { deadline = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 15000); })]);
  clearTimeout(deadline);
  await ended;
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
