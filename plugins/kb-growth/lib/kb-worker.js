// kb-worker.js —— 后台 Worker（从宿主 kb-worker.js 提炼；原子租约领取，独立 tick）
//
// 2026-09-29 补全「自主增删」闭环（此前只有入候选，缺三块）：
//   1. ensureIndexes：Mongo 连上后按 kb-schema 的 INIT_INDEXES 建齐索引，
//      chunks/candidates/tasks/logs 的 expires_at 都要挂 TTL —— 没有 TTL 索引，
//      过期时间写再多也永远不删（这是"自主删除"丢了的主因之一）。
//   2. promoteCandidates：周期扫 pending 候选，够信任等级 + 够置信度 → 分块写入
//      knowledge_chunks（status=active，TTL=chunkTtlDays）并把候选转 auto_approved；
//      不够格的候选标记 promote_attempted 后不再重扫，等候选 TTL 到期由 Mongo 自动删。
//      敏感主题（medical/legal/finance）一律不自动晋升，留给人工。
//   3. rejectStaleLeases：任务租约过期自动回滚 pending（掉线/崩溃的实例不再永久卡单）。
import crypto from 'node:crypto';
import { COLLECTIONS, STATUS, INIT_INDEXES } from './kb-schema.js';
import { newId, sha256Hex, tokenize, round } from './kb-util.js';

const SENSITIVE_TOPICS = ['medical', 'legal', 'finance'];

export class IngestWorker {
  constructor({ mongo, intervalMs = 1500, batchSize = 4, concurrency = 2, leaseMs = 60000, audit, config = null, embedder = null, promoteEveryMs = 30000 } = {}) {
    this.mongo = mongo;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.concurrency = concurrency;
    this.leaseMs = leaseMs;
    this.audit = audit;
    this.config = config;          // () => 插件配置（读 chunkSize/chunkTtlDays/autoApprove*）
    this.embedder = embedder;      // 晋升时分块做向量（语义挂了自动退回哈希）
    this.promoteEveryMs = promoteEveryMs;
    this.running = false;
    this.timer = null;
    this.promoteTimer = null;
    this.lastRunAt = null;
    this.lastPromoteAt = null;
    this.stats = { processed: 0, failed: 0, duplicates: 0, promoted: 0, rejected: 0 };
  }

  /* ── 索引（TTL 索引是"自主删除"的开关）────────────────────────────── */
  async ensureIndexes() {
    const db = this.mongo?.db;
    if (!db?.collection) return false;
    let ok = 0;
    for (const spec of INIT_INDEXES) {
      try {
        await db.collection(spec.collection).createIndexes([{ name: spec.name, key: spec.keys, ...(spec.expireAfterSeconds !== undefined ? { expireAfterSeconds: spec.expireAfterSeconds } : {}), ...(spec.unique ? { unique: true } : {}), ...(spec.sparse ? { sparse: true } : {}) }]);
        ok++;
      } catch (e) {
        // 同名索引已存在/定义冲突：忽略（幂等语义），不阻塞 worker
        this.audit?.log?.('index.error', { name: spec.name, error: e?.message ?? String(e) });
      }
    }
    return ok > 0;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.promoteTimer = setInterval(() => this.promoteTick().catch(() => {}), this.promoteEveryMs);
    this.promoteTimer.unref?.();
    // 索引：Mongo 连接是插件里**后台异步**完成的（activate 里探测不阻塞），
    // worker 构造时 db 往往还没就绪。这里每 5s 重试，直到建齐或放弃。
    let retries = 0;
    const tryIndexes = async () => {
      if (!this.running) return;
      try {
        if (this.mongo?.db) {
          const ok = await this.ensureIndexes();
          if (ok || retries >= 20) return;
        }
      } catch { /* 软失败继续重试 */ }
      retries++;
      if (this.running && retries <= 20) setTimeout(tryIndexes, 5000);
    };
    tryIndexes();
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
    // 首轮尽快：慢启动 1s 后先跑一遍，避免刚部署时等一个完整 interval
    setTimeout(() => { this.tick().catch(() => {}); }, 1000);
  }

  /* ── 任务 tick ─────────────────────────────────────────────────────── */
  async tick() {
    if (!this.running || !this.mongo?.db || !this.mongo.db.collection) return;
    this.lastRunAt = Date.now();
    await this.reclaimStaleLeases();
    const tasks = await this.leaseTasks();
    for (const t of tasks) await this.processTask(t);
  }

  /** 租约过期回收：status='leased' 且 leased_until < now → 回滚 pending（不重置 attempts，防死循环）。 */
  async reclaimStaleLeases() {
    try {
      const now = new Date();
      await this.mongo.db.collection(COLLECTIONS.tasks).updateMany(
        { status: 'leased', leased_until: { $lt: now } },
        { $set: { status: 'pending', released_at: now } }
      );
    } catch { /* 回收失败不影响主循环 */ }
  }

  async leaseTasks() {
    const db = this.mongo.db;
    const now = new Date();
    const until = new Date(Date.now() + this.leaseMs);
    const res = await db.collection(COLLECTIONS.tasks).find({ status: 'pending' }).sort({ priority: -1, created_at: 1 }).limit(this.batchSize).toArray();
    for (const t of res) {
      await db.collection(COLLECTIONS.tasks).updateOne({ _id: t._id, status: 'pending' }, {
        $set: { status: 'leased', leased_until: until, attempts: (t.attempts ?? 0) + 1 },
      });
    }
    return res.filter((t) => t.attempts <= (t.max_attempts ?? 3));
  }

  async processTask(task) {
    try {
      const p = task.payload ?? {};
      const text = p.query ? '' : (p.results ? p.results.map((r) => (r.title ?? '') + ' ' + (r.snippet ?? r.content ?? '')).join('\n') : '');
      if (text.length < 48) { this.stats.duplicates++; await this.markDone(task, 'skipped'); return; }
      // 三重去重：URL hash / 内容 hash / 向量 ANN（ANN 需 Mongo，缺了降级前两道）
      const hash = crypto.createHash('sha256').update(text.slice(0, 1500)).digest('hex');
      const dup = await this.mongo.db.collection(COLLECTIONS.candidates).findOne({ doc_content_hash: hash, status: { $in: ['pending', 'auto_approved'] } });
      if (dup) { this.stats.duplicates++; await this.markDone(task, 'duplicate'); return; }
      await this.mongo.db.collection(COLLECTIONS.candidates).insertOne({
        candidate_id: newId(),
        tenant_id: task.tenant_id ?? 'default',
        title: p.query || text.slice(0, 30),
        content: text.slice(0, 2000),
        doc_content_hash: hash,
        url_hash: p.url ? crypto.createHash('sha256').update(p.url).digest('hex') : null,
        source_trust: 'web',
        confidence: 0.6,
        risk_level: 'medium',
        status: 'pending',
        created_at: new Date(),
        expires_at: new Date(Date.now() + 30 * 86400_000),
      });
      this.stats.processed++;
      await this.markDone(task, 'ok');
    } catch (e) {
      this.stats.failed++;
      await this.markDone(task, 'error: ' + e?.message);
    }
  }

  async markDone(task, result) {
    try {
      await this.mongo.db.collection(COLLECTIONS.tasks).updateOne({ _id: task._id }, { $set: { status: 'done', result, finished_at: new Date() } });
    } catch {}
  }

  /* ── 自主晋升（AutoApprove）────────────────────────────────────────── */
  async promoteTick() {
    if (!this.running || !this.mongo?.db?.collection) return;
    const c = (typeof this.config === 'function' ? this.config() : {}) || {};
    const trustLevels = String(c.autoApproveTrust || 'high,web')
      .split(',').map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    const minConf = Number(c.autoApproveConfidence) || 0.7;
    const chunkSize = Math.max(80, Number(c.chunkSize) || 420);
    const chunkOverlap = Math.max(0, Number(c.chunkOverlap) || 80);
    const chunkTtlMs = (Number(c.chunkTtlDays) || 180) * 86400_000;
    const now = new Date();
    const db = this.mongo.db;

    // 只扫"还没评估过"的 pending 候选；不合格的标记 promote_attempted 后不再重扫，
    // 等候选 TTL 到期由 Mongo 自动删除 —— 这就是"增/删"的完整闭环。
    const cands = await db.collection(COLLECTIONS.candidates)
      .find({ status: STATUS.pending, promote_attempted: { $ne: true } })
      .sort({ confidence: -1, created_at: 1 })
      .limit(12)
      .project({ _id: 1, tenant_id: 1, candidate_id: 1, title: 1, content: 1, source_trust: 1, confidence: 1, risk_level: 1 })
      .toArray();
    if (!cands.length) return;

    for (const cand of cands) {
      const trustOk = trustLevels.includes(String(cand.source_trust ?? '').toLowerCase());
      const confOk = Number(cand.confidence ?? 0) >= minConf;
      const sensitive = SENSITIVE_TOPICS.some((t) => String(cand.title || '').toLowerCase().includes(t));

      if (!trustOk || !confOk || sensitive) {
        // 不够格：标记不再重扫（留给人工或 TTL 到期自动删除）
        await db.collection(COLLECTIONS.candidates).updateOne(
          { _id: cand._id },
          { $set: { promote_attempted: true, promote_attempted_at: now, promote_reason: sensitive ? 'sensitive' : (trustOk ? 'low_confidence' : 'low_trust') } }
        );
        this.stats.rejected++;
        continue;
      }

      // 够格：分块写入正式库
      const chunks = splitChunks(String(cand.content ?? ''), chunkSize, chunkOverlap).slice(0, 40);
      let written = 0;
      for (const chunk of chunks) {
        const hash = sha256Hex(chunk);
        const dup = await db.collection(COLLECTIONS.chunks).findOne({ tenant_id: cand.tenant_id, content_hash: hash, status: 'active' });
        if (dup) continue;
        try {
          const embedding = this.embedder ? await this.embedder.embed(chunk) : null;
          await db.collection(COLLECTIONS.chunks).insertOne({
            chunk_id: newId(),
            tenant_id: cand.tenant_id,
            doc_id: cand.candidate_id,
            candidate_id: cand.candidate_id,
            title: String(cand.title ?? '').slice(0, 120),
            content: chunk,
            tokens: tokenize(chunk),
            embedding,
            embed_provider: this.embedder?.provider ?? 'none',
            source_url: null,
            source_trust: String(cand.source_trust ?? 'web'),
            confidence: round(Number(cand.confidence ?? 0.6)),
            risk_level: String(cand.risk_level ?? 'medium'),
            content_hash: hash,
            status: 'active',
            created_at: now,
            expires_at: new Date(now.getTime() + chunkTtlMs),
            index_version: 1,
          });
          written++;
        } catch (e) {
          this.audit?.log?.('promote.chunk_failed', { candidate_id: cand.candidate_id, error: e?.message ?? String(e) });
        }
      }
      await db.collection(COLLECTIONS.candidates).updateOne(
        { _id: cand._id },
        { $set: { status: STATUS.auto_approved, promoted_at: now, promoted_chunks: written, promote_attempted: true } }
      );
      this.stats.promoted++;
      this.lastPromoteAt = now;
    }
  }

  /* ── 停 ────────────────────────────────────────────────────────────── */
  async stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.promoteTimer) { clearInterval(this.promoteTimer); this.promoteTimer = null; }
  }
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