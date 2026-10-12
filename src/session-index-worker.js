import fs from 'node:fs';
import path from 'node:path';
import { workerData, parentPort } from 'node:worker_threads';
import { DATA_DIR } from './config.js';
import { openSessionIndex, summarizeSession } from './session-index.js';
import { readJsonObjectArray } from './storage-json-stream.js';

const index = openSessionIndex();
const directory = path.join(DATA_DIR, 'sessions');
const currentIds = new Set(workerData.activeIds);
let indexed = 0;
let failed = 0;
try {
  const dir = await fs.promises.opendir(directory);
  for await (const file of dir) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue;
    const id = file.name.slice(0, -5);
    if (currentIds.has(id)) continue;
    const filePath = path.join(directory, file.name);
    const stamp = await fs.promises.stat(filePath);
    const cached = index.source(id);
    if (cached?.mtime === stamp.mtimeMs && cached?.bytes === stamp.size) continue;
    try {
      let tools = 0;
      const { metadata } = await readJsonObjectArray(filePath, { onMessage(message) { if (message.toolCall) tools++; } });
      if (!metadata.id || String(metadata.id) !== id || Number(metadata.startedAt) >= workerData.startedAt) continue;
      if (metadata.status === 'running' || metadata.status === 'waiting') {
        metadata.status = 'aborted';
        metadata.endedAt ??= workerData.startedAt;
        metadata.abortedOnBoot = true;
      }
      index.put(summarizeSession(metadata, Math.max(tools, Number(metadata.toolCalls) || 0)), stamp);
      indexed++;
    } catch (error) {
      failed++;
      if (failed <= 5) parentPort.postMessage({ warning: `会话 ${id} 摘要索引失败：${String(error?.message || error).slice(0, 300)}` });
    }
    if (indexed % 32 === 0) parentPort.postMessage({ indexed, failed });
  }
  let offset = 0;
  for (;;) {
    const rows = index.list(256, offset);
    if (!rows.length) break;
    let removed = 0;
    for (const row of rows) {
      if (!currentIds.has(row.id) && !fs.existsSync(path.join(directory, `${row.id}.json`))) { index.remove(row.id); removed++; }
    }
    offset += rows.length - removed;
  }
  index.checkpoint();
  parentPort.postMessage({ done: true, indexed, failed });
} finally { index.close(); }
