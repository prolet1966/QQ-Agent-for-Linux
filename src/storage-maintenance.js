import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { acquireProcessLock } from './process-lock.js';

function acquireLock(dataDir) {
  const file = path.join(dataDir, 'qq-agent.lock');
  const result = acquireProcessLock(file);
  if (!result.ok) throw new Error(`${result.reason}；请先停止 QQA 再迁移。`);
  return result;
}

export async function runStorageMaintenance({ operation, dataDir, outputDir, maxRecordBytes = 16 * 1024 * 1024 }, { onProgress = () => {}, signal } = {}) {
  if (!['migrate', 'export', 'rollback'].includes(operation)) throw new Error('operation 必须是 migrate、export 或 rollback');
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('请提供绝对数据目录路径');
  dataDir = path.resolve(dataDir);
  if (operation === 'export') {
    if (!outputDir || !path.isAbsolute(outputDir)) throw new Error('export 需要绝对输出目录路径');
    outputDir = path.resolve(outputDir);
    if (fs.existsSync(outputDir)) throw new Error(`导出目录已经存在：${outputDir}`);
    fs.mkdirSync(path.dirname(outputDir), { recursive: true });
    // Staging and final export must be on the same filesystem for atomic rename.
    if (fs.statSync(path.dirname(outputDir)).dev !== fs.statSync(dataDir).dev) throw new Error('请在数据目录所在文件系统中导出，完成后再复制到其他磁盘。');
  }
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1024 || maxRecordBytes > 64 * 1024 * 1024) {
    throw new Error('maxRecordBytes 必须在 1 KiB–64 MiB 之间');
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lock = acquireLock(dataDir);
  const stageDir = path.join(dataDir, `.message-storage-${crypto.randomUUID()}`);
  let worker;
  try {
    let savedBackend = 'auto';
    const configFile = path.join(dataDir, 'config.json');
    if (fs.existsSync(configFile)) {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
      savedBackend = config.store?.backend || 'auto';
    }
    const forcedBackend = process.env.QQ_AGENT_STORE_BACKEND || savedBackend;
    if (operation !== 'export' && forcedBackend !== 'auto') {
      throw new Error('切换存储前请将 config.json 的 store.backend 设为 auto，并清除 QQ_AGENT_STORE_BACKEND 覆盖；否则运行时会忽略迁移/回滚结果。');
    }
    if (operation === 'export' && forcedBackend === 'json') {
      throw new Error('当前配置强制使用 JSON；不能把旧 SQLite 档案当作最新数据导出。');
    }
    if (signal?.aborted) throw new Error('存储维护已取消');
    return await new Promise((resolve, reject) => {
      worker = new Worker(new URL('./storage-worker.js', import.meta.url), {
        workerData: { operation, dataDir, outputDir, stageDir, maxRecordBytes },
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
      });
      const abort = () => { worker.terminate().finally(() => reject(new Error('存储维护已取消；未完成的迁移不会切换后端。'))); };
      signal?.addEventListener('abort', abort, { once: true });
      worker.once('exit', code => {
        signal?.removeEventListener('abort', abort);
        if (code !== 0) reject(new Error(`存储维护 Worker 提前退出（${code}）；源数据与已完成的检查点保留。`));
      });
      worker.once('error', reject);
      worker.on('message', message => {
        if (message.error) reject(new Error(message.error));
        else if (message.result) resolve(message.result);
        else if (message.progress) {
          try { onProgress(message.progress); } catch (error) { worker.terminate().finally(() => reject(error)); }
        }
      });
    });
  } finally {
    // Never release the shared lock before the worker has stopped writing.
    if (worker) await worker.terminate();
    fs.rmSync(stageDir, { recursive: true, force: true });
    lock.release();
  }
}
