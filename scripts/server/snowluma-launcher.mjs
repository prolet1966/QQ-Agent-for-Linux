import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';

const MAX_LINE_BYTES = 16 * 1024;

// Buffer one bounded line. Once a long line reaches the limit, discard its tail
// through the next newline so a split credential cannot escape redaction.
export function createCredentialFilter(passwordFile, { maxLineBytes = MAX_LINE_BYTES } = {}) {
  let parts = [], bytes = 0, dropping = false;
  function line(saveCredential = true) {
    const value = Buffer.concat(parts, bytes).toString('utf8'); parts = []; bytes = 0;
    const match = value.match(/initial credentials:.*?password=([^\s\x1b]+)/i);
    if (saveCredential && match && Buffer.byteLength(match[1]) <= 1024) {
      fs.mkdirSync(path.dirname(passwordFile), { recursive: true });
      fs.writeFileSync(passwordFile, match[1] + '\n', { mode: 0o600 }); fs.chmodSync(passwordFile, 0o600);
    }
    const redacted = value.replace(/((?:password|token|access_token|secret|api[_-]?key)\s*["']?\s*[=:]\s*["']?)[^\s,;&"']+/gi, '$1[REDACTED]');
    return Buffer.from(redacted).subarray(0, maxLineBytes);
  }
  return new Transform({ readableHighWaterMark: MAX_LINE_BYTES, writableHighWaterMark: MAX_LINE_BYTES,
    transform(chunk, _encoding, callback) {
      try {
        let at = 0;
        while (at < chunk.length) {
          const end = chunk.indexOf(10, at), stop = end < 0 ? chunk.length : end;
          if (!dropping) {
            const length = Math.min(stop - at, maxLineBytes - bytes);
            if (length) { parts.push(Buffer.from(chunk.subarray(at, at + length))); bytes += length; }
            if (stop - at > length) { this.push(line(false)); this.push('\n'); dropping = true; }
          }
          if (end >= 0) { if (!dropping) { this.push(line()); this.push('\n'); } dropping = false; }
          at = end < 0 ? chunk.length : end + 1;
        }
        callback();
      } catch (error) { callback(error); }
    },
    flush(callback) { try { if (bytes) { this.push(line()); this.push('\n'); } callback(); } catch (error) { callback(error); } }
  });
}

export function launchSnowluma() {
  const dir = process.cwd(), passwordFile = path.join(dir, 'config', 'qqa-initial-password.txt');
  try { if (!JSON.parse(fs.readFileSync(path.join(dir, 'config', 'webui.json'), 'utf8')).mustChangePassword) fs.rmSync(passwordFile, { force: true }); } catch {}
  const child = spawn(process.execPath, [path.join(dir, 'index.mjs')], { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    const filter = createCredentialFilter(passwordFile);
    // pipe handles destination backpressure; it never accumulates the complete
    // journal output in memory while a reader is slow.
    stream.pipe(filter).pipe(output, { end: false });
    filter.on('error', () => { process.stderr.write('SnowLuma 日志处理失败\n'); child.kill(); process.exitCode = 1; });
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { process.stderr.write('SnowLuma 启动失败\n'); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = signal ? 0 : code ?? 1; });
  return child;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) launchSnowluma();
