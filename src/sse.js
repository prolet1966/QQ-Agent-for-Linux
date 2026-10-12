// Slow readers are disconnected instead of retaining an unbounded write queue.
export class SseHub {
  constructor({ maxClients = 8, maxEventBytes = 128 * 1024, maxBufferBytes = 256 * 1024, authorize = () => true } = {}) {
    Object.assign(this, { maxClients, maxEventBytes, maxBufferBytes, authorize });
    this.clients = new Set();
    this.dropped = 0;
  }
  add(req, res) {
    if (this.clients.size >= this.maxClients) return false;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    this.clients.add(res);
    const heartbeat = setInterval(() => {
      if (!this.authorize(req)) return res.end();
      this.write(res, ': ping\n\n');
    }, 15000);
    heartbeat.unref?.();
    const cleanup = () => { clearInterval(heartbeat); this.clients.delete(res); };
    res.on('error', cleanup); res.on('close', cleanup);
    this.write(res, 'event: hello\ndata: {}\n\n');
    return true;
  }
  write(res, data) {
    if (res.destroyed || res.writableEnded) { this.clients.delete(res); return; }
    if (res.writableNeedDrain || res.writableLength + Buffer.byteLength(data) > this.maxBufferBytes) {
      this.dropped++; this.clients.delete(res); res.destroy(); return;
    }
    try { res.write(data); } catch { this.clients.delete(res); res.destroy(); }
  }
  emit(event, payload) {
    if (!this.clients.size) return;
    let data = JSON.stringify(payload);
    if (Buffer.byteLength(data) > this.maxEventBytes) {
      data = JSON.stringify({ refresh: true, sessionId: payload?.sessionId || payload?.id, chatKey: payload?.chatKey, status: payload?.status });
    }
    for (const res of this.clients) this.write(res, `event: ${event}\ndata: ${data}\n\n`);
  }
  close() { for (const res of this.clients) res.end(); this.clients.clear(); }
}
