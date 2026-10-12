import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DATA_DIR, getConfig } from './config.js';
import { listOfficialPrices } from './model-prices.js';

const MAX_QUEUE = 8;
const JOB_TIMEOUT = 120_000;
const IDLE_TERMINATE = 30_000;

function pricingSnapshot() {
  const cfg = getConfig(); const api = cfg.api || {};
  const price = (entry) => ({ in: Number(entry?.in) || 0, out: Number(entry?.out) || 0,
    cached: entry?.cached == null ? null : Number(entry.cached) || 0,
    peak: entry?.peak && typeof entry.peak === 'object' ? { in: Number(entry.peak.in) || 0, out: Number(entry.peak.out) || 0, cached: entry.peak.cached == null ? null : Number(entry.peak.cached) || 0 } : null });
  const custom = Object.create(null); let count = 0, bytes = 0;
  for (const [id, entry] of Object.entries(api.modelPrices || {})) {
    const value = price(entry); bytes += Buffer.byteLength(id) + Buffer.byteLength(JSON.stringify(value)); count++;
    if (count > 4096 || bytes > 1024 * 1024 || Buffer.byteLength(id) > 4096) throw new Error('自定义价格表超过用量统计的 4096 条或 1 MiB 上限');
    custom[id] = value;
  }
  const table = [];
  for (const entry of listOfficialPrices()) {
    const value = { id: String(entry.id), ...price(entry) }; bytes += Buffer.byteLength(JSON.stringify(value)); count++;
    if (count > 8192 || bytes > 2 * 1024 * 1024 || Buffer.byteLength(value.id) > 4096) throw new Error('官方及远程价格表超过用量统计的 8192 条或 2 MiB 上限');
    table.push(value);
  }
  return { config: { api: {
    useOfficialPrice: api.useOfficialPrice === true,
    modelPrices: custom,
    priceInputPerM: Number(api.priceInputPerM) || 0, priceOutputPerM: Number(api.priceOutputPerM) || 0, priceCachedPerM: Number(api.priceCachedPerM) || 0
  } }, table };
}

/** Main-thread facade. The worker is lazy, serial, bounded, and disposable when idle. */
export class UsageService {
  #worker = null; #queue = []; #active = null; #nextId = 1; #idleTimer = null; #closed = false; #stopping = null;
  constructor({ dataDir = DATA_DIR, timeoutMs = JOB_TIMEOUT, queueCapacity = MAX_QUEUE } = {}) {
    this.dataDir = dataDir; this.timeoutMs = Math.min(JOB_TIMEOUT, Math.max(1000, Number(timeoutMs) || JOB_TIMEOUT)); this.queueCapacity = Math.min(MAX_QUEUE, Math.max(1, Number(queueCapacity) || MAX_QUEUE));
    this.sessionsDir = path.join(dataDir, 'sessions'); this.indexFile = path.join(dataDir, 'usage.sqlite');
  }
  status() { return { active: this.#active ? 1 : 0, pending: this.#queue.length, worker: Boolean(this.#worker) }; }
  #startWorker() {
    if (this.#worker) return this.#worker;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const worker = new Worker(new URL('./usage-worker.js', import.meta.url), { workerData: { indexFile: this.indexFile, sessionsDir: this.sessionsDir }, resourceLimits: { maxOldGenerationSizeMb: 112, maxYoungGenerationSizeMb: 16 } });
    this.#worker = worker;
    worker.on('message', (m) => this.#message(m));
    worker.on('error', (error) => { if (this.#worker === worker) this.#failWorker(error); });
    worker.on('exit', (code) => { if (this.#worker === worker) this.#failWorker(new Error(`用量统计线程退出（${code}）`)); });
    worker.unref();
    return worker;
  }
  #message(message) {
    if (!this.#active || message.id !== this.#active.id) return;
    if (message.progress) { this.#active.progress = message.progress; return; }
    const job = this.#active; this.#active = null; clearTimeout(job.timer);
    if (message.error) job.reject(new Error(message.error)); else job.resolve(message.value);
    this.#pump();
  }
  #failWorker(error) {
    clearTimeout(this.#idleTimer);
    const active = this.#active; this.#active = null; if (active) { clearTimeout(active.timer); active.reject(error); }
    while (this.#queue.length) this.#queue.shift().reject(new Error('用量统计线程已停止，任务未执行'));
    const worker = this.#worker;
    this.#worker = null;
    if (worker) this.#stopping = this.#stopWorker(worker, false).finally(() => { this.#stopping = null; this.#pump(); });
  }
  #pump() {
    if (this.#closed || this.#stopping || this.#active || !this.#queue.length) { if (!this.#active && !this.#queue.length && this.#worker) this.#armIdle(); return; }
    clearTimeout(this.#idleTimer); const job = this.#queue.shift(); this.#active = job;
    try {
      const worker = this.#startWorker();
      job.timer = setTimeout(() => { this.#failWorker(new Error(`用量统计超过 ${this.timeoutMs / 1000} 秒，已终止后台线程`)); }, this.timeoutMs);
      worker.postMessage({ op: 'query', id: job.id, kind: job.kind, args: job.args, pricing: pricingSnapshot(), now: Date.now() });
    } catch (error) { this.#failWorker(error); }
  }
  async #stopWorker(worker, graceful) {
    if (!worker) return;
    if (graceful) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        const done = () => { clearTimeout(timer); worker.off('exit', done); resolve(); };
        worker.once('exit', done); worker.postMessage({ op: 'close', id: 0 });
      });
    }
    await worker.terminate().catch(() => {});
  }
  #armIdle() {
    clearTimeout(this.#idleTimer); this.#idleTimer = setTimeout(() => {
      const worker = this.#worker; this.#worker = null;
      this.#stopping = this.#stopWorker(worker, true).finally(() => { this.#stopping = null; this.#pump(); });
    }, IDLE_TERMINATE); this.#idleTimer.unref?.();
  }
  query(kind, args = {}) {
    if (this.#closed) return Promise.reject(new Error('用量统计服务已关闭'));
    if (kind !== 'stats' && kind !== 'breakdown') return Promise.reject(new Error('不支持的用量查询'));
    if (this.#queue.length + (this.#active ? 1 : 0) >= this.queueCapacity) return Promise.reject(new Error('用量统计队列已满，请稍后重试'));
    const bounded = Object.fromEntries(['range', 'dim', 'key', 'by'].map((k) => [k, String(args?.[k] || '')]));
    if (Object.values(bounded).some((v) => Buffer.byteLength(v) > 4096)) return Promise.reject(new Error('用量查询参数超过 4096 字节'));
    return new Promise((resolve, reject) => { this.#queue.push({ id: this.#nextId++, kind, args: bounded, resolve, reject, timer: null }); this.#pump(); });
  }
  async close() {
    this.#closed = true; clearTimeout(this.#idleTimer);
    const error = new Error('用量统计服务已关闭'); const wasActive = Boolean(this.#active); if (this.#active) { clearTimeout(this.#active.timer); this.#active.reject(error); this.#active = null; }
    while (this.#queue.length) this.#queue.shift().reject(error);
    const worker = this.#worker; this.#worker = null; await this.#stopWorker(worker, !wasActive); if (this.#stopping) await this.#stopping;
  }
}

export const usageService = new UsageService();
