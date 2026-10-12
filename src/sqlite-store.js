// Incremental, indexed message storage. SQLite is loaded lazily so older
// Electron runtimes can continue to open their existing JSON data.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const SQLITE_FILE = 'messages.sqlite';
export const STORAGE_STATE_FILE = 'message-storage.json';
export const DEFAULT_QUERY_LIMIT = 2000;

export function sqliteAvailable() {
  try { return typeof require('node:sqlite').DatabaseSync === 'function'; } catch { return false; }
}

export function openMessageDatabase(file, { readOnly = false } = {}) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch {
    throw new Error('SQLite 消息存储需要 Node.js 22.16 或更新版本；旧运行时请继续使用 JSON 后端。');
  }
  const db = new DatabaseSync(file, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE;');
    const version = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (version > 1) throw new Error(`消息数据库版本 ${version} 比当前程序支持的版本新，拒绝降级写入。`);
    if (!readOnly) {
      // The ingress acknowledgement and replay key must outlive a sudden power
      // loss as well as a normal process restart. WAL FULL syncs each commit.
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS chats (
          chat_key TEXT PRIMARY KEY, next_local_id INTEGER NOT NULL DEFAULT 1,
          metadata TEXT NOT NULL DEFAULT '{}', total INTEGER NOT NULL DEFAULT 0,
          unread INTEGER NOT NULL DEFAULT 0, incoming_unread INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_key TEXT NOT NULL REFERENCES chats(chat_key),
          local_id INTEGER NOT NULL, mid_key TEXT NOT NULL, sender_key TEXT NOT NULL,
          ts REAL NOT NULL, is_read INTEGER NOT NULL, is_self INTEGER NOT NULL, payload TEXT NOT NULL,
          UNIQUE(chat_key, local_id)
        );
        CREATE INDEX IF NOT EXISTS messages_chat_seq ON messages(chat_key, seq DESC);
        CREATE INDEX IF NOT EXISTS messages_chat_mid ON messages(chat_key, mid_key, seq);
        CREATE INDEX IF NOT EXISTS messages_source_event ON messages(chat_key, json_extract(payload,'$.sourceEventKey'), seq);
        CREATE INDEX IF NOT EXISTS messages_unread ON messages(chat_key, is_read, is_self, seq);
        CREATE INDEX IF NOT EXISTS messages_time ON messages(chat_key, ts, is_read, is_self);
        CREATE INDEX IF NOT EXISTS messages_members ON messages(chat_key, sender_key, is_self, ts DESC, seq);
        CREATE TABLE IF NOT EXISTS members (
          chat_key TEXT NOT NULL, sender_key TEXT NOT NULL, name TEXT NOT NULL,
          last_ts REAL NOT NULL, last_seq INTEGER NOT NULL, first_seq INTEGER NOT NULL, count INTEGER NOT NULL,
          PRIMARY KEY(chat_key, sender_key)
        );
        CREATE INDEX IF NOT EXISTS members_recent ON members(chat_key, last_ts DESC);
        CREATE TRIGGER IF NOT EXISTS message_insert AFTER INSERT ON messages BEGIN
          UPDATE chats SET total=total+1, unread=unread+(NEW.is_read=0),
            incoming_unread=incoming_unread+(NEW.is_read=0 AND NEW.is_self=0) WHERE chat_key=NEW.chat_key;
          INSERT INTO members(chat_key,sender_key,name,last_ts,last_seq,first_seq,count)
            SELECT NEW.chat_key,NEW.sender_key,COALESCE(json_extract(NEW.payload,'$.senderName'),''),NEW.ts,NEW.seq,NEW.seq,1
            WHERE NEW.is_self=0
            ON CONFLICT(chat_key,sender_key) DO UPDATE SET count=count+1,
              name=CASE WHEN excluded.last_ts>members.last_ts THEN excluded.name ELSE members.name END,
              last_seq=CASE WHEN excluded.last_ts>members.last_ts THEN excluded.last_seq ELSE members.last_seq END,
              last_ts=MAX(excluded.last_ts,members.last_ts);
        END;
        CREATE TRIGGER IF NOT EXISTS message_read AFTER UPDATE OF is_read ON messages BEGIN
          UPDATE chats SET unread=unread+(NEW.is_read=0)-(OLD.is_read=0),
            incoming_unread=incoming_unread+(NEW.is_read=0 AND NEW.is_self=0)-(OLD.is_read=0 AND OLD.is_self=0)
            WHERE chat_key=NEW.chat_key;
        END;
        CREATE TRIGGER IF NOT EXISTS message_delete AFTER DELETE ON messages BEGIN
          UPDATE chats SET total=total-1, unread=unread-(OLD.is_read=0),
            incoming_unread=incoming_unread-(OLD.is_read=0 AND OLD.is_self=0) WHERE chat_key=OLD.chat_key;
          UPDATE members SET count=count-1 WHERE chat_key=OLD.chat_key AND sender_key=OLD.sender_key AND OLD.is_self=0;
          DELETE FROM members WHERE chat_key=OLD.chat_key AND sender_key=OLD.sender_key AND count=0;
          UPDATE members SET first_seq=(SELECT MIN(seq) FROM messages WHERE chat_key=OLD.chat_key AND sender_key=OLD.sender_key AND is_self=0)
            WHERE chat_key=OLD.chat_key AND sender_key=OLD.sender_key AND first_seq=OLD.seq AND OLD.is_self=0;
          UPDATE members SET
            name=COALESCE((SELECT json_extract(payload,'$.senderName') FROM messages
              WHERE chat_key=OLD.chat_key AND sender_key=OLD.sender_key AND is_self=0 ORDER BY ts DESC,seq LIMIT 1),''),
            last_ts=(SELECT ts FROM messages WHERE chat_key=OLD.chat_key AND sender_key=OLD.sender_key AND is_self=0 ORDER BY ts DESC,seq LIMIT 1),
            last_seq=(SELECT seq FROM messages WHERE chat_key=OLD.chat_key AND sender_key=OLD.sender_key AND is_self=0 ORDER BY ts DESC,seq LIMIT 1)
            WHERE chat_key=OLD.chat_key AND sender_key=OLD.sender_key AND last_seq=OLD.seq AND OLD.is_self=0;
        END;
        PRAGMA user_version=1;
      `);
      if (file !== ':memory:') fs.chmodSync(file, 0o600);
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

export function decodeMessage(row) {
  if (!row) return null;
  const message = JSON.parse(row.payload);
  // Read flags are separate indexed columns; changing a whole unread batch does
  // not rewrite every JSON payload. All other fields retain their original type.
  message.read = Boolean(row.is_read);
  message.self = Boolean(row.is_self);
  return message;
}

function positiveLimit(value, fallback, ceiling) {
  return Math.min(ceiling, Math.max(1, Math.floor(Number(value) || fallback)));
}

export class SQLiteChatStore {
  constructor(maxPerChat = 0, { dataDir, databaseFile, queryLimit = DEFAULT_QUERY_LIMIT, maxReadBytes = 8 * 1024 * 1024 } = {}) {
    if (!dataDir && !databaseFile) throw new Error('SQLiteChatStore requires dataDir');
    this.backend = 'sqlite';
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.queryLimit = positiveLimit(queryLimit, DEFAULT_QUERY_LIMIT, 10000);
    this.maxReadBytes = positiveLimit(maxReadBytes, 8 * 1024 * 1024, 32 * 1024 * 1024);
    this.databaseFile = databaseFile || path.join(dataDir, SQLITE_FILE);
    if (this.databaseFile !== ':memory:') fs.mkdirSync(path.dirname(this.databaseFile), { recursive: true });
    this.db = openMessageDatabase(this.databaseFile);
    this.statements = new Map();
    this.closed = false;
  }

  #query(sql) {
    if (this.closed) throw new Error('消息存储已经关闭');
    if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql));
    return this.statements.get(sql);
  }
  #ensure(chatKey) {
    this.#query('INSERT OR IGNORE INTO chats(chat_key) VALUES(?)').run(String(chatKey));
    return String(chatKey);
  }
  #messageRows(query, ...parameters) {
    const rows = [];
    let bytes = 0;
    for (const row of query.iterate(...parameters)) {
      const size = Buffer.byteLength(row.payload);
      // At least one message is returned, including a valid large legacy item,
      // so a large first unread message cannot permanently stall the backlog.
      if (rows.length && bytes + size > this.maxReadBytes) break;
      rows.push(row); bytes += size;
    }
    return rows;
  }
  #transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  setMaxPerChat(cap) { this.maxPerChat = Math.max(0, Number(cap) || 0); }

  listChats({ limit = this.queryLimit, offset = 0 } = {}) {
    return this.#query('SELECT chat_key FROM chats ORDER BY rowid LIMIT ? OFFSET ?')
      .all(positiveLimit(limit, this.queryLimit, this.queryLimit), Math.max(0, Math.floor(Number(offset) || 0)))
      .map(row => row.chat_key);
  }
  chatCount() { return this.#query('SELECT COUNT(*) AS count FROM chats').get().count; }

  getChatMeta(chatKey) {
    chatKey = this.#ensure(chatKey);
    const row = this.#query('SELECT total, unread FROM chats WHERE chat_key=?').get(chatKey);
    const last = decodeMessage(this.#query('SELECT payload,is_read,is_self FROM messages WHERE chat_key=? ORDER BY seq DESC LIMIT 1').get(chatKey));
    return { chatKey, total: row.total, unread: row.unread, lastTs: last?.ts ?? 0, lastText: last?.text ?? '' };
  }

  #append(chatKey, fields) {
    chatKey = String(chatKey);
    return this.#transaction(() => {
      this.#ensure(chatKey);
      const id = this.#query('SELECT next_local_id FROM chats WHERE chat_key=?').get(chatKey).next_local_id;
      const entry = { id, ...fields };
      const payload = JSON.stringify(entry);
      if (Buffer.byteLength(payload) > 16 * 1024 * 1024) throw new Error('单条存档消息超过 16 MiB 上限');
      this.#query(`INSERT INTO messages(chat_key,local_id,mid_key,sender_key,ts,is_read,is_self,payload)
        VALUES(?,?,?,?,?,?,?,?)`).run(chatKey, id, String(entry.mid), String(entry.senderId), entry.ts, Number(entry.read), Number(entry.self), payload);
      this.#query('UPDATE chats SET next_local_id=? WHERE chat_key=?').run(id + 1, chatKey);
      if (this.maxPerChat > 0) this.#query(`DELETE FROM messages WHERE chat_key=? AND seq IN
        (SELECT seq FROM messages WHERE chat_key=? ORDER BY seq DESC LIMIT -1 OFFSET ?)`).run(chatKey, chatKey, Math.floor(this.maxPerChat));
      return entry;
    });
  }
  appendIncoming(chatKey, { mid, ts, senderId, senderName, text, reply = null, media = [], isPoke = false, sourceEventKey = null }) {
    return this.#append(chatKey, { mid: mid ?? null, ts: ts || Date.now(), senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''), text: String(text ?? ''), self: false, read: false,
      reply: reply || null, media: Array.isArray(media) ? media : [], isPoke: Boolean(isPoke),
      ...(sourceEventKey == null || sourceEventKey === '' ? {} : { sourceEventKey: String(sourceEventKey) }) });
  }
  appendSelf(chatKey, { text, ts, mid = null }) {
    return this.#append(chatKey, { mid: mid ?? null, ts: ts || Date.now(), senderId: 'self', senderName: '我',
      text: String(text ?? ''), self: true, read: true, reply: null, media: [] });
  }

  drainUnread(chatKey) {
    chatKey = this.#ensure(chatKey);
    return this.#transaction(() => {
      const rows = this.#messageRows(this.#query('SELECT seq,payload,is_read,is_self FROM messages WHERE chat_key=? AND is_read=0 AND is_self=0 ORDER BY seq LIMIT ?'), chatKey, this.queryLimit);
      if (rows.length) this.#query('UPDATE messages SET is_read=1 WHERE chat_key=? AND is_read=0 AND is_self=0 AND seq<=?').run(chatKey, rows.at(-1).seq);
      // Self messages from old archives are not triggers, but legacy drainUnread
      // nevertheless marked them read.
      this.#query('UPDATE messages SET is_read=1 WHERE chat_key=? AND is_read=0 AND is_self=1').run(chatKey);
      return rows.map(row => decodeMessage({ ...row, is_read: 1 }));
    });
  }
  markAllRead(chatKey) {
    chatKey = this.#ensure(chatKey);
    return this.#query('UPDATE messages SET is_read=1 WHERE chat_key=? AND is_read=0 AND is_self=0').run(chatKey).changes;
  }
  markUnreadInWindow(chatKey, startedAt, endedAt) {
    chatKey = this.#ensure(chatKey);
    return this.#query('UPDATE messages SET is_read=0 WHERE chat_key=? AND is_self=0 AND is_read=1 AND ts>=? AND ts<=?')
      .run(chatKey, Number(startedAt) - 300000, Number(endedAt || startedAt) + 1000).changes;
  }
  unreadCount(chatKey) {
    chatKey = this.#ensure(chatKey);
    return this.#query('SELECT incoming_unread FROM chats WHERE chat_key=?').get(chatKey).incoming_unread;
  }
  peekUnread(chatKey, limit = 3) {
    chatKey = this.#ensure(chatKey);
    return this.#messageRows(this.#query('SELECT payload,is_read,is_self FROM messages WHERE chat_key=? AND is_read=0 AND is_self=0 ORDER BY seq LIMIT ?'),
      chatKey, positiveLimit(limit, 3, this.queryLimit)).map(decodeMessage);
  }
  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {
    chatKey = this.#ensure(chatKey);
    const sql = `SELECT payload,is_read,is_self FROM messages WHERE chat_key=?${includeSelf ? '' : ' AND is_self=0'} ORDER BY seq DESC LIMIT ? OFFSET ?`;
    return this.#messageRows(this.#query(sql), chatKey, positiveLimit(limit, 1, this.queryLimit), Math.max(0, Math.floor(Number(offset) || 0)))
      .reverse().map(decodeMessage);
  }
  #rowByMid(chatKey, mid) {
    this.#ensure(chatKey);
    return this.#query('SELECT seq,payload,is_read,is_self FROM messages WHERE chat_key=? AND mid_key=? ORDER BY seq LIMIT 1').get(String(chatKey), String(mid));
  }
  findByMid(chatKey, mid) { return decodeMessage(this.#rowByMid(chatKey, mid)); }
  findBySourceEventKey(chatKey, sourceEventKey) {
    if (sourceEventKey == null || sourceEventKey === '') return null;
    return decodeMessage(this.#query("SELECT payload,is_read,is_self FROM messages WHERE chat_key=? AND json_extract(payload,'$.sourceEventKey')=? ORDER BY seq LIMIT 1")
      .get(String(chatKey), String(sourceEventKey)));
  }
  findByLocalId(chatKey, localId) {
    chatKey = this.#ensure(chatKey);
    const id = Number(localId);
    if (!Number.isFinite(id)) return null;
    return decodeMessage(this.#query('SELECT payload,is_read,is_self FROM messages WHERE chat_key=? AND local_id=?').get(chatKey, id));
  }
  markRecalled(chatKey, mid) {
    const row = this.#rowByMid(chatKey, mid);
    if (!row) return false;
    const entry = decodeMessage(row);
    entry.recalled = true; entry.read = true;
    this.#query('UPDATE messages SET payload=?, is_read=1 WHERE seq=?').run(JSON.stringify(entry), row.seq);
    return true;
  }
  updateByMid(chatKey, mid, { text, appendMedia = [] } = {}) {
    const row = this.#rowByMid(chatKey, mid);
    if (!row) return false;
    const entry = decodeMessage(row);
    if (text != null) entry.text = String(text);
    if (appendMedia.length) {
      entry.media = Array.isArray(entry.media) ? entry.media : [];
      const seen = new Set(entry.media.map(x => x && x.url));
      for (const item of appendMedia) if (item?.url && !seen.has(item.url)) { entry.media.push(item); seen.add(item.url); }
    }
    const payload = JSON.stringify(entry);
    if (Buffer.byteLength(payload) > 16 * 1024 * 1024) throw new Error('单条存档消息超过 16 MiB 上限');
    this.#query('UPDATE messages SET payload=? WHERE seq=?').run(payload, row.seq);
    return true;
  }
  removeByLocalIds(chatKey, localIds = []) {
    chatKey = this.#ensure(chatKey);
    const ids = new Set((Array.isArray(localIds) ? localIds : [localIds]).map(Number).filter(Number.isFinite));
    return this.#transaction(() => {
      const query = this.#query('DELETE FROM messages WHERE chat_key=? AND local_id=?');
      let removed = 0;
      for (const id of ids) removed += query.run(chatKey, id).changes;
      return removed;
    });
  }
  clearChat(chatKey) {
    chatKey = this.#ensure(chatKey);
    return this.#query('DELETE FROM messages WHERE chat_key=?').run(chatKey).changes;
  }
  muteUnread(chatKey) { return this.markAllRead(chatKey); }
  activeMembers(chatKey, limit = 10) {
    chatKey = this.#ensure(chatKey);
    const rows = [];
    let bytes = 0;
    for (const row of this.#query('SELECT sender_key AS userId,name,last_ts AS lastTs,count FROM members WHERE chat_key=? ORDER BY last_ts DESC,first_seq LIMIT ?')
      .iterate(chatKey, positiveLimit(limit, 10, this.queryLimit))) {
      const size = Buffer.byteLength(row.name) + Buffer.byteLength(row.userId) + 64;
      if (rows.length && bytes + size > this.maxReadBytes) break;
      rows.push({ ...row }); bytes += size;
    }
    return rows;
  }
  close() {
    if (this.closed) return;
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    this.db.close();
    this.closed = true;
    this.statements.clear();
  }
}
