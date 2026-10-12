export class TaskQueue {
  constructor({ concurrency = 1, capacity = 512, onError = console.error } = {}) {
    this.concurrency = Math.max(1, concurrency); this.capacity = Math.max(1, capacity);
    this.onError = onError; this.pending = []; this.running = 0; this.rejected = 0; this.closed = false; this.waiters = [];
  }
  push(task, { priority = 0 } = {}) {
    if (this.closed || this.pending.length >= this.capacity) { this.rejected++; return false; }
    this.pending.push({ task, priority });
    this.pending.sort((a, b) => b.priority - a.priority);
    this.pump(); return true;
  }
  pump() {
    while (this.running < this.concurrency && this.pending.length) {
      const { task } = this.pending.shift(); this.running++;
      Promise.resolve().then(task).catch(this.onError).finally(() => {
        this.running--; this.pump();
        if (!this.running && !this.pending.length) this.waiters.splice(0).forEach(resolve => resolve());
      });
    }
  }
  stats() { return { running: this.running, pending: this.pending.length, capacity: this.capacity, rejected: this.rejected }; }
  async close() { this.closed = true; if (this.running || this.pending.length) await new Promise(resolve => this.waiters.push(resolve)); }
}
