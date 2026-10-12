import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { BoundedWorkQueue } from './bounded-work.js';

export function mediaMaxBytes(fallback = 15 * 1024 * 1024) {
  const mb = Number(getConfig().resources?.mediaMaxBytesMB);
  return mb > 0 ? Math.min(fallback, Math.floor(mb * 1024 * 1024)) : fallback;
}

export const mediaWork = new BoundedWorkQueue({
  concurrency: () => getConfig().resources?.mediaConcurrency || 1,
  capacity: 16,
  maxWaitMs: 30000,
  name: '媒体处理'
});

export const mediaDownloads = new BoundedWorkQueue({ concurrency: 1, capacity: 16, maxWaitMs: 30000, name: '媒体下载' });

const pruneTimes = new Map();
/** Only disposable cache files are pruned; member memory and message history are untouched. */
export function pruneMediaCache(dir, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - (pruneTimes.get(dir) || 0) < 60000) return;
  pruneTimes.set(dir, now);
  const cfg = getConfig().resources || {};
  const budget = Math.max(1, Number(cfg.mediaCacheMB) || 64) * 1024 * 1024;
  const ttl = Math.max(60000, Number(cfg.mediaCacheTtlMs) || 86400000);
  try {
    const files = [];
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const st = fs.lstatSync(file);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs > ttl) { fs.unlinkSync(file); continue; }
      files.push({ file, size: st.size, time: st.mtimeMs });
    }
    let bytes = files.reduce((sum, file) => sum + file.size, 0);
    files.sort((a, b) => a.time - b.time);
    for (const file of files) {
      if (bytes <= budget) break;
      fs.unlinkSync(file.file);
      bytes -= file.size;
    }
  } catch { /* Cache maintenance must not block conversation processing. */ }
}
