import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../ui/app/02-sse-sessions.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
function harness(api) {
  const timers = [], events = {}, rendered = [], detail = { innerHTML: '' }, scope = { self: true, id: 'self' };
  const state = { sessions: [], sessionTotal: 0, sessionLimit: 50, tab: 'sessions', currentSessionId: null, activeInst: scope, autoFollowRunning: false, preview: false, config: {} };
  const counts = { status: 0, chats: 0, snowluma: 0, logs: 0 };
  const context = vm.createContext({ state, api, console, SESSION_PAGE: 50, SESSION_KEEP: 400, pendingSessionDetail: new Map(), appReady: true,
    setInterval: () => 1, clearInterval() {}, setTimeout(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout(timer) { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
    document: { hidden: false, addEventListener() {}, getElementById: () => null }, $: () => detail, $$: () => [], esc: String,
    EventSource: class { addEventListener(name, fn) { events[name] = fn; } }, isPeerView: () => !state.activeInst.self,
    refreshStatus: async () => { counts.status++; }, loadChats: async () => { counts.chats++; }, loadSnowlumaPage: async () => { counts.snowluma++; }, refreshSnowlumaLogs: async () => { counts.logs++; },
    scheduleSessionRender() {}, setLoadingStatus() {} });
  vm.runInContext(source, context);
  context.renderSessionList = () => {};
  context.renderSessionDetail = (s) => rendered.push(s);
  vm.runInContext('globalThis.testApi={loadSessions,loadMoreSessions,loadSessionDetail,selectSession,connectSSE,scheduleSSERefresh}', context);
  return { state, context, counts, rendered, events, timers, api: context.testApi, async flush() { const jobs = timers.splice(0); await Promise.all(jobs.map((t) => t.fn())); await settle(); } };
}
function row(i) { return { id: `s${i}`, startedAt: 10000 - i, status: 'done' }; }

test('refresh preserves 700 loaded histories using pages no larger than 500 and scroll appends the next page', async () => {
  const calls = [], records = Array.from({ length: 900 }, (_v, i) => row(i));
  const h = harness(async (path) => { calls.push(path); const url = new URL(path, 'http://localhost'), limit = Number(url.searchParams.get('limit')), offset = Number(url.searchParams.get('offset')); return { sessions: records.slice(offset, offset + limit), count: records.length }; });
  h.state.sessions = records.slice(0, 700); h.state.sessionLimit = 700;
  await h.api.loadSessions(); assert.equal(h.state.sessions.length, 700); assert.equal(h.state.sessionLimit, 700); assert.equal(h.state.sessionTotal, 900);
  assert.deepEqual(calls, ['/api/sessions?limit=500&offset=0', '/api/sessions?limit=200&offset=500']);
  await h.api.loadMoreSessions(); assert.equal(h.state.sessions.length, 800); assert.equal(h.state.sessionLimit, 750); assert.equal(calls[2], '/api/sessions?limit=100&offset=700');
  await h.api.loadSessions(); assert.equal(h.state.sessions.length, 800); assert.equal(h.state.sessions[799].id, 's799');
  assert.ok(calls.every((p) => Number(new URL(p, 'http://localhost').searchParams.get('limit')) <= 500));
});

test('list/detail duplicate calls share inflight and an old instance response cannot overwrite current data', async () => {
  const local = deferred(), peer = deferred(); let calls = 0;
  const h = harness(() => ++calls === 1 ? local.promise : peer.promise);
  const first = h.api.loadSessions(), duplicate = h.api.loadSessions(); assert.equal(first, duplicate); assert.equal(calls, 1);
  h.state.activeInst = { self: false, id: 'peer' }; const current = h.api.loadSessions(); assert.equal(calls, 2);
  peer.resolve({ sessions: [row('peer')], count: 1 }); await current;
  local.resolve({ sessions: [row('local')], count: 1 }); await first; assert.equal(h.state.sessions[0].id, 'speer');
});

test('A to B to A selection ignores stale success and failures from the previous selections', async () => {
  const requests = []; const h = harness((path) => { const d = deferred(); requests.push({ path, ...d }); return d.promise; });
  const a1 = h.api.selectSession('A'); const b = h.api.selectSession('B'); const a2 = h.api.selectSession('A');
  assert.equal(requests.length, 3);
  requests[0].resolve({ id: 'A', marker: 'old' }); await a1; assert.equal(h.state.sessionDetail, null);
  requests[1].reject(new Error('old failure')); await b; assert.equal(h.context.$().innerHTML, '<div class="empty-hint">加载中…</div>');
  requests[2].resolve({ id: 'A', marker: 'new' }); await a2; assert.equal(h.state.sessionDetail.marker, 'new'); assert.equal(h.rendered.length, 1);
  const d = h.api.loadSessionDetail('A', { quiet: true }), same = h.api.loadSessionDetail('A', { quiet: true }); assert.equal(d, same);
  requests[3].resolve({ id: 'A', marker: 'current' }); await d;
});

test('detail pagination replaces its bounded window and trailing refresh retains the selected page', async () => {
  const calls = []; const h = harness(async path => {
    calls.push(path); const offset = Number(new URL(path, 'http://localhost').searchParams.get('offset')) || 0;
    return { id: 'A', messages: Array.from({ length: 100 }, (_v, i) => ({ sequence: offset + i })), detailPage: { offset, nextOffset: offset + 100, total: 300 } };
  });
  await h.api.selectSession('A'); await h.api.loadSessionDetail('A', { offset: 100 });
  assert.equal(h.state.sessionDetail.messages.length, 100); assert.equal(h.state.sessionDetail.messages[0].sequence, 100);
  await h.api.loadSessionDetail('A', { quiet: true }); assert.equal(calls[2], '/api/sessions/A?offset=100&limit=100');
  await h.api.loadSessionDetail('A', { offset: 0 }); assert.equal(h.state.sessionDetail.messages[0].sequence, 0);
});

test('a slow prior detail page cannot replace a later requested page', async () => {
  const requests = []; const h = harness(path => { const d = deferred(); requests.push({ path, ...d }); return d.promise; });
  h.state.currentSessionId = 'A';
  const first = h.api.loadSessionDetail('A', { offset: 100 }), second = h.api.loadSessionDetail('A', { offset: 200 });
  requests[1].resolve({ id: 'A', detailPage: { offset: 200 }, messages: [] }); await second;
  requests[0].resolve({ id: 'A', detailPage: { offset: 100 }, messages: [] }); await first;
  assert.equal(h.state.sessionDetail.detailPage.offset, 200);
});

test('SSE summary and log bursts combine into one API pass and defer further bursts while inflight', async () => {
  const calls = []; const h = harness(async (path) => { calls.push(path); return path.includes('?') ? { sessions: [{ id: 'A', status: 'running' }], count: 1 } : { id: 'A', status: 'running' }; });
  h.state.currentSessionId = 'A'; h.api.connectSSE();
  for (let i = 0; i < 100; i++) { h.events['session-update']({ data: JSON.stringify({ sessionId: 'A', refresh: true }) }); h.events.status(); }
  assert.equal(calls.length, 0); assert.equal(h.timers.length, 1); assert.equal(h.timers[0].ms, 300);
  await h.flush(); assert.deepEqual(calls, ['/api/sessions?limit=100&offset=0', '/api/sessions/A']); assert.equal(h.counts.status, 1);
  h.state.tab = 'snowluma';
  for (let i = 0; i < 100; i++) { h.events['qq-portable-log'](); h.events['snowluma-log']({ data: JSON.stringify({ text: 'line' }) }); }
  await h.flush(); assert.equal(h.counts.snowluma, 1); assert.equal(h.counts.logs, 0, 'page refresh already includes logs');
});

test('SSE changes during an HTTP list request preserve the live patch and trigger one later refresh', async () => {
  const first = deferred(); let calls = 0;
  const h = harness(() => ++calls === 1 ? first.promise : Promise.resolve({ sessions: [{ id: 'A', status: 'running' }], count: 1 }));
  h.api.connectSSE(); const request = h.api.loadSessions();
  h.events['session-update']({ data: JSON.stringify({ sessionId: 'A', status: 'running', startedAt: 100 }) });
  first.resolve({ sessions: [{ id: 'A', status: 'waiting' }], count: 1 }); await request;
  assert.equal(h.state.sessions[0].status, 'running'); assert.equal(h.timers.length, 1); await h.flush(); assert.equal(calls, 2); assert.equal(h.state.sessions[0].status, 'running');
});

test('events received while a refresh is active wait for one trailing pass', async () => {
  const first = deferred(); let calls = 0;
  const h = harness(() => ++calls === 1 ? first.promise : Promise.resolve({ sessions: [{ id: 'A', status: 'running' }], count: 1 }));
  h.api.connectSSE(); h.events['session-start'](); const active = h.flush(); await settle(); assert.equal(calls, 1);
  for (let i = 0; i < 100; i++) h.events['session-update']({ data: JSON.stringify({ sessionId: 'A', refresh: true }) });
  assert.equal(calls, 1); assert.equal(h.timers.length, 0);
  first.resolve({ sessions: [{ id: 'A', status: 'waiting' }], count: 1 }); await active;
  assert.equal(h.timers.length, 1); await h.flush(); assert.equal(calls, 2);
});

test('automatic follow queued before a manual selection cannot override that later selection', async () => {
  const h = harness(async (url) => url.includes('?') ? { sessions: [{ id: 'running', status: 'running' }], count: 1 } : { id: 'history', status: 'done' });
  h.state.autoFollowRunning = true; h.api.connectSSE(); h.events['session-start'](); await h.api.selectSession('history'); await h.flush();
  assert.equal(h.state.currentSessionId, 'history'); assert.equal(h.state.sessionDetail.id, 'history');
});
