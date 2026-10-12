import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-archive-media-'));
process.env.QQ_AGENT_DATA_DIR = dir; process.env.QQ_AGENT_MODE = 'server';
const { createRoutes } = await import('../src/routes.js');
const { SQLiteChatStore } = await import('../src/sqlite-store.js');
const { JSONChatStore } = await import('../src/store.js');
const { DEFAULT_CONFIG, deepMerge, setRuntimeConfig } = await import('../src/config.js');
const { mediaWork } = await import('../src/media-resources.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
function configure(patch = {}) { setRuntimeConfig(deepMerge(DEFAULT_CONFIG, { resources: { mediaMaxBytesMB: 1, mediaConcurrency: 1 }, ...patch })); }
function archiveRoute(store) { return createRoutes({ store }).find(route => String(route.pattern).includes('messages$')).handler; }
async function archive(handler, query = '') {
  let result;
  await handler({ res: {}, match: ['', 'group', '100'], url: new URL(`http://localhost/api/chats/group_100/messages${query}`), json: (_res, code, body) => { result = { code, body }; } });
  return result;
}

test('JSON and SQLite archive APIs page all 2101 records beyond the old 2000-item window', async () => {
  const stores = [new SQLiteChatStore(0, { databaseFile: ':memory:' }), new JSONChatStore(0, { dataDir: dir })];
  try {
    // A legacy JSON fixture avoids rewriting the same whole archive 2101 times.
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages', 'group_100.json'), JSON.stringify({ chatKey: 'group:100', nextLocalId: 2102,
      messages: Array.from({ length: 2101 }, (_v, i) => ({ id: i + 1, mid: i + 1, text: `message ${i + 1}`, ts: i + 1, self: true, read: true })) }));
    for (let i = 1; i <= 2101; i++) stores[0].appendSelf('group:100', { mid: i, text: `message ${i}`, ts: i });
    for (const store of stores) {
      const handler = archiveRoute(store);
      const first = await archive(handler, '?limit=100000');
      assert.equal(first.code, 200); assert.equal(first.body.messages.length, 500); assert.equal(first.body.total, 2101);
      assert.equal(first.body.messages[0].mid, 1602); assert.equal(first.body.hasMore, true);
      const oldest = await archive(handler, '?limit=500&offset=2000');
      assert.equal(oldest.body.messages.length, 101); assert.equal(oldest.body.messages[0].mid, 1); assert.equal(oldest.body.hasMore, false);
      const ids = new Set(); let offset = 0;
      while (true) {
        const { body } = await archive(handler, `?limit=500&offset=${offset}`);
        for (const message of body.messages) { assert.equal(ids.has(message.id), false); ids.add(message.id); }
        if (!body.hasMore) break;
        assert.ok(body.nextOffset > offset); offset = body.nextOffset;
      }
      assert.equal(ids.size, 2101);
      for (const query of ['?offset=-1', '?offset=1.5', '?offset=Infinity', '?limit=NaN', '?limit=0']) assert.equal((await archive(handler, query)).code, 400);
    }
  } finally { for (const store of stores) store.close?.(); }
});

test('archive nextOffset advances by returned rows when the SQLite byte budget ends a short page', async () => {
  const store = new SQLiteChatStore(0, { databaseFile: ':memory:', maxReadBytes: 350 });
  try {
    for (let i = 1; i <= 8; i++) store.appendSelf('group:100', { mid: i, text: 'x'.repeat(150), ts: i });
    const handler = archiveRoute(store); const all = []; let offset = 0;
    while (true) {
      const { body } = await archive(handler, `?limit=500&offset=${offset}`);
      assert.equal(body.messages.length, 1); assert.equal(body.nextOffset, offset + 1); all.push(body.messages[0].mid);
      if (!body.hasMore) break;
      offset = body.nextOffset;
    }
    assert.deepEqual(all, [8, 7, 6, 5, 4, 3, 2, 1]);
  } finally { store.close(); }
});

function mediaHandler(items, call) { return createRoutes({ readBody: async () => ({ items }), onebot: { call } }).find(route => route.pattern === '/api/media-data').handler; }
async function media(handler, res = {}) {
  let result;
  await handler({ req: {}, res, json: (_res, code, body) => { result = { code, body }; } });
  return result;
}
const file = (name, bytes) => { const location = path.join(dir, name); fs.writeFileSync(location, Buffer.alloc(bytes, 1)); return location; };

test('media response bounds the whole batch, rejects excess input explicitly and preserves successful positions', async () => {
  configure();
  const image = file('medium.png', 600 * 1024);
  const over = await media(mediaHandler([{ file: 'one' }, { file: 'two' }], async () => ({ file: image })));
  assert.equal(over.code, 413); assert.match(over.body.error, /图片总大小超过 1 MiB/); assert.deepEqual(over.body.results, []);
  const large = file('large.png', 1024 * 1024 + 1);
  assert.equal((await media(mediaHandler([{ file: 'big' }], async () => ({ file: large })))).code, 413);
  const tooMany = Array.from({ length: 21 }, () => ({ file: 'one' }));
  assert.equal((await media(mediaHandler(tooMany, async () => assert.fail('oversized count must not call OneBot')))).code, 413);
  const small = file('small.png', 128);
  const ok = await media(mediaHandler([{ file: 'missing' }, { file: 'image' }], async (_action, args) => args.file === 'missing' ? {} : { file: small }));
  assert.equal(ok.code, 200); assert.equal(ok.body.results[0], null);
  assert.equal(Buffer.from(ok.body.results[1].dataUrl.split(',')[1], 'base64').length, 128);
});

test('remote downloads use the remaining aggregate budget and private-host guards stay active', async () => {
  configure();
  const remote = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.alloc(600 * 1024)); });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${remote.address().port}/image.png`;
    const blocked = await media(mediaHandler([{ url }], async () => ({})));
    assert.equal(blocked.code, 200); assert.equal(blocked.body.results[0], null);
    configure({ security: { allowPrivateImageHosts: true } });
    const image = file('remote-first.png', 600 * 1024);
    const result = await media(mediaHandler([{ file: 'local' }, { file: 'remote', url }], async (_action, args) => args.file === 'local' ? { file: image } : {}));
    assert.equal(result.code, 413); assert.deepEqual(result.body.results, []);
  } finally { remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); }
});

test('external OneBot never reads a coincidentally matching local file and uses guarded remote URLs', async () => {
  configure({ snowluma: { mode: 'external' }, security: { allowPrivateImageHosts: true } });
  const local = file('external-name-collision.png', 128);
  const remote = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.alloc(64, 7)); });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  try {
    const unavailable = await media(mediaHandler([{ file: 'remote-image' }], async () => ({ file: local })));
    assert.equal(unavailable.code, 200); assert.equal(unavailable.body.results[0], null);
    const url = `http://127.0.0.1:${remote.address().port}/external-name-collision.png`;
    for (const source of ['ret', 'item']) {
      const result = await media(mediaHandler([{ file: 'remote-image', ...(source === 'item' ? { url } : {}) }], async () => ({ file: local, ...(source === 'ret' ? { url } : {}) })));
      assert.equal(result.code, 200);
      assert.deepEqual(Buffer.from(result.body.results[0].dataUrl.split(',')[1], 'base64'), Buffer.alloc(64, 7));
    }
  } finally { remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); }
});

test('slow responses hold the shared media concurrency slot until finish or close', async () => {
  configure();
  const image = file('concurrent.png', 128); let calls = 0;
  const handler = mediaHandler([{ file: 'one' }], async () => { calls++; return { file: image }; });
  const first = new EventEmitter(), second = new EventEmitter();
  const p1 = media(handler, first); const p2 = media(handler, second);
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 1); assert.deepEqual(mediaWork.status(), { active: 1, pending: 1 });
    first.emit('finish'); await p1;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2); assert.equal(mediaWork.status().active, 1);
    second.emit('close'); await p2;
  } finally {
    first.emit('finish'); second.emit('close'); await Promise.all([p1, p2]);
  }
});
