// kb-worker.js —— 后台 Worker（从宿主 kb-worker.js 提炼；原子租约领取，独立 tick）
import crypto from 'node:crypto';

export class IngestWorker {
  constructor({ mongo, intervalMs = 1500, batchSize = 4, concurrency = 2, leaseMs = 60000, audit } = {}) {
    this.mongo = mongo;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.concurrency = concurrency;
    this.leaseMs = leaseMs;
    this.audit = audit;
    this.running = false;
    this.timer = null;
    this.lastRunAt = null;
    this.stats = { processed: 0, failed: 0, duplicates: 0 };
  }
  async start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
  }
  async tick() {
    if (!this.running || !this.mongo?.db || !this.mongo.db.collection) return;
    this.lastRunAt = Date.now();
    const tasks = await this.leaseTasks();
    for (const t of tasks) await this.processTask(t);
  }
  async leaseTasks() {
    const db = this.mongo.db;
    const now = new Date();
    const until = new Date(Date.now() + this.leaseMs);
    const res = await db.collection('ingest_tasks').find({ status: 'pending' }).sort({ priority: -1, created_at: 1 }).limit(this.batchSize).toArray();
    for (const t of res) {
      await db.collection('ingest_tasks').updateOne({ _id: t._id, status: 'pending' }, {
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
      const dup = await this.mongo.db.collection('knowledge_candidates').findOne({ doc_content_hash: hash, status: { $in: ['pending', 'auto_approved'] } });
      if (dup) { this.stats.duplicates++; await this.markDone(task, 'duplicate'); return; }
      await this.mongo.db.collection('knowledge_candidates').insertOne({
        candidate_id: new Date().toISOString().replace(/[-:.]/g, '').slice(0, 14),
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
      await this.mongo.db.collection('ingest_tasks').updateOne({ _id: task._id }, { $set: { status: 'done', result, finished_at: new Date() } });
    } catch {}
  }
  async stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
