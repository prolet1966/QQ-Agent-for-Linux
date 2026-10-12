/** FIFO work queue. Capacity includes running jobs; rejected work is never executed. */
export class BoundedWorkQueue {
  constructor({ concurrency = 1, capacity = 32, maxWaitMs = 0, name = '任务' } = {}) {
    this.concurrency = concurrency;
    this.capacity = capacity;
    this.name = name;
    this.maxWaitMs = maxWaitMs;
    this.active = 0;
    this.pending = [];
  }

  #value(input, fallback) {
    const n = Number(typeof input === 'function' ? input() : input);
    return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : fallback;
  }

  run(fn) {
    if (this.active + this.pending.length >= this.#value(this.capacity, 32)) {
      return Promise.reject(new Error(`${this.name}队列已满，请稍后重试`));
    }
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject, timer: null };
      this.pending.push(job);
      if (this.maxWaitMs > 0) job.timer = setTimeout(() => {
        const index = this.pending.indexOf(job);
        if (index < 0) return;
        this.pending.splice(index, 1);
        reject(new Error(`${this.name}排队超时，请稍后重试`));
      }, this.maxWaitMs);
      this.#drain();
    });
  }

  #drain() {
    while (this.pending.length && this.active < this.#value(this.concurrency, 1)) {
      const job = this.pending.shift();
      if (job.timer) clearTimeout(job.timer);
      this.active++;
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => {
        this.active--;
        this.#drain();
      });
    }
  }

  status() { return { active: this.active, pending: this.pending.length }; }
}
