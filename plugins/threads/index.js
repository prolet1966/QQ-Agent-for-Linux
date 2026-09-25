// threads —— 讨论线记忆（宿主「功能全清单」§3.1 的 threads.js；宿主从未实现，本插件按规格新建）
//
// 一句话：记住"群里聊到一半的话题"，下次自然接得上，而不是每次都像失忆。
//
// 规格（清单原文）：「六维记分卡驱动，活跃层（带摘要）+ 沉睡层（仅标签）双层窗口」
//   + 相邻条款：「拟人记忆上限：只主动提起最相关 1~3 条」「用进废退：被注入的线索巩固度上升」
// 六维定义与权重见 lib/threads-core.js 顶部注释（宿主没给，是我按规格定的，可调）。
//
// 结构：
//   · providers: threads.record / threads.select（给技能用，避免技能自己读文件）
//   · hooks: before-llm-messages —— 把该提的线索注入【聊到一半的线索】段
//   · 存储：data/threads/<chatKey 转义>.json（本地 JSON，原子写）

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import { upsertThread, selectForInjection, renderThreads, markInjected, scoreThread } from './lib/threads-core.js';

const DIR = path.join(DATA_DIR, 'threads');
const MAX_PER_CHAT = 200;

let cfg = () => ({});
let api = null;
// before-llm-messages 拿不到 triggerEntries/chatKey，只能按 sessionId 缓存
// （与其它注入型插件同一套做法）
const pendingBySession = new Map();

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* 已存在 */ } }

const fileOf = (chatKey) => path.join(DIR, encodeURIComponent(String(chatKey || 'unknown')).replace(/%/g, '_') + '.json');

/** 原子写（tmp + rename），坏文件不炸。 */
function readThreads(chatKey) {
  try {
    const raw = fs.readFileSync(fileOf(chatKey), 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j?.threads) ? j.threads : [];
  } catch { return []; }
}
function writeThreads(chatKey, threads) {
  ensureDir();
  const file = fileOf(chatKey);
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ chatKey: String(chatKey), updatedAt: Date.now(), threads: threads.slice(0, MAX_PER_CHAT) }, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) { api?.log?.('threads: 写盘失败 ' + (e?.message ?? e)); }
}

export const providers = {
  /** 记一条线索（技能 note_discussion 调用）。 */
  'threads.record': ({ chatKey, topic, tags, summary, participants, charge, unresolved } = {}) => {
    const threads = upsertThread(readThreads(chatKey), {
      topic, tags, summary,
      participants: participants || [],
      charge: Number(charge) || 0,
      unresolved: Number(unresolved) || 0,
    });
    writeThreads(chatKey, threads);
    return { ok: true, total: threads.length };
  },
  /** 取该注入的线索（供调试/面板）。 */
  'threads.select': ({ chatKey, maxActive, maxDormant } = {}) => {
    const c = cfg();
    const threads = readThreads(chatKey);
    const sel = selectForInjection(threads, {
      maxActive: Number(maxActive) || Number(c.maxActive) || 3,
      maxDormant: Number(maxDormant) || Number(c.maxDormant) || 5,
      activeThreshold: Number(c.activeThreshold) || 45,
    });
    return {
      total: threads.length,
      active: sel.active.map((x) => ({ id: x.thread.id, topic: x.thread.topic, score: x.total, dims: x.dims })),
      dormant: sel.dormant.map((x) => ({ id: x.thread.id, topic: x.thread.topic, score: x.total })),
    };
  },
};

export function setup(a) {
  api = a;
  cfg = a.config;
  ensureDir();
  api.log('threads 已加载（讨论线：六维记分卡 + 活跃/沉睡双层窗口；宿主未实现，按清单规格新建）');
}

export function available() {
  const c = cfg();
  return {
    ok: true,
    reason: c.inject === false
      ? '已关闭注入（仍可用 note_discussion 记录）'
      : '注入开启（活跃最多 ' + (Number(c.maxActive) || 3) + ' 条）',
  };
}

export function dispose() { pendingBySession.clear(); }

export const hooks = {
  /**
   * 注入前先算好（此时能拿到 chatKey / session）；
   * 真正改 messages 在 before-llm-messages（那个钩子拿不到 chatKey）。
   */
  'before-context'({ chatKey, session, triggerEntries } = {}) {
    try {
      if (cfg().inject === false) return;
      const key = String(chatKey || '');
      if (!key) return;
      const sid = String(session?.id || key);
      const threads = readThreads(key);
      if (!threads.length) { pendingBySession.delete(sid); return; }

      // 用本批消息给线索"计温"：出现同一 topic 的词就刷新活跃度
      const text = (Array.isArray(triggerEntries) ? triggerEntries : []).map((e) => String(e?.text ?? '')).join('\n');
      if (text) {
        let changed = false;
        const next = threads.map((t) => {
          const topicHit = t.topic && text.includes(String(t.topic).slice(0, 6));
          const tagHit = (t.tags || []).some((g) => g && text.includes(String(g)));
          if (topicHit || tagHit) { changed = true; return { ...t, lastActiveAt: Date.now(), mentions: (Number(t.mentions) || 0) + 1 }; }
          return t;
        });
        if (changed) writeThreads(key, next);
      }

      const c = cfg();
      const sel = selectForInjection(changed ? readThreads(key) : threads, {
        maxActive: Number(c.maxActive) || 3,
        maxDormant: Number(c.maxDormant) || 5,
        activeThreshold: Number(c.activeThreshold) || 45,
      });
      const block = renderThreads(sel);
      if (!block) { pendingBySession.delete(sid); return; }
      pendingBySession.set(sid, { block, ids: sel.active.map((x) => x.thread.id), chatKey: key });
    } catch (e) { api?.log?.('threads: before-context 失败 ' + (e?.message ?? e)); }
  },

  /** 把【聊到一半的线索】段插到系统消息里（追加到已有 system 内容末尾，不新建消息）。 */
  'before-llm-messages'({ messages, session } = {}) {
    try {
      const sid = String(session?.id || '');
      const pend = pendingBySession.get(sid);
      if (!pend || !Array.isArray(messages)) return;
      const sys = messages.find((m) => m?.role === 'system');
      if (!sys) return;
      sys.content = String(sys.content || '') + '\n\n' + pend.block;
      // 记账注入（用进废退的"进"）
      const threads = readThreads(pend.chatKey);
      writeThreads(pend.chatKey, markInjected(threads, pend.ids));
      pendingBySession.delete(sid);
    } catch (e) { api?.log?.('threads: before-llm-messages 失败 ' + (e?.message ?? e)); }
  },
};
