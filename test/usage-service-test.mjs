import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { performance } from 'node:perf_hooks';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-usage-'));
process.env.QQ_AGENT_DATA_DIR = root; process.env.QQ_AGENT_MODE = 'server';
const { UsageService } = await import('../src/usage-service.js');
const { openUsageIndex, queryUsage, refreshUsageIndex } = await import('../src/usage-index.js');
const { updateConfig } = await import('../src/config.js');
const { setRemotePrices, modelLabel, isPeakHour } = await import('../src/model-prices.js');
const services = [];
function fixtureDir(name) { const dir = path.join(root, name); fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true }); return dir; }
function service(dir, options) { const s = new UsageService({ dataDir: dir, ...options }); services.push(s); return s; }
function save(dir, id, value) { fs.writeFileSync(path.join(dir, 'sessions', `${id}.json`), JSON.stringify(value)); }
function session(id, started, extra = {}) {
  return { id, chatKey: extra.chatKey || 'group:1', vendor: extra.vendor || '测试渠道', model: extra.model || 'm', startedAt: started, webSearchCount: 2,
    usage: { promptTokens: 3, completionTokens: 4, cachedTokens: 1 }, messages: [{ content: extra.content || '', raw: { created: Math.floor(started / 1000), model: extra.model || 'm',
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } } }, toolCall: { name: 'search' } }] };
}
function approx(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`); }
test.after(async () => { await Promise.all(services.map((s) => s.close())); fs.rmSync(root, { recursive: true, force: true }); });

test('persistent usage incrementally indexes exact and fallback rows, metadata after messages and repricing', async () => {
  updateConfig({ api: { useOfficialPrice: false, modelPrices: {}, priceInputPerM: 2, priceOutputPerM: 3, priceCachedPerM: 0.5 } });
  const dir = fixtureDir('incremental'), at = Date.now() - 3600_000;
  const a = session('a', at); save(dir, 'a', { messages: a.messages, ...Object.fromEntries(Object.entries(a).filter(([key]) => key !== 'messages')) });
  save(dir, 'b', { id: 'b', chatKey: 'group:2', vendor: 'V', model: 'm', startedAt: at, usage: { promptTokens: 20, completionTokens: 2, cachedTokens: 4 }, messages: [] });
  const s = service(dir), stats = await s.query('stats', { range: 'all' });
  assert.equal(stats.totals.runs, 2); assert.equal(stats.totals.promptTokens, 30); assert.equal(stats.totals.exactCalls, 1); assert.equal(stats.searchCount, 2); assert.equal(stats.toolCounts.search, 1);
  approx(stats.totals.cost, (24 * 2 + 6 * 0.5 + 7 * 3) / 1e6); assert.equal(stats.index.changed, 2);
  const stable = await s.query('stats', { range: 'all' }); assert.equal(stable.index.changed, 0);
  const changed = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'b.json'), 'utf8')); changed.usage.promptTokens = 200; save(dir, 'b', changed);
  const updated = await s.query('stats', { range: 'all' }); assert.equal(updated.index.changed, 1); assert.equal(updated.totals.promptTokens, 210);
  updateConfig({ api: { priceInputPerM: 4, priceOutputPerM: 6, priceCachedPerM: 1 } });
  const repriced = await s.query('stats', { range: 'all' }); approx(repriced.totals.cost, updated.totals.cost * 2); assert.equal(repriced.index.changed, 0);
  const breakdown = await s.query('breakdown', { range: 'all', dim: 'chat', key: 'group:1', by: 'model' });
  assert.equal(breakdown.totals.promptTokens, 10); assert.equal(breakdown.rows[0].key, modelLabel('测试渠道', 'm')); approx(breakdown.rows[0].cost, breakdown.totals.cost);
  await s.close(); fs.unlinkSync(path.join(dir, 'sessions', 'b.json'));
  const reopened = service(dir); const remaining = await reopened.query('stats', { range: 'all' }); assert.equal(remaining.totals.runs, 1); assert.equal(remaining.index.changed, 0); await reopened.close();
});

test('per-call timestamps cross midnight, session counters use start time, historical vendors and current remote/custom prices survive', async () => {
  const dir = fixtureDir('ranges'); const now = new Date('2026-10-12T08:00:00Z').getTime();
  const started = now - 20 * 3600_000, peak = new Date('2026-10-12T02:00:00Z').getTime();
  save(dir, 'a', { id: 'a', startedAt: started, chatKey: 'group:9', vendor: '旧渠道', model: 'deepseek-flash', webSearchCount: 9,
    messages: [{ raw: { created: started / 1000, model: 'deepseek-flash', usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 50 } } }, toolCall: { name: 'oldTool' } },
      { raw: { created: peak / 1000, usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 100 } } }, toolCall: { name: 'todayTool' } }] });
  const index = openUsageIndex(path.join(dir, 'direct.sqlite')); await refreshUsageIndex(index, path.join(dir, 'sessions'));
  try {
    const pricing = { config: { api: { useOfficialPrice: true } }, table: [{ id: 'deepseek-flash', in: 1, out: 4, cached: 0.02, peak: { in: 2, out: 8, cached: 0.04 } }] };
    const today = await queryUsage(index, 'stats', { range: 'today' }, pricing, now);
    assert.equal(today.totals.runs, 1); assert.equal(today.searchCount, 0); assert.deepEqual(Object.keys(today.toolCounts), []); assert.equal(today.totals.cachedTokens, 10); assert.equal(today.models[0].vendor, '旧渠道');
    approx(today.totals.cost, (10 * 0.04 + 5 * 8) / 1e6); assert.equal(today.totals.hasPeakModel, true); assert.equal(isPeakHour(peak), true);
    const all = await queryUsage(index, 'stats', { range: 'all' }, pricing, now); assert.equal(all.totals.runs, 2); assert.equal(all.searchCount, 9); assert.equal(all.toolCounts.todayTool, 1);
    const channelPrice = { config: { api: { useOfficialPrice: true, modelPrices: { [modelLabel('旧渠道', 'deepseek-flash')]: { in: 7, out: 11, cached: 2 } } } }, table: pricing.table };
    const custom = await queryUsage(index, 'stats', { range: 'today' }, channelPrice, now); approx(custom.totals.cost, (10 * 2 + 5 * 11) / 1e6);
  } finally { index.close(); }
  updateConfig({ api: { useOfficialPrice: true, modelPrices: {} } });
  setRemotePrices({ m: { in: 5, out: 9, cached: 1 } }); save(dir, 'remote', session('remote', Date.now() - 1000));
  const s = service(dir); const stats = await s.query('breakdown', { range: 'all', dim: 'model', key: modelLabel('测试渠道', 'm'), by: 'chat' });
  approx(stats.totals.cost, (8 * 5 + 2 * 1 + 5 * 9) / 1e6); await s.close(); setRemotePrices({});
});

test('damaged sources retain complete previous data and expose incomplete diagnostics', async () => {
  const dir = fixtureDir('damaged'); save(dir, 'a', session('a', Date.now() - 1000)); const s = service(dir);
  const initial = await s.query('stats', { range: 'all' }); fs.writeFileSync(path.join(dir, 'sessions', 'a.json'), '{"messages":[{"raw":');
  const damaged = await s.query('stats', { range: 'all' }); assert.equal(damaged.totals.totalTokens, initial.totals.totalTokens); assert.equal(damaged.index.failed, 1); assert.equal(damaged.index.incomplete, true); assert.equal(damaged.index.warnings.length, 1); await s.close();
});

test('worker timeout rejects the bounded job and can restart with the persistent index intact', async () => {
  const dir = fixtureDir('timeout'), large = session('large', Date.now() - 1000, { content: 'x'.repeat(14 * 1024 * 1024) });
  large.messages = Array.from({ length: 4 }, () => large.messages[0]); save(dir, 'large', large);
  const s = service(dir, { timeoutMs: 1000 }); const pending = s.query('stats', { range: 'all' });
  await assert.rejects(pending, /超过 1 秒/);
  fs.unlinkSync(path.join(dir, 'sessions', 'large.json')); save(dir, 'small', session('small', Date.now() - 1000));
  const recovered = await s.query('stats', { range: 'all' }); assert.equal(recovered.totals.runs, 1); assert.equal(recovered.index.failed, 0); await s.close();
});

test('5000 sessions index without blocking HTTP and return every chat under the worker heap limit', async () => {
  updateConfig({ api: { useOfficialPrice: false, modelPrices: {}, priceInputPerM: 2, priceOutputPerM: 3, priceCachedPerM: 0.5 } });
  const dir = fixtureDir('large'), at = Date.now() - 3600_000;
  for (let i = 0; i < 5000; i++) save(dir, `s${i}`, session(`s${i}`, at + i, { chatKey: `group:${i}`, content: '文'.repeat(1400) }));
  const server = http.createServer((_req, res) => res.end('ok')); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}/`, s = service(dir); let done = false; const durations = [];
  try {
    const job = s.query('stats', { range: 'all' }).finally(() => { done = true; });
    while (!done) { const start = performance.now(); const response = await fetch(address); assert.equal(await response.text(), 'ok'); durations.push(performance.now() - start); await new Promise((resolve) => setTimeout(resolve, 10)); }
    const result = await job; assert.equal(result.chats.length, 5000); assert.equal(result.totals.runs, 5000); assert.equal(result.totals.promptTokens, 50000); assert.equal(result.searchCount, 10000);
    assert.equal(result.index.failed, 0); assert.ok(result.workerHeapBytes < 128 * 1024 * 1024); approx(result.chats.reduce((n, r) => n + r.cost, 0), result.totals.cost);
    assert.ok(durations.length >= 3, 'HTTP must serve several requests during first index'); assert.ok(Math.max(...durations) < 1000, `HTTP request stalled ${Math.max(...durations)} ms`);
    const pending = Array.from({ length: 8 }, () => s.query('stats', { range: 'all' })); await assert.rejects(s.query('stats', { range: 'all' }), /队列已满/); await Promise.all(pending);
    console.log(JSON.stringify({ sessions: 5000, workerHeapMiB: +(result.workerHeapBytes / 1024 / 1024).toFixed(1), httpMaxMs: +Math.max(...durations).toFixed(1), httpRequests: durations.length }));
  } finally { await s.close(); await new Promise((resolve) => server.close(resolve)); }
});

test('oversized grouping returns an explicit error without silently cutting the result', async () => {
  const dir = fixtureDir('oversize'), index = openUsageIndex(path.join(dir, 'direct.sqlite'));
  try {
    index.db.exec('BEGIN'); index.db.prepare('INSERT INTO sources(filename,mtime,bytes) VALUES(?,?,?)').run('x', 1, 1);
    const put = index.statements.insertCall;
    for (let i = 0; i < 20001; i++) put.run('x', i, Date.now() - 1000, 1, 1, 0, 'm', 'V', `group:${i}`, 1);
    index.db.exec('COMMIT'); await assert.rejects(queryUsage(index, 'stats', { range: 'all' }), /未截断任何统计行/);
  } finally { index.close(); }
});
