#!/usr/bin/env node
// Usage: node scripts/message-storage.mjs migrate --data-dir /absolute/data
//        node scripts/message-storage.mjs export --data-dir /absolute/data --output /absolute/export
//        node scripts/message-storage.mjs rollback --data-dir /absolute/data
import { runStorageMaintenance } from '../src/storage-maintenance.js';

const [operation, ...args] = process.argv.slice(2);
const options = { operation };
const names = { '--data-dir': 'dataDir', '--output': 'outputDir', '--max-record-mib': 'maxRecordBytes' };
try {
  if (!operation || operation === '--help') {
    console.log('停止 QQA 后执行：\n  node scripts/message-storage.mjs migrate --data-dir /绝对数据目录\n  node scripts/message-storage.mjs export --data-dir /绝对数据目录 --output /不存在的绝对导出目录\n  node scripts/message-storage.mjs rollback --data-dir /绝对数据目录\n迁移保留原 JSON；回滚先导出 SQLite 最新数据，不会丢弃迁移后的新消息。使用 auto 后端，并清除冲突的 QQ_AGENT_STORE_BACKEND 环境覆盖。');
  } else {
    for (let i = 0; i < args.length; i += 2) {
      const name = names[args[i]];
      if (!name || !args[i + 1]) throw new Error(`未知或不完整参数：${args[i]}`);
      options[name] = name === 'maxRecordBytes' ? Number(args[i + 1]) * 1024 * 1024 : args[i + 1];
    }
    const abort = new AbortController();
    process.once('SIGINT', () => abort.abort());
    process.once('SIGTERM', () => abort.abort());
    const result = await runStorageMaintenance(options, {
      signal: abort.signal,
      onProgress: value => process.stderr.write(`${JSON.stringify(value)}\n`),
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  }
} catch (error) {
  console.error(`消息存储维护失败：${error.message}`);
  process.exitCode = 1;
}
