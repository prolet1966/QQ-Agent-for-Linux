// kb-mongo.js —— Mongo 软依赖客户端（从宿主 kb-mongo.js 提炼，动态 import 避免硬依赖）
export class MongoHandle {
  constructor({ uri, db }) {
    this.uri = uri;
    this.dbName = db;
    this.client = null;
    this.db = null;
  }
  async connect(opts = {}) {
    let mod;
    try {
      mod = await import('mongodb');
    } catch {
      throw new Error('mongodb 驱动未安装（软依赖：无驱动时调用方应降级纯本地）');
    }
    const { MongoClient } = mod;
    this.client = new MongoClient(this.uri, {
      serverSelectionTimeoutMS: opts.serverSelectionTimeoutMs ?? 800,
      connectTimeoutMS: opts.connectTimeoutMs ?? 800,
      maxPoolSize: 4,
    });
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    return this;
  }
  async close() {
    try { await this.client?.close(); } catch {}
    this.client = null; this.db = null;
  }
}
