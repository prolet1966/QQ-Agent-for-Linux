// ask-admin-skill —— LLM 型技能：向管理员私下求教 + 内部知识沉淀（清单 §4.2「黑话/内部知识 ask_admin 答案自动沉淀」）
//
// 宿主语义：模型遇到搞不定的问题 → ask_admin 工具 → 管理员答复 → 沉淀进内部知识 →
//   注入【内部知识】段，下次同类问题直接答。
// 存储：data/ask-admin/internal-knowledge.json（本地 JSON，无外部依赖）。

import fs from 'node:fs';
import path from 'node:path';
// 数据根目录：必须与正在运行的那份进程完全一致（多实例下插件自己拼会算错根目录，
// 表现是「实例 #2 的数据写进 #1 的目录」，两个机器人互相污染且极难发现）。
// 复用核心导出，唯一真源 —— 官方 conversation-memory 插件同款做法。
import { DATA_DIR } from '../../src/config.js';


let dataDir = null;
const MAX = 200;

function file() { return path.join(dataDir || (process.cwd() + '/data/ask-admin'), 'internal-knowledge.json'); }
function read() {
  try {
    let t = fs.readFileSync(file(), 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    return Array.isArray(j.knowledge) ? j.knowledge : [];
  } catch { return []; }
}
function write(items) {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = file() + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, knowledge: items.slice(-MAX) }, null, 1), 'utf8');
    try { fs.unlinkSync(file()); } catch {}
    fs.renameSync(tmp, file());
  } catch {}
}

export function setup(api) {
  api.log('ask-admin-skill 已加载（管理员求教 + 内部知识沉淀）');
  const ok = (d) => ({ content: typeof d === 'string' ? d : JSON.stringify(d, null, 2) });
  const err = (m) => ({ content: m, isError: true });

  api.registerTool({
    id: 'ask_admin',
    name: '求教管理员',
    description: '遇到你自己搞不定的问题（群友问的某个你不确定/没把握的事），私下向管理员求教。把问题写清楚，等管理员答复后会沉淀进内部知识，下次同类问题直接答。不要逢问就求教——能自己把握的自己答。',
    category: 'system',
    icon: '🙋',
    defaultEnabled: false,
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问管理员的问题（写清楚背景 + 你想确认什么）' },
      },
      required: ['question'],
    },
    async execute(ctx, args) {
      try {
        const q = String(args.question ?? '').trim();
        if (!q) return err('要写明问题');
        const items = read();
        items.push({
          id: 'k' + Date.now().toString(36),
          question: q.slice(0, 300),
          answer: null,
          status: 'pending',
          chatKey: ctx.chatKey,
          at: new Date().toISOString(),
        });
        write(items);
        return ok('已记下这个问题，会私下问管理员。答复前这类问题你如实说「还不确定，去问了下」，别硬编。');
      } catch (e) {
        return err('求教失败：' + (e?.message ?? e));
      }
    },
  });

  api.registerTool({
    id: 'internal_knowledge',
    name: '查内部知识',
    description: '查已沉淀的内部知识（管理员答复过的 + 群内黑话/梗/约定）。回答群友涉及「群内约定/黑话/之前管理员定过的事」时先查这个，命中就按它答。',
    category: 'knowledge',
    icon: '📚',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的关键词或问题' },
      },
      required: ['query'],
    },
    async execute(ctx, args) {
      try {
        const q = String(args.query ?? '').toLowerCase().trim();
        if (!q) return err('要指定 query');
        const items = read().filter((k) => k.status === 'answered' && (k.question.toLowerCase().includes(q) || (k.answer || '').toLowerCase().includes(q)));
        if (!items.length) return ok('内部知识里没有相关条目。可如实说不知道。');
        return ok({
          count: items.length,
          knowledge: items.slice(-10).map((k) => ({ question: k.question, answer: k.answer, at: k.at })),
        });
      } catch (e) {
        return err('查内部知识失败：' + (e?.message ?? e));
      }
    },
  });
}

export function available() { return { ok: true, reason: '本地 JSON，开箱即用' }; }
export function activate(ctx) {
  dataDir = path.join(DATA_DIR, 'ask-admin');
}
export function deactivate(ctx) {}
export function dispose() {}
