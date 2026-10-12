// Headless integration fixtures: the protocol and model endpoints are entirely local.
// This exercises the same WebSocket/HTTP/LLM boundaries used by server mode without
// requiring a QQ account, SnowLuma, network access, or a billable model request.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';

const TOKEN = 'mock-onebot-token';
const LLM_TOKEN = 'mock-llm-token';
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-boundary-fixture-'));
const originalDataDir = process.env.QQ_AGENT_DATA_DIR;
process.env.QQ_AGENT_DATA_DIR = dataDir;
after(async () => {
  if (originalDataDir === undefined) delete process.env.QQ_AGENT_DATA_DIR;
  else process.env.QQ_AGENT_DATA_DIR = originalDataDir;
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
  });
}

async function mockOneBot({ sendEvents = false } = {}) {
  const calls = [];
  let connections = 0;
  let firstSocket;
  const httpServer = http.createServer(async (req, res) => {
    const auth = String(req.headers.authorization || '');
    assert.equal(auth, `Bearer ${TOKEN}`, `OneBot HTTP auth missing for ${req.url}`);
    const action = String(req.url || '').replace(/^\//, '');
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = body ? JSON.parse(body) : {};
    calls.push({ action, params });
    let data = action === 'get_login_info'
      ? { user_id: 10001, nickname: 'Mock QQ' }
      : action === 'send_group_msg'
        ? { message_id: -100 - calls.length }
        : action === 'get_group_list' ? [{ group_id: 30003, group_name: 'Mock Group' }] : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
  const httpPort = await listen(httpServer);
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.once('listening', resolve));
  wss.on('connection', (socket, req) => {
    const url = new URL(req.url, 'ws://127.0.0.1');
    assert.equal(url.searchParams.get('access_token'), TOKEN);
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    connections++;
    if (!firstSocket) firstSocket = socket;
    if (sendEvents && connections === 1) {
      setTimeout(() => socket.send(JSON.stringify({
        post_type: 'message', message_type: 'group', self_id: 10001,
        message_id: -42, group_id: 30003, user_id: 20002,
        raw_message: 'hello from fixture', message: 'hello from fixture',
        sender: { user_id: 20002, nickname: 'Tester', card: 'Tester' }
      })), 20).unref?.();
    }
  });
  const wsPort = wss.address().port;
  return {
    calls, get connections() { return connections; }, get firstSocket() { return firstSocket; },
    wsUrl: `ws://127.0.0.1:${wsPort}`, httpUrl: `http://127.0.0.1:${httpPort}`,
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => httpServer.close(resolve));
    }
  };
}

async function mockLlm() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, '/chat/completions');
    assert.equal(req.headers.authorization, `Bearer ${LLM_TOKEN}`);
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{
      index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'mock reply' }
    }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  });
  const port = await listen(server);
  return { requests, baseUrl: `http://127.0.0.1:${port}`, async close() { await new Promise((resolve) => server.close(resolve)); } };
}

test('mock OneBot + mock LLM receive, authenticate, answer, preserve negative message id, and reconnect', async (t) => {
  // Configure llm.js without writing config.json or contacting a real provider.
  const { DEFAULT_CONFIG, deepMerge, setRuntimeConfig } = await import('../src/config.js');
  const { OneBotClient } = await import('../src/onebot.js');
  const { chatCompletion } = await import('../src/llm.js');
  const bot = await mockOneBot({ sendEvents: true });
  const llm = await mockLlm();
  let client;
  t.after(async () => {
    client?.close();
    await bot.close();
    await llm.close();
  });
  const config = deepMerge(DEFAULT_CONFIG, {
    api: { baseUrl: llm.baseUrl, apiKey: LLM_TOKEN, model: 'mock-model', timeoutMs: 5000 },
    allow: { groups: ['30003'], private: [] }, allowAllWhenEmpty: false,
    snowluma: { wsUrl: bot.wsUrl, httpUrl: bot.httpUrl, accessToken: TOKEN, httpAccessToken: TOKEN }
  });
  setRuntimeConfig(config);
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock OneBot event was not received')), 4000);
    client = new OneBotClient({ wsUrl: bot.wsUrl, httpUrl: bot.httpUrl, accessToken: TOKEN, httpToken: TOKEN,
      onEvent: async (event) => {
        try {
          if (event.post_type !== 'message') return;
          const result = await chatCompletion({ messages: [{ role: 'user', content: event.raw_message }], tag: 'integration' });
          await client.sendText('group', event.group_id, result.message.content, { replyToMessageId: event.message_id });
          clearTimeout(timer); resolve(event);
        } catch (error) { clearTimeout(timer); reject(error); }
      }
    });
    client.connect();
  });
  const event = await received;
  assert.equal(event.message_id, -42);
  assert.equal(llm.requests.length, 1);
  assert.equal(llm.requests[0].messages[0].content, 'hello from fixture');
  const sent = bot.calls.find((call) => call.action === 'send_group_msg');
  assert(sent, 'mock OneBot did not receive a response');
  assert.deepEqual(sent.params.message[0], { type: 'reply', data: { id: '-42' } });
  assert.equal(sent.params.message.at(-1).data.text, 'mock reply');
  assert.equal((await client.call('get_group_list'))[0].group_id, 30003);
  assert.equal(bot.connections, 1);
  // A live socket close starts the client's bounded backoff reconnect loop.
  bot.firstSocket.close();
  for (let i = 0; i < 60 && bot.connections < 2; i++) await delay(100);
  assert.ok(bot.connections >= 2, `expected reconnect, got ${bot.connections}`);
});

test('mock OneBot event pressure remains bounded at 5 and 20 events/sec', async (t) => {
  const { OneBotClient } = await import('../src/onebot.js');
  const { TaskQueue } = await import('../src/task-queue.js');
  const bot = await mockOneBot();
  const queue = new TaskQueue({ concurrency: 1, capacity: 16, onError: (error) => { throw error; } });
  let client;
  t.after(async () => {
    client?.close();
    await queue.close();
    await bot.close();
  });
  let accepted = 0; let observed = 0; let maxPending = 0;
  client = new OneBotClient({ wsUrl: bot.wsUrl, httpUrl: bot.httpUrl, accessToken: TOKEN, httpToken: TOKEN,
    onEvent: () => {
      observed++;
      if (queue.push(async () => { await delay(100); })) accepted++;
      maxPending = Math.max(maxPending, queue.stats().pending);
    }
  });
  client.connect();
  for (let i = 0; i < 50 && !client.connected; i++) await delay(20);
  assert.equal(client.connected, true);
  async function phase(rate, durationMs) {
    const socket = bot.firstSocket;
    const interval = 1000 / rate, count = Math.floor(durationMs / interval), start = Date.now();
    for (let sent = 1; sent <= count; sent++) {
      await delay(Math.max(0, start + sent * interval - Date.now()));
      socket.send(JSON.stringify({ post_type: 'message', message_type: 'group', message_id: sent, group_id: 30003,
        user_id: 20002, raw_message: `pressure-${rate}-${sent}`, message: `pressure-${rate}-${sent}` }));
    }
    return count;
  }
  const five = await phase(5, 2000);
  for (let i = 0; i < 50 && observed < five; i++) await delay(10);
  const fiveObserved = observed;
  assert.equal(queue.rejected, 0, '5/sec fixture should fit within the worker budget');
  const twenty = await phase(20, 2000);
  for (let i = 0; i < 50 && observed < five + twenty; i++) await delay(10);
  // Check overload while the queue is still open so a delayed WS frame cannot
  // count as rejection merely because cleanup has already closed the queue.
  assert.ok(queue.rejected > 0, `20/sec pressure should exercise queue rejection (sent=${five + twenty}, observed=${observed}, accepted=${accepted}, rejected=${queue.rejected}, max=${maxPending})`);
  await queue.close();
  assert.ok(five >= 8 && five <= 12, `fixture sent ${five} at 5/sec`);
  assert.ok(fiveObserved >= 8 && fiveObserved <= five);
  assert.ok(twenty >= 30 && twenty <= 50, `fixture sent ${twenty} at 20/sec`);
  assert.ok(maxPending <= 16, `pending queue exceeded cap: ${maxPending}`);
  assert.ok(observed <= five + twenty);
});
