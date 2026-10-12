import { parentPort, workerData } from 'node:worker_threads';
import { openUsageIndex, refreshUsageIndex, queryUsage } from './usage-index.js';

const index = openUsageIndex(workerData.indexFile);
const sessionsDir = workerData.sessionsDir;
let closed = false;

async function run(message) {
  if (message.op === 'close') { closed = true; index.close(); parentPort.close(); return; }
  if (message.op !== 'query') throw new Error(`未知用量操作：${message.op}`);
  const progress = (p) => parentPort.postMessage({ id: message.id, progress: p });
  const scan = await refreshUsageIndex(index, sessionsDir, (p) => progress(p));
  const value = await queryUsage(index, message.kind, message.args || {}, message.pricing || {}, message.now || Date.now());
  return { ...value, index: scan, workerHeapBytes: process.memoryUsage().heapUsed };
}

parentPort.on('message', (message) => {
  if (closed) return;
  Promise.resolve().then(() => run(message)).then((value) => { if (!closed) parentPort.postMessage({ id: message.id, value }); })
    .catch((error) => parentPort.postMessage({ id: message.id, error: String(error?.message || error) }));
});

process.on('exit', () => { try { if (!closed) index.close(); } catch {} });
