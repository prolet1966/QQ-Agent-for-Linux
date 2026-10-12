// Offline maintenance runs in a Worker so migration/export never loads history
// into the web server heap. The caller holds the same lock as the QQA core.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { SQLITE_FILE, STORAGE_STATE_FILE, openMessageDatabase, decodeMessage } from './sqlite-store.js';
import { readLegacyChat } from './storage-json-stream.js';

const { operation, dataDir, outputDir, stageDir, maxRecordBytes } = workerData;
const databaseFile = path.join(dataDir, SQLITE_FILE);
let database;

function progress(value) { parentPort.postMessage({ progress: value }); }
function writeAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function writeAll(fd, value) {
  const buffer = Buffer.from(value);
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
}
function recordManifest(value) {
  writeAtomic(path.join(dataDir, STORAGE_STATE_FILE), { version: 1, updatedAt: new Date().toISOString(), ...value });
}

async function migrate() {
  if (fs.existsSync(databaseFile)) throw new Error('SQLite 消息数据库已经存在；拒绝覆盖。请先核对当前存储状态。');
  const sourceDir = path.join(dataDir, 'messages');
  const files = fs.existsSync(sourceDir) ? fs.readdirSync(sourceDir).filter(file => /\.json$/i.test(file)).sort() : [];
  if (files.length > 100000) throw new Error('消息会话文件数量超过迁移工具的 100000 上限');
  const stagedDatabase = path.join(stageDir, SQLITE_FILE);
  database = openMessageDatabase(stagedDatabase);
  const addChat = database.prepare('INSERT INTO chats(chat_key) VALUES(?)');
  const insert = database.prepare(`INSERT INTO messages(chat_key,local_id,mid_key,sender_key,ts,is_read,is_self,payload) VALUES(?,?,?,?,?,?,?,?)`);
  const update = database.prepare('UPDATE chats SET next_local_id=?,metadata=? WHERE chat_key=?');
  const select = database.prepare('SELECT payload FROM messages WHERE chat_key=? ORDER BY seq');
  const manifest = [];
  let messages = 0;
  for (const file of files) {
    const filename = /^(group|private)_(\d+)\.json$/.exec(file);
    if (!filename) throw new Error(`未知消息文件 ${file}；拒绝静默跳过历史。请先导出或检查该文件。`);
    const chatKey = `${filename[1]}:${filename[2]}`;
    const sourceFile = path.join(sourceDir, file);
    if (fs.lstatSync(sourceFile).isSymbolicLink()) throw new Error(`迁移不跟随符号链接：${file}`);
    addChat.run(chatKey);
    let inBatch = 0;
    database.exec('BEGIN IMMEDIATE');
    let parsed;
    try {
      parsed = await readLegacyChat(sourceFile, {
        maxRecordBytes,
        onMessage: entry => {
          insert.run(chatKey, entry.id, String(entry.mid), String(entry.senderId), Number(entry.ts), Number(Boolean(entry.read)), Number(Boolean(entry.self)), JSON.stringify(entry));
          messages++; inBatch++;
          if (inBatch >= 500) {
            database.exec('COMMIT; BEGIN IMMEDIATE'); inBatch = 0;
            progress({ phase: 'import', chatKey, messages });
          }
        },
      });
      if (parsed.metadata.chatKey !== chatKey) throw new Error(`${file}: chatKey 与文件名不一致，拒绝错误归档`);
      update.run(parsed.metadata.nextLocalId, JSON.stringify(parsed.metadata), chatKey);
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
    const hash = crypto.createHash('sha256');
    let verified = 0;
    for (const row of select.iterate(chatKey)) { hash.update(row.payload); hash.update('\n'); verified++; }
    if (verified !== parsed.count || hash.digest('hex') !== parsed.messageHash) throw new Error(`${file}: 迁移后数量或消息字段校验不一致`);
    const counters = database.prepare('SELECT total,unread,incoming_unread FROM chats WHERE chat_key=?').get(chatKey);
    const actual = database.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(is_read=0),0) AS unread,
      COALESCE(SUM(is_read=0 AND is_self=0),0) AS incoming_unread FROM messages WHERE chat_key=?`).get(chatKey);
    if (JSON.stringify(counters) !== JSON.stringify(actual)) throw new Error(`${file}: 未读索引校验不一致`);
    manifest.push({ file, chatKey, messages: parsed.count, sha256: parsed.fileHash, messageSha256: parsed.messageHash });
    progress({ phase: 'verified', chatKey, messages, chats: manifest.length });
  }
  const integrity = database.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') throw new Error(`SQLite 完整性校验失败：${integrity}`);
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  database.close(); database = null;
  const backupManifest = path.join(dataDir, `message-migration-${crypto.randomUUID()}.json`);
  writeAtomic(backupManifest, { version: 1, createdAt: new Date().toISOString(), source: sourceDir, sourcePreserved: true, chats: manifest, messages });
  // Nothing becomes visible to auto mode until every archive has been verified.
  // A kill before this rename leaves the untouched JSON backend in place.
  fs.renameSync(stagedDatabase, databaseFile);
  recordManifest({ backend: 'sqlite', migrationManifest: path.basename(backupManifest) });
  return { backend: 'sqlite', chats: manifest.length, messages, databaseFile, sourcePreserved: sourceDir, migrationManifest: backupManifest };
}

async function exportSQLite(destination) {
  const results = [];
  const usedNames = new Set();
  const chats = database.prepare('SELECT chat_key,next_local_id,metadata,total FROM chats ORDER BY rowid');
  const messages = database.prepare('SELECT payload,is_read,is_self FROM messages WHERE chat_key=? ORDER BY seq');
  database.exec('BEGIN');
  try {
    for (const chat of chats.iterate()) {
      const filename = `${chat.chat_key.replace(/[^a-z0-9_]/gi, '_')}.json`;
      if (usedNames.has(filename)) throw new Error(`会话导出文件名冲突：${chat.chat_key}`);
      usedNames.add(filename);
      const target = path.join(destination, filename);
      const meta = { ...JSON.parse(chat.metadata), chatKey: chat.chat_key, nextLocalId: chat.next_local_id };
      delete meta.messages;
      const fd = fs.openSync(target, 'wx', 0o600);
      const hash = crypto.createHash('sha256');
      let count = 0;
      try {
        writeAll(fd, `${JSON.stringify(meta).slice(0, -1)},"messages":[`);
        for (const row of messages.iterate(chat.chat_key)) {
          const payload = JSON.stringify(decodeMessage(row));
          writeAll(fd, `${count ? ',' : ''}${payload}`);
          hash.update(payload); hash.update('\n'); count++;
        }
        writeAll(fd, ']}\n'); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      if (count !== chat.total) throw new Error(`导出消息数量与索引不一致：${chat.chat_key}`);
      const actual = await readLegacyChat(target, { maxRecordBytes });
      if (actual.count !== count || actual.metadata.nextLocalId !== chat.next_local_id || actual.messageHash !== hash.digest('hex')) {
        throw new Error(`导出校验失败：${chat.chat_key}`);
      }
      results.push({ chatKey: chat.chat_key, file: filename, messages: count, sha256: actual.fileHash });
      progress({ phase: 'export', chats: results.length, chatKey: chat.chat_key });
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return { chats: results.length, messages: results.reduce((sum, item) => sum + item.messages, 0), files: results };
}

async function run() {
  fs.mkdirSync(stageDir, { recursive: false, mode: 0o700 });
  if (operation === 'migrate') return migrate();
  const markerFile = path.join(dataDir, STORAGE_STATE_FILE);
  if (fs.existsSync(markerFile)) {
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    if (marker.backend === 'json') throw new Error('当前已经使用 JSON 后端；残留 SQLite 可能是旧检查点，拒绝用它覆盖或冒充最新消息。');
    if (marker.backend !== 'sqlite') throw new Error('消息存储选择文件包含未知后端');
  }
  if (!fs.existsSync(databaseFile)) throw new Error('找不到 SQLite 消息数据库。');
  database = openMessageDatabase(databaseFile, { readOnly: operation !== 'rollback' });
  const stagedMessages = path.join(stageDir, 'messages');
  fs.mkdirSync(stagedMessages, { mode: 0o700 });
  const result = await exportSQLite(stagedMessages);
  if (operation === 'export') {
    database.close(); database = null;
    // A destination must be absent. Do not overwrite an older export.
    if (fs.existsSync(outputDir)) throw new Error(`导出目录已经存在：${outputDir}`);
    fs.renameSync(stagedMessages, outputDir);
    return { ...result, outputDir };
  }
  if (operation !== 'rollback') throw new Error(`未知存储操作：${operation}`);
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); database.close(); database = null;
  const previousJSON = path.join(dataDir, `messages-json-before-rollback-${crypto.randomUUID()}`);
  const messagesDir = path.join(dataDir, 'messages');
  if (fs.existsSync(messagesDir)) fs.renameSync(messagesDir, previousJSON);
  try { fs.renameSync(stagedMessages, messagesDir); }
  catch (error) {
    if (fs.existsSync(previousJSON)) fs.renameSync(previousJSON, messagesDir);
    throw error;
  }
  // Set the marker only after latest data is installed. Until then auto mode
  // still uses the original SQLite database, including all post-migration data.
  recordManifest({ backend: 'json', previousJSON: path.basename(previousJSON) });
  const sqliteBackup = path.join(dataDir, `messages-before-rollback-${crypto.randomUUID()}.sqlite`);
  fs.renameSync(databaseFile, sqliteBackup);
  return { ...result, backend: 'json', messagesDir, sqliteBackup, previousJSON };
}

try {
  const result = await run();
  parentPort.postMessage({ result });
} catch (error) {
  try { database?.close(); } catch { /* preserve the original failure */ }
  parentPort.postMessage({ error: error.message, stack: error.stack });
}
