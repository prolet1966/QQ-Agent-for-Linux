import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-resource-test-'));
process.env.QQ_AGENT_DATA_DIR = directory;
process.env.QQ_AGENT_MODE = 'server';
const { getConfig, updateConfig } = await import('../src/config.js');
const { BoundedWorkQueue } = await import('../src/bounded-work.js');
const { SendQueue } = await import('../src/sender.js');
const { MemoryStore } = await import('../src/memory.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { logger } = await import('../src/logger.js');
const { safeFetchBinary, safeFetchBinaryToFile } = await import('../src/safe-fetch.js');
const { runMediaProcess } = await import('../src/media-process.js');
const { mediaWork } = await import('../src/media-resources.js');
const { VideoReader } = await import('../src/video-reader.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { OneBotClient } = await import('../src/onebot.js');
logger.mirrorConsole = false;
function configure(patch) { updateConfig(patch); }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!fn()) { if (Date.now() > deadline) throw new Error('condition timed out'); await delay(10); }
}
test.after(() => { fs.rmSync(directory, { recursive: true, force: true }); });

test('bounded FIFO rejects excess jobs and releases failed jobs without increasing concurrency', async () => {
  const queue = new BoundedWorkQueue({ concurrency: 1, capacity: 2 });
  let release;
  const first = queue.run(() => new Promise((resolve) => { release = resolve; }));
  const second = queue.run(() => { throw new Error('expected failure'); });
  const secondCheck = assert.rejects(second, /expected failure/);
  await assert.rejects(queue.run(() => assert.fail('rejected work ran')), /队列已满/);
  await until(() => release);
  assert.deepEqual(queue.status(), { active: 1, pending: 1 });
  release('done');
  assert.equal(await first, 'done');
  await secondCheck;
  await until(() => queue.active === 0);
  assert.equal(await queue.run(() => 7), 7);
});

test('sender bounds pending messages, preserves order, reports overflow and removes idle chains', async () => {
  configure({ resources: { ...getConfig().resources, sendQueuePerChat: 2 }, send: { ...getConfig().send, dedupeWindowMs: 0 } });
  let release;
  const calls = [];
  const sender = new SendQueue({ store: { appendSelf() {} }, onebot: {
    async sendText(_kind, _id, text) { calls.push(text); if (text === 'first') await new Promise((resolve) => { release = resolve; }); return { message_id: calls.length }; }
  } });
  const first = sender.sendTextBatch('group:123', ['first']);
  const second = sender.sendTextBatch('group:123', ['second']);
  await assert.rejects(sender.sendTextBatch('group:123', ['overflow']), /发送队列已满/);
  await until(() => release);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(sender.chains.size, 0);
});

test('member memory evicts cold chat caches while preserving persisted impressions', () => {
  configure({ resources: { ...getConfig().resources, memoryCacheChats: 2 } });
  const memory = new MemoryStore();
  for (let i = 1; i <= 3; i++) memory.replaceMember(`group:${i}`, '10001', '测试成员', [`印象 ${i}`]);
  assert.equal(memory.cache.size, 2);
  assert.equal(memory.cache.has('group:1'), false);
  assert.equal(memory.getMember('group:1', '10001').impressions[0].content, '印象 1');
  assert.equal(memory.cache.size, 2);
  const legacy = path.join(directory, 'memory', 'group_10.json');
  fs.writeFileSync(legacy, JSON.stringify({ memberImpression: [{ target: '10001', content: '旧版印象', createdAt: 123 }] }));
  assert.equal(memory.getMember('group:10', '10001').impressions[0].content, '旧版印象');
  assert.equal(fs.existsSync(path.join(directory, 'memory', 'backups', 'group_10.json')), true);
});

test('session histories stay on disk while summaries page from SQLite and index worker recovers stale runs', async () => {
  const files = path.join(directory, 'sessions'); fs.mkdirSync(files, { recursive: true });
  for (let i = 0; i < 620; i++) {
    fs.writeFileSync(path.join(files, `fixture-${i}.json`), JSON.stringify({ id: `fixture-${i}`, chatKey: 'group:123', startedAt: 1700000000000 + i,
      status: i === 0 ? 'running' : 'done', messages: [{ role: 'tool', toolCall: { name: 'example' } }], usage: { calls: 0, totalTokens: 0 } }));
  }
  const sessions = new SessionRegistry();
  assert.equal(sessions.index.length, 0, 'startup must not parse full transcripts');
  await sessions.reconcileInBackground();
  assert.equal(sessions.summaryCount(), 620);
  assert.ok(sessions.index.length <= 256);
  assert.equal(sessions.listSummaries(1000000).length, 500);
  assert.equal(sessions.listSummaries(3, 500)[0].id, 'fixture-119');
  assert.equal(sessions.listSummaries(3)[0].toolCalls, 1);
  assert.equal(sessions.get('fixture-0').status, 'aborted');
  assert.equal(fs.readdirSync(files).length, 620, 'cache limits must not remove history');
  await sessions.close();
  const reopened = new SessionRegistry();
  assert.equal(reopened.summaryCount(), 620);
  assert.equal(reopened.clearFinished(), 620);
  assert.equal(reopened.summaryCount(), 0);
  await reopened.close();
});

test('large historical detail requests stream pages off the main thread and download the original archive', async () => {
  const { createRoutes } = await import('../src/routes.js');
  const id = 'large-detail-fixture', file = path.join(directory, 'sessions', `${id}.json`);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, JSON.stringify({ id, chatKey: 'group:1', status: 'error', startedAt: Date.now(), userPrompt: 'original prompt' }).slice(0, -1) + ',"messages":[');
  for (let i = 0; i < 350; i++) fs.writeSync(fd, (i ? ',' : '') + JSON.stringify({ role: 'assistant', sequence: i, content: '中'.repeat(12000) }));
  fs.writeSync(fd, ']}'); fs.closeSync(fd);
  const originalBytes = fs.statSync(file).size; assert.ok(originalBytes > 8 * 1024 * 1024);
  const sessions = new SessionRegistry();
  const routes = createRoutes({ sessions }); let heartbeats = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (out, status, value) => { out.writeHead(status, { 'content-type': 'application/json' }); out.end(JSON.stringify(value)); };
    const route = routes.find(item => item.method === 'GET' && item.pattern instanceof RegExp && item.pattern.test(url.pathname));
    try { if (!route) return json(res, 404, {}); await route.handler({ req, res, json, url, match: route.pattern.exec(url.pathname) }); }
    catch (error) { json(res, error.status || 500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function(input, ...args) { if (String(input) === file) assert.fail('main thread read the complete historical session'); return readFileSync.call(this, input, ...args); };
  const timer = setInterval(() => { heartbeats++; }, 10);
  try {
    for (const method of ['get', 'peek']) assert.throws(() => sessions[method](id), error => error.status === 413 && error.expose && /下载完整会话档案.*新会话/.test(error.message));
    let restored = 0;
    const orchestrator = new Orchestrator({ sessions, onebot: { connected: true }, sender: {}, memory: {},
      store: { markUnreadInWindow() { restored++; return 1; } } });
    const refusal = orchestrator.retrySession(id); assert.equal(refusal.ok, false); assert.match(refusal.reason, /下载完整会话档案.*新会话/);
    assert.equal(restored, 0); assert.equal(sessions.current.has(id), false); await orchestrator.abortAll();
    const response = await fetch(`${base}/api/sessions/${id}`); assert.equal(response.status, 200);
    const text = await response.text(); assert.ok(Buffer.byteLength(text) < 1024 * 1024);
    const page = JSON.parse(text); assert.equal(page.detailPage.total, 350); assert.equal(page.messages[0].sequence, 0);
    assert.equal(page.detailPage.truncated, true); assert.equal(page.detailPage.hasMore, true); assert.ok(page.messages.length <= 100);
    assert.ok(heartbeats > 5, 'HTTP event loop must continue running during archive scanning');
    const next = await (await fetch(`${base}/api/sessions/${id}?offset=${page.detailPage.nextOffset}&limit=1000000`)).json();
    assert.equal(next.messages[0].sequence, page.detailPage.nextOffset); assert.ok(next.messages.length <= 100);
    const last = await (await fetch(`${base}/api/sessions/${id}?offset=349`)).json();
    assert.equal(last.messages[0].sequence, 349); assert.equal(last.detailPage.hasMore, false);
    const burst = await Promise.allSettled(Array.from({ length: 5 }, () => sessions.getDetail(id)));
    assert.equal(burst.filter(result => result.status === 'fulfilled').length, 4);
    assert.equal(burst.filter(result => result.status === 'rejected' && result.reason.status === 429).length, 1);
    const downloaded = await fetch(`${base}/api/sessions/${id}/download`); assert.equal(downloaded.status, 200);
    let bytes = 0; for await (const chunk of downloaded.body) bytes += chunk.length;
    assert.equal(bytes, originalBytes); assert.equal(fs.statSync(file).size, originalBytes);
  } finally { clearInterval(timer); fs.readFileSync = readFileSync; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await sessions.close(); fs.rmSync(file); }
});

test('a small failed historical session still supports full get/peek and an in-place retry', async () => {
  configure({ allow: { groups: [], private: ['1'] }, deny: { groups: [], private: [] }, allowAllWhenEmpty: false });
  const id = 'small-retry-fixture', file = path.join(directory, 'sessions', `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, chatKey: 'private:1', status: 'error', startedAt: 100, endedAt: 200,
    messages: [{ role: 'assistant', content: 'original error' }], sent: [], error: 'fixture' }));
  const sessions = new SessionRegistry(); let restored = 0; const scheduled = [];
  const orchestrator = new Orchestrator({ sessions, onebot: { connected: true }, sender: {}, memory: {},
    store: { markUnreadInWindow(key, start, end) { assert.equal(key, 'private:1'); assert.equal(start, 100); assert.equal(end, 200); restored++; return 1; } } });
  orchestrator.scheduleWake = (key, delayMs, options) => scheduled.push({ key, delayMs, options });
  try {
    assert.equal(sessions.get(id).messages[0].content, 'original error'); assert.equal(sessions.peek(id).status, 'error');
    assert.deepEqual(orchestrator.retrySession(id), { ok: true, restored: 1 }); assert.equal(restored, 1);
    assert.equal(sessions.current.get(id).status, 'running'); assert.deepEqual(scheduled, [{ key: 'private:1', delayMs: 0, options: { reuseSessionId: id } }]);
    assert.equal(sessions.get('missing-retry-fixture'), null); assert.equal(sessions.peek('missing-retry-fixture'), null);
  } finally { await orchestrator.abortAll(); await sessions.close(); fs.rmSync(file); }
});

test('an oversized historical JSON field gives a recoverable 413 without parsing on the main thread', async () => {
  const id = 'oversized-detail-field', file = path.join(directory, 'sessions', `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, messages: [{ role: 'assistant', content: 'x'.repeat(5 * 1024 * 1024) }] }));
  const sessions = new SessionRegistry();
  try { await assert.rejects(sessions.getDetail(id), error => error.status === 413 && /下载完整档案/.test(error.message)); assert.ok(fs.statSync(file).size > 5 * 1024 * 1024); }
  finally { await sessions.close(); fs.rmSync(file); }
});

test('active session detail bounds messages and escaped data without modifying its live object', async () => {
  const sessions = new SessionRegistry();
  try {
    const session = sessions.create({ chatKey: 'group:1', trigger: [], triggerSummary: 'bounded active' });
    session.messages = Array.from({ length: 300 }, (_v, i) => ({ role: 'assistant', sequence: i, content: '\u0000'.repeat(70000) }));
    session.userPrompt = '中'.repeat(200000); session.sent = [{ text: 'confirmed' }];
    const page = await sessions.getDetail(session.id); assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
    assert.equal(page.detailPage.total, 300); assert.ok(page.messages.length <= 100); assert.equal(page.detailPage.truncated, true);
    const next = await sessions.getDetail(session.id, { offset: page.detailPage.nextOffset }); assert.equal(next.messages[0].sequence, page.detailPage.nextOffset);
    assert.equal(session.messages.length, 300); assert.equal(session.messages[0].content.length, 70000); assert.equal(session.userPrompt.length, 200000);
  } finally { await sessions.close(); }
});

test('media downloads reject oversized content, delete partial files and enforce total duration', async () => {
  configure({ security: { ...getConfig().security, allowPrivateImageHosts: true } });
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      const timer = setInterval(() => res.write('x'), 20);
      res.on('close', () => clearInterval(timer));
    } else res.end(Buffer.alloc(128));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(safeFetchBinary(`${url}/large`, 64), /大小上限/);
    const output = path.join(directory, 'partial.mp4');
    await assert.rejects(safeFetchBinaryToFile(`${url}/large`, output, 64), /大小上限/);
    assert.equal(fs.existsSync(output), false);
    const start = Date.now();
    await assert.rejects(safeFetchBinaryToFile(`${url}/slow`, output, 10000, { timeoutMs: 200 }), /超限|aborted/);
    assert.ok(Date.now() - start < 1500);
    assert.equal(fs.existsSync(output), false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('media process timeout and stdout cap terminate the child before releasing its slot', async () => {
  const result = await runMediaProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 150);
  assert.equal(result, null);
  const large = await runMediaProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(70000));setInterval(() => {},1000)'], 1500);
  assert.equal(large, null);
  await until(() => mediaWork.active === 0);
  const small = await runMediaProcess(process.execPath, ['-e', 'process.stdout.write("ok")'], 1500);
  assert.equal(small.stdout, 'ok');
});

test('server media preset avoids subprocesses and protocol downloads while retaining remote video URLs', async () => {
  configure({ resources: { ...getConfig().resources, localMedia: false }, api: { ...getConfig().api, videoMode: 'native' } });
  const reader = new VideoReader({ call() { assert.fail('local media fetch must be disabled'); } });
  const result = await reader.probe({ file: 'ignored', url: 'https://example.invalid/video.mp4' });
  assert.equal(result.route, 'native');
  assert.equal(result.nativeUrl, 'https://example.invalid/video.mp4');
});

test('orchestrator reserves before asynchronous mute checks and coalesces a bounded pending queue', async () => {
  configure({ allowAllWhenEmpty: true, maxConcurrentRuns: 1, maxPendingChats: 2, api: { ...getConfig().api, model: 'test' }, memory: { ...getConfig().memory, consolidateEnabled: false } });
  const unread = new Map(['group:1', 'group:2', 'group:3', 'group:4'].map((key) => [key, 1]));
  let active = 0, peak = 0, release;
  const orchestrator = new Orchestrator({
    store: { listChats: () => [...unread.keys()], unreadCount: (key) => unread.get(key) || 0, markAllRead: (key) => { unread.set(key, 0); return 1; } },
    sessions: { current: new Map() }, sender: {}, memory: {},
    onebot: { selfId: '10001', connected: true, async call() {
      active++; peak = Math.max(peak, active);
      if (!release) await new Promise((resolve) => { release = resolve; }); else await delay(20);
      active--; return { shut_up_timestamp: Math.floor(Date.now() / 1000) + 60 };
    } }
  });
  const first = orchestrator.wake('group:1');
  await orchestrator.wake('group:2');
  await orchestrator.wake('group:3');
  assert.equal(orchestrator.statusSummary().pendingChats, 2);
  assert.deepEqual(await orchestrator.wake('group:4'), { deferred: true });
  assert.equal(unread.get('group:4'), 1, 'overflow must preserve unread data');
  await until(() => release);
  release();
  await first;
  await until(() => [...unread.values()].every((count) => count === 0));
  assert.equal(peak, 1);
  await orchestrator.abortAll();
});

test('sender close cancels queued sends and waits for a confirmed send to finish recording', async () => {
  configure({ resources: { ...getConfig().resources, sendQueuePerChat: 4 }, send: { ...getConfig().send, dedupeWindowMs: 0 } });
  let release, recorded = 0; const calls = [];
  const sender = new SendQueue({ store: { appendSelf() { recorded++; } }, onebot: {
    async sendText(_kind, _id, text) { calls.push(text); await new Promise(resolve => { release = resolve; }); return { message_id: 1 }; }
  } });
  const first = sender.sendTextBatch('group:1', ['first']);
  const second = sender.sendTextBatch('group:1', ['second']); const secondCheck = assert.rejects(second, /发送队列已关闭/);
  await until(() => release);
  let stopped = false; const closing = sender.close().then(() => { stopped = true; });
  await delay(20); assert.equal(stopped, false); assert.equal(recorded, 0);
  await assert.rejects(sender.sendTextBatch('group:1', ['third']), /发送队列已关闭/);
  release(); await Promise.all([first, secondCheck, closing]);
  assert.deepEqual(calls, ['first']); assert.equal(recorded, 1); assert.equal(sender.queuedBytes, 0); assert.equal(sender.chains.size, 0);
});

test('OneBot close aborts requests before headers and during body reads, and prevents later calls', async () => {
  let phase = 'headers', received = 0;
  const server = http.createServer((_req, res) => { received++; if (phase === 'body') { res.setHeader('content-type', 'application/json'); res.write('{"status":"ok","data":'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (phase of ['headers', 'body']) {
      const client = new OneBotClient({ httpUrl: `http://127.0.0.1:${server.address().port}` }); const before = received;
      const pending = client.call('get_login_info'); const denied = assert.rejects(pending, /客户端已关闭/);
      await until(() => received > before); await delay(20); await client.close(); await denied;
      await assert.rejects(client.call('send_group_msg'), /未发送请求/); assert.equal(received, before + 1);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('OneBot bounds declared and chunked HTTP payloads and recovers for a later normal request', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/declared') { res.setHeader('content-length', 2048); res.end('x'.repeat(2048)); }
    else if (req.url === '/chunked') { res.write('x'.repeat(800)); res.end('x'.repeat(800)); }
    else res.end('{"status":"ok","data":{"ready":true}}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new OneBotClient({ httpUrl: `http://127.0.0.1:${server.address().port}`, maxPayload: 1024 });
  try {
    await assert.rejects(client.call('declared'), /响应超过 1024 字节上限/);
    await assert.rejects(client.call('chunked'), /响应超过 1024 字节上限/);
    assert.deepEqual(await client.call('normal'), { ready: true });
  } finally { await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('an unread archive failure does not block recovery of other permitted chats', async () => {
  configure({ allow: { groups: ['1', '2'] }, deny: { groups: [] }, allowAllWhenEmpty: false });
  const scheduled = [];
  const orchestrator = new Orchestrator({ onebot: { connected: true }, sessions: { current: new Map() }, memory: {}, sender: {}, store: {
    listChats: () => ['group:1', 'group:2'], unreadCount: key => { if (key === 'group:1') throw new Error('offline migrate required'); return 1; }
  } });
  orchestrator.scheduleWake = key => scheduled.push(key);
  assert.doesNotThrow(() => orchestrator.drainBacklogAfterResume());
  assert.deepEqual(scheduled, ['group:2']); await orchestrator.abortAll();
});

test('server backlog preserves unread while disconnected and rechecks current allow and deny rules', async () => {
  configure({ allow: { groups: ['1', '2'], private: [] }, deny: { groups: ['2'], private: [] }, allowAllWhenEmpty: false,
    wakeDelayMs: 0, maxConcurrentRuns: 1, api: { ...getConfig().api, model: 'test' } });
  const unread = new Map(['group:1', 'group:2', 'group:3'].map(key => [key, 1])); const calls = [];
  const bot = { connected: false, selfId: '10001', async call(_action, params) { calls.push(params.group_id); return { shut_up_timestamp: Math.floor(Date.now() / 1000) + 60 }; } };
  const orchestrator = new Orchestrator({ onebot: bot, sessions: { current: new Map() }, memory: {}, sender: {}, store: {
    listChats: () => [...unread.keys()], unreadCount: key => unread.get(key), markAllRead(key) { unread.set(key, 0); return 1; }
  } });
  orchestrator.drainBacklogAfterResume(); orchestrator.scheduleWake('group:1'); await orchestrator.wake('group:1');
  assert.deepEqual(calls, []); assert.equal(unread.get('group:1'), 1); assert.equal(orchestrator.pendingWake.size, 0);
  bot.connected = true; orchestrator.drainBacklogAfterResume();
  await until(() => unread.get('group:1') === 0); assert.deepEqual(calls, [1]);
  assert.equal(unread.get('group:2'), 1); assert.equal(unread.get('group:3'), 1);
  unread.set('group:1', 1); configure({ allow: { groups: ['3'] } });
  await orchestrator.wake('group:1'); assert.equal(unread.get('group:1'), 1); assert.deepEqual(calls, [1]);
  await orchestrator.abortAll();
});

test('abortAll waits for an active readiness check to settle before releasing its run', async () => {
  configure({ allow: { groups: ['1'] }, deny: { groups: [] }, api: { ...getConfig().api, model: 'test' } });
  let release; let marks = 0;
  const orchestrator = new Orchestrator({ onebot: { connected: true, selfId: '10001', call: () => new Promise(resolve => { release = resolve; }) },
    store: { markAllRead() { marks++; } }, sessions: { current: new Map() }, memory: {}, sender: {} });
  const pending = orchestrator.wake('group:1'); await until(() => release);
  let done = false; const stopping = orchestrator.abortAll().then(() => { done = true; }); await delay(20); assert.equal(done, false);
  release({ shut_up_timestamp: Math.floor(Date.now() / 1000) + 60 }); await Promise.all([pending, stopping]);
  assert.equal(marks, 0); assert.equal(orchestrator.reservedChats.size, 0); assert.equal(orchestrator.inflight.size, 0);
});

test('reconnecting resumes the pending run queue without requiring another incoming event', async () => {
  configure({ allow: { groups: ['1', '2'] }, deny: { groups: [] }, maxConcurrentRuns: 1, maxPendingChats: 4,
    api: { ...getConfig().api, model: 'test' } });
  let release; const unread = new Map([['group:1', 1], ['group:2', 1]]);
  const bot = { connected: true, selfId: '10001', async call(_action, params) {
    if (params.group_id === 1) await new Promise(resolve => { release = resolve; });
    return { shut_up_timestamp: Math.floor(Date.now() / 1000) + 60 };
  } };
  const orchestrator = new Orchestrator({ onebot: bot, sessions: { current: new Map() }, memory: {}, sender: {}, store: {
    listChats: () => [...unread.keys()], unreadCount: key => unread.get(key), markAllRead(key) { unread.set(key, 0); return 1; }
  } });
  const first = orchestrator.wake('group:1'); await until(() => release); await orchestrator.wake('group:2');
  assert.equal(orchestrator.pendingRuns.size, 1); bot.connected = false; release(); await first;
  assert.equal(orchestrator.pendingRuns.size, 1); assert.equal(unread.get('group:1'), 1); assert.equal(unread.get('group:2'), 1);
  bot.connected = true; orchestrator.drainBacklogAfterResume();
  await until(() => [...unread.values()].every(count => count === 0)); assert.equal(orchestrator.pendingRuns.size, 0);
  await orchestrator.abortAll();
});

test('stopping an in-flight reminder waits for its completion and never rearms the timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release; let fired = 0;
  const orchestrator = new Orchestrator({ onebot: {}, sessions: { current: new Map() }, memory: {}, store: {},
    reminders: { due: () => [{ id: 'reminder', chatKey: 'group:1', text: 'remember' }], markFired() { fired++; }, prune() {} },
    sender: { sendTextBatch: () => new Promise(resolve => { release = resolve; }) } });
  orchestrator.startReminderLoop(); t.mock.timers.tick(5000); assert.equal(typeof release, 'function');
  let done = false; const stopping = orchestrator.abortAll().then(() => { done = true; }); await Promise.resolve(); assert.equal(done, false);
  release({ sent: [{}] }); await stopping; assert.equal(fired, 1); assert.equal(orchestrator.reminderTimer, null);
  t.mock.timers.tick(100000); assert.equal(fired, 1); t.mock.timers.reset();
});

test('logger caps UTF-8 entries, memory and total retained files without serializing huge arrays', () => {
  for (let i = 0; i < 600; i++) logger.info('test', '中'.repeat(20000), { huge: Array.from({ length: 10000 }, (_, n) => n) });
  assert.ok(logger.memoryBytes <= 1024 * 1024);
  assert.ok(logger.recent(500).every((row) => Buffer.byteLength(row.text) <= 16 * 1024));
  const logs = path.join(directory, 'logs');
  for (let i = 0; i < 10; i++) {
    const file = path.join(logs, `qq-agent-fixture-${i}.log`);
    const fd = fs.openSync(file, 'w'); fs.ftruncateSync(fd, 8 * 1024 * 1024); fs.closeSync(fd);
  }
  logger.prune();
  const bytes = fs.readdirSync(logs).reduce((total, file) => total + fs.statSync(path.join(logs, file)).size, 0);
  assert.ok(bytes <= 64 * 1024 * 1024);
});

test('app stop holds SQLite and its instance lock until sends and reserved runs settle', async () => {
  configure({ allow: { groups: ['1'] }, deny: { groups: [] }, resources: { ...getConfig().resources, sendQueuePerChat: 4 },
    snowluma: { mode: 'external', autoLaunch: false }, send: { ...getConfig().send, dedupeWindowMs: 0 },
    background: { telemetry: false, usageWarm: false, priceFeed: false, mongoAutoStart: false, cacheWarm: false, communitySync: false } });
  const { createApp } = await import('../src/app.js');
  const app = createApp({ log() {} }); let releaseSend, releaseCheck; const calls = [];
  try {
    app.onebot.sendText = async (_kind, _id, text) => { calls.push(text); await new Promise(resolve => { releaseSend = resolve; }); return { message_id: 1 }; };
    app.onebot.connected = true; app.onebot.selfInfo = { user_id: 10001 };
    app.onebot.call = () => new Promise(resolve => { releaseCheck = resolve; });
    const first = app.sender.sendTextBatch('group:1', ['first']); const second = app.sender.sendTextBatch('group:1', ['second']);
    const secondCheck = assert.rejects(second, /发送队列已关闭/);
    const wake = app.orchestrator.wake('group:1'); await until(() => releaseSend && releaseCheck);
    let stopped = false; const stop = app.stop().then(() => { stopped = true; });
    await delay(25); assert.equal(stopped, false); assert.equal(fs.existsSync(path.join(directory, 'qq-agent.lock')), true);
    assert.doesNotThrow(() => app.store.recent('group:1', { limit: 1 }), 'SQLite must remain open while a send is unresolved');
    releaseCheck({ shut_up_timestamp: 0 }); await wake; await delay(10); assert.equal(stopped, false);
    releaseSend(); const sent = await first; await Promise.all([secondCheck, stop]);
    assert.equal(sent.sent.length, 1); assert.deepEqual(calls, ['first']); assert.equal(fs.existsSync(path.join(directory, 'qq-agent.lock')), false);
    const restarted = createApp({ log() {} });
    try { assert.ok(restarted.store.recent('group:1', { limit: 10 }).some(message => message.self && message.text === 'first')); }
    finally { await restarted.stop(); }
  } finally { releaseSend?.(); releaseCheck?.({}); await app.stop(); }
});
