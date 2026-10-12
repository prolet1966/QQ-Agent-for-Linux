import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ChatStore, JSONChatStore, resolveStorageBackend } from '../src/store.js';
import { SQLiteChatStore, SQLITE_FILE, STORAGE_STATE_FILE } from '../src/sqlite-store.js';
import { readLegacyChat } from '../src/storage-json-stream.js';
import { runStorageMaintenance } from '../src/storage-maintenance.js';
import { EventInbox } from '../src/event-inbox.js';

const roots = [];
function temporary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-storage-test-'));
  roots.push(dir); return dir;
}
test.after(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fixtureMessage = id => ({ id, mid: id % 7 === 0 ? null : -id, ts: 1700000000000 + id,
  senderId: String(id % 7), senderName: `用户${id % 7}`, text: `记录 ${id} 汉字，"引号" 和 \\转义`,
  self: false, read: id % 3 === 0, reply: id % 5 ? null : { sender: '人', text: '[{}]"' },
  media: id % 11 ? [] : [{ kind: 'image', url: `https://example.invalid/${id}`, extra: ['a', true, null] }],
  ...(id % 13 === 0 ? { recalled: true, arbitraryExtensionField: { untouched: true } } : {}),
});
function legacyFile(dataDir, { count = 20, nextLocalId = count + 1, reordered = false } = {}) {
  const dir = path.join(dataDir, 'messages'); fs.mkdirSync(dir);
  const file = path.join(dir, 'group_123.json');
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeSync(fd, reordered ? '\uFEFF{"messages":[' : `{"chatKey":"group:123","nextLocalId":${nextLocalId},"customMeta":{"kept":true},"messages":[`);
    for (let id = 1; id <= count; id++) fs.writeSync(fd, `${id > 1 ? ',' : ''}${JSON.stringify(fixtureMessage(id))}`);
    fs.writeSync(fd, reordered ? `],"nextLocalId":${nextLocalId},"chatKey":"group:123","customMeta":{"kept":true}}` : ']}');
  } finally { fs.closeSync(fd); }
  return file;
}

test('auto creates SQLite only for new data and refuses a missing activated database', () => {
  const fresh = temporary();
  const store = new ChatStore(0, { dataDir: fresh, backend: 'auto' });
  assert.equal(store.backend, 'sqlite'); store.close();
  const legacy = temporary(); legacyFile(legacy);
  assert.equal(resolveStorageBackend(legacy), 'json');
  assert.equal(fs.existsSync(path.join(legacy, SQLITE_FILE)), false);
  fs.writeFileSync(path.join(legacy, STORAGE_STATE_FILE), JSON.stringify({ backend: 'sqlite' }));
  assert.throws(() => resolveStorageBackend(legacy), /数据库不存在/);
});

test('server legacy JSON refuses oversized reads and writes until offline migration, preserving the archive', () => {
  const priorMode = process.env.QQ_AGENT_MODE; process.env.QQ_AGENT_MODE = 'server';
  const dataDir = temporary(), file = legacyFile(dataDir);
  const store = new JSONChatStore(0, { dataDir });
  const originalRead = fs.readFileSync; let wholeArchiveReads = 0;
  try {
    const fd = fs.openSync(file, 'r+'); fs.ftruncateSync(fd, 9 * 1024 * 1024); fs.closeSync(fd);
    fs.readFileSync = function(target, ...args) { if (String(target) === file) wholeArchiveReads++; return originalRead.call(this, target, ...args); };
    assert.throws(() => store.recent('group:123'), /migrate/);
    assert.throws(() => store.appendIncoming('group:123', { text: 'new' }), /migrate/);
    assert.equal(wholeArchiveReads, 0); assert.equal(fs.statSync(file).size, 9 * 1024 * 1024);
    fs.readFileSync = originalRead;
    const small = new JSONChatStore(0, { dataDir: temporary() });
    small.appendIncoming('group:123', { text: 'preserve me' });
    const smallFile = path.join(small.messagesDir, 'group_123.json'); const before = hashFile(smallFile);
    assert.throws(() => small.appendIncoming('group:123', { text: 'x'.repeat(8 * 1024 * 1024) }), /migrate/);
    assert.equal(hashFile(smallFile), before); assert.equal(small.recent('group:123').length, 1); small.close();
  } finally {
    fs.readFileSync = originalRead; store.close();
    if (priorMode === undefined) delete process.env.QQ_AGENT_MODE; else process.env.QQ_AGENT_MODE = priorMode;
  }
});

test('legacy JSON cache evicts working sets without deleting history or eagerly parsing chat lists', () => {
  const dataDir = temporary();
  const store = new JSONChatStore(0, { dataDir, maxCachedChats: 2, maxCacheBytes: 1000 });
  for (let id = 1; id <= 12; id++) store.appendIncoming(`group:${id}`, { ts: id, text: 'history' });
  assert.equal(store.chats.size, 2);
  store.close();
  const reopened = new JSONChatStore(0, { dataDir, maxCachedChats: 2, maxCacheBytes: 1000 });
  assert.equal(reopened.listChats().length, 12);
  assert.equal(reopened.chats.size, 0);
  assert.equal(reopened.recent('group:1')[0].text, 'history');
  reopened.appendIncoming('group:1', { ts: 13, text: 'x'.repeat(2000) });
  assert.equal(reopened.chats.has('group:1'), false);
  assert.equal(reopened.recent('group:1').length, 2);
  assert.equal(reopened.chats.has('group:1'), false);
  assert.equal(reopened.chatCount(), 12);
  reopened.close();
});

test('JSON and SQLite persist source event keys for message and poke replay deduplication', async () => {
  for (const Store of [JSONChatStore, SQLiteChatStore]) {
    const dataDir = temporary();
    let store = new Store(0, { dataDir });
    const message = store.appendIncoming('group:123', { mid: -99, text: 'durable message', ts: 1700000000000, sourceEventKey: 'inbox:10' });
    const poke = store.appendIncoming('group:123', { text: 'poke', isPoke: true, ts: 1700000000001, sourceEventKey: 'inbox:11' });
    assert.equal(store.findBySourceEventKey('group:123', null), null);
    assert.equal(store.findBySourceEventKey('group:123', ''), null);
    assert.equal(store.findBySourceEventKey('private:123', 'inbox:10'), null);
    store.markAllRead('group:123');
    store.close();
    store = new Store(0, { dataDir });
    try {
      assert.deepEqual(store.findBySourceEventKey('group:123', 'inbox:10'), { ...message, read: true });
      assert.deepEqual(store.findBySourceEventKey('group:123', 'inbox:11'), { ...poke, read: true });
      assert.equal(store.findBySourceEventKey('group:123', 'missing'), null);
    } finally { store.close(); }
  }

  const dataDir = temporary();
  const json = new JSONChatStore(0, { dataDir });
  const original = json.appendIncoming('group:123', { text: 'migrate source key', isPoke: true, sourceEventKey: 'inbox:100' });
  json.close();
  await runStorageMaintenance({ operation: 'migrate', dataDir });
  const sql = new SQLiteChatStore(0, { dataDir });
  assert.deepEqual(sql.findBySourceEventKey('group:123', 'inbox:100'), original);
  sql.close();
  await runStorageMaintenance({ operation: 'rollback', dataDir });
  const restored = new JSONChatStore(0, { dataDir });
  assert.deepEqual(restored.findBySourceEventKey('group:123', 'inbox:100'), original);
  restored.close();
});

test('failed JSON writes discard the working cache and durable inbox replay reaches disk exactly once', async () => {
  const dataDir = temporary();
  const store = new JSONChatStore(0, { dataDir });
  const original = store.appendIncoming('group:123', { mid: 1, text: 'original', sourceEventKey: 'original' });
  const writeFile = fs.writeFileSync;
  let failures = 0;
  fs.writeFileSync = function(file, ...args) {
    if (String(file).startsWith(store.messagesDir) && failures === 0) {
      failures++;
      const error = new Error('fixture disk full'); error.code = 'ENOSPC'; throw error;
    }
    return writeFile.call(this, file, ...args);
  };
  try {
    assert.throws(() => store.appendIncoming('group:123', { mid: 2, text: 'not yet saved', sourceEventKey: 'failed' }), { code: 'ENOSPC' });
    assert.equal(store.findBySourceEventKey('group:123', 'failed'), null);
    assert.deepEqual(store.findBySourceEventKey('group:123', 'original'), original);
    assert.equal(store.cachedBytes, fs.statSync(path.join(store.messagesDir, 'group_123.json')).size);
    assert.equal(store.appendIncoming('group:123', { mid: 2, text: 'saved retry', sourceEventKey: 'failed' }).id, 2);
  } finally { fs.writeFileSync = writeFile; store.close(); }

  const inbox = new EventInbox({ dataDir, retryBaseMs: 5, retryMaxMs: 10 });
  const replayStore = new JSONChatStore(0, { dataDir });
  let handlerAttempts = 0;
  let queueCompleted;
  const completed = new Promise(resolve => { queueCompleted = resolve; });
  let timeout;
  failures = 0;
  fs.writeFileSync = function(file, ...args) {
    if (String(file).startsWith(replayStore.messagesDir) && failures === 0) {
      failures++;
      const error = new Error('fixture disk full'); error.code = 'ENOSPC'; throw error;
    }
    return writeFile.call(this, file, ...args);
  };
  try {
    inbox.push({ mid: 3, text: 'durable replay' });
    inbox.start(async (event, context) => {
      handlerAttempts++;
      const sourceEventKey = `inbox:${context.instanceId}:${context.id}`;
      if (!replayStore.findBySourceEventKey('group:123', sourceEventKey)) {
        replayStore.appendIncoming('group:123', { ...event, sourceEventKey });
      }
      queueCompleted();
    });
    await Promise.race([completed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('inbox replay timed out')), 3000); })]);
    clearTimeout(timeout);
    await inbox.close();
    assert.equal(handlerAttempts, 2);
    assert.equal(inbox.stats().completed, 1);
    assert.equal(inbox.stats().failures, 1);
    replayStore.close();
    const reopened = new JSONChatStore(0, { dataDir });
    try {
      const messages = reopened.recent('group:123');
      assert.equal(messages.length, 3);
      assert.equal(messages.filter(message => message.text === 'durable replay').length, 1);
      assert.equal(messages.at(-1).id, 3);
      assert.ok(reopened.findBySourceEventKey('group:123', messages.at(-1).sourceEventKey));
    } finally { reopened.close(); }
  } finally {
    clearTimeout(timeout); fs.writeFileSync = writeFile; replayStore.close(); await inbox.close({ deadlineMs: 0 });
  }
});

test('JSON compatibility never overwrites unreadable/corrupt archives and retains failed inbox events', async () => {
  const invalid = [
    '{"chatKey":"group:123","messages":[{"id":1,"text":"old history"}',
    JSON.stringify({ chatKey: 'group:123', nextLocalId: 2, messages: { old: 'history' } }),
    JSON.stringify({ chatKey: 'group:123', nextLocalId: 2, messages: [null] }),
    JSON.stringify({ chatKey: 'group:999', nextLocalId: 2, messages: [{ id: 1, text: 'old history' }] }),
    JSON.stringify({ chatKey: 'group:123', nextLocalId: 1, messages: [{ id: 1, text: 'old history' }] }),
  ];
  for (const content of invalid) {
    const dataDir = temporary(), messagesDir = path.join(dataDir, 'messages'); fs.mkdirSync(messagesDir);
    const file = path.join(messagesDir, 'group_123.json'); fs.writeFileSync(file, content);
    const store = new JSONChatStore(0, { dataDir });
    assert.throws(() => store.appendIncoming('group:123', { mid: 2, text: 'new' }), /原文件已保留/);
    assert.equal(fs.readFileSync(file, 'utf8'), content); store.close();
  }

  const dataDir = temporary(), messagesDir = path.join(dataDir, 'messages'); fs.mkdirSync(messagesDir);
  const file = path.join(messagesDir, 'group_123.json'), content = invalid[0]; fs.writeFileSync(file, content);
  const store = new JSONChatStore(0, { dataDir });
  const inbox = new EventInbox({ dataDir, maxAttempts: 1 });
  try {
    inbox.push({ mid: 2, text: 'must remain queued' });
    inbox.start(async event => { store.appendIncoming('group:123', event); });
    const deadline = Date.now() + 2000;
    while (inbox.stats().deadletter !== 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(inbox.stats().deadletter, 1); assert.equal(inbox.stats().completed, 0);
    assert.equal(inbox.stats().count, 1); assert.equal(fs.readFileSync(file, 'utf8'), content);
  } finally { await inbox.close(); store.close(); }

  const readFile = fs.readFileSync;
  fs.writeFileSync(file, JSON.stringify({ messages: [{ id: 8, text: 'valid old format', legacy: true }] }));
  fs.readFileSync = function(target, ...args) {
    if (String(target) === file) { const error = new Error('fixture denied'); error.code = 'EACCES'; throw error; }
    return readFile.call(this, target, ...args);
  };
  const inaccessible = new JSONChatStore(0, { dataDir });
  try { assert.throws(() => inaccessible.appendIncoming('group:123', { text: 'new' }), /无法读取聊天档案/); }
  finally { fs.readFileSync = readFile; inaccessible.close(); }
  const compatible = new JSONChatStore(0, { dataDir });
  try {
    assert.equal(compatible.recent('group:123')[0].text, 'valid old format');
    assert.equal(compatible.appendIncoming('group:123', { text: 'new' }).id, 9);
    assert.equal(compatible.recent('group:123')[0].legacy, true);
    assert.equal(compatible.appendIncoming('group:456', { text: 'new chat' }).id, 1);
  } finally { compatible.close(); }
});

test('SQLite matches JSON message, unread, recall, pagination, member and retention semantics', () => {
  const json = new JSONChatStore(0, { dataDir: temporary() });
  const sql = new SQLiteChatStore(0, { dataDir: temporary() });
  const stores = [json, sql];
  const key = 'group:123';
  function both(method, ...args) {
    const results = stores.map(store => store[method](...structuredClone(args)));
    assert.deepEqual(results[1], results[0], method);
    assert.deepEqual(sql.recent(key, { limit: 500 }), json.recent(key, { limit: 500 }), `${method}: history`);
    assert.deepEqual(sql.getChatMeta(key), json.getChatMeta(key), `${method}: meta`);
    assert.deepEqual(sql.activeMembers(key), json.activeMembers(key), `${method}: members`);
    assert.equal(sql.unreadCount(key), json.unreadCount(key), `${method}: unread`);
    return results[0];
  }
  try {
    both('getChatMeta', key);
    for (let i = 1; i <= 28; i++) {
      both('appendIncoming', key, { ...fixtureMessage(i), senderName: `昵称 ${i}`, ts: i % 4 ? 1700000000000 + i : 1700000000000,
        isPoke: i === 9 });
      if (i % 5 === 0) both('appendSelf', key, { text: `自己 ${i}`, ts: 1700000000000 + i, mid: i });
    }
    both('findByMid', key, -5);
    both('findByMid', key, null);
    both('findByLocalId', key, 7);
    both('findByLocalId', key, 'nonsense');
    both('peekUnread', key, 5);
    both('recent', key, { limit: 4, offset: 6, includeSelf: false });
    both('updateByMid', key, -5, { text: '已展开', appendMedia: [{ url: 'one', kind: 'image' }, { url: 'one' }, { url: 'two' }] });
    both('markRecalled', key, -9);
    both('markRecalled', key, 999);
    both('markAllRead', key);
    both('markUnreadInWindow', key, 1700000000008, 1700000000015);
    both('drainUnread', key);
    both('removeByLocalIds', key, [1, 2, 10, 999, 10]);
    both('removeByLocalIds', key, 8);
    both('muteUnread', key);
    both('setMaxPerChat', 3);
    both('appendIncoming', key, { mid: -900, text: '保留规则', ts: 1700000001000, senderId: 'a' });
    both('appendSelf', key, { text: '尾部', ts: 1700000001001 });
    both('clearChat', key);
    both('clearChat', key);
    assert.equal(both('appendIncoming', key, { text: '清空后 ID 不复用', ts: 1700000002000 }).id, 36);
    assert.deepEqual(sql.listChats(), json.listChats());
  } finally { for (const store of stores) store.close(); }
});

test('large unread batches and reads remain bounded without deleting or marking unseen entries read', () => {
  const sql = new SQLiteChatStore(0, { dataDir: temporary(), queryLimit: 3 });
  try {
    for (let i = 1; i <= 10; i++) sql.appendIncoming('group:1', { mid: i, ts: i, text: `m${i}` });
    assert.equal(sql.recent('group:1', { limit: 100000 }).length, 3);
    assert.deepEqual(sql.drainUnread('group:1').map(x => [x.id, x.read]), [[1, true], [2, true], [3, true]]);
    assert.equal(sql.unreadCount('group:1'), 7);
    assert.deepEqual(sql.peekUnread('group:1', 100000).map(x => x.id), [4, 5, 6]);
    assert.equal(sql.getChatMeta('group:1').total, 10);
    assert.equal(sql.drainUnread('group:1').length, 3);
    assert.equal(sql.drainUnread('group:1').length, 3);
    assert.equal(sql.drainUnread('group:1').length, 1);
    assert.equal(sql.unreadCount('group:1'), 0);
  } finally { sql.close(); }
});

test('message query byte budgets bound large payloads and keep an oversized first item drainable', () => {
  const sql = new SQLiteChatStore(0, { dataDir: temporary(), maxReadBytes: 2000 });
  try {
    for (let id = 1; id <= 10; id++) sql.appendIncoming('group:1', { mid: id, ts: id, text: 'x'.repeat(id === 1 ? 4000 : 1000) });
    assert.equal(sql.recent('group:1', { limit: 10 }).length, 1);
    assert.deepEqual(sql.drainUnread('group:1').map(x => x.id), [1]);
    assert.equal(sql.unreadCount('group:1'), 9);
    assert.deepEqual(sql.drainUnread('group:1').map(x => x.id), [2]);
    assert.equal(sql.getChatMeta('group:1').total, 10);
  } finally { sql.close(); }
});

test('Worker migration preserves fields/IDs/source and rollback keeps messages added after migration', async () => {
  const dataDir = temporary();
  const file = legacyFile(dataDir, { count: 20, nextLocalId: 41, reordered: true });
  const originalHash = hashFile(file);
  const original = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const migrated = await runStorageMaintenance({ operation: 'migrate', dataDir });
  assert.equal(migrated.messages, 20);
  assert.equal(hashFile(file), originalHash);
  const sql = new ChatStore(0, { dataDir, backend: 'auto' });
  assert.equal(sql.backend, 'sqlite');
  assert.deepEqual(sql.recent('group:123', { limit: 100 }), original.messages);
  assert.equal(sql.appendIncoming('group:123', { text: '迁移后的新消息', mid: -999, ts: 1700000100000 }).id, 41);
  sql.markRecalled('group:123', -2);
  sql.updateByMid('group:123', -5, { text: '修改后的文本' });
  const latest = sql.recent('group:123', { limit: 100 });
  const meta = sql.getChatMeta('group:123');
  sql.close();
  const outputDir = path.join(dataDir, 'export');
  const exported = await runStorageMaintenance({ operation: 'export', dataDir, outputDir });
  assert.equal(exported.messages, 21);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDir, 'group_123.json'), 'utf8')).messages, latest);
  assert.equal(hashFile(file), originalHash);
  await assert.rejects(runStorageMaintenance({ operation: 'export', dataDir, outputDir }), /已经存在/);
  const rolledBack = await runStorageMaintenance({ operation: 'rollback', dataDir });
  assert.equal(rolledBack.messages, 21);
  assert.ok(fs.existsSync(rolledBack.sqliteBackup));
  assert.equal(hashFile(path.join(rolledBack.previousJSON, 'group_123.json')), originalHash);
  const json = new ChatStore(0, { dataDir, backend: 'auto' });
  assert.equal(json.backend, 'json');
  assert.deepEqual(json.recent('group:123', { limit: 100 }), latest);
  assert.deepEqual(json.getChatMeta('group:123'), meta);
  assert.equal(json.appendSelf('group:123', { text: '回滚后的消息', ts: 1700000200000 }).id, 42);
  json.close();
  // Simulate a power loss after the JSON marker was written, but before the
  // old SQLite file was archived. A second rollback must not overwrite newer
  // JSON messages with this stale checkpoint.
  fs.copyFileSync(rolledBack.sqliteBackup, path.join(dataDir, SQLITE_FILE));
  await assert.rejects(runStorageMaintenance({ operation: 'rollback', dataDir }), /已经使用 JSON/);
  const stillLatest = new ChatStore(0, { dataDir, backend: 'auto' });
  assert.equal(stillLatest.getChatMeta('group:123').total, 22);
  stillLatest.close();
});

test('stream parser handles chunk boundaries/BOM/reordered fields and rejects malformed/oversized archives', async () => {
  const dataDir = temporary();
  const file = legacyFile(dataDir, { count: 1000, reordered: true });
  let count = 0;
  const parsed = await readLegacyChat(file, { onMessage: entry => { count++; assert.deepEqual(entry, fixtureMessage(count)); } });
  assert.equal(parsed.count, 1000); assert.equal(parsed.metadata.customMeta.kept, true);
  for (const [text, reason] of [
    ['{"chatKey":"group:1","nextLocalId":2,"messages":[', /不完整/],
    ['{"chatKey":"group:1","nextLocalId":2,"messages":[{"id":1,"ts":1},]}', /JSON 字段损坏/],
    ['{"messages":[],"nextLocalId":1,"nextLocalId":2}', /重复字段/],
    ['{"messages":[],"nextLocalId":1}false', /多余内容/],
  ]) {
    fs.writeFileSync(file, text); await assert.rejects(readLegacyChat(file), reason);
  }
  fs.writeFileSync(file, JSON.stringify({ messages: [{ id: 1, ts: 1, text: 'x'.repeat(2000) }], nextLocalId: 2 }));
  await assert.rejects(readLegacyChat(file, { maxRecordBytes: 1024 }), /超过/);
});

test('invalid IDs and running-instance locks prevent activation; retry is safe', async () => {
  const dataDir = temporary();
  const file = legacyFile(dataDir, { count: 20, nextLocalId: 5 });
  await assert.rejects(runStorageMaintenance({ operation: 'migrate', dataDir }), /nextLocalId/);
  assert.equal(fs.existsSync(path.join(dataDir, SQLITE_FILE)), false);
  assert.equal(resolveStorageBackend(dataDir), 'json');
  const text = fs.readFileSync(file, 'utf8').replace('"nextLocalId":5,', '"nextLocalId":21,');
  fs.writeFileSync(file, text);
  const configFile = path.join(dataDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ store: { backend: 'json' } }));
  await assert.rejects(runStorageMaintenance({ operation: 'migrate', dataDir }), /store.backend/);
  assert.equal(fs.existsSync(path.join(dataDir, SQLITE_FILE)), false);
  fs.unlinkSync(configFile);
  const lock = path.join(dataDir, 'qq-agent.lock'); fs.writeFileSync(lock, String(process.pid));
  await assert.rejects(runStorageMaintenance({ operation: 'migrate', dataDir }), /仍在运行/);
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid)); fs.unlinkSync(lock);
  await runStorageMaintenance({ operation: 'migrate', dataDir });
  assert.equal(resolveStorageBackend(dataDir), 'sqlite');
  assert.equal(fs.readdirSync(dataDir).filter(x => x.startsWith('.message-storage-')).length, 0);
});

test('interrupted migration leaves JSON unchanged and a subsequent migration reads 100000 messages', { timeout: 120000 }, async () => {
  const dataDir = temporary();
  const file = legacyFile(dataDir, { count: 100000 });
  const originalHash = hashFile(file);
  const cancel = new AbortController();
  await assert.rejects(runStorageMaintenance({ operation: 'migrate', dataDir }, {
    signal: cancel.signal,
    onProgress: value => { if (value.phase === 'import') cancel.abort(); },
  }), /取消|提前退出/);
  assert.equal(fs.existsSync(path.join(dataDir, SQLITE_FILE)), false);
  assert.equal(hashFile(file), originalHash);
  assert.equal(resolveStorageBackend(dataDir), 'json');
  const result = await runStorageMaintenance({ operation: 'migrate', dataDir });
  assert.equal(result.messages, 100000);
  const sql = new ChatStore(0, { dataDir, backend: 'auto' });
  assert.equal(sql.getChatMeta('group:123').total, 100000);
  assert.equal(sql.unreadCount('group:123'), 66667);
  assert.equal(sql.recent('group:123', { limit: 2000 }).length, 2000);
  assert.equal(sql.findByMid('group:123', -99999).id, 99999);
  assert.equal(sql.appendIncoming('group:123', { text: '继续增长', ts: 1800000000000 }).id, 100001);
  assert.equal(sql.getChatMeta('group:123').total, 100001);
  sql.close();
});
