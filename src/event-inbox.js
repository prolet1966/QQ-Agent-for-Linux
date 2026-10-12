// Durable server ingress. Only one parsed event is resident while its async
// handler runs; the pending backlog lives in SQLite, not Promise closures.
// Delivery is at least once: a crash after a side effect but before acknowledgement
// can replay that event. Consumers must retain protocol/message deduplication.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MiB = 1024 * 1024;
export const EVENT_INBOX_FILE = 'event-inbox.sqlite';

function bounded(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`事件接入队列参数必须在 ${min}–${max} 之间`);
  return number;
}
function shortError(error) { return String(error?.message || error || '未知错误').slice(0, 1024); }

export class EventInbox {
  constructor({ dataDir, databaseFile, maxEventBytes = 4 * MiB, maxBytes = 64 * MiB, capacity = 4096,
    maxAttempts = 5, retryBaseMs = 1000, retryMaxMs = 30000, onError = () => {} } = {}) {
    if (!dataDir && !databaseFile) throw new Error('事件接入队列需要数据目录');
    this.maxEventBytes = bounded(maxEventBytes, 4 * MiB, 256, 4 * MiB);
    this.maxBytes = bounded(maxBytes, 64 * MiB, this.maxEventBytes, 64 * MiB);
    this.capacity = bounded(capacity, 4096, 1, 4096);
    this.maxAttempts = bounded(maxAttempts, 5, 1, 10);
    this.retryBaseMs = bounded(retryBaseMs, 1000, 1, 60000);
    this.retryMaxMs = bounded(retryMaxMs, 30000, this.retryBaseMs, 300000);
    this.onError = onError;
    this.databaseFile = databaseFile || path.join(dataDir, EVENT_INBOX_FILE);
    if (this.databaseFile !== ':memory:') fs.mkdirSync(path.dirname(this.databaseFile), { recursive: true, mode: 0o700 });
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch { throw new Error('服务器持久事件队列需要 Node.js >=22.16'); }
    this.db = new DatabaseSync(this.databaseFile);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE;');
      const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
      if (version > 1) throw new Error('事件队列数据库版本比当前程序更新，拒绝降级写入。');
      const pageSize = Number(this.db.prepare('PRAGMA page_size').get().page_size);
      const pageBudget = Math.floor(96 * MiB / pageSize);
      const pageCount = Number(this.db.prepare('PRAGMA page_count').get().page_count);
      if (pageCount > pageBudget) throw new Error('事件队列数据库超过 96 MiB 页面预算；请先离线处理积压，原数据已保留。');
      this.db.exec(`PRAGMA max_page_count=${pageBudget}`);
      this.db.exec(`
        PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=8388608;
        CREATE TABLE IF NOT EXISTS inbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0),
          created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','deadletter')),
          attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS inbox_ready ON inbox(status,next_attempt,id);
        CREATE TABLE IF NOT EXISTS inbox_totals (
          id INTEGER PRIMARY KEY CHECK(id=1), count INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
          accepted INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
          failures INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS inbox_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT OR IGNORE INTO inbox_totals(id) VALUES(1);
        CREATE TRIGGER IF NOT EXISTS inbox_insert AFTER INSERT ON inbox BEGIN
          UPDATE inbox_totals SET count=count+1,bytes=bytes+NEW.bytes,accepted=accepted+1 WHERE id=1;
        END;
        CREATE TRIGGER IF NOT EXISTS inbox_delete AFTER DELETE ON inbox BEGIN
          UPDATE inbox_totals SET count=count-1,bytes=bytes-OLD.bytes WHERE id=1;
        END;
        PRAGMA user_version=1;
      `);
      // Core single-instance locking excludes concurrent consumers. A processing
      // row means the prior core did not acknowledge it before stopping.
      // The instance id is durable so a recreated worker database can never
      // reuse an old row id and collide with a message already in the archive.
      this.db.prepare("INSERT OR IGNORE INTO inbox_meta(key,value) VALUES('instance_id', ?)").run(crypto.randomUUID());
      this.instanceId = this.db.prepare("SELECT value FROM inbox_meta WHERE key='instance_id'").get().value;
      this.recovered = this.db.prepare("UPDATE inbox SET status='pending',next_attempt=0 WHERE status='processing'").run().changes;
      if (this.databaseFile !== ':memory:') {
        for (const file of [this.databaseFile, `${this.databaseFile}-wal`, `${this.databaseFile}-shm`]) if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
      }
      this.statements = new Map(); this.handler = null; this.active = null; this.timer = null;
      this.accepting = true; this.closing = false; this.closed = false; this.closePromise = null; this.lastError = null;
      this.memoryBytes = 0; this.finishClose = null; this.activeSettled = Promise.resolve();
    } catch (error) { this.db.close(); throw error; }
  }

  #query(sql) {
    if (this.closed) throw new Error('事件接入队列已关闭');
    if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql));
    return this.statements.get(sql);
  }
  #notify(error) {
    try { this.onError(error); } catch { /* diagnostics must not break persistence */ }
  }
  #checkpoint() {
    // No long-lived read cursors are kept. Reuse database freelist pages and
    // checkpoint each inserted/acknowledged event; WAL retention is <=8 MiB.
    try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); }
    catch (error) {
      // The event transaction already committed. A checkpoint failure must not
      // tell the sender its durable event was rejected (which could duplicate it).
      this.lastError = { code: 'checkpoint', message: shortError(error), at: Date.now() };
      this.#notify(error);
    }
  }
  #reject(code, message) {
    this.lastError = { code, message, at: Date.now() };
    if (!this.closed) {
      try { this.#query('UPDATE inbox_totals SET rejected=rejected+1 WHERE id=1').run(); } catch { /* report original failure */ }
    }
    this.#notify(new Error(message)); return false;
  }

  push(event) {
    if (!this.accepting || this.closed) return this.#reject('closed', '事件队列正在关闭，未接收新事件');
    let payload;
    try {
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('协议事件必须是 JSON 对象');
      payload = JSON.stringify(event);
      if (typeof payload !== 'string' || !payload.startsWith('{')) throw new Error('协议事件序列化结果必须是 JSON 对象');
    } catch (error) { return this.#reject('invalid', `协议事件不能序列化：${shortError(error)}`); }
    const bytes = Buffer.byteLength(payload);
    if (bytes > this.maxEventBytes) return this.#reject('event-too-large', `协议事件超过 ${this.maxEventBytes} 字节上限，未入队`);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const totals = this.#query('SELECT count,bytes FROM inbox_totals WHERE id=1').get();
      if (totals.count >= this.capacity || totals.bytes + bytes > this.maxBytes) {
        this.db.exec('ROLLBACK');
        return this.#reject('full', '持久事件队列已满（包含失败事件）；请处理积压或失败记录，未接收本次事件');
      }
      this.#query('INSERT INTO inbox(event,bytes,created_at) VALUES(?,?,?)').run(payload, bytes, Date.now());
      this.db.exec('COMMIT');
      this.#checkpoint();
      this.#schedule(0); return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction may not have begun */ }
      return this.#reject('persistence', `协议事件持久化失败：${shortError(error)}`);
    }
  }

  start(handler) {
    if (this.closed || this.closing) throw new Error('已关闭的事件队列不能启动');
    if (typeof handler !== 'function') throw new Error('事件处理函数不能为空');
    if (this.handler && this.handler !== handler) throw new Error('事件队列已经绑定处理函数');
    this.handler = handler; this.#schedule(0); return this;
  }
  #schedule(delay) {
    if (this.closed || this.active || !this.handler) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.#pump(); }, Math.max(0, delay));
  }
  async #pump() {
    if (this.closed || this.active || !this.handler) return;
    let row, nextDelay = 0, finishActive;
    try {
      row = this.#query("SELECT id,event,bytes,attempts FROM inbox WHERE status='pending' AND next_attempt<=? ORDER BY next_attempt,id LIMIT 1").get(Date.now());
      if (!row) {
        const next = this.#query("SELECT MIN(next_attempt) AS next FROM inbox WHERE status='pending'").get().next;
        if (next != null) this.#schedule(Math.max(1, next - Date.now()));
        else if (this.closing) this.#finalize();
        return;
      }
      this.#query("UPDATE inbox SET status='processing' WHERE id=? AND status='pending'").run(row.id);
      const abort = new AbortController();
      this.active = { id: row.id, abort }; this.memoryBytes = row.bytes;
      // Keep this barrier even if close() reaches its database deadline. An
      // aborted handler can still have continuations that use the chat store.
      this.activeSettled = new Promise(resolve => { finishActive = resolve; });
      const event = JSON.parse(row.event); row.event = null;
      await this.handler(event, { id: row.id, instanceId: this.instanceId, attempt: row.attempts + 1, signal: abort.signal });
      if (!this.closed) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.#query('DELETE FROM inbox WHERE id=?').run(row.id);
          this.#query('UPDATE inbox_totals SET completed=completed+1 WHERE id=1').run();
          this.db.exec('COMMIT');
          this.#checkpoint();
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
    } catch (error) {
      if (!this.closed && row) {
        const attempts = row.attempts + 1;
        const deadletter = attempts >= this.maxAttempts;
        const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(16, attempts - 1));
        const message = shortError(error);
        let failureSaved = false;
        try {
          this.db.exec('BEGIN IMMEDIATE');
          this.#query('UPDATE inbox SET status=?,attempts=?,next_attempt=?,last_error=? WHERE id=?')
            .run(deadletter ? 'deadletter' : 'pending', attempts, Date.now() + delay, message, row.id);
          this.#query('UPDATE inbox_totals SET failures=failures+1 WHERE id=1').run();
          this.db.exec('COMMIT');
          failureSaved = true;
          this.#checkpoint();
        } catch (databaseError) {
          try { this.db.exec('ROLLBACK'); } catch { /* original error retained */ }
          this.lastError = { code: 'persistence', message: shortError(databaseError), at: Date.now() };
        }
        if (failureSaved) {
          this.lastError = { code: deadletter ? 'deadletter' : 'retry', message, id: row.id, at: Date.now() };
          this.#notify(new Error(`事件 ${row.id} ${deadletter ? '达到重试上限，已保留为失败记录' : '处理失败，稍后重试'}：${message}`));
        } else this.#notify(new Error(`事件 ${row.id} 状态写入失败，原事件已保留；重启核心后恢复处理：${this.lastError?.message}`));
      } else if (!this.closed) {
        this.lastError = { code: 'persistence', message: shortError(error), at: Date.now() };
        this.#notify(error);
        this.#schedule(1000);
      }
    } finally {
      this.active = null; this.memoryBytes = 0;
      finishActive?.();
      if (!this.closed && row) this.#schedule(nextDelay);
    }
  }

  stats() {
    if (this.closed) return { ...this.finalStats, running: this.active ? 1 : 0, memoryBytes: this.memoryBytes, closed: true };
    const totals = this.#query('SELECT count,bytes,accepted,completed,failures,rejected FROM inbox_totals WHERE id=1').get();
    const byStatus = Object.fromEntries(this.#query('SELECT status,COUNT(*) AS count FROM inbox GROUP BY status').all().map(row => [row.status, row.count]));
    return { ...totals, pending: byStatus.pending || 0, running: this.active ? 1 : 0,
      processing: byStatus.processing || 0, deadletter: byStatus.deadletter || 0, capacity: this.capacity,
      maxBytes: this.maxBytes, maxEventBytes: this.maxEventBytes, memoryBytes: this.memoryBytes, instanceId: this.instanceId,
      recovered: this.recovered, closing: this.closing, closed: false, lastError: this.lastError };
  }

  retryFailed(limit = 100) {
    if (this.closed || this.closing) throw new Error('事件队列正在关闭');
    limit = bounded(limit, 100, 1, 100);
    const result = this.#query(`UPDATE inbox SET status='pending',attempts=0,next_attempt=0,last_error=''
      WHERE id IN (SELECT id FROM inbox WHERE status='deadletter' ORDER BY id LIMIT ?)`).run(limit);
    this.#schedule(0); return result.changes;
  }

  #finalize() {
    if (this.closed) return;
    this.finalStats = this.stats();
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.active?.abort.abort();
    // Leave an unfinished row marked processing. Recovery on next start will
    // requeue it; a late handler resolution after close cannot acknowledge it.
    try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* WAL remains recoverable */ }
    this.db.close(); this.closed = true; this.statements.clear();
    this.finishClose?.(this.stats());
  }
  close({ deadlineMs = 5000 } = {}) {
    if (this.closePromise) return this.closePromise;
    this.accepting = false; this.closing = true;
    const deadline = bounded(deadlineMs, 5000, 0, 30000);
    this.closePromise = new Promise(resolve => {
      this.finishClose = resolve;
      const timer = setTimeout(() => this.#finalize(), deadline);
      const finish = this.finishClose;
      this.finishClose = result => { clearTimeout(timer); finish(result); };
      if (!this.handler || deadline === 0) this.#finalize();
      else this.#schedule(0);
    });
    return this.closePromise;
  }

  async waitSettled() {
    if (!this.closing) throw new Error('请先关闭事件队列，再等待事件处理完成');
    // close() has a bounded persistence deadline, not a guarantee that an
    // uncooperative handler has stopped. Core teardown must await this barrier
    // before closing dependent stores or releasing its single-instance lock.
    await this.closePromise;
    await this.activeSettled;
  }
}
