// meme-engine —— 梗库引擎（V0.3.1 确定性插件）
//
// 宿主来源：部署版 src/memes.js（21.9KB，含 P0/P1/P2 全部语义化优化）。
// 一句话原则：梗库要闪得准 —— 语义联想（换个说法也认得出）+ 淘汰锁定（常用老梗不被挤掉）
//   + 真实使用统计（uses 是真用过，不是重复保存 +1）+ 从记忆库收编（免手工誊抄）。
//
// 软依赖：
//   - 语义向量服务（127.0.0.1:3917）：不可用时逐字节退回改造前的字面逻辑（宿主降级路径照搬，
//     连返回值结构都不变，聊天不卡）
//
// ⚠️ meme.cue / meme.data 是自建能力名 —— 核心不认识。必须被 skills/meme-lib 用
//   api.capability() 消费（防孤儿能力，见 plugin-development.md §5）。
//   宿主里 meme.cue 被 orchestrator 在提示词组装时调用注入「脑内闪过」；V0.3.1 核心没有这个消费点，
//   所以 meme.cue 由本插件的 before-context 钩子消费（注入提示词），meme.data 由技能消费。

import fs from 'node:fs';
import path from 'node:path';
import { ensureMemeVectors, cueMemories, cueLiteralFallback, loadMemes, saveMemes } from './lib/meme-cue.js';
import { prune, noteMemeUse } from './lib/meme-prune.js';
import { collectFromMemory, normalizeTags, inferTags } from './lib/meme-collect.js';
import { hashEmbed } from './lib/meme-embed.js';
// 数据根目录：必须与正在运行的那份进程完全一致（多实例下插件自己拼会算错根目录，
// 表现是「实例 #2 的数据写进 #1 的目录」，两个机器人互相污染且极难发现）。
// 复用核心导出，唯一真源 —— 官方 conversation-memory 插件同款做法。
import { DATA_DIR } from '../../src/config.js';


// ── 模块状态（setup 初始化，activate 建，deactivate 必须清）────────
let cfg = () => ({});
let dataDir = null;
let memesCache = null;
let vectorsCache = null;
let vectorProbeTimer = null;
let semanticProbeState = { ok: false, reason: '未探测', probeAt: 0 };

function memeDataPath() {
  return path.join(dataDir, 'memes.json');
}
function vectorCachePath() {
  return path.join(dataDir, 'memes-vectors.json');
}

function loadAll() {
  try {
    const m = memeDataPath();
    memesCache = fs.existsSync(m) ? JSON.parse(fs.readFileSync(m, 'utf8')) : { items: [] };
    const v = vectorCachePath();
    vectorsCache = fs.existsSync(v) ? JSON.parse(fs.readFileSync(v, 'utf8')) : {};
  } catch {
    memesCache = { items: [] };
    vectorsCache = {};
  }
}

function persist() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (memesCache) fs.writeFileSync(memeDataPath(), JSON.stringify(memesCache, null, 2));
    if (vectorsCache) fs.writeFileSync(vectorCachePath(), JSON.stringify(vectorsCache));
  } catch {}
}

async function probeSemantic() {
  const url = String((cfg().semanticEmbedUrl) || 'http://127.0.0.1:3917');
  try {
    const res = await fetch(url + '/health', { signal: AbortSignal.timeout(800) });
    semanticProbeState = { ok: res.ok, reason: res.ok ? 'online' : 'HTTP ' + res.status, probeAt: Date.now() };
  } catch (e) {
    semanticProbeState = { ok: false, reason: String(e?.message ?? e), probeAt: Date.now() };
  }
  return semanticProbeState.ok;
}

let api = null;

export function setup(a) {
  api = a;
  cfg = a.config;
  api.log('meme-engine 已加载（语义向量 3917 软依赖，不可用退回字面）');
}

export function available() {
  return { ok: true, reason: semanticProbeState.ok ? '语义已连接' : '字面模式：' + (semanticProbeState.reason || '未探活') };
}

export async function activate(ctx) {
  // 数据目录：V0.3.1 核心通过 ctx.dataDir / ctx.paths.data 提供；退化到 process.cwd()/data
  const c = cfg();
  dataDir = path.join(DATA_DIR, 'meme-engine');
  loadAll();
  api.log?.('meme-engine: 已加载 ' + (memesCache?.items?.length ?? 0) + ' 条梗（数据目录 ' + dataDir + '）');

  // 语义向量服务探活 + 后台缓存（宿主 ensureMemeVectors：改梗才重算，200 条一次约 200ms）
  if (c.semanticEmbedEnabled !== false) {
    await probeSemantic();
    if (semanticProbeState.ok) {
      const t0 = Date.now();
      try {
        vectorsCache = await ensureMemeVectors(memesCache.items, vectorsCache, {
          embedText: (m) => (m.text || '') + ' ' + (Array.isArray(m.tags) ? m.tags.join(' ') : '') + ' ' + (m.note || ''),
          hashText: hashEmbed,
          fetchVectors: async (texts) => {
            const url = c.semanticEmbedUrl || 'http://127.0.0.1:3917';
            const res = await fetch(url + '/embed', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ texts }),
              signal: AbortSignal.timeout(c.vectorCacheTimeoutMs ?? 8000),
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return (await res.json()).vectors || [];
          },
        });
        persist();
        api.log?.('meme-engine: 梗向量缓存完成（' + (Date.now() - t0) + 'ms）');
      } catch (e) {
        api.warn?.('meme-engine: 向量缓存失败 → 退回字面（' + e?.message + '）');
      }
    }
    // 看门狗：每 60s 重探一次（宿主独立 watchdog 简化为插件内轮询）
    vectorProbeTimer = setInterval(() => { probeSemantic().catch(() => {}); }, 60_000);
    vectorProbeTimer.unref?.();
  }
}

export async function deactivate(ctx) {
  if (vectorProbeTimer) { clearInterval(vectorProbeTimer); vectorProbeTimer = null; }
  memesCache = null;
  vectorsCache = null;
  api.log?.('meme-engine: 已停用');
}

export function dispose() {
  vectorProbeTimer = null;
  memesCache = null;
  vectorsCache = null;
}

// ── providers ────────────────────────────────────────────────────
export const providers = {
  /**
   * 脑内闪过（宿主 cueMemories 语义照搬）：语义 × 0.75 + 字面 × 0.25 融合打分，
   *   双门槛（字面有交集 → literalScoreThreshold 0.64；完全不沾边 → semanticScoreThreshold 0.70）
   *   + alias 保底 0.75（梗名原文出现）。语义不可用 → 逐字节退回字面。
   * 入参：{ text, chatKey?, limit? }
   * 返回：{ cues: [{ text, score, via }], semantic, degraded }
   *   - via='semantic' | 'literal' | 'alias'
   */
  'meme.cue': async ({ text, limit } = {}) => {
    if (!memesCache) loadAll();
    const c = cfg();
    const items = (memesCache?.items ?? []).filter((m) => m.disabled !== true);
    if (!items.length) return { cues: [], semantic: false, degraded: false };

    const topN = Math.min(3, Number(limit) || 2);   // 宿主：脑内闪过 1~2 条

    if (semanticProbeState.ok) {
      // 语义模式：融合打分
      const cues = cueMemories(items, text, {
        vectorsCache,
        embedText: (m) => (m.text || '') + ' ' + (Array.isArray(m.tags) ? m.tags.join(' ') : '') + ' ' + (m.note || ''),
        hashText: hashEmbed,
        semanticWeight: 0.75,
        literalWeight: 0.25,
        literalCeiling: 12,          // 字面分 12 封顶（宿主）
        literalThreshold: c.literalScoreThreshold ?? 0.64,
        semanticThreshold: c.semanticScoreThreshold ?? 0.7,
        aliasFloor: c.aliasFloor ?? 0.75,
      }).slice(0, topN);
      return { cues, semantic: true, degraded: false };
    }
    // 降级：逐字节退回改造前的字面逻辑（连返回值结构都不变）
    const cues = cueLiteralFallback(items, text, {
      threshold: c.literalScoreThreshold ?? 0.64,
      aliasFloor: c.aliasFloor ?? 0.75,
    }).slice(0, topN);
    return { cues, semantic: false, degraded: true };
  },

  /**
   * 梗库数据读写（供技能与管理台）。宿主 memes.js 数据面照搬。
   * 入参：{ op:'list'|'get'|'flags'|'prune'|'noteUse'|'importFromMemory'|'suggest', ... }
   */
  'meme.data': async ({ op, ...rest } = {}) => {
    if (!memesCache) loadAll();
    const items = memesCache.items ?? (memesCache.items = []);
    const c = cfg();

    switch (op) {
      case 'list': {
        return { ok: true, count: items.length, items: items.map((m) => ({
          id: m.id, text: m.text, tags: m.tags ?? [], uses: m.uses ?? 0, saves: m.saves ?? 1,
          locked: m.locked === true, disabled: m.disabled === true, lastUsedAt: m.lastUsedAt,
        })) };
      }
      case 'get':
        return { ok: true, item: items.find((m) => m.id === rest.id) ?? null };
      case 'flags': {
        // 锁定/停用（宿主 setMemeFlags）
        const m = items.find((x) => x.id === rest.id);
        if (!m) return { ok: false, error: '找不到梗 ' + rest.id };
        if (rest.locked != null) m.locked = rest.locked === true;
        if (rest.disabled != null) m.disabled = rest.disabled === true;
        persist();
        return { ok: true, item: { id: m.id, locked: m.locked, disabled: m.disabled } };
      }
      case 'prune': {
        // 淘汰（宿主 prune：locked 永不淘汰；先丢停用的、再丢从未真用过的，同档最久没更新的先走）
        const r = prune(items, c.maxMemes ?? 200);
        persist();
        return { ok: true, pruned: r.pruned, kept: items.length, detail: r.detail };
      }
      case 'noteUse': {
        // 真实使用统计（宿主 noteMemeUse：回复命中梗原文才 +1）
        const r = noteMemeUse(items, rest.text);
        persist();
        return { ok: true, matched: r.matched, count: r.count };
      }
      case 'importFromMemory': {
        // 从记忆库收编（宿主三道闸：像不像梗 → 语义去重 ≥0.90 → 截断到停顿）
        const r = collectFromMemory(rest.memoryMemes ?? [], items, {
          dedupeThreshold: 0.9,
          vectorsCache,
          semanticOk: semanticProbeState.ok,
        });
        // 收编时顺手整库标签归一（宿主 P2-a）
        normalizeTagsAll(items);
        persist();
        return { ok: true, imported: r.imported, deduped: r.deduped, skipped: r.skipped };
      }
      case 'suggest': {
        // 从群聊发现高频短句（宿主 P2-b：只推荐不自动入库）
        return { ok: true, candidates: rest.candidates ?? [], note: '只推荐，要收的话在梗库页一条条加或调 importFromMemory' };
      }
      default:
        return { ok: false, error: '未知操作 ' + op };
    }
  },

  /** 控制台「扩展」面板数据（只读）。panel. 前缀 = 核心放行的只读约定。 */
  'panel.meme': () => {
    if (!memesCache) loadAll();
    const c = cfg();
    const items = memesCache?.items ?? [];
    const used = items.filter((m) => (m.uses ?? 0) > 0).length;
    const locked = items.filter((m) => m.locked === true).length;
    return {
      title: '梗库',
      summary: [
        { label: '总条数', value: String(items.length) + ' / ' + (c.maxMemes ?? 200) },
        { label: '真用过的', value: String(used) },
        { label: '锁定', value: String(locked) },
        { label: '语义联想', value: semanticProbeState.ok ? '已连接' : '字面模式' },
        { label: '向量缓存', value: String(Object.keys(vectorsCache || {}).length) },
      ],
      sections: items.length ? [{
        type: 'table', title: '梗库条目（按使用次数）',
        columns: ['梗', '标签', '使用', '录入', '锁定', '停用'],
        rows: [...items].sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0)).slice(0, 40).map((m) => [
          String(m.text ?? '').slice(0, 40),
          (Array.isArray(m.tags) ? m.tags : []).join('/') || '-',
          String(m.uses ?? 0), String(m.saves ?? 1),
          m.locked ? '是' : '-', m.disabled ? '是' : '-',
        ]),
      }] : [{ type: 'note', title: '梗库是空的', text: '还没有录入梗。可以让机器人调 meme_save，或用 meme_import 从记忆库收编。' }],
    };
  },
};

function normalizeTagsAll(items) {
  for (const m of items) {
    m.tags = normalizeTags(m.tags ?? []);
  }
}
