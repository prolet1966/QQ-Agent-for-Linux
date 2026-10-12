import { createRequire } from 'node:module';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { isServerMode } from './runtime.js';

/** Summaries only: full transcripts remain in their existing JSON files. */
export function openSessionIndex() {
  if (!isServerMode()) return null;
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(path.join(DATA_DIR, 'session-summaries.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-2048;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS summaries(id TEXT PRIMARY KEY, started INTEGER NOT NULL, value TEXT NOT NULL, mtime REAL NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS summaries_started ON summaries(started DESC, id DESC);`);
  const put = db.prepare('INSERT INTO summaries(id,started,value,mtime,bytes) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET started=excluded.started,value=excluded.value,mtime=excluded.mtime,bytes=excluded.bytes');
  return {
    put(summary, stamp = {}) { put.run(String(summary.id), Number(summary.startedAt) || 0, JSON.stringify(summary), Number(stamp.mtimeMs) || 0, Number(stamp.size) || 0); },
    list(limit = 100, offset = 0) {
      return db.prepare('SELECT value FROM summaries ORDER BY started DESC,id DESC LIMIT ? OFFSET ?').all(limit, offset).map((row) => JSON.parse(row.value));
    },
    remove(id) { db.prepare('DELETE FROM summaries WHERE id=?').run(String(id)); },
    has(id) { return Boolean(db.prepare('SELECT 1 FROM summaries WHERE id=?').get(String(id))); },
    source(id) { return db.prepare('SELECT mtime,bytes FROM summaries WHERE id=?').get(String(id)); },
    get(id) {
      const row = db.prepare('SELECT value FROM summaries WHERE id=?').get(String(id));
      return row ? JSON.parse(row.value) : null;
    },
    count() { return Number(db.prepare('SELECT COUNT(*) AS count FROM summaries').get().count); },
    checkpoint() { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); },
    close() { db.close(); }
  };
}

export function summarizeSession(s, toolCalls = Number(s?.toolCalls) || 0) {
  const usage = s.usage && Object.fromEntries(['promptTokens', 'completionTokens', 'cachedTokens', 'totalTokens', 'calls'].map((key) => [key, Number(s.usage[key]) || 0]));
  const outcome = s.outcome && { sent: Number(s.outcome.sent) || 0, finishReason: String(s.outcome.finishReason || '').slice(0, 500) };
  return { id: s.id, chatKey: s.chatKey, startedAt: s.startedAt, endedAt: s.endedAt ?? null,
    status: s.status, waitUntil: s.waitUntil ?? null, activity: String(s.activity ?? '').slice(0, 500),
    webSearchCount: s.webSearchCount ?? 0, toolCalls, outcome: outcome || null, usage: usage || null,
    model: String(s.model ?? '').slice(0, 256), trigger: String(s.triggerSummary ?? '').slice(0, 500),
    promptChars: s.promptChars ?? 0, rounds: s.rounds ?? 0,
    ...(s.abortedOnBoot ? { abortedOnBoot: true } : {}) };
}
