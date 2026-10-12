import { spawn } from 'node:child_process';
import path from 'node:path';
import { mediaWork } from './media-resources.js';

/** Keep the slot occupied until the process exits, including after a timeout. */
export function runMediaProcess(cmd, args, timeoutMs = 30000) {
  return mediaWork.run(() => new Promise((resolve) => {
    let stdout = '';
    let bytes = 0;
    let failed = false;
    let child;
    const limitedArgs = /^ffmpeg(?:\.exe)?$/i.test(path.basename(cmd))
      ? ['-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1', ...args]
      : args;
    try {
      child = spawn(cmd, limitedArgs, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch { resolve(null); return; }
    const kill = () => {
      failed = true;
      try { child.kill('SIGKILL'); } catch { /* Process may have already exited. */ }
    };
    const timer = setTimeout(kill, Math.min(120000, Math.max(100, timeoutMs)));
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { kill(); return; }
      stdout += chunk.toString();
    });
    child.on('error', () => { failed = true; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(!failed && code === 0 ? { stdout } : null);
    });
  })).catch(() => null);
}
