// 每个会话（group:xxx / private:xxx）一个不断增长的 JSON 消息存储。
// 这是新架构的核心数据结构：模型不携带对话历史，每次运行都从这里拼接"过去状态"。
//
// 条目格式：
// {
//   id:        本地递增序号（自 1 起，同群唯一，用于 UI 定位）
//   mid:       QQ 消息 id（可为负数；自己主动发送的本地记录可能没有）
//   ts:        时间戳毫秒
//   senderId:  QQ 号（自己发送的为 selfId）
//   senderName:群名片/昵称（自己发送的为 botName）
//   text:      解析后的纯文本（[图片] 等占位符已内联）
//   self:      是否是机器人自己发的
//   read:      已读状态（运行开始时批量置 true）
//   reply:     可选 { sender, text }：该消息引用/回复的对象摘要
//   media:     可选 [{ kind, url, file, faceId, summary }] 原始媒体定位信息
// }
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { SQLiteChatStore, SQLITE_FILE, STORAGE_STATE_FILE, sqliteAvailable } from './sqlite-store.js';
import { isServerMode } from './runtime.js';

function chatFile(messagesDir, chatKey) {
  // chatKey 形如 group:123 / private:456
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(messagesDir, `${safe}.json`);
}

function loadChat(messagesDir, chatKey, maxArchiveBytes) {
  const file = chatFile(messagesDir, chatKey);
  let text;
  try {
    if (fs.statSync(file).size > maxArchiveBytes) throw legacyArchiveLimit();
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { chatKey, nextLocalId: 1, messages: [] };
    if (error.expose) throw error;
    throw new Error(`无法读取聊天档案，原文件已保留：${file}（${error.message}）`, { cause: error });
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new Error(`聊天档案 JSON 损坏，原文件已保留：${file}（${error.message}）`, { cause: error }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.messages)
    || parsed.messages.some(message => !message || typeof message !== 'object' || Array.isArray(message))) {
    throw new Error(`聊天档案结构异常，原文件已保留：${file}`);
  }
  if (parsed.chatKey != null && String(parsed.chatKey) !== String(chatKey)) throw new Error(`聊天档案 chatKey 与路径不一致，原文件已保留：${file}`);
  // Early archives may omit these metadata fields. Repair missing metadata from
  // the filename and existing local IDs without dropping or rebuilding records.
  const lastLocalId = parsed.messages.reduce((maximum, message) => {
    const id = Number(message.id);
    return Number.isSafeInteger(id) && id > maximum ? id : maximum;
  }, 0);
  const nextLocalId = parsed.nextLocalId == null ? lastLocalId + 1 : Number(parsed.nextLocalId);
  if (!Number.isSafeInteger(nextLocalId) || nextLocalId <= lastLocalId || nextLocalId < 1) {
    throw new Error(`聊天档案 nextLocalId 无效，原文件已保留：${file}`);
  }
  return { ...parsed, chatKey, nextLocalId };
}

function legacyArchiveLimit() {
  return Object.assign(new Error('旧 JSON 聊天档案超过服务器 8 MiB 读取预算；请停止核心，备份后执行消息存储 migrate 切换到 SQLite，原档案不会被覆盖'), { status: 413, expose: true });
}

function saveChat(messagesDir, state, maxArchiveBytes) {
  fs.mkdirSync(messagesDir, { recursive: true });
  const tmp = `${chatFile(messagesDir, state.chatKey)}.${process.pid}.tmp`;
  const text = JSON.stringify(state, null, 1);
  if (Buffer.byteLength(text) > maxArchiveBytes) throw legacyArchiveLimit();
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, chatFile(messagesDir, state.chatKey));
  return Buffer.byteLength(text);
}

export class JSONChatStore {
  constructor(maxPerChat = 0, { dataDir = DATA_DIR, maxCachedChats = 8, maxCacheBytes = 8 * 1024 * 1024 } = {}) {
    this.backend = 'json';
    this.messagesDir = path.join(dataDir, 'messages');
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.chats = new Map(); // chatKey -> state
    this.knownChats = new Set();
    this.cacheSizes = new Map();
    this.maxCachedChats = Math.max(1, Number(maxCachedChats) || 8);
    this.maxCacheBytes = Math.max(1, Number(maxCacheBytes) || 8 * 1024 * 1024);
    this.cachedBytes = 0;
    this.maxArchiveBytes = isServerMode() ? 8 * 1024 * 1024 : Infinity;
  }

  setMaxPerChat(cap) {
    this.maxPerChat = Math.max(0, Number(cap) || 0);
  }

  #state(chatKey) {
    this.knownChats.add(chatKey);
    let state = this.chats.get(chatKey);
    if (state) {
      this.chats.delete(chatKey); this.chats.set(chatKey, state);
      return state;
    }
    state = loadChat(this.messagesDir, chatKey, this.maxArchiveBytes);
    let bytes = 0;
    try { bytes = fs.statSync(chatFile(this.messagesDir, chatKey)).size; } catch { /* new chat */ }
    this.chats.set(chatKey, state); this.cacheSizes.set(chatKey, bytes); this.cachedBytes += bytes;
    this.#trimCache();
    return state;
  }

  #trimCache() {
    while (this.chats.size > this.maxCachedChats || this.cachedBytes > this.maxCacheBytes) {
      const key = this.chats.keys().next().value;
      if (key === undefined) break;
      this.cachedBytes -= this.cacheSizes.get(key) || 0;
      this.cacheSizes.delete(key); this.chats.delete(key);
    }
  }

  #save(state) {
    let bytes;
    try { bytes = saveChat(this.messagesDir, state, this.maxArchiveBytes); }
    catch (error) {
      // Mutators update the working object before writing. On ENOSPC/EACCES or
      // rename failure, discard it so replay deduplication sees only disk state.
      // Keeping a failed append cached would let the durable inbox acknowledge
      // an event whose sourceEventKey had never reached the message archive.
      if (this.chats.has(state.chatKey)) {
        this.cachedBytes -= this.cacheSizes.get(state.chatKey) || 0;
        this.cacheSizes.delete(state.chatKey); this.chats.delete(state.chatKey);
      }
      throw error;
    }
    if (this.chats.has(state.chatKey)) {
      this.cachedBytes += bytes - (this.cacheSizes.get(state.chatKey) || 0);
      this.cacheSizes.set(state.chatKey, bytes); this.#trimCache();
    }
  }

  #discoverChats() {
    // Listing archives does not parse or cache every historical JSON file.
    try {
      const files = fs.readdirSync(this.messagesDir).filter((f) => /^(group|private)_\d+\.json$/.test(f));
      for (const f of files) {
        const m = /^(group|private)_(\d+)\.json$/.exec(f);
        if (m) this.knownChats.add(`${m[1]}:${m[2]}`);
      }
    } catch { /* 目录不存在 */ }
  }

  listChats({ limit = 2000, offset = 0 } = {}) {
    this.#discoverChats();
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    return [...this.knownChats].slice(start, start + Math.min(2000, Math.max(1, Math.floor(Number(limit) || 2000))));
  }
  chatCount() { this.#discoverChats(); return this.knownChats.size; }

  getChatMeta(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read).length;
    const last = st.messages[st.messages.length - 1] || null;
    return { chatKey, total: st.messages.length, unread, lastTs: last?.ts ?? 0, lastText: last?.text ?? '' };
  }

  /** 追加一条收到的消息（未读）。返回写入的条目。 */
  appendIncoming(chatKey, { mid, ts, senderId, senderName, text, reply = null, media = [], isPoke = false, sourceEventKey = null }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''),
      text: String(text ?? ''),
      self: false,
      read: false,
      reply: reply || null,
      media: Array.isArray(media) ? media : [],
      // 拍一拍事件：可作触发批（resolveContextTier 按 1 档响应），但不进【过去状态】
      isPoke: Boolean(isPoke),
      ...(sourceEventKey == null || sourceEventKey === '' ? {} : { sourceEventKey: String(sourceEventKey) })
    };
    st.messages.push(entry);
    this.#trim(st);
    this.#save(st);
    return entry;
  }

  /** 记录机器人自己发出的消息（已读）。 */
  appendSelf(chatKey, { text, ts, mid = null }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: 'self',
      senderName: '我',
      text: String(text ?? ''),
      self: true,
      read: true,
      reply: null,
      media: []
    };
    st.messages.push(entry);
    this.#trim(st);
    this.#save(st);
    return entry;
  }

  /** 快照当前未读并全部置为已读（运行开始时调用）。 */
  drainUnread(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    for (const m of st.messages) m.read = true;
    this.#save(st);
    return unread;
  }

  /**
   * 把当前所有未读标记为已读，**但不取走它们**。
   *
   * 这是"档位控制是否响应"的关键：机器人判断"这次不回应"时调用它，
   * 消息就沉入历史（已读），不会产生会话、不消耗 token；
   * 但内容仍留在存档里，日后被艾特时还能作为"已读上下文"带进提示词。
   * 与 drainUnread 的区别：drainUnread 取走并作为触发批，这个只标记。
   *
   * @returns {number} 被标记为已读的条数
   */
  markAllRead(chatKey) {
    const st = this.#state(chatKey);
    let n = 0;
    for (const m of st.messages) {
      if (!m.read && !m.self) { m.read = true; n++; }
    }
    if (n) this.#save(st);
    return n;
  }

  /**
   * 把时间窗内的**已读**消息重新标记为未读（手动重试失败会话用）。
   *
   * 触发批当初被 drainUnread 置了已读；重试时按会话起止时间把它们翻回未读，
   * 唤醒流程就能重新取走它们。窗口向前放宽 5 分钟（容纳防抖聚批期），
   * 向后到会话结束 —— 窗口外的不动，避免误翻后来真正已读的历史。
   * @returns {number} 恢复为未读的条数
   */
  markUnreadInWindow(chatKey, startedAt, endedAt) {
    const st = this.#state(chatKey);
    const winStart = Number(startedAt) - 5 * 60 * 1000;
    const winEnd = Number(endedAt || startedAt) + 1000;
    let n = 0;
    for (const m of st.messages) {
      if (m.self) continue;
      if (m.read && m.ts >= winStart && m.ts <= winEnd) { m.read = false; n++; }
    }
    if (n) this.#save(st);
    return n;
  }

  unreadCount(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).length;
  }

  /** 查看当前未读消息（不置已读），用于“等待中”会话的触发摘要。 */
  peekUnread(chatKey, limit = 3) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).slice(0, Math.max(1, Number(limit) || 3));
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {
    const st = this.#state(chatKey);
    const all = includeSelf ? st.messages : st.messages.filter((m) => !m.self);
    // offset = 跳过最近 N 条（用于工具翻页）。只读，绝不能修改 st.messages！
    const start = Math.max(0, all.length - Math.max(0, Number(offset) || 0));
    return all.slice(0, start).slice(-Math.max(1, Number(limit) || 1));
  }

  findByMid(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    return st.messages.find((m) => String(m.mid) === target) || null;
  }

  findBySourceEventKey(chatKey, sourceEventKey) {
    if (sourceEventKey == null || sourceEventKey === '') return null;
    const target = String(sourceEventKey);
    return this.#state(chatKey).messages.find(message => message.sourceEventKey === target) || null;
  }

  /**
   * 标记一条消息已被用户撤回（按 QQ 消息 id）。
   * 撤回的消息后续不再发给大模型（buildPastState 会过滤 recalled）。
   * @returns {boolean} 是否找到并标记了
   */
  markRecalled(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const m = st.messages.find((x) => String(x.mid) === target);
    if (!m) return false;
    m.recalled = true;
    m.read = true;   // 撤回的消息也算"已读"，不再触发回复
    this.#save(st);
    return true;
  }

  /**
   * 按 QQ 消息 id 更新一条已存档消息（文本/补媒体），并落盘。
   * 用途：read_forward 工具把"合并转发占位符"永久升级成展开后的文本
   * —— 一次展开，以后谁（模型/存档页/金句）都直接读到内容。
   */
  updateByMid(chatKey, mid, { text, appendMedia = [] } = {}) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const m = st.messages.find((x) => String(x.mid) === target);
    if (!m) return false;
    if (text != null) m.text = String(text);
    if (appendMedia.length) {
      m.media = Array.isArray(m.media) ? m.media : [];
      const seen = new Set(m.media.map((x) => x && x.url));
      for (const x of appendMedia) {
        if (x && x.url && !seen.has(x.url)) { m.media.push(x); seen.add(x.url); }
      }
    }
    this.#save(st);
    return true;
  }

  findByLocalId(chatKey, localId) {
    const st = this.#state(chatKey);
    return st.messages.find((m) => m.id === Number(localId)) || null;
  }

  /**
   * 删除指定本地 id 的消息（部分清除）。返回删掉的条数。
   * @param {string} chatKey
   * @param {number[]} localIds 本地递增 id 数组
   */
  removeByLocalIds(chatKey, localIds = []) {
    const st = this.#state(chatKey);
    const ids = new Set((Array.isArray(localIds) ? localIds : [localIds]).map(Number));
    if (!ids.size) return 0;
    const before = st.messages.length;
    st.messages = st.messages.filter((m) => !ids.has(m.id));
    const removed = before - st.messages.length;
    if (removed) this.#save(st);
    return removed;
  }

  /**
   * 清空某会话的全部消息（整体清除）。返回删掉的条数。
   * 会话文件保留（空 messages），下次来消息继续往里写。
   */
  clearChat(chatKey) {
    const st = this.#state(chatKey);
    const removed = st.messages.length;
    if (removed) {
      st.messages = [];
      this.#save(st);
    }
    return removed;
  }

  /**
   * 仅屏蔽（不删除）：把某会话的全部未读标记为已读。
   * 与 markAllRead 相同语义，这里显式命名供"仅屏蔽、不再发送"场景调用。
   * 返回标记的条数。
   */
  muteUnread(chatKey) {
    return this.markAllRead(chatKey);
  }

  /** 最近 senderId 出现过的活跃成员（带最后发言时间）。 */
  activeMembers(chatKey, limit = 10) {
    const st = this.#state(chatKey);
    const map = new Map();
    for (const m of st.messages) {
      if (m.self) continue;
      const prev = map.get(m.senderId);
      if (!prev || prev.lastTs < m.ts) {
        map.set(m.senderId, { userId: m.senderId, name: m.senderName, lastTs: m.ts, count: (prev?.count || 0) + 1 });
      } else {
        prev.count += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, Math.max(1, limit));
  }

  #trim(st) {
    if (this.maxPerChat > 0 && st.messages.length > this.maxPerChat) {
      st.messages.splice(0, st.messages.length - this.maxPerChat);
    }
  }

  close() { this.chats.clear(); this.cacheSizes.clear(); this.knownChats.clear(); this.cachedBytes = 0; }
}

/** Auto never rewrites legacy history. Switching an existing JSON archive is an
 * explicit offline `node scripts/message-storage.mjs migrate --data-dir ...`.
 * A rollback marker takes precedence over a retained SQLite backup. */
export function resolveStorageBackend(dataDir, requested = 'auto') {
  if (!['auto', 'json', 'sqlite'].includes(requested)) throw new Error(`未知消息存储后端：${requested}`);
  if (requested !== 'auto') return requested;
  const stateFile = path.join(dataDir, STORAGE_STATE_FILE);
  if (fs.existsSync(stateFile)) {
    let state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch (error) { throw new Error(`消息存储选择文件损坏：${error.message}`); }
    if (!['json', 'sqlite'].includes(state.backend)) throw new Error('消息存储选择文件包含未知后端');
    if (state.backend === 'sqlite' && !fs.existsSync(path.join(dataDir, SQLITE_FILE))) {
      throw new Error('消息存储已切换到 SQLite，但数据库不存在。请恢复备份，拒绝创建空数据库。');
    }
    return state.backend;
  }
  if (fs.existsSync(path.join(dataDir, SQLITE_FILE))) return 'sqlite';
  try {
    if (fs.readdirSync(path.join(dataDir, 'messages')).some(file => /\.json$/i.test(file))) return 'json';
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return sqliteAvailable() ? 'sqlite' : 'json';
}

export class ChatStore {
  constructor(maxPerChat = 0, options = {}) {
    const dataDir = options.dataDir || DATA_DIR;
    const requested = options.backend || process.env.QQ_AGENT_STORE_BACKEND || getConfig().store?.backend || 'auto';
    const backend = resolveStorageBackend(dataDir, requested);
    return backend === 'sqlite' ? new SQLiteChatStore(maxPerChat, { ...options, dataDir }) : new JSONChatStore(maxPerChat, { ...options, dataDir });
  }
}
