// A small bounded JSON reader for the legacy { ..., messages: [ ... ] } format.
// It parses one message at a time rather than retaining the entire archive.
import fs from 'node:fs';
import crypto from 'node:crypto';

export async function readJsonObjectArray(file, { onMessage = () => {}, maxRecordBytes = 16 * 1024 * 1024, arrayField = 'messages', validateLegacy = false } = {}) {
  const before = fs.statSync(file);
  if (!before.isFile()) throw new Error(`消息档案不是普通文件：${file}`);
  const metadata = Object.create(null);
  const keys = new Set();
  const fileHash = crypto.createHash('sha256');
  const messageHash = crypto.createHash('sha256');
  let state = 'start', key = '', capture = null, count = 0, maxLocalId = 0;
  let metadataBytes = 0;
  let mayEnd = true, sawMessages = false, first = true;

  function fail(reason) { throw new Error(`${file}: ${reason}`); }
  function begin(char, done) {
    capture = { parts: [], fragment: char, length: Buffer.byteLength(char), depth: char === '{' || char === '[' ? 1 : 0,
      string: char === '"', escape: false, kind: char === '"' ? 'string' : char === '{' || char === '[' ? 'container' : 'primitive', done };
  }
  function finish() {
    const token = capture;
    capture = null;
    let value;
    try { value = JSON.parse(token.parts.join('') + token.fragment); } catch (error) { fail(`JSON 字段损坏：${error.message}`); }
    token.done(value, token.length);
  }
  function tokenChar(char) {
    const token = capture;
    if (token.kind === 'primitive' && /[\s,\]}]/.test(char)) { finish(); return false; }
    token.fragment += char;
    if (token.fragment.length >= 4096) {
      // Flatten each small fragment before retaining it. Keeping a multi-MiB
      // per-character V8 rope can consume far more heap than the JSON itself.
      token.parts.push(Buffer.from(token.fragment, 'utf8').toString('utf8'));
      token.fragment = '';
    }
    // Characters are sufficient for a cheap precheck; the exact UTF-8 byte limit
    // is checked before parsing, without building a second archive-sized buffer.
    token.length += Buffer.byteLength(char);
    if (token.length > maxRecordBytes) fail(`单个 JSON 字段或消息超过 ${maxRecordBytes} 字节上限`);
    if (token.string) {
      if (token.escape) token.escape = false;
      else if (char === '\\') token.escape = true;
      else if (char === '"') {
        token.string = false;
        if (token.kind === 'string') finish();
      }
    } else if (char === '"') token.string = true;
    else if (char === '{' || char === '[') token.depth++;
    else if (char === '}' || char === ']') {
      token.depth--;
      if (token.depth === 0) finish();
    }
    return true;
  }
  function message(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${arrayField} 中存在非对象条目`);
    if (validateLegacy) {
      if (!Number.isSafeInteger(value.id) || value.id < 1) fail('消息 local ID 必须是正整数');
      if (!Number.isFinite(Number(value.ts))) fail(`消息 ${value.id} 缺少有效时间戳`);
      maxLocalId = Math.max(maxLocalId, value.id);
    }
    messageHash.update(JSON.stringify(value)); messageHash.update('\n');
    onMessage(value);
    count++;
    state = 'arrayAfter';
  }
  function consume(char) {
    if (first) { first = false; if (char === '\uFEFF') return; }
    if (capture && tokenChar(char)) return;
    if (/\s/.test(char)) return;
    if (state === 'start') {
      if (char !== '{') fail('根节点必须是 JSON 对象');
      state = 'keyStart'; mayEnd = true;
    } else if (state === 'keyStart') {
      if (char === '}' && mayEnd) { state = 'done'; return; }
      if (char !== '"') fail('预期 JSON 字段名');
      begin(char, value => {
        if (keys.has(value)) fail(`重复字段：${value}`);
        keys.add(value); key = value; state = 'colon';
      });
    } else if (state === 'colon') {
      if (char !== ':') fail('字段名后缺少冒号');
      state = 'value';
    } else if (state === 'value') {
      if (key === arrayField) {
        if (char !== '[') fail(`${arrayField} 必须是数组`);
        sawMessages = true; state = 'arrayValue'; mayEnd = true;
      } else begin(char, (value, bytes) => {
        metadataBytes += bytes + Buffer.byteLength(key);
        if (metadataBytes > maxRecordBytes) fail(`顶层元数据超过 ${maxRecordBytes} 字节上限`);
        metadata[key] = value; state = 'afterValue';
      });
    } else if (state === 'arrayValue') {
      if (char === ']' && mayEnd) { state = 'afterValue'; return; }
      begin(char, message);
    } else if (state === 'arrayAfter') {
      if (char === ']') state = 'afterValue';
      else if (char === ',') { state = 'arrayValue'; mayEnd = false; }
      else fail('消息后预期逗号或数组结束');
    } else if (state === 'afterValue') {
      if (char === '}') state = 'done';
      else if (char === ',') { state = 'keyStart'; mayEnd = false; }
      else fail('字段后预期逗号或对象结束');
    } else if (state === 'done') fail('JSON 根对象后存在多余内容');
  }
  for await (const chunk of fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 })) {
    fileHash.update(chunk);
    for (const char of chunk) consume(char);
  }
  if (capture || state !== 'done' || !sawMessages) fail(`消息档案不完整或缺少 ${arrayField} 数组`);
  const after = fs.statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) fail('迁移期间源档案发生变化，已中止');
  if (validateLegacy && (!Number.isSafeInteger(metadata.nextLocalId) || metadata.nextLocalId < maxLocalId + 1)) fail('nextLocalId 无效或小于已有消息 ID');
  return { metadata, count, maxLocalId, fileHash: fileHash.digest('hex'), messageHash: messageHash.digest('hex') };
}

export function readLegacyChat(file, options = {}) {
  return readJsonObjectArray(file, { ...options, validateLegacy: true });
}
