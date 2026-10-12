#!/usr/bin/env node
// Isolated real createApp -> durable inbox -> SQLite -> orchestrator -> model
// -> OneBot benchmark. All protocol/model servers bind to loopback fixtures.
// Not part of npm test. Default: 5 events/s for 10s, then 20 events/s for 60s.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { DatabaseSync } from 'node:sqlite';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), '..');
let interruptedSignal;

export function measureCpu(previous, current, clockTicks, minimumWindowMs = 100) {
  if (!previous) return { cpuPercent: null, cpuWindowMs: null, baseline: current };
  const cpuWindowMs = current.now - previous.now;
  // Linux accounts CPU in whole HZ ticks. Phase-boundary/manual samples can
  // arrive only milliseconds apart and turn one tick into a false CPU spike.
  // Retain the valid baseline so the next sample includes this short interval.
  if (cpuWindowMs < minimumWindowMs) return { cpuPercent: null, cpuWindowMs, baseline: previous };
  const ticks = current.ticks - previous.ticks;
  return { cpuPercent: ticks < 0 ? null : (ticks / clockTicks) / (cpuWindowMs / 1000) * 100, cpuWindowMs, baseline: current };
}

async function childMain() {
  let app, stopping;
  function shutdown(code = 0) {
    if (stopping) return stopping;
    const fuse = setTimeout(() => process.exit(1), 15000); fuse.unref();
    stopping = (async () => {
      try { await app?.stop(); }
      catch (error) { process.stderr.write(`benchmark child stop failed: ${error.message}\n`); code = 1; }
      clearTimeout(fuse); process.exit(code);
    })();
    return stopping;
  }
  process.on('message', message => { if (message?.type === 'stop') shutdown(); });
  process.on('disconnect', () => shutdown(1));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown());
  for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, error => {
    process.stderr.write(`benchmark child ${event}: ${error?.stack || error}\n`); shutdown(1);
  });
  try {
    const { createApp } = await import('../src/app.js');
    app = createApp(); await app.start();
    process.send?.({ type: 'ready' });
  } catch (error) { process.stderr.write(`benchmark child startup failed: ${error.stack}\n`); await shutdown(1); }
}

function options(args) {
  const out = { normalSeconds: 10, burstSeconds: 60, sampleMs: 1000, drainSeconds: 20, modelDelayMs: 10, maxSamples: 10000, output: null };
  const keys = { '--normal-seconds': 'normalSeconds', '--burst-seconds': 'burstSeconds', '--sample-ms': 'sampleMs',
    '--drain-seconds': 'drainSeconds', '--model-delay-ms': 'modelDelayMs', '--max-samples': 'maxSamples', '--output': 'output' };
  if (args.includes('--help')) {
    process.stdout.write('Usage: node scripts/server-benchmark.mjs [--normal-seconds 10] [--burst-seconds 60] [--sample-ms 1000] [--drain-seconds 20] [--model-delay-ms 10] [--max-samples 10000] [--output /absolute/report.json]\nAll app data is temporary; QQ, SnowLuma and paid models are not contacted. Defaults run about 70 seconds plus startup/drain. Long runs are explicit; this script never schedules a later run.\n');
    return null;
  }
  for (let i = 0; i < args.length; i += 2) {
    const key = keys[args[i]]; if (!key || !args[i + 1]) throw new Error(`Unknown/incomplete argument: ${args[i]}`);
    out[key] = key === 'output' ? path.resolve(args[i + 1]) : Number(args[i + 1]);
  }
  for (const [key, min, max] of [['normalSeconds', 0, 86400], ['burstSeconds', 0, 86400], ['sampleMs', 100, 60000],
    ['drainSeconds', 1, 300], ['modelDelayMs', 0, 1000], ['maxSamples', 10, 100000]]) {
    if (!Number.isSafeInteger(out[key]) || out[key] < min || out[key] > max) throw new Error(`${key} must be an integer in ${min}..${max}`);
  }
  if (!out.normalSeconds && !out.burstSeconds) throw new Error('At least one load phase must be nonzero');
  return out;
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
  });
}
async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
}
async function until(check, timeoutMs, message) {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    if (interruptedSignal) throw new Error(`Benchmark interrupted by ${interruptedSignal}`);
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}
async function body(req) {
  let value = ''; for await (const chunk of req) { value += chunk; if (value.length > 2 * 1024 * 1024) throw new Error('Fixture request exceeds 2 MiB'); }
  return value ? JSON.parse(value) : {};
}
function json(res, value) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
function latencyStats() {
  const bounds = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, Infinity], counts = bounds.map(() => 0);
  let count = 0, sum = 0, max = 0;
  return { add(ms) { count++; sum += ms; max = Math.max(max, ms); counts[bounds.findIndex(bound => ms <= bound)]++; },
    report() {
      function percentile(fraction) { let accumulated = 0; for (let i = 0; i < counts.length; i++) { accumulated += counts[i]; if (accumulated >= Math.ceil(count * fraction)) return Number.isFinite(bounds[i]) ? bounds[i] : '>5000'; } return null; }
      return { count, averageMs: count ? sum / count : null, maxMs: max, p95UpperBoundMs: count ? percentile(0.95) : null,
        p99UpperBoundMs: count ? percentile(0.99) : null, histogram: bounds.map((bound, i) => ({ upperBoundMs: Number.isFinite(bound) ? bound : '>5000', count: counts[i] })) };
    } };
}
function archiveStats(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'messages.sqlite'), { readOnly: true });
  try {
    const totals = db.prepare(`SELECT COUNT(*) AS incoming, COUNT(DISTINCT chat_key || ':' || mid_key) AS distinctProtocolKeys,
      SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END) AS unread,
      SUM(CASE WHEN json_extract(payload,'$.sourceEventKey') IS NULL THEN 1 ELSE 0 END) AS missingSourceKeys
      FROM messages WHERE is_self=0`).get();
    return { ...totals, groups: db.prepare('SELECT chat_key,COUNT(*) AS incoming FROM messages WHERE is_self=0 GROUP BY chat_key ORDER BY chat_key').all(),
      duplicateRows: db.prepare('SELECT COUNT(*) AS count FROM (SELECT chat_key,mid_key FROM messages WHERE is_self=0 GROUP BY chat_key,mid_key HAVING COUNT(*)>1)').get().count };
  } finally { db.close(); }
}
function persistedInbox(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'event-inbox.sqlite'), { readOnly: true });
  try {
    const totals = db.prepare('SELECT count,bytes,accepted,completed,failures,rejected FROM inbox_totals WHERE id=1').get();
    const status = Object.fromEntries(db.prepare('SELECT status,COUNT(*) AS count FROM inbox GROUP BY status').all().map(row => [row.status, row.count]));
    return { ...totals, pending: status.pending || 0, processing: status.processing || 0, deadletter: status.deadletter || 0 };
  } finally { db.close(); }
}
async function main(opt) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-real-benchmark-'));
  const groups = ['30001', '30002', '30003', '30004', '30005'];
  const botToken = crypto.randomBytes(24).toString('hex'), modelToken = crypto.randomBytes(24).toString('hex'), password = crypto.randomBytes(24).toString('hex');
  const errors = [], samples = [], phases = [], representatives = new Map(), repliesPerGroup = new Map();
  const runtimeLatency = latencyStats(), consoleLatency = latencyStats();
  const peaks = { rss: 0, pss: null, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0, eventLoopP99Ms: 0, eventLoopMaxMs: 0,
    incomingCount: 0, incomingBytes: 0, incomingRunning: 0, cpuPercent: null, swapBytes: null };
  let botServer, modelServer, wss, child, socket, childOutput = '', cookie, appUrl, sampling = false, sampler,
    uniqueEvents = 0, duplicateEvents = 0, modelCalls = 0, modelActive = 0, replies = 0, botCalls = 0, loginInfoCalls = 0, sampleCount = 0, droppedSamples = 0,
    lastCpu, phaseName = 'startup', forcedStop = false, exitState;
  let temporaryDataRemoved = false, sampleChain = Promise.resolve();
  const samplingAbort = new AbortController();
  const onSignal = signal => { interruptedSignal = signal; sampling = false; samplingAbort.abort(); };
  const onSigInt = () => onSignal('SIGINT'), onSigTerm = () => onSignal('SIGTERM');
  process.on('SIGINT', onSigInt); process.on('SIGTERM', onSigTerm);
  const startedAt = new Date().toISOString(), clockStarted = performance.now();
  const clockTicks = process.platform === 'linux' ? Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim()) || 100 : null;
  function recordError(error) { if (errors.length < 32) errors.push(String(error?.message || error).slice(0, 500)); }
  async function request(url, opt = {}) {
    const result = await fetch(appUrl + url, { ...opt, headers: { ...(cookie ? { cookie } : {}), ...opt.headers }, signal: AbortSignal.timeout(5000) });
    if (!result.ok) throw new Error(`${url} returned ${result.status}`);
    return result;
  }
  async function login() {
    const response = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    cookie = response.headers.get('set-cookie')?.split(';')[0]; if (!cookie) throw new Error('Console login did not set a session cookie');
  }
  async function osMetrics() {
    if (process.platform !== 'linux') return { available: false, reason: 'Linux /proc unavailable; runtime RSS remains measured' };
    try {
      const [rollup, status, stat] = await Promise.all([fs.readFile(`/proc/${child.pid}/smaps_rollup`, 'utf8'), fs.readFile(`/proc/${child.pid}/status`, 'utf8'), fs.readFile(`/proc/${child.pid}/stat`, 'utf8')]);
      const kb = (text, key) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)?.[1] || 0) * 1024;
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/), ticks = Number(fields[11]) + Number(fields[12]), now = performance.now();
      const cpu = measureCpu(lastCpu, { ticks, now }, clockTicks, Math.max(100, opt.sampleMs)); lastCpu = cpu.baseline;
      return { available: true, pid: child.pid, rss: kb(status, 'VmRSS'), pss: kb(rollup, 'Pss'), privateClean: kb(rollup, 'Private_Clean'), privateDirty: kb(rollup, 'Private_Dirty'),
        swapBytes: kb(status, 'VmSwap'), threads: Number(/^Threads:\s+(\d+)/m.exec(status)?.[1] || 0), cpuSeconds: ticks / clockTicks, cpuPercent: cpu.cpuPercent, cpuWindowMs: cpu.cpuWindowMs };
    } catch (error) { return { available: false, reason: error.code || error.message }; }
  }
  async function sampleWork() {
    const runtimeStart = performance.now();
    const runtime = await (await request('/api/runtime')).json();
    const runtimeMs = performance.now() - runtimeStart; runtimeLatency.add(runtimeMs);
    const consoleStart = performance.now(), sessions = await (await request('/api/sessions?limit=20')).json();
    const consoleMs = performance.now() - consoleStart; consoleLatency.add(consoleMs);
    const measured = await osMetrics();
    const item = { elapsedSeconds: (performance.now() - clockStarted) / 1000, phase: phaseName, runtimeMs, consoleMs, memory: runtime.memory,
      eventLoop: runtime.eventLoop, incoming: runtime.incoming, store: runtime.store, sessionCount: sessions.count, os: measured };
    for (const key of ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']) peaks[key] = Math.max(peaks[key], runtime.memory?.[key] || 0);
    if (measured.available) {
      peaks.pss = Math.max(peaks.pss || 0, measured.pss); peaks.swapBytes = Math.max(peaks.swapBytes || 0, measured.swapBytes);
      if (measured.cpuPercent !== null) peaks.cpuPercent = Math.max(peaks.cpuPercent || 0, measured.cpuPercent);
    }
    peaks.eventLoopP99Ms = Math.max(peaks.eventLoopP99Ms, runtime.eventLoop.p99Ms); peaks.eventLoopMaxMs = Math.max(peaks.eventLoopMaxMs, runtime.eventLoop.maxMs);
    peaks.incomingCount = Math.max(peaks.incomingCount, runtime.incoming.count); peaks.incomingBytes = Math.max(peaks.incomingBytes, runtime.incoming.bytes); peaks.incomingRunning = Math.max(peaks.incomingRunning, runtime.incoming.running);
    sampleCount++; samples.push(item); if (samples.length > opt.maxSamples) { samples.shift(); droppedSamples++; }
    return runtime;
  }
  function sample() {
    // Phase boundaries and the periodic sampler share one measurement stream,
    // so /proc CPU deltas and response timings never use overlapping samples.
    const result = sampleChain.then(sampleWork); sampleChain = result.catch(() => {}); return result;
  }
  async function lockProbe() {
    const helper = pathToFileURL(path.join(ROOT, 'src/process-lock.js')).href, file = path.join(dataDir, 'qq-agent.lock');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {acquireProcessLock} from ${JSON.stringify(helper)};const result=acquireProcessLock(${JSON.stringify(file)});console.log(JSON.stringify({ok:result.ok,existingPid:result.existingPid}));result.release?.();`], { encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) throw new Error(`Lock probe failed: ${result.stderr}`);
    return JSON.parse(result.stdout.trim());
  }
  async function stopChild() {
    if (!child || exitState) return;
    const ended = new Promise(resolve => child.once('exit', (code, signal) => { exitState = { code, signal }; resolve(); }));
    const force = setTimeout(() => { forcedStop = true; child.kill('SIGKILL'); }, 20000); force.unref();
    if (child.connected) child.send({ type: 'stop' }); else child.kill('SIGTERM');
    await ended; clearTimeout(force);
  }
  async function drain() {
    let stableSince = null;
    await until(async () => {
      const runtime = await (await request('/api/runtime')).json();
      const archived = archiveStats(dataDir);
      if (runtime.incoming.count || runtime.incoming.running || archived.unread || modelActive) { stableSince = null; return false; }
      stableSince ??= performance.now(); return performance.now() - stableSince >= 500;
    }, opt.drainSeconds * 1000, 'App did not drain durable ingress and unread messages');
  }
  async function phase(name, rate, seconds) {
    if (!seconds) return;
    phaseName = name; const before = await sample(), phaseStart = performance.now(), count = seconds * rate;
    process.stderr.write(`benchmark: ${name}, ${rate} events/s for ${seconds}s\n`);
    for (let i = 0; i < count; i++) {
      if (interruptedSignal) throw new Error(`Benchmark interrupted by ${interruptedSignal}`);
      const due = phaseStart + i * 1000 / rate, wait = due - performance.now(); if (wait > 0) await delay(wait);
      if (socket?.readyState !== 1) throw new Error('Mock OneBot disconnected during pressure phase');
      const seq = ++uniqueEvents, groupId = groups[(seq - 1) % groups.length], text = `benchmark message ${seq} group ${groupId}`;
      const event = { time: Math.floor(Date.now() / 1000), post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: 10001,
        message_id: -seq, group_id: Number(groupId), user_id: 20002, raw_message: text, message: [{ type: 'text', data: { text } }],
        sender: { user_id: 20002, nickname: 'Benchmark user', card: 'Benchmark user', role: 'member' } };
      if (!representatives.has(groupId)) representatives.set(groupId, event);
      socket.send(JSON.stringify(event));
    }
    const remaining = phaseStart + seconds * 1000 - performance.now(); if (remaining > 0) await delay(remaining);
    const after = await sample();
    phases.push({ name, rate, targetSeconds: seconds, actualSeconds: (performance.now() - phaseStart) / 1000, emitted: count,
      acceptedDuringPhase: after.incoming.accepted - before.incoming.accepted, completedDuringPhase: after.incoming.completed - before.incoming.completed,
      pendingAtEnd: after.incoming.pending, deadletterAtEnd: after.incoming.deadletter });
  }
  let report;
  try {
    botServer = http.createServer(async (req, res) => {
      try {
        if (req.headers.authorization !== `Bearer ${botToken}`) throw new Error('Mock OneBot token mismatch');
        const params = await body(req), action = String(req.url).slice(1); botCalls++;
        if (action === 'get_login_info') loginInfoCalls++;
        if (action === 'send_group_msg') { replies++; const group = String(params.group_id); repliesPerGroup.set(group, (repliesPerGroup.get(group) || 0) + 1); }
        const data = action === 'get_login_info' ? { user_id: 10001, nickname: 'Benchmark bot' }
          : action === 'get_group_info' ? { group_id: params.group_id, group_name: `Benchmark group ${params.group_id}` }
          : action === 'get_group_member_info' ? { user_id: params.user_id, nickname: 'Benchmark user', shut_up_timestamp: 0 }
          : action === 'get_group_member_list' ? [{ user_id: 20002, nickname: 'Benchmark user' }]
          : action === 'get_group_list' ? groups.map(group_id => ({ group_id: Number(group_id), group_name: `Benchmark group ${group_id}` }))
          : action === 'send_group_msg' ? { message_id: -100000000 - replies } : {};
        json(res, { status: 'ok', retcode: 0, data });
      } catch (error) { recordError(error); res.writeHead(500); res.end('{}'); }
    });
    modelServer = http.createServer(async (req, res) => {
      modelActive++;
      try {
        if (req.url !== '/chat/completions' || req.headers.authorization !== `Bearer ${modelToken}`) throw new Error('Mock model endpoint/token mismatch');
        const input = await body(req), id = ++modelCalls;
        if (!JSON.stringify(input.messages).includes('benchmark message') || !input.tools?.some(tool => tool.function.name === 'send_message')) throw new Error('Real orchestrator messages/tools not observed by mock model');
        if (opt.modelDelayMs) await delay(opt.modelDelayMs);
        json(res, { model: input.model, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
          { id: `benchmark_send_${id}`, type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ messages: `benchmark simulated reply ${id}` }) } },
          { id: `benchmark_finish_${id}`, type: 'function', function: { name: 'finish', arguments: JSON.stringify({ summary: 'Benchmark simulated reply delivered' }) } }
        ] } }], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } });
      } catch (error) { recordError(error); res.writeHead(500); res.end('{}'); }
      finally { modelActive--; }
    });
    const [botPort, modelPort] = await Promise.all([listen(botServer), listen(modelServer)]);
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (connected, req) => {
      if (new URL(req.url, 'ws://127.0.0.1').searchParams.get('access_token') !== botToken || req.headers.authorization !== `Bearer ${botToken}`) {
        recordError(new Error('Mock OneBot WebSocket token mismatch')); connected.terminate(); return;
      }
      socket = connected;
    });
    if (!wss.address()) await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
    const reservation = http.createServer(), appPort = await listen(reservation); await closeServer(reservation); appUrl = `http://127.0.0.1:${appPort}`;
    await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
      api: { baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: modelToken, model: 'benchmark-local-model', timeoutMs: 5000, maxRounds: 2 },
      allow: { groups, private: [] }, allowAllWhenEmpty: false, wakeDelayMs: 25, drainDelayMs: 25, maxConcurrentRuns: 1, sessionRetryAttempts: 0,
      store: { backend: 'sqlite', contextTier: 4, contextSliderPos: 100, keepSessionFiles: 128 },
      send: { minGapMs: 1, maxGapMs: 1, byLengthMs: 0, maxPerMinute: 100000, maxPerHour: 10000000, dedupeWindowMs: 0 },
      snowluma: { mode: 'external', autoLaunch: false }, extensions: { hotReload: false },
      background: { telemetry: false, usageWarm: false, priceFeed: false, mongoAutoStart: false, cacheWarm: false, communitySync: false },
      sticker: { collectEnabled: false }, memory: { consolidateEnabled: false }, proactive: { enabled: false }
    }));
    child = spawn(process.execPath, [SCRIPT, '--internal-child'], { cwd: ROOT, env: { ...process.env,
      QQ_AGENT_MODE: 'server', QQ_AGENT_PRESET: 'server-2c2g', QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_STORE_BACKEND: 'sqlite',
      QQ_AGENT_PORT: String(appPort), QQ_AGENT_BIND_HOST: '127.0.0.1', QQ_AGENT_PUBLIC_HOST: `127.0.0.1:${appPort}`, QQ_AGENT_ALLOWED_ORIGINS: '',
      QQ_AGENT_CONSOLE_PASSWORD: password, QQ_AGENT_API_KEY: modelToken, QQ_AGENT_PROTOCOL_MODE: 'external',
      QQ_AGENT_ONEBOT_WS_URL: `ws://127.0.0.1:${wss.address().port}`, QQ_AGENT_ONEBOT_HTTP_URL: `http://127.0.0.1:${botPort}`,
      QQ_AGENT_ONEBOT_TOKEN: botToken, QQ_AGENT_ONEBOT_HTTP_TOKEN: botToken
    }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const childPid = child.pid;
    child.on('error', error => { recordError(error); exitState = { code: null, signal: null, error: error.message }; });
    child.on('exit', (code, signal) => { exitState = { code, signal }; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { childOutput = (childOutput + chunk).slice(-8192); });
    await until(async () => { if (exitState) throw new Error(`Child exited ${JSON.stringify(exitState)}: ${childOutput}`); return (await request('/api/auth/session')).ok; }, 15000, 'Benchmark app did not start');
    await login(); await until(() => socket?.readyState === 1 && loginInfoCalls > 0, 10000, 'Mock OneBot did not become ready');
    const lockWhileRunning = await lockProbe(), initialRuntime = await sample();
    if (initialRuntime.mode !== 'server' || initialRuntime.store.backend !== 'sqlite' || !initialRuntime.incoming.instanceId || initialRuntime.incoming.capacity !== 512) throw new Error('Server preset/durable EventInbox/SQLite not enabled');
    let lastLogin = performance.now(); sampling = true;
    sampler = (async () => {
      while (sampling) {
        try { await delay(opt.sampleMs, undefined, { signal: samplingAbort.signal }); }
        catch (error) { if (samplingAbort.signal.aborted) break; throw error; }
        if (!sampling) break;
        try { if (performance.now() - lastLogin > 3600000) { await login(); lastLogin = performance.now(); } await sample(); }
        catch (error) { recordError(error); }
      }
    })();
    await phase('normal', 5, opt.normalSeconds); await phase('burst', 20, opt.burstSeconds);
    phaseName = 'drain'; await drain(); const beforeDuplicates = archiveStats(dataDir), modelBefore = modelCalls, repliesBefore = replies;
    for (const event of representatives.values()) { socket.send(JSON.stringify(event)); duplicateEvents++; }
    phaseName = 'deduplication'; await until(async () => (await (await request('/api/runtime')).json()).incoming.completed === uniqueEvents + duplicateEvents, opt.drainSeconds * 1000, 'Duplicate events did not acknowledge');
    await drain(); const finalRuntime = await sample(), finalArchive = archiveStats(dataDir);
    sampling = false; samplingAbort.abort(); await sampler; sampler = null;
    phaseName = 'shutdown'; const lockBeforeStop = Number((await fs.readFile(path.join(dataDir, 'qq-agent.lock'), 'utf8')).trim());
    const stopStart = performance.now(); await stopChild(); const shutdownMs = performance.now() - stopStart;
    const lockRemoved = await fs.stat(path.join(dataDir, 'qq-agent.lock')).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
    const lockAfterStop = await lockProbe(), diskInbox = persistedInbox(dataDir), diskArchive = archiveStats(dataDir);
    const validations = { realServerAndDurableInbox: true, sqliteChatStore: true, allEmittedEventsPersisted: diskInbox.accepted === uniqueEvents + duplicateEvents,
      allPersistedEventsCompleted: diskInbox.completed === diskInbox.accepted && diskInbox.count === 0,
      noRejectedOrDeadletterEvents: diskInbox.rejected === 0 && diskInbox.deadletter === 0 && diskInbox.failures === 0,
      uniqueIncomingArchive: diskArchive.incoming === uniqueEvents && diskArchive.distinctProtocolKeys === uniqueEvents && diskArchive.duplicateRows === 0,
      sourceKeysPersisted: diskArchive.missingSourceKeys === 0, allFiveGroupsArchivedAndReplied: diskArchive.groups.length === 5 && repliesPerGroup.size === 5,
      duplicatesDoNotAppend: beforeDuplicates.incoming === finalArchive.incoming, duplicatesDoNotCallModel: modelCalls === modelBefore,
      duplicatesDoNotSend: replies === repliesBefore, noUnreadAfterDrain: diskArchive.unread === 0,
      runningLockRejectsContender: !lockWhileRunning.ok && lockWhileRunning.existingPid === childPid && lockBeforeStop === childPid,
      gracefulShutdown: !forcedStop && exitState?.code === 0, lockRemovedAfterStop: lockRemoved, nextInstanceCanAcquireLock: lockAfterStop.ok,
      consoleSamplingSucceeded: errors.length === 0 && sampleCount > 0 };
    report = { format: 1, type: 'isolated-real-server-benchmark', startedAt, finishedAt: new Date().toISOString(), elapsedSeconds: (performance.now() - clockStarted) / 1000,
      environment: { node: process.version, platform: process.platform, arch: process.arch, cpuCount: os.cpus().length, totalMemory: os.totalmem(),
        freeMemory: os.freemem(), hostLoadAverage: os.loadavg(), corePid: childPid, fixtureProcesses: 'parent harness + one real createApp child' },
      configuration: opt, phases, emitted: { unique: uniqueEvents, duplicate: duplicateEvents }, model: { simulated: true, calls: modelCalls, delayMs: opt.modelDelayMs },
      protocol: { simulated: true, calls: botCalls, replies, repliesPerGroup: Object.fromEntries(repliesPerGroup) },
      incoming: diskInbox, archive: diskArchive, finalRuntime, peaks, latency: { runtime: runtimeLatency.report(), consoleSessions: consoleLatency.report() },
      shutdown: { milliseconds: shutdownMs, forced: forcedStop, exit: exitState, lockWhileRunning, lockAfterStop }, validations,
      passed: Object.values(validations).every(Boolean), sampling: { count: sampleCount, retained: samples.length, dropped: droppedSamples }, samples, errors,
      limitations: ['QQ, SnowLuma, Xvfb and paid model providers are simulated or absent; their resource use and real delivery are not measured.',
        'Node heap/external metrics describe the main isolate; core RSS and Linux PSS include its Workers. Linux CPU percent may exceed 100 on multiple cores.',
        'CPU windows shorter than max(100 ms, sampleMs) are null and preserve the preceding valid baseline to avoid Linux HZ quantization spikes.',
        'Console latency is measured with authenticated loopback HTTP. Event-loop p99/max are cumulative runtime counters. Histogram percentile values are upper bounds.',
        'Incoming event completion means parsing/archive/scheduling completed; model replies are checked separately after draining. Short runs do not establish 24-hour stability.'] };
  } catch (error) {
    recordError(error); report = { format: 1, type: 'isolated-real-server-benchmark', passed: false, startedAt, finishedAt: new Date().toISOString(),
      configuration: opt, emitted: { unique: uniqueEvents, duplicate: duplicateEvents }, phases, peaks, samples, errors, childOutput };
  } finally {
    sampling = false; samplingAbort.abort(); await sampler?.catch(recordError); await stopChild().catch(recordError);
    if (wss) { for (const connected of wss.clients) connected.terminate(); await new Promise(resolve => wss.close(resolve)).catch(recordError); }
    await Promise.all([closeServer(botServer), closeServer(modelServer)]).catch(recordError);
    try { await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); temporaryDataRemoved = true; } catch (error) { recordError(error); }
    process.off('SIGINT', onSigInt); process.off('SIGTERM', onSigTerm);
  }
  report.temporaryDataRemoved = temporaryDataRemoved;
  report.passed = report.passed && errors.length === 0 && temporaryDataRemoved;
  if (opt.output) {
    await fs.mkdir(path.dirname(opt.output), { recursive: true }); await fs.writeFile(opt.output, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ passed: report.passed, report: opt.output, emitted: report.emitted, incoming: report.incoming, validations: report.validations, errors: report.errors }, null, 2) + '\n');
  } else process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  if (process.argv[2] === '--internal-child' && process.send) await childMain();
  else {
    try { const parsed = options(process.argv.slice(2)); if (parsed) await main(parsed); }
    catch (error) { process.stderr.write(`benchmark failed: ${error.stack}\n`); process.exitCode = 1; }
  }
}
