// Exercise the actual server -> incoming queue -> SQLite -> orchestrator -> LLM
// -> sender pipeline. Every protocol/model endpoint is a local fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { EventInbox, EVENT_INBOX_FILE } from '../src/event-inbox.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOT_TOKEN = 'app-fixture-onebot';
const MODEL_TOKEN = 'app-fixture-model';
const PASSWORD = 'app-fixture-console-password';
const EVENT = {
  time: Math.floor(Date.now() / 1000), post_type: 'message', message_type: 'group',
  sub_type: 'normal', self_id: 10001, message_id: -42, group_id: 30003, user_id: 20002,
  raw_message: 'app integration marker',
  message: [{ type: 'text', data: { text: 'app integration marker' } }],
  sender: { user_id: 20002, nickname: 'Fixture user', card: 'Fixture user', role: 'member' }
};

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
  });
}
function closeServer(server) {
  server.closeIdleConnections?.();
  return new Promise(resolve => server.close(resolve));
}
async function until(check, message, timeout = 10000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

test('real external-mode app deduplicates durable ingress, reconnects and replays only unarchived events', { timeout: 35000 }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-app-fixture-'));
  const botCalls = [], modelCalls = [], fixtureErrors = [];
  let child, childOutput = '', socket, connections = 0;
  const botServer = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${BOT_TOKEN}`);
      let raw = ''; for await (const chunk of req) raw += chunk;
      const action = String(req.url).slice(1), params = raw ? JSON.parse(raw) : {};
      botCalls.push({ action, params });
      const data = action === 'get_login_info' ? { user_id: 10001, nickname: 'Fixture bot' }
        : action === 'get_group_info' ? { group_id: 30003, group_name: 'Fixture group' }
        : action === 'get_group_member_info' ? { user_id: params.user_id, nickname: 'Fixture user', shut_up_timestamp: 0 }
        : action === 'get_group_member_list' ? [{ user_id: 20002, nickname: 'Fixture user' }]
        : action === 'get_group_list' ? [{ group_id: 30003, group_name: 'Fixture group' }]
        : action === 'send_group_msg' ? { message_id: -1000 - botCalls.length } : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    } catch (error) { fixtureErrors.push(error); res.writeHead(500); res.end('{}'); }
  });
  const modelServer = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/chat/completions');
      assert.equal(req.headers.authorization, `Bearer ${MODEL_TOKEN}`);
      let raw = ''; for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw); modelCalls.push(request);
      assert.match(JSON.stringify(request.messages), /app integration marker/);
      const replay = JSON.stringify(request.messages).includes('app integration replay marker');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: request.model, choices: [{ index: 0, finish_reason: 'tool_calls',
        message: { role: 'assistant', content: null, tool_calls: [
          { id: 'fixture_send', type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ messages: replay ? 'app integration replay reply' : 'app integration reply', replyToMessageId: replay ? -43 : -42 }) } },
          { id: 'fixture_finish', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ summary: 'Fixture reply delivered' }) } }
        ] }
      }], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } }));
    } catch (error) { fixtureErrors.push(error); res.writeHead(500); res.end('{}'); }
  });
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (connected, req) => {
    try {
      assert.equal(new URL(req.url, 'ws://127.0.0.1').searchParams.get('access_token'), BOT_TOKEN);
      assert.equal(req.headers.authorization, `Bearer ${BOT_TOKEN}`);
      socket = connected; connections++;
    } catch (error) { fixtureErrors.push(error); connected.close(); }
  });
  async function stopApp() {
    if (!child) return;
    const proc = child; child = null;
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const ended = new Promise(resolve => proc.once('exit', resolve));
    proc.kill('SIGTERM');
    const timer = setTimeout(() => proc.kill('SIGKILL'), 7000);
    await ended; clearTimeout(timer);
  }
  t.after(async () => {
    await stopApp();
    for (const connected of wss.clients) connected.terminate();
    await new Promise(resolve => wss.close(resolve));
    await Promise.all([closeServer(botServer), closeServer(modelServer)]);
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const [botPort, modelPort] = await Promise.all([listen(botServer), listen(modelServer)]);
  if (!wss.address()) await new Promise(resolve => wss.once('listening', resolve));
  // Reserve an ephemeral port instead of a fixed test port to allow parallel suites.
  const reservation = http.createServer();
  const appPort = await listen(reservation); await closeServer(reservation);
  await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    api: { baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: MODEL_TOKEN, model: 'fixture-model', timeoutMs: 5000 },
    allow: { groups: ['30003'], private: [] }, allowAllWhenEmpty: false,
    wakeDelayMs: 25, drainDelayMs: 25, maxConcurrentRuns: 1, sessionRetryAttempts: 0,
    store: { backend: 'sqlite', contextTier: 4, contextSliderPos: 100 },
    send: { minGapMs: 1, maxGapMs: 1, byLengthMs: 0, maxPerMinute: 1000, maxPerHour: 1000, dedupeWindowMs: 0 },
    snowluma: { mode: 'external', autoLaunch: false },
    background: { telemetry: false, usageWarm: false, priceFeed: false, mongoAutoStart: false, cacheWarm: false, communitySync: false },
    sticker: { collectEnabled: false }, memory: { consolidateEnabled: false }
  }));
  const appUrl = `http://127.0.0.1:${appPort}`;
  async function request(url, options = {}) { return fetch(appUrl + url, { signal: AbortSignal.timeout(4000), ...options }); }
  async function startApp() {
    childOutput = '';
    child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: {
      ...process.env, QQ_AGENT_MODE: 'server', QQ_AGENT_PRESET: 'server-2c2g', QQ_AGENT_DATA_DIR: dataDir,
      QQ_AGENT_PORT: String(appPort), QQ_AGENT_BIND_HOST: '127.0.0.1', QQ_AGENT_PUBLIC_HOST: `127.0.0.1:${appPort}`,
      QQ_AGENT_CONSOLE_PASSWORD: PASSWORD, QQ_AGENT_PROTOCOL_MODE: 'external',
      QQ_AGENT_ONEBOT_WS_URL: `ws://127.0.0.1:${wss.address().port}`, QQ_AGENT_ONEBOT_HTTP_URL: `http://127.0.0.1:${botPort}`,
      QQ_AGENT_ONEBOT_TOKEN: BOT_TOKEN, QQ_AGENT_ONEBOT_HTTP_TOKEN: BOT_TOKEN
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { childOutput = (childOutput + chunk).slice(-20000); });
    child.stderr.on('data', chunk => { childOutput = (childOutput + chunk).slice(-20000); });
    await until(async () => (await request('/api/auth/session')).ok, 'fixture app did not listen');
    const login = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(login.status, 200, childOutput);
    return login.headers.get('set-cookie').split(';')[0];
  }
  let cookie = await startApp();
  await until(() => socket?.readyState === 1 && botCalls.some(call => call.action === 'get_login_info'), 'OneBot app did not become ready');
  socket.send(JSON.stringify(EVENT));
  const sent = await until(() => botCalls.find(call => call.action === 'send_group_msg'), `orchestrator did not send a response; ${childOutput}`);
  assert.equal(sent.params.group_id, 30003);
  assert.deepEqual(sent.params.message[0], { type: 'reply', data: { id: '-42' } });
  assert.equal(sent.params.message.at(-1).data.text, 'app integration reply');
  assert.equal(modelCalls.length, 1, childOutput);
  assert.equal(modelCalls[0].model, 'fixture-model');
  assert.ok(modelCalls[0].tools.some(tool => tool.function.name === 'send_message'));
  assert.ok(modelCalls[0].tools.some(tool => tool.function.name === 'finish'));
  const session = await until(async () => {
    const response = await request('/api/sessions', { headers: { cookie } });
    return (await response.json()).sessions.find(item => item.chatKey === 'group:30003' && item.status === 'done');
  }, `session did not complete; ${childOutput}`);
  const detail = await (await request(`/api/sessions/${session.id}`, { headers: { cookie } })).json();
  assert.equal(detail.finishReason, 'Fixture reply delivered');
  assert.equal(detail.sent[0].text, 'app integration reply');
  async function persistedMessages() {
    const response = await request('/api/chats/group_30003/messages?limit=50', { headers: { cookie } });
    assert.equal(response.status, 200, childOutput);
    return (await response.json()).messages;
  }
  async function runtime() {
    const response = await request('/api/runtime', { headers: { cookie } });
    assert.equal(response.status, 200, childOutput);
    return response.json();
  }
  function archivedIncoming() {
    const db = new DatabaseSync(path.join(dataDir, 'messages.sqlite'), { readOnly: true });
    try {
      return db.prepare('SELECT payload,is_read FROM messages WHERE chat_key=? AND is_self=0 ORDER BY seq').all('group:30003')
        .map(row => ({ ...JSON.parse(row.payload), read: !!row.is_read }));
    } finally { db.close(); }
  }
  let messages = await persistedMessages();
  assert.ok(messages.some(message => String(message.mid) === '-42' && message.text === EVENT.raw_message), JSON.stringify(messages));
  assert.ok(messages.some(message => message.self && message.text === 'app integration reply'));
  assert.equal(messages.length, 2, 'first exchange should contain one incoming message and one response');
  const storedEvent = archivedIncoming()[0];
  assert.match(storedEvent.sourceEventKey, /^inbox:[\da-f-]+:\d+$/, 'real ingress must persist its durable event identity');
  assert.equal(storedEvent.read, true, 'completed trigger must remain read on replay');
  const initialInbox = await until(async () => {
    const current = (await runtime()).incoming;
    return current.completed >= 1 && current.count === 0 && current.running === 0 && current;
  }, 'initial durable event did not acknowledge');
  // OneBot reconnection can deliver an already handled message as a new inbox
  // row. Protocol message identity must prevent another model call and send.
  socket.send(JSON.stringify(EVENT));
  await until(async () => {
    const current = (await runtime()).incoming;
    return current.completed === initialInbox.completed + 1 && current.count === 0 && current.running === 0;
  }, 'duplicate event did not acknowledge');
  await delay(200); // beyond the configured wake/drain windows
  assert.equal(modelCalls.length, 1, 'duplicate -42 event must not invoke the model');
  assert.equal(botCalls.filter(call => call.action === 'send_group_msg').length, 1, 'duplicate -42 event must not send another response');
  assert.equal((await persistedMessages()).length, 2, 'duplicate -42 event must not create another archive row');
  const firstConnectionCount = connections;
  socket.close();
  await until(() => connections > firstConnectionCount, 'app did not reconnect OneBot', 7000);
  await stopApp();
  cookie = await startApp();
  messages = await persistedMessages();
  assert.ok(messages.some(message => String(message.mid) === '-42' && message.text === EVENT.raw_message), JSON.stringify(messages));
  assert.ok(messages.some(message => message.self && message.text === 'app integration reply'));
  assert.equal(modelCalls.length, 1, 'restoring archived history must not invoke the model');
  await stopApp();
  // Simulate the exact durability boundary: an already read archive entry has
  // a processing inbox row that was never acknowledged, while a later event is
  // still pending and has not reached the message store. Omitting message_id on
  // the processing fixture additionally proves sourceEventKey itself dedupes.
  const replayEvent = { ...EVENT, message_id: -43, raw_message: 'app integration replay marker',
    message: [{ type: 'text', data: { text: 'app integration replay marker' } }] };
  const seed = new EventInbox({ dataDir });
  try {
    const processing = JSON.stringify({ ...EVENT, message_id: null });
    const storedInboxId = Number(storedEvent.sourceEventKey.split(':').at(-1));
    seed.db.prepare("INSERT INTO inbox(id,event,bytes,created_at,status) VALUES(?,?,?,?,'processing')")
      .run(storedInboxId, processing, Buffer.byteLength(processing), Date.now());
    assert.equal(seed.push(replayEvent), true);
    assert.equal(seed.stats().processing, 1);
    assert.equal(seed.stats().pending, 1);
  } finally { await seed.close(); }
  assert.equal(archivedIncoming().length, 1, 'pending fixture must not be preinserted into the message archive');
  cookie = await startApp();
  const replayedInbox = await until(async () => {
    const current = (await runtime()).incoming;
    return current.recovered === 1 && current.count === 0 && current.running === 0 && current;
  }, 'processing/pending events did not replay and acknowledge');
  assert.equal(replayedInbox.completed, initialInbox.completed + 3);
  assert.equal(replayedInbox.failures, 0);
  const replaySent = await until(() => botCalls.filter(call => call.action === 'send_group_msg')[1], 'unarchived replay did not get a response');
  assert.deepEqual(replaySent.params.message[0], { type: 'reply', data: { id: '-43' } });
  assert.equal(replaySent.params.message.at(-1).data.text, 'app integration replay reply');
  await until(async () => {
    const current = await persistedMessages();
    return current.length === 4 && current.some(message => message.self && message.text === 'app integration replay reply');
  }, 'replayed message and response were not archived');
  await delay(200);
  assert.equal(modelCalls.length, 2, 'only the previously unarchived event may call the model on replay');
  assert.equal(botCalls.filter(call => call.action === 'send_group_msg').length, 2, 'read processing replay must not send twice');
  const archived = archivedIncoming();
  assert.equal(archived.length, 2);
  assert.equal(archived.filter(message => message.text === EVENT.raw_message).length, 1);
  assert.equal(archived.find(message => String(message.mid) === '-42').sourceEventKey, storedEvent.sourceEventKey);
  assert.match(archived.find(message => String(message.mid) === '-43').sourceEventKey, /^inbox:[\da-f-]+:\d+$/);
  assert.ok(archived.every(message => message.read));
  assert.equal((await fs.stat(path.join(dataDir, EVENT_INBOX_FILE))).isFile(), true);
  assert.equal((await fs.stat(path.join(dataDir, 'messages.sqlite'))).isFile(), true);
  assert.deepEqual(fixtureErrors, []);
});
