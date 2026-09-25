// todo-skill —— LLM 型技能：待办状态机（宿主 pending.js 语义照搬）
// 工具面：宿主 tools.js 的 memory_todo_save / memory_todo_done。
// 到期自动消失、同会话同文去重、绑人待办仅该人出现才注入、上限 40 条/单条 100 字/过期上限 7 天。

import fs from 'node:fs';
import path from 'node:path';
// 数据根目录：必须与正在运行的那份进程完全一致（多实例下插件自己拼会算错根目录，
// 表现是「实例 #2 的数据写进 #1 的目录」，两个机器人互相污染且极难发现）。
// 复用核心导出，唯一真源 —— 官方 conversation-memory 插件同款做法。
import { DATA_DIR } from '../../src/config.js';


let cfg = () => ({});
let dataDir = null;

const MAX = 40;
function file() { return path.join(dataDir || (process.cwd() + '/data/todo-skill'), 'pending-todos.json'); }
function read() {
  try {
    let t = fs.readFileSync(file(), 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    return Array.isArray(j.todos) ? j.todos : [];
  } catch { return []; }
}
function write(todos) {
  const now = Date.now();
  const alive = todos.filter((t) => !t.expiresAt || Number(t.expiresAt) > now).slice(-MAX);
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = file() + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, todos: alive }, null, 1), 'utf8');
    try { fs.unlinkSync(file()); } catch {}
    fs.renameSync(tmp, file());
  } catch {}
  return alive;
}

export function saveTodo({ chatKey, text, expireInMinutes = 120, userId = '', note = '' }) {
  const body = String(text || '').trim().slice(0, 100);
  if (!body) return { ok: false, error: '待办内容不能为空' };
  let mins = Number(expireInMinutes);
  if (!Number.isFinite(mins) || mins <= 0) mins = 120;
  mins = Math.min(7 * 24 * 60, Math.round(mins));
  const now = Date.now();
  const todos = read();
  const uid = String(userId || '').replace(/^-?\d{5,15}$/, (m) => String(Math.abs(Number(m))));
  const fixedUid = /^\d{1,15}$/.test(uid) ? uid : '';
  const key = String(chatKey || '') + '|' + body.toLowerCase();
  const existing = todos.find((t) => (String(t.chatKey || '') + '|' + String(t.text).toLowerCase()) === key);
  if (existing) {
    existing.expiresAt = now + mins * 60000;
    existing.updatedAt = now;
    existing.note = String(note || '').slice(0, 80);
    if (fixedUid) existing.userId = fixedUid;
    write(todos);
    return { ok: true, todo: existing, deduped: true };
  }
  const todo = {
    id: 't' + now.toString(36), chatKey: String(chatKey || ''), userId: fixedUid,
    text: body, note: String(note || '').slice(0, 80),
    createdAt: now, updatedAt: now, expiresAt: now + mins * 60000, expireInMinutes: mins,
  };
  todos.push(todo);
  write(todos);
  return { ok: true, todo };
}

export function completeTodo({ chatKey, text }) {
  const key = String(text || '').trim().toLowerCase();
  if (!key) return false;
  const todos = read();
  const next = todos.filter((t) => {
    if (chatKey && t.chatKey && t.chatKey !== chatKey) return true;
    return String(t.text || '').toLowerCase() !== key;
  });
  if (next.length === todos.length) return false;
  write(next);
  return true;
}

export function setup(api) {
  cfg = api.config;
  const ok = (d) => ({ content: typeof d === 'string' ? d : JSON.stringify(d, null, 2) });
  const err = (m) => ({ content: m, isError: true });
  api.log('todo-skill 已加载（待办状态机，宿主 pending.js 照搬；到期自动消失）');

  api.registerTool({
    id: 'memory_todo_save',
    name: '记待办',
    description: '给自己记一条待办（例如「明天问一下他考试怎么样」）。到期会自动忘掉，所以过期时间要自己定。只在那种「以后得记着办」的事情上用，别把普通闲聊都记成待办。',
    category: 'memory',
    icon: '📌',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要办的事，一句话（不超过 100 字）' },
        expireInMinutes: { type: 'integer', description: '多少分钟后自动忘记，默认 120（上限 7 天）' },
        userId: { type: 'string', description: '可选：这件事跟谁的 QQ 号有关' },
      },
      required: ['text'],
    },
    async execute(ctx, args) {
      try {
        const r = saveTodo({ chatKey: ctx.chatKey, text: args.text, expireInMinutes: args.expireInMinutes, userId: args.userId });
        if (!r.ok) return err(r.error || '记待办失败');
        return ok(r.deduped ? '这条待办已经有了（已刷新过期时间），别声张，该干嘛干嘛。' : '记下了（到点会自动忘）。别声张，该干嘛干嘛。');
      } catch (e) { return err('记待办失败：' + (e?.message ?? e)); }
    },
  });

  api.registerTool({
    id: 'memory_todo_done',
    name: '清待办',
    description: '把之前记的待办标记为已完成（办完了就清掉，别一直挂着）。',
    category: 'memory',
    icon: '✅',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '待办原文（与记的时候一致）' } },
      required: ['text'],
    },
    async execute(ctx, args) {
      try {
        const done = completeTodo({ chatKey: ctx.chatKey, text: args.text });
        return ok(done ? '已经清掉了。' : '没找到这条待办（可能已经过期忘掉了）。');
      } catch (e) { return err('清待办失败：' + (e?.message ?? e)); }
    },
  });
}

export function available() {
  return { ok: true, reason: '本地 JSON，开箱即用' };
}
export function activate(ctx) {
  dataDir = path.join(DATA_DIR, 'todo-skill');
}
export function deactivate(ctx) {}
export function dispose() {}
