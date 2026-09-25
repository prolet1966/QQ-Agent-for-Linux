// kb-growth —— 知识库自增长闭环（V0.3.1 确定性插件）
//
// 一句话原则：回答不等入库，入库不堵回答；候选与正式分离；不遍历全库；可审计可回滚。
//
// 宿主来源：部署版 src/kb-growth.js + 13 个 kb-*.js（检索/兜底/入队/Worker/去重/审计）。
// 迁移要点：宿主是 patch 进 tools.js/orchestrator.js 的，V0.3.1 是声明式扩展 ——
//   本插件提供 capability（knowledge.*），由 skills/knowledge-verify 用 api.capability() 软依赖消费。
//
// 软依赖（缺了不崩，自动降级）：
//   - MongoDB（127.0.0.1:27017）：无库时降级纯本地词面检索 + 跳过入库，绝不让回答变慢或失败
//   - 语义向量服务（127.0.0.1:3917）：不可用时逐字节退回哈希向量（宿主 kb-embed.js 降级路径照搬）
//
// ⚠️ knowledge.* 是自建能力名 —— 核心不认识。必须被 skills/knowledge-verify 的
//   api.capability('knowledge.recall'/'knowledge.agent-write'/'knowledge.crawl') 消费，
//   否则审计报孤儿能力。knowledge.worker / knowledge.status 供控制台与技能查询用。

import { loadConfig, getCfg, tenantFor, resolvePath, paths, applyEnvOverrides } from './lib/kb-config.js';
import { MongoHandle } from './lib/kb-mongo.js';
import { AuditLogger } from './lib/kb-audit.js';
import { IngestQueue } from './lib/kb-ingest.js';
import { IngestWorker } from './lib/kb-worker.js';
import { Embedder } from './lib/kb-embed.js';
import { retrieveFromKb, buildKbContext } from './lib/kb-retrieve.js';
import { raceTimeout, nowMs, newId, sha256Hex, summarize, tokenize, round } from './lib/kb-util.js';
import { COLLECTIONS, STATUS } from './lib/kb-schema.js';
import { searchWebFallback } from './lib/search-fallback.js';
import fs from 'node:fs';

export const NO_RESULT_NOTE = '暂无，已记录。';

// ── 模块状态（setup 初始化，deactivate 清理）─────────────────────────
let cfg = () => ({});
let mongoHandle = null;          // MongoHandle | null（软依赖，探活失败为 null）
let auditLogger = null;
let ingestQueue = null;
let worker = null;
let embedder = null;
let mongoProbeState = { ok: false, reason: '未探测', probeAt: 0 };  // 首次乐观放行+后台探测+缓存
let semanticProbeState = { ok: false, reason: '未探测', probeAt: 0 };
let semanticProbeTimer = null;
let mongoProbeTimer = null;

/** 语义向量服务探活（首次乐观放行 + 后台探测 + 缓存，参考宿主 speech-to-text 的 probeState 模式）。 */
function probeSemantic() {
  return new Promise((resolve) => {
    const url = String((cfg() && cfg().semanticEmbedUrl) || 'http://127.0.0.1:3917');
    fetch(url + '/health', { signal: AbortSignal.timeout(800) })
      .then((res) => {
        semanticProbeState = { ok: res.ok, reason: res.ok ? 'online' : 'HTTP ' + res.status, probeAt: Date.now() };
        resolve(semanticProbeState.ok);
      })
      .catch((err) => {
        semanticProbeState = { ok: false, reason: String(err?.message ?? err), probeAt: Date.now() };
        resolve(false);
      });
  });
}

/** 定时重探语义服务（看门狗，每 60s 一次；宿主有独立 watchdog，这里简化为插件内轮询）。 */
function scheduleSemanticProbe() {
  if (semanticProbeTimer) return;
  semanticProbeTimer = setInterval(() => { probeSemantic().catch(() => {}); }, 60_000);
  semanticProbeTimer.unref?.();
}

let api = null;

export function setup(a) {
  api = a;
  cfg = a.config;
  api.log('kb-growth 已加载（Mongo/语义向量均为软依赖，缺了自动降级）');
}

/** available() 必须同步：首次乐观放行，后台补探测。缺 Mongo 不判不可用（降级纯本地）。 */
export function available() {
  if (cfg().enabled === false) return { ok: false, reason: 'kbGrowth.enabled=false' };
  return {
    ok: true,
    reason: mongoProbeState.ok ? 'Mongo 已连接' : '降级模式：' + (mongoProbeState.reason || 'Mongo 未探活'),
  };
}

export async function activate(ctx) {
  const c = cfg();
  // 1) Mongo 软依赖探活（不阻塞 activate，后台跑）
  mongoProbeState = { ok: false, reason: '探测中', probeAt: Date.now() };
  (async () => {
    try {
      mongoHandle = new MongoHandle({ uri: c.mongoUri, db: c.mongoDb });
      await mongoHandle.connect({ serverSelectionTimeoutMs: 800 });
      mongoProbeState = { ok: true, reason: 'connected', probeAt: Date.now() };
      api.log?.('kb-growth: MongoDB 已连接 ' + c.mongoUri);
    } catch (e) {
      mongoHandle = null;
      mongoProbeState = { ok: false, reason: e?.message ?? String(e), probeAt: Date.now() };
      api.log?.('kb-growth: MongoDB 不可用 → 降级纯本地词面检索（' + e?.message + '）');
    }
  })();

  // 2) 审计日志
  auditLogger = new AuditLogger({ enabled: true, flushIntervalMs: 1000, maxBuffer: 500 });
  // 3) 入队队列（内存，微秒级入队不 await IO）
  ingestQueue = new IngestQueue({
    maxSize: 500,
    dedupeMs: 600000,
    onFlush: async (items) => {
      if (!mongoHandle || !mongoProbeState.ok) {
        // Mongo 不可用：死信落盘，不卡
        const file = resolvePath('kb-growth/dead-letter.jsonl');
        try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
        try { fs.appendFileSync(file, items.map((i) => JSON.stringify(i)).join('\n') + '\n'); } catch {}
        return;
      }
      try {
        const db = mongoHandle.db;
        const now = new Date();
        for (const item of items) {
          await db.collection(COLLECTIONS.tasks).insertOne({
            task_id: item.taskId ?? newId(),
            tenant_id: item.tenantId ?? 'default',
            kind: item.kind,
            payload: item.payload,
            priority: item.priority ?? 1,
            status: 'pending',
            attempts: 0,
            created_at: now,
            expires_at: new Date(now.getTime() + 37 * 86400_000),
          });
        }
      } catch (e) {
        auditLogger?.log('worker.enqueue_failed', { error: e?.message });
      }
    },
  });

  // 4) 后台 Worker（独立 tick，原子租约领取）
  worker = new IngestWorker({
    mongo: mongoHandle,
    intervalMs: c.worker?.intervalMs ?? 1500,
    batchSize: Number(c.workerBatchSize) || 4,
    concurrency: c.worker?.concurrency ?? 2,
    leaseMs: c.worker?.leaseMs ?? 60_000,
    audit: auditLogger,
  });
  await worker.start();
  api.log?.('kb-growth: 后台 Worker 已启动（tick ' + (c.worker?.intervalMs ?? 1500) + 'ms）');

  // 5) 语义向量服务探活（软依赖）
  if (c.semanticEmbedEnabled !== false) {
    embedder = new Embedder({
      provider: 'local-hash',   // 默认哈希，语义可用时升级
      dim: 256,
      semanticUrl: c.semanticEmbedUrl || 'http://127.0.0.1:3917',
    });
    await probeSemantic();
    scheduleSemanticProbe();
    api.log?.('kb-growth: 语义向量服务 ' + (semanticProbeState.ok ? '已连接' : '不可用 → 退回哈希向量（' + semanticProbeState.reason + '）'));
  }
}

export async function deactivate(ctx) {
  // 必须清掉 activate 建的东西，否则"关掉了但还在推"
  if (semanticProbeTimer) { clearInterval(semanticProbeTimer); semanticProbeTimer = null; }
  try { await worker?.stop(); } catch {}
  worker = null;
  try { await ingestQueue?.flush(); } catch {}
  ingestQueue = null;
  try { auditLogger?.close(); } catch {}
  auditLogger = null;
  try { await mongoHandle?.close(); } catch {}
  mongoHandle = null;
  embedder = null;
  api.log?.('kb-growth: 已停用，后台任务全部清理');
}

export function dispose() {
  mongoHandle = null;
  worker = null;
  ingestQueue = null;
  auditLogger = null;
  embedder = null;
}

// ── providers ────────────────────────────────────────────────────
export const providers = {
  /**
   * 同步检索链路（200ms 预算）。核心/技能问"某问题有没有本地知识"。
   * 入参：{ query, chatKey?, topK? }
   * 返回：{ context, source, confidence, note?, latency_ms, web?, degraded }
   *   - 命中本地 → source='kb'，context 为拼好的检索资料
   *   - 未命中 → 走联网兜底（3s 预算）→ source='web'；都没有 → source='none'，note=NO_RESULT_NOTE
   *   - Mongo 不可用 → 降级纯词面，degraded=true
   * 软依赖：search-web（宿主多引擎聚合搜索能力）；无则用内置兜底。
   */
  'knowledge.recall': async ({ query, chatKey, topK } = {}) => {
    const c = cfg();
    const tenant = tenantFor(chatKey, c);
    const t0 = nowMs();
    let degraded = false;

    // [1] MongoDB 混合检索（200ms 预算；Mongo 不可用则降级词面）
    let kbHit = null;
    if (mongoProbeState.ok && mongoHandle) {
      try {
        kbHit = await raceTimeout(
          retrieveFromKb(mongoHandle, { tenant, query, topK: topK ?? 5, keywordWeight: c.keywordWeight, vectorWeight: c.vectorWeight, hardMinConfidence: c.hardMinConfidence }),
          Number(c.retrieveTimeoutMs) || 200,
        );
      } catch { kbHit = null; }
    } else {
      degraded = true;
      // 纯本地词面：扫 data/kb-growth/local-chunks.jsonl（无 Mongo 时的兜底存储）
      kbHit = localLexicalRecall(c, { tenant, query, topK: topK ?? 5 });
    }

    if (kbHit && kbHit.confidence >= (c.retrieve?.minConfidence ?? 0.7)) {
      const context = buildKbContext(kbHit.hits ?? [], c.retrieve?.maxContextChars ?? 2600);
      // 顺手入队（微秒级，不 await IO）
      if (c.fallback?.ingestResults) {
        ingestQueue?.enqueue({
          taskId: newId(), tenantId: tenant, kind: 'query',
          payload: { query, chatKey }, priority: 2,
        }).catch(() => {});
      }
      return {
        context, source: 'kb', confidence: round(kbHit.confidence),
        latency_ms: nowMs() - t0, degraded,
      };
    }

    // [2] 未命中 / 低置信 → 联网兜底（3s 预算）
    let web = null;
    if (true) {
      try {
        // 软依赖多引擎聚合搜索能力；无则降级内置简化版
        const searchFn = typeof c.__searchAggregateFn === 'function' ? c.__searchAggregateFn : searchWebFallback;
        web = await raceTimeout(
          searchFn({ query, maxResults: 4 }),
          Number(c.webTimeoutMs) || 3000,
        );
      } catch { web = null; }
    }

    if (web && web.results?.length) {
      const context = buildKbContext(web.results.map((r) => ({
        title: r.title, content: r.snippet ?? r.content, sourceUrl: r.url,
      })), c.retrieve?.maxContextChars ?? 2600);
      if (c.fallback?.ingestResults !== false) {
        ingestQueue?.enqueue({
          taskId: newId(), tenantId: tenant, kind: 'web',
          payload: { query, results: web.results }, priority: 1,
        }).catch(() => {});
      }
      return {
        context, source: web.fromKb ? 'kb+web' : 'web',
        confidence: web.confidence ?? 0.5,
        latency_ms: nowMs() - t0, web: { ms: web.ms, timed_out: !!web.timedOut },
        degraded,
      };
    }

    // [3] 都没有
    return {
      context: '', source: 'none', note: NO_RESULT_NOTE,
      confidence: 0, latency_ms: nowMs() - t0, degraded,
    };
  },

  /**
   * 后台 Worker 状态/手动 tick。供控制台与技能查询。
   * 入参：{ tick? }（true 时立刻跑一轮）
   * 返回：{ running, queueSize, lastRun, stats }
   */
  'knowledge.worker': async ({ tick } = {}) => {
    if (!worker) return { running: false, reason: '未激活' };
    if (tick) await worker.tick?.();
    return { running: true, queueSize: ingestQueue?.size ?? 0, lastRun: worker.lastRunAt, stats: worker.stats };
  },

  /**
   * 插件整体状态（控制台「知识库」页查询用）。
   * 返回：{ mongo: mongoProbeState, semantic: semanticProbeState, worker, queueSize }
   */
  'knowledge.status': async () => ({
    mongo: mongoProbeState,
    semantic: semanticProbeState,
    worker: worker ? { running: true, stats: worker.stats } : { running: false },
    queueSize: ingestQueue?.size ?? 0,
    noResultNote: NO_RESULT_NOTE,
  }),

  /**
   * 控制台「扩展」面板数据（只读）—— panel. 前缀 = 核心放行的只读约定。
   * 返回统一面板结构：{ title, summary[], sections[] }，由控制台通用渲染器画。
   */
  'panel.knowledge': async () => {
    const c = cfg();
    const summary = [
      { label: 'MongoDB', value: mongoProbeState.ok ? '已连接' : ('降级：' + (mongoProbeState.reason || '未探活')) },
      { label: '语义向量', value: semanticProbeState.ok ? '已连接' : ('退回哈希：' + (semanticProbeState.reason || '未探活')) },
      { label: 'Worker', value: worker ? '运行中' : '未启动' },
      { label: '队列', value: String(ingestQueue?.size ?? 0) },
    ];
    const sections = [];
    if (!mongoProbeState.ok || !mongoHandle?.db) {
      sections.push({ type: 'note', title: '为什么看不到数据', text: 'MongoDB 不可用（' + (mongoProbeState.reason || '未探活') + '），知识库当前走纯本地词面降级，没有可展示的库内数据。' });
      return { title: '知识库', summary, sections };
    }
    try {
      const db = mongoHandle.db;
      const tenant = tenantFor(null, c);
      const [chunks, cands, tasks] = await Promise.all([
        db.collection(COLLECTIONS.chunks).countDocuments({ tenant_id: tenant, status: 'active' }),
        db.collection(COLLECTIONS.candidates).countDocuments({ tenant_id: tenant }),
        db.collection(COLLECTIONS.tasks).countDocuments({ status: 'pending' }),
      ]);
      summary.push({ label: '正式分块', value: String(chunks) }, { label: '候选池', value: String(cands) }, { label: '待入库任务', value: String(tasks) });
      const recent = await db.collection(COLLECTIONS.chunks)
        .find({ tenant_id: tenant, status: 'active' })
        .sort({ created_at: -1 }).limit(20)
        .project({ title: 1, content: 1, source_url: 1, source_trust: 1, confidence: 1 })
        .toArray();
      sections.push({
        type: 'table', title: '最近入库（20 条）',
        columns: ['标题', '来源信任', '置信度', '正文摘要'],
        rows: recent.map((x) => [
          String(x.title ?? '-').slice(0, 30),
          String(x.source_trust ?? '-'),
          x.confidence != null ? Number(x.confidence).toFixed(2) : '-',
          String(x.content ?? '').replace(/\s+/g, ' ').slice(0, 60),
        ]),
      });
      const pending = await db.collection(COLLECTIONS.candidates)
        .find({ tenant_id: tenant, status: 'pending' })
        .sort({ created_at: -1 }).limit(20)
        .project({ title: 1, source_trust: 1, confidence: 1, risk_level: 1 })
        .toArray();
      if (pending.length) {
        sections.push({
          type: 'table', title: '待审候选（20 条）',
          columns: ['标题', '来源', '置信度', '风险'],
          rows: pending.map((x) => [String(x.title ?? '-').slice(0, 30), String(x.source_trust ?? '-'), x.confidence != null ? Number(x.confidence).toFixed(2) : '-', String(x.risk_level ?? '-')]),
        });
      }
    } catch (e) {
      sections.push({ type: 'note', title: '查询失败', text: String(e?.message ?? e) });
    }
    return { title: '知识库', summary, sections };
  },

  /**
   * agent 自行追加知识库（仅管理员）。宿主 tools.js kb_write 语义照搬。
   * 入参：{ action:'create'|'append', title, content, targetTitle, sourceUrl, images, requester, chatKey }
   * 返回：{ ok, chunks, chunksSkipped, deduped, images, imagesSkipped, error? }
   * 鉴权：requester（QQ 号）必须在 settings.adminWriteQq 名单里，否则 ok:false。
   */
  'knowledge.agent-write': async ({ action = 'create', title, content, targetTitle, sourceUrl, images = [], requester, chatKey } = {}) => {
    const c = cfg();
    const adminQq = String(c.adminWriteQq ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!adminQq.length || !adminQq.includes(String(requester ?? ''))) {
      return { ok: false, error: '无权限：只有管理员能写正式知识库（当前 settings.adminWriteQq 为空或不含该 QQ）' };
    }
    if (!mongoProbeState.ok || !mongoHandle) {
      return { ok: false, error: 'MongoDB 不可用，无法写入正式库（' + mongoProbeState.reason + '）' };
    }
    const contentText = String(content ?? '').trim();
    if (contentText.length < 40 && !images.length) {
      return { ok: false, error: '正文至少 40 字（或提供图片），太短不值得入库' };
    }
    const tenant = tenantFor(chatKey, c);
    const db = mongoHandle.db;
    const chunks = contentText
      ? splitChunks(contentText, Number(c.chunkSize) || 420, Number(c.chunkOverlap) || 80)
      : [];
    const now = new Date();
    let written = 0, skipped = 0, deduped = false;
    const docId = targetTitle
      ? await findDocIdByTitle(db, tenant, targetTitle) ?? newId()
      : newId();
    for (const chunk of chunks) {
      const dup = await db.collection(COLLECTIONS.chunks).findOne({
        tenant_id: tenant, doc_id: docId, content_hash: sha256Hex(chunk), status: 'active',
      });
      if (dup) { skipped++; deduped = true; continue; }
      await db.collection(COLLECTIONS.chunks).insertOne({
        chunk_id: newId(), tenant_id: tenant, doc_id,
        title: targetTitle || title || contentText.slice(0, 30),
        content: chunk,
        tokens: tokenize(chunk),
        embedding: embedder ? await embedder.embed(chunk) : null,
        embed_provider: embedder?.provider ?? 'none',
        source_url: sourceUrl || null,
        source_trust: 'manual',
        confidence: 0.9,
        risk_level: 'low',
        content_hash: sha256Hex(chunk),
        status: 'active',
        created_at: now,
        expires_at: new Date(now.getTime() + (Number(c.chunkTtlDays) || 180) * 86400_000),
        index_version: 1,
      });
      written++;
    }
    let imgCount = 0, imgSkipped = 0;
    if (images.length) {
      for (const img of images) {
        // 去重：有 url 按 url 去重；没有 url（data URL / 本地文件来源）按内容 hash 去重
        const buf = img.buffer || null;
        const contentHash = buf ? sha256Hex(buf.toString('base64').slice(0, 200000)) : null;
        const dupFilter = img.url
          ? { doc_id: docId, url: img.url }
          : (contentHash ? { doc_id: docId, content_hash: contentHash } : null);
        if (dupFilter) {
          const dup = await db.collection('knowledge_images').findOne(dupFilter);
          if (dup) { imgSkipped++; continue; }
        }
        await db.collection('knowledge_images').insertOne({
          image_id: newId(), doc_id, tenant_id: tenant,
          url: img.url || null,
          mime: img.mime || 'image/jpeg',
          content_hash: contentHash,
          buffer: buf ? buf.toString('base64') : null,
          bytes: buf ? buf.length : 0,
          created_at: now,
        });
        imgCount++;
      }
    }
    return { ok: true, action, docId, chunks: written, chunksSkipped: skipped, deduped, images: imgCount, imagesSkipped: imgSkipped };
  },

  /**
   * 爬取 URL 正文+配图，写入正式库（仅管理员）。宿主 kb_crawl 语义照搬。
   * 入参：{ url, title?, maxImages, requester, chatKey }
   * 返回：{ ok, docId, chunks, images, error? }
   */
  'knowledge.crawl': async ({ url, title, maxImages = 3, requester, chatKey } = {}) => {
    const c = cfg();
    const adminQq = String(c.adminWriteQq ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!adminQq.length || !adminQq.includes(String(requester ?? ''))) {
      return { ok: false, error: '无权限：只有管理员能爬取网页存入知识库' };
    }
    if (!mongoProbeState.ok || !mongoHandle) return { ok: false, error: 'MongoDB 不可用，无法爬取入库' };
    if (!/^https?:\/\//i.test(String(url ?? ''))) return { ok: false, error: 'url 必须是 http/https 链接' };
    // 宿主 crawlUrl 走 kb-growth.js 的 fetch + 图片采集，这里简化：抓正文 → 走 agent-write 同路
    let text = '';
    try {
      const res = await fetch(String(url), { signal: AbortSignal.timeout(10_000) });
      text = await res.text();
      text = stripHtml(text);
    } catch (e) {
      return { ok: false, error: '抓取失败：' + (e?.message ?? e) };
    }
    return providers['knowledge.agent-write']({
      action: 'create', title: title || url, content: text,
      sourceUrl: url, images: [], requester, chatKey,
    });
  },
};

// ── 本地降级词面检索（无 Mongo 时）──────────────────────────────────
function localLexicalRecall(c, { tenant, query, topK }) {
  const file = resolvePath('kb-growth/local-chunks.jsonl');
  try {
    if (!fs.existsSync(file)) return { confidence: 0, hits: [] };
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const qTokens = tokenize(query);
    const scored = lines.map((line) => {
      try {
        const doc = JSON.parse(line);
        const toks = new Set(doc.tokens ?? []);
        let hit = 0;
        for (const t of qTokens) if (toks.has(t)) hit++;
        const conf = qTokens.length ? hit / qTokens.length : 0;
        return { ...doc, _conf: conf };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b._conf - a._conf).slice(0, topK);
    const maxConf = scored[0]?._conf ?? 0;
    return { confidence: maxConf, hits: scored };
  } catch { return { confidence: 0, hits: [] }; }
}

// ── 辅助函数 ──────────────────────────────────────────────────────
import path from 'node:path';
function stripHtml(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ensp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
function splitChunks(text, size, overlap) {
  const out = [];
  const t = String(text ?? '');
  if (!t.length) return out;
  for (let i = 0; i < t.length; i += Math.max(1, size - overlap)) {
    out.push(t.slice(i, i + size));
    if (i + size >= t.length) break;
  }
  return out;
}
async function findDocIdByTitle(db, tenant, title) {
  const row = await db.collection(COLLECTIONS.chunks).findOne({ tenant_id: tenant, title, status: 'active' });
  return row?.doc_id ?? null;
}
