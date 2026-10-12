import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readJsonObjectArray } from './storage-json-stream.js';
import { UNKNOWN_VENDOR, modelLabel, splitModelLabel, resolveModelPrice, priceAt, isPeakHour } from './model-prices.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const DAY = 86_400_000;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_GROUPS = 20_000;
const MAX_IDENTITY_BYTES = 4096;

export function resolveRange(raw = '7', now = Date.now()) {
  const s = String(raw || '7').trim().toLowerCase();
  if (s === 'today') { const d = new Date(now); d.setHours(0, 0, 0, 0); return { mode: 'today', start: d.getTime(), end: now, label: '今天' }; }
  if (s === '24h') return { mode: '24h', start: now - DAY, end: now, label: '最近 24 小时' };
  if (s === 'all') return { mode: 'all', start: 0, end: now, label: '全部' };
  const n = Math.min(30, Math.max(1, Number(s) || 7));
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  return { mode: 'days', start: d.getTime() - (n - 1) * DAY, end: now, label: `最近 ${n} 天` };
}
function dayKey(at) { const d = new Date(Number(at) || 0); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function identity(value, fallback) {
  const text = String(value || fallback);
  if (Buffer.byteLength(text) > MAX_IDENTITY_BYTES) throw new Error('用量记录中的模型、渠道或会话标识超过 4096 字节');
  return text;
}
function number(value) {
  const n = Number(value) || 0;
  if (!Number.isFinite(n)) throw new Error('用量记录包含非有限数值');
  return n;
}

/** The index contains extracted usage only. Original transcripts are never changed. */
export function openUsageIndex(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-2048;
    PRAGMA temp_store=FILE; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
    INSERT OR IGNORE INTO index_meta(key,value) VALUES('generation',0);
    CREATE TABLE IF NOT EXISTS sources(filename TEXT PRIMARY KEY, mtime REAL NOT NULL, bytes INTEGER NOT NULL,
      started REAL NOT NULL DEFAULT 0,search_count REAL NOT NULL DEFAULT 0,seen INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS calls(source TEXT NOT NULL,seq INTEGER NOT NULL,at REAL NOT NULL,prompt REAL NOT NULL,
      completion REAL NOT NULL,cached REAL NOT NULL,model TEXT NOT NULL,vendor TEXT NOT NULL,chat_key TEXT NOT NULL,exact INTEGER NOT NULL,
      PRIMARY KEY(source,seq),FOREIGN KEY(source) REFERENCES sources(filename) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS tools(source TEXT NOT NULL,name TEXT NOT NULL,count INTEGER NOT NULL,
      PRIMARY KEY(source,name),FOREIGN KEY(source) REFERENCES sources(filename) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS calls_at ON calls(at); CREATE INDEX IF NOT EXISTS sources_started ON sources(started);`);
  const statements = {
    source: db.prepare('SELECT mtime,bytes FROM sources WHERE filename=?'),
    mark: db.prepare('UPDATE sources SET seen=? WHERE filename=?'),
    placeholder: db.prepare('INSERT OR IGNORE INTO sources(filename,mtime,bytes,seen) VALUES(?,?,?,?)'),
    finish: db.prepare('UPDATE sources SET mtime=?,bytes=?,started=?,search_count=?,seen=? WHERE filename=?'),
    insertCall: db.prepare('INSERT INTO calls(source,seq,at,prompt,completion,cached,model,vendor,chat_key,exact) VALUES(?,?,?,?,?,?,?,?,?,?)'),
    insertTool: db.prepare('INSERT INTO tools(source,name,count) VALUES(?,?,1) ON CONFLICT(source,name) DO UPDATE SET count=count+1'),
    deleteCalls: db.prepare('DELETE FROM calls WHERE source=?'), deleteTools: db.prepare('DELETE FROM tools WHERE source=?'),
    fill: db.prepare("UPDATE calls SET at=CASE WHEN at=0 THEN ? ELSE at END,model=CASE WHEN model='' THEN ? ELSE model END,vendor=?,chat_key=? WHERE source=?")
  };
  return {
    db, statements,
    nextGeneration() { db.prepare("UPDATE index_meta SET value=value+1 WHERE key='generation'").run(); return Number(db.prepare("SELECT value FROM index_meta WHERE key='generation'").get().value); },
    close() { db.close(); }
  };
}

export async function refreshUsageIndex(index, sessionsDir, report = () => {}) {
  const generation = index.nextGeneration(); const { db, statements: s } = index;
  let directory;
  try { directory = await fs.promises.opendir(sessionsDir); }
  catch (error) { if (error.code !== 'ENOENT') throw error; db.exec('DELETE FROM sources'); return { files: 0, changed: 0, failed: 0, warnings: [] }; }
  let changed = 0, failed = 0, files = 0; const warnings = [];
  for await (const entry of directory) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filename = entry.name; const full = path.join(sessionsDir, filename); files++;
    const old = s.source.get(filename); s.mark.run(generation, filename);
    let stamp;
    try { stamp = await fs.promises.stat(full); } catch (error) { failed++; if (warnings.length < 5) warnings.push({ filename, error: String(error.message).slice(0, 300) }); continue; }
    if (old && Number(old.mtime) === stamp.mtimeMs && Number(old.bytes) === stamp.size) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      s.placeholder.run(filename, stamp.mtimeMs, stamp.size, generation); s.deleteCalls.run(filename); s.deleteTools.run(filename);
      let seq = 0;
      const { metadata: m } = await readJsonObjectArray(full, { onMessage(message) {
        if (message?.toolCall?.name) s.insertTool.run(filename, identity(message.toolCall.name, '(未知)'));
        const raw = message?.raw, u = raw?.usage || {};
        const prompt = number(u.prompt_tokens), completion = number(u.completion_tokens);
        if (!prompt && !completion) return;
        s.insertCall.run(filename, seq++, number(raw.created) * 1000, prompt, completion,
          number(u.prompt_tokens_details?.cached_tokens), identity(raw.model, ''), '', '', 1);
      } });
      // Metadata can follow the messages array in old files. Fill it only after a complete parse.
      const started = number(m.startedAt), chatKey = identity(m.chatKey, '(未知)'), vendor = identity(String(m.vendor || '').trim(), UNKNOWN_VENDOR), model = identity(m.model, '(未知)');
      if (started) {
        s.fill.run(started, model, vendor, chatKey, filename);
        if (!seq) { const u = m.usage || {}; const prompt = number(u.promptTokens), completion = number(u.completionTokens); if (prompt || completion) s.insertCall.run(filename, seq++, started, prompt, completion, number(u.cachedTokens), model, vendor, chatKey, 0); }
      } else { s.deleteCalls.run(filename); s.deleteTools.run(filename); }
      const after = await fs.promises.stat(full);
      if (after.mtimeMs !== stamp.mtimeMs || after.size !== stamp.size) throw new Error('读取期间会话文件发生变化，保留上次完整索引');
      s.finish.run(stamp.mtimeMs, stamp.size, started, started ? number(m.webSearchCount) : 0, generation, filename);
      db.exec('COMMIT'); changed++;
    } catch (error) {
      db.exec('ROLLBACK'); failed++;
      if (warnings.length < 5) warnings.push({ filename, error: String(error?.message || error).slice(0, 300) });
    }
    if ((changed + failed) % 32 === 0) report({ indexed: changed, failed });
  }
  db.prepare('DELETE FROM sources WHERE seen<>?').run(generation);
  return { files, changed, failed, warnings, incomplete: failed > 0 };
}

function finishTotals(row = {}) {
  const out = Object.fromEntries(['cost', 'peakCost', 'offPeakCost', 'peakTokens', 'offPeakTokens', 'promptTokens', 'completionTokens', 'cachedTokens', 'exactCalls', 'runs'].map((k) => [k, Number(row[k]) || 0]));
  out.hasPeakModel = Boolean(row.hasPeakModel); out.totalTokens = out.promptTokens + out.completionTokens;
  out.cacheHitRate = out.promptTokens ? Math.min(1, out.cachedTokens / out.promptTokens) : 0;
  out.peakRatio = out.totalTokens ? out.peakTokens / out.totalTokens : 0;
  return out;
}
const AGGREGATE = `SUM(cost) AS cost,SUM(CASE WHEN peak=1 THEN cost ELSE 0 END) AS peakCost,
  SUM(CASE WHEN peak=0 THEN cost ELSE 0 END) AS offPeakCost,SUM(CASE WHEN peak=1 THEN prompt+completion ELSE 0 END) AS peakTokens,
  SUM(CASE WHEN peak=0 THEN prompt+completion ELSE 0 END) AS offPeakTokens,SUM(prompt) AS promptTokens,
  SUM(completion) AS completionTokens,SUM(cached) AS cachedTokens,SUM(exact) AS exactCalls,MAX(has_peak) AS hasPeakModel,COUNT(*) AS runs`;

/** Price rows into a disk temp table, then aggregate dimensions in SQL. No full-history JS arrays or group Maps. */
export async function queryUsage(index, kind, args = {}, pricing = {}, now = Date.now()) {
  if (kind !== 'stats' && kind !== 'breakdown') throw new Error('不支持的用量查询');
  const { db } = index; const range = resolveRange(args.range, now); const prices = new Map();
  function priceFor(model, vendor) {
    const key = modelLabel(vendor, model); let p = prices.get(key);
    if (p) { prices.delete(key); prices.set(key, p); return p; }
    const cfg = pricing.config || {}, table = pricing.table || [];
    const channel = resolveModelPrice(key, cfg, table);
    p = channel.source === 'custom' ? channel : resolveModelPrice(model, cfg, table);
    prices.set(key, p); if (prices.size > 256) prices.delete(prices.keys().next().value); return p;
  }
  db.exec(`DROP TABLE IF EXISTS temp.query_rows; CREATE TEMP TABLE query_rows(day TEXT,chat TEXT,model TEXT,prompt REAL,completion REAL,cached REAL,cost REAL,peak INTEGER,has_peak INTEGER,exact INTEGER);`);
  const put = db.prepare('INSERT INTO query_rows VALUES(?,?,?,?,?,?,?,?,?,?)');
  const field = (dim) => dim === 'day' ? 'day' : dim === 'model' ? 'model' : 'chat';
  db.exec('BEGIN');
  try {
    for (const r of db.prepare('SELECT at,prompt,completion,cached,model,vendor,chat_key AS chat,exact FROM calls WHERE at>=? AND at<=?').iterate(range.start, range.end)) {
      const day = dayKey(r.at), model = modelLabel(r.vendor, r.model), chat = r.chat;
      if (kind === 'breakdown' && args.dim && String({ day, chat, model }[field(args.dim)]) !== String(args.key || '')) continue;
      const p = priceFor(r.model, r.vendor), tier = p.peak ? priceAt(p, r.at) : p;
      const cached = Math.min(number(r.cached), number(r.prompt)), fresh = Math.max(0, r.prompt - cached);
      const cost = fresh / 1e6 * tier.in + cached / 1e6 * tier.cached + r.completion / 1e6 * tier.out;
      put.run(day, chat, model, r.prompt, r.completion, cached, cost, isPeakHour(r.at) ? 1 : 0, p.peak ? 1 : 0, r.exact);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  let resultBytes = 1024, resultGroups = 0;
  function account(value) {
    resultBytes += Buffer.byteLength(JSON.stringify(value)); resultGroups++;
    if (resultBytes > MAX_RESULT_BYTES || resultGroups > MAX_RESULT_GROUPS) throw new Error('用量统计结果超过 8 MiB 或 20000 组，请缩小时间范围；未截断任何统计行');
    return value;
  }
  function groups(dim, transform = (x) => x) {
    const out = [];
    for (const row of db.prepare(`SELECT ${field(dim)} AS key,${AGGREGATE} FROM query_rows GROUP BY ${field(dim)} ORDER BY cost DESC,promptTokens+completionTokens DESC`).iterate()) out.push(account(transform({ key: row.key, ...finishTotals(row) })));
    return out;
  }
  const totals = finishTotals(db.prepare(`SELECT ${AGGREGATE} FROM query_rows`).get());
  if (kind === 'breakdown') {
    const rows = groups(args.by, (g) => Object.fromEntries(['key', 'cost', 'promptTokens', 'completionTokens', 'cachedTokens', 'totalTokens', 'cacheHitRate', 'runs', 'exactCalls'].map((k) => [k, g[k]])));
    return { range: String(args.range || '7'), dim: String(args.dim || ''), key: String(args.key || ''), by: String(args.by || ''), totals, showPeak: totals.hasPeakModel && (totals.peakCost > 0 || totals.offPeakCost > 0), rows };
  }
  const searchCount = Number(db.prepare('SELECT SUM(search_count) AS count FROM sources WHERE started>=? AND started<=?').get(range.start, range.end).count) || 0;
  const toolCounts = Object.create(null);
  for (const row of db.prepare('SELECT t.name,SUM(t.count) AS count FROM tools t JOIN sources s ON s.filename=t.source WHERE s.started>=? AND s.started<=? GROUP BY t.name').iterate(range.start, range.end)) { account(row); toolCounts[row.name] = Number(row.count); }
  const days = range.mode === 'days' ? groups('day', (g) => ({ day: g.key, ...g })).sort((a, b) => a.day.localeCompare(b.day)) : [];
  return { range: String(args.range || '7'), rangeLabel: range.label, mode: range.mode, totals, searchCount, toolCounts, days,
    chats: groups('chat'), models: groups('model', (g) => ({ ...g, ...splitModelLabel(g.key) })), computedAt: Date.now() };
}
