import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness(api) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', scrollTop: 0, scrollHeight: 1000, style: {}, addEventListener() {},
      querySelector: selector => node(selector), insertAdjacentHTML(_position, html) { this.innerHTML += html; } });
    return nodes.get(id);
  };
  const state = { currentChatKey: 'group:100', chats: [], chatMessages: [], activeInst: { self: true, id: 'local' } };
  const context = vm.createContext({ state, api, console, CHAT_MSG_PAGE: 500, CHAT_MSG_MORE: 200, $: node, $$: () => [],
    esc: String, fmtTime: String, formatChatTitle: key => key, chatNameOf: () => '', initChatScrollLoader() {} });
  vm.runInContext(fs.readFileSync(new URL('../ui/app/04-archive-usage.js', import.meta.url), 'utf8'), context);
  return { state, context, nodes };
}
const records = Array.from({ length: 2101 }, (_v, i) => ({ id: i + 1, mid: i + 1, ts: i + 1, text: `message ${i + 1}`, senderName: 'test', read: true }));
function page(rows, path) {
  const url = new URL(path, 'http://localhost');
  const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
  const end = Math.max(0, rows.length - offset), messages = rows.slice(Math.max(0, end - limit), end);
  return { messages, total: rows.length, nextOffset: offset + messages.length, hasMore: offset + messages.length < rows.length };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('archive scrolling requests bounded server pages until messages older than 2000 are visible', async () => {
  const calls = [];
  const h = harness(async path => { calls.push(path); return page(records, path); });
  await h.context.loadChatMessages('group:100');
  assert.equal(h.state.chatMessages.length, 500); assert.equal(h.state.chatMessageTotal, 2101);
  assert.match(h.nodes.get('#chat-msg-more').textContent, /还有 1601 条/);
  assert.equal((h.nodes.get('#chat-msg-body').innerHTML.match(/<tr /g) || []).length, 500);
  await h.context.loadMoreChatMessages();
  assert.equal(h.state.chatMessages.length, 700); assert.equal(calls[1], '/api/chats/group_100/messages?limit=200&offset=500');
  while (h.state.chatHasMore) await h.context.loadMoreChatMessages();
  assert.equal(h.state.chatMessages.length, 2101); assert.equal(h.state.chatNextOffset, 2101);
  assert.match(h.nodes.get('#chat-msg-body').innerHTML, /message 1<\/td>/);
  assert.match(h.nodes.get('#chat-msg-more').textContent, /已显示全部 2101 条/);
  assert.ok(calls.every(path => Number(new URL(path, 'http://localhost').searchParams.get('limit')) <= 500));
});

test('archive refresh preserves loaded history and reads each page separately', async () => {
  const calls = [], current = [...records];
  const h = harness(async path => { calls.push(path); return page(current, path); });
  await h.context.loadChatMessages('group:100'); await h.context.loadMoreChatMessages();
  calls.length = 0; current.push({ ...records.at(-1), id: 2102, mid: 2102, text: 'new message', ts: 2102 });
  await h.context.loadChatMessages('group:100', { keepView: true });
  assert.equal(h.state.chatMessages.length, 700); assert.equal(h.state.chatMsgLimit, 700); assert.equal(h.state.chatMessageTotal, 2102);
  assert.deepEqual(calls, ['/api/chats/group_100/messages?limit=500&offset=0', '/api/chats/group_100/messages?limit=200&offset=500']);
  assert.match(h.nodes.get('#chat-msg-body').innerHTML, /new message/);
});

test('a byte-limited first page stays bounded and scrolling advances by its actual row count', async () => {
  const calls = [];
  const h = harness(async path => {
    calls.push(path);
    const url = new URL(path, 'http://localhost');
    url.searchParams.set('limit', 3);
    return page(records, url.href);
  });
  await h.context.loadChatMessages('group:100');
  assert.equal(calls.length, 1); assert.equal(h.state.chatMessages.length, 3); assert.equal(h.state.chatNextOffset, 3);
  await h.context.loadMoreChatMessages();
  assert.equal(calls[1], '/api/chats/group_100/messages?limit=200&offset=3');
  assert.equal(h.state.chatMessages.length, 6); assert.equal(h.state.chatNextOffset, 6);
});

test('archive requests coalesce and old instance or A-B-A responses cannot overwrite the selected archive', async () => {
  const requests = [];
  const h = harness(path => { const d = deferred(); requests.push({ ...d, path }); return d.promise; });
  const a1 = h.context.loadChatMessages('group:100');
  assert.equal(h.context.loadChatMessages('group:100', { keepView: true }), a1);
  h.state.currentChatKey = 'group:200'; const b = h.context.loadChatMessages('group:200');
  h.state.currentChatKey = 'group:100'; const a2 = h.context.loadChatMessages('group:100');
  requests[0].resolve(page([{ ...records[0], text: 'old A' }], requests[0].path)); await a1;
  requests[1].resolve(page([{ ...records[0], text: 'old B' }], requests[1].path)); await b;
  assert.equal(h.state.chatMessages.length, 0);
  requests[2].resolve(page([{ ...records[0], text: 'current A' }], requests[2].path)); await a2;
  assert.equal(h.state.chatMessages[0].text, 'current A');
  const local = h.context.loadChatMessages('group:100', { keepView: true });
  h.state.activeInst = { self: false, id: 'peer' };
  const peer = h.context.loadChatMessages('group:100');
  requests[4].resolve(page([{ ...records[0], text: 'peer' }], requests[4].path)); await peer;
  requests[3].resolve(page([{ ...records[0], text: 'stale local' }], requests[3].path)); await local;
  assert.equal(h.state.chatMessages[0].text, 'peer');
});
