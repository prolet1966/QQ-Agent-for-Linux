import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventInbox, EVENT_INBOX_FILE } from '../src/event-inbox.js';

const require = createRequire(import.meta.url);
const roots = [];
const MiB = 1024 * 1024;

function temporary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-event-inbox-'));
  roots.push(dir);
  return dir;
}

function eventWithBytes(bytes) {
  // {"data":""} is exactly 11 UTF-8 bytes. ASCII keeps byte and character
  // lengths identical, which makes the boundary assertions deterministic.
  assert.ok(bytes >= 11);
  return { data: 'x'.repeat(bytes - 11) };
}

function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      let result = false;
      try { result = Boolean(predicate()); } catch (error) { reject(error); return; }
      if (result) { resolve(); return; }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`等待事件队列状态超时：${JSON.stringify(predicate())}`));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

async function closeQuietly(inbox, options) {
  if (inbox) await inbox.close(options);
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('enforces the 4 MiB event boundary and rejects oversized events', async () => {
  const dataDir = temporary();
  const inbox = new EventInbox({ dataDir });
  try {
    assert.equal(inbox.push(eventWithBytes(4 * MiB)), true);
    assert.equal(inbox.push(eventWithBytes(4 * MiB + 1)), false);
    const stats = inbox.stats();
    assert.equal(stats.count, 1);
    assert.equal(stats.accepted, 1);
    assert.equal(stats.rejected, 1);
    assert.equal(stats.lastError.code, 'event-too-large');
  } finally { await closeQuietly(inbox); }
});

test('enforces queue byte and count limits without dropping accepted events', async () => {
  const dataDir = temporary();
  const inbox = new EventInbox({ dataDir, maxEventBytes: 256, maxBytes: 512, capacity: 2 });
  try {
    assert.equal(inbox.push(eventWithBytes(256)), true);
    assert.equal(inbox.push(eventWithBytes(256)), true);
    assert.equal(inbox.push(eventWithBytes(256)), false);
    assert.equal(inbox.stats().count, 2);
    assert.equal(inbox.stats().lastError.code, 'full');
  } finally { await closeQuietly(inbox); }

  const countDir = temporary();
  const byCount = new EventInbox({ dataDir: countDir, maxEventBytes: 256, capacity: 2 });
  try {
    assert.equal(byCount.push({ id: 1 }), true);
    assert.equal(byCount.push({ id: 2 }), true);
    assert.equal(byCount.push({ id: 3 }), false);
    assert.equal(byCount.stats().count, 2);
    assert.equal(byCount.stats().rejected, 1);
  } finally { await closeQuietly(byCount); }
});

test('default limits retain 64 MiB or 4096 events without accepting an overflow', async () => {
  const byBytes = new EventInbox({ dataDir: temporary() });
  try {
    const event = eventWithBytes(4 * MiB);
    for (let index = 0; index < 16; index++) assert.equal(byBytes.push(event), true);
    assert.equal(byBytes.stats().bytes, 64 * MiB);
    assert.equal(byBytes.push({ overflow: true }), false);
    assert.equal(byBytes.stats().count, 16);
  } finally { await byBytes.close(); }

  const byCount = new EventInbox({ databaseFile: ':memory:' });
  try {
    for (let index = 0; index < 4096; index++) assert.equal(byCount.push({ index }), true);
    assert.equal(byCount.push({ overflow: true }), false);
    assert.equal(byCount.stats().count, 4096);
  } finally { await byCount.close(); }
});

test('rejects non-object and invalid serialized events without throwing', async () => {
  const inbox = new EventInbox({ dataDir: temporary() });
  try {
    for (const event of [null, [], 'text', { toJSON() {} }, { toJSON() { return 'text'; } }, { value: 1n }]) {
      assert.equal(inbox.push(event), false);
      assert.equal(inbox.stats().lastError.code, 'invalid');
    }
    const circular = {}; circular.self = circular;
    assert.equal(inbox.push(circular), false);
    assert.equal(inbox.stats().count, 0);
  } finally { await inbox.close(); }
});

test('reopens with pending events and delivers them after a restart', async () => {
  const dataDir = temporary();
  const first = new EventInbox({ dataDir });
  const instanceId = first.instanceId;
  first.push({ kind: 'restart', value: 42 });
  await first.close();

  const second = new EventInbox({ dataDir });
  assert.equal(second.instanceId, instanceId);
  const seen = [];
  second.start(async event => { seen.push(event); });
  await waitFor(() => second.stats().completed === 1 && second.stats().count === 0);
  assert.deepEqual(seen, [{ kind: 'restart', value: 42 }]);
  await second.close();
  fs.unlinkSync(path.join(dataDir, EVENT_INBOX_FILE));
  const recreated = new EventInbox({ dataDir });
  assert.notEqual(recreated.instanceId, instanceId, 'recreated queue cannot reuse archive event identities');
  await recreated.close();
});

test('recovers a processing row left by a crashed worker', async () => {
  const dataDir = temporary();
  const first = new EventInbox({ dataDir });
  let entered;
  let resolveLate;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  first.push({ kind: 'crash-recovery' });
  first.start(async (_event, { signal }) => {
    entered();
    // Deliberately ignore AbortSignal: this simulates a handler that was
    // interrupted after its side effect but before acknowledgement.
    await new Promise(resolve => { resolveLate = resolve; });
    assert.equal(signal.aborted, true);
  });
  await enteredPromise;
  const closing = first.close({ deadlineMs: 20 });
  const closeStarted = Date.now();
  await closing;
  assert.ok(Date.now() - closeStarted < 500, 'close must honor its deadline');

  const second = new EventInbox({ dataDir });
  assert.equal(second.stats().recovered, 1);
  let deliveries = 0;
  second.start(async event => { assert.equal(event.kind, 'crash-recovery'); deliveries++; });
  await waitFor(() => second.stats().completed === 1 && second.stats().count === 0);
  assert.equal(deliveries, 1);
  await second.close();
  resolveLate();
  await first.waitSettled();
  assert.equal(first.stats().completed, 0, 'late handler cannot acknowledge after close');
});

test('removes successful events and keeps only one parsed event resident', async () => {
  const dataDir = temporary();
  const inbox = new EventInbox({ dataDir, maxEventBytes: 1024, capacity: 100 });
  const count = 40;
  for (let id = 0; id < count; id++) assert.equal(inbox.push({ id, payload: 'y'.repeat(200) }), true);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  inbox.start(async () => {
    calls++;
    if (calls === 1) {
      await gate;
    }
  });
  await waitFor(() => calls >= 1);
  // The first handler is the only parsed event; the remaining 39 stay in DB.
  assert.equal(inbox.stats().running, 1);
  assert.equal(inbox.stats().count, count);
  assert.ok(inbox.stats().memoryBytes > 0);
  assert.ok(inbox.stats().memoryBytes <= 1024);
  release();
  await waitFor(() => inbox.stats().completed === count && inbox.stats().count === 0, { timeoutMs: 4000 });
  await inbox.close();
});

test('retries failures with backoff and moves exhausted events to deadletter', async () => {
  const dataDir = temporary();
  const inbox = new EventInbox({ dataDir, maxAttempts: 3, retryBaseMs: 15, retryMaxMs: 30 });
  let attempts = 0;
  inbox.push({ kind: 'retry' });
  const started = Date.now();
  inbox.start(async () => { attempts++; throw new Error('temporary failure'); });
  await waitFor(() => inbox.stats().deadletter === 1, { timeoutMs: 2500 });
  assert.equal(attempts, 3);
  assert.equal(inbox.stats().failures, 3);
  assert.ok(Date.now() - started >= 30, 'retries should observe exponential backoff');
  assert.equal(inbox.stats().lastError.code, 'deadletter');
  assert.equal(inbox.stats().count, 1, 'deadletter remains durable');
  await inbox.close();
});

test('retryFailed retries at most 100 deadletters and does not delete source rows', async () => {
  const dataDir = temporary();
  const inbox = new EventInbox({ dataDir, maxAttempts: 1, retryBaseMs: 1 });
  for (let id = 0; id < 101; id++) inbox.push({ id });
  let failing = true;
  let handled = 0;
  inbox.start(async () => { if (failing) throw new Error('dead'); handled++; });
  try {
    await waitFor(() => inbox.stats().deadletter === 101, { timeoutMs: 5000 });
    assert.throws(() => inbox.retryFailed(101), /参数必须/);
    failing = false;
    assert.equal(inbox.retryFailed(100), 100);
    assert.equal(inbox.stats().count, 101);
    assert.equal(inbox.stats().deadletter, 1);
    await waitFor(() => inbox.stats().completed === 100, { timeoutMs: 5000 });
    assert.equal(inbox.stats().count, 1);
    assert.equal(inbox.retryFailed(100), 1);
    await waitFor(() => inbox.stats().completed === 101 && inbox.stats().count === 0);
    assert.equal(handled, 101);
  } finally { await inbox.close(); }
});

test('close deadline returns promptly while an uncooperative handler is active', async () => {
  const dataDir = temporary();
  const inbox = new EventInbox({ dataDir });
  let finishHandler;
  inbox.push({ kind: 'deadline' });
  inbox.start(async () => new Promise(resolve => { finishHandler = resolve; }));
  await waitFor(() => inbox.stats().running === 1);
  const started = Date.now();
  await inbox.close({ deadlineMs: 25 });
  assert.ok(Date.now() - started < 500);
  assert.equal(inbox.stats().closed, true);
  assert.equal(inbox.stats().running, 1, 'database close is distinct from handler settlement');
  finishHandler();
  await inbox.waitSettled();
  assert.equal(inbox.stats().running, 0);
});

test('settlement barrier retains dependent stores and locks until a late continuation finishes', async () => {
  const dataDir = temporary();
  const inbox = new EventInbox({ dataDir });
  await assert.rejects(inbox.waitSettled(), /请先关闭事件队列/);
  let continueHandler;
  let dependentStoreOpen = true;
  let lockHeld = true;
  let writes = 0;
  inbox.push({ kind: 'late-store-write' });
  inbox.start(async (_event, { signal }) => {
    await new Promise(resolve => { continueHandler = resolve; });
    assert.equal(signal.aborted, true);
    assert.equal(dependentStoreOpen, true);
    assert.equal(lockHeld, true);
    writes++;
  });
  await waitFor(() => inbox.stats().running === 1);
  await inbox.close({ deadlineMs: 5 });
  let teardownFinished = false;
  const teardown = inbox.waitSettled().then(() => {
    dependentStoreOpen = false;
    lockHeld = false;
    teardownFinished = true;
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(teardownFinished, false, 'deadline cannot release handler dependencies');
  continueHandler();
  await teardown;
  assert.equal(writes, 1);
  assert.equal(inbox.stats().completed, 0, 'closed database preserves source event for recovery');
  assert.equal(inbox.stats().count, 1);
  assert.equal(lockHeld, false);
  const recovered = new EventInbox({ dataDir });
  try { assert.equal(recovered.stats().recovered, 1); }
  finally { await recovered.close(); }
});

test('protects SQLite files and rejects a newer database schema', async () => {
  const dataDir = temporary();
  const inbox = new EventInbox({ dataDir });
  inbox.push({ secure: true });
  const dbFile = path.join(dataDir, EVENT_INBOX_FILE);
  await inbox.close();
  assert.equal(fs.existsSync(dbFile), true);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dbFile).mode & 0o777, 0o600);
    for (const sidecar of [`${dbFile}-wal`, `${dbFile}-shm`]) {
      if (fs.existsSync(sidecar)) assert.equal(fs.statSync(sidecar).mode & 0o777, 0o600);
    }
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA user_version=2');
  db.close();
  assert.throws(() => new EventInbox({ dataDir }), /拒绝降级/);
});

test('rejects an existing oversized database before making schema changes', () => {
  const dataDir = temporary();
  const dbFile = path.join(dataDir, EVENT_INBOX_FILE);
  const { DatabaseSync } = require('node:sqlite');
  let db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE original (payload BLOB); INSERT INTO original VALUES(zeroblob(101711872));');
  db.close();
  assert.ok(fs.statSync(dbFile).size > 96 * MiB);
  assert.throws(() => new EventInbox({ dataDir }), /96 MiB/);
  db = new DatabaseSync(dbFile);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='inbox'").get().count, 0);
    assert.equal(db.prepare('SELECT LENGTH(payload) AS bytes FROM original').get().bytes, 101711872);
  } finally { db.close(); }
});
