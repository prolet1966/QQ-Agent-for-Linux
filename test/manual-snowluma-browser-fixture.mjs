// Manual browser compatibility fixture. Serve the real 1.14.22 client assets
// supplied by the operator; mock protocol APIs never contact QQ or a model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const client = path.resolve(process.argv[2] || '../snowluma-v1.14.22-reference/client');
if (!fs.existsSync(path.join(client, 'index.html'))) throw new Error('Supply SnowLuma 1.14.22 client directory');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-browser-'));
const snowDir = path.join(temp, 'snow'); fs.mkdirSync(path.join(snowDir, 'config'), { recursive: true });
fs.writeFileSync(path.join(snowDir, 'package.json'), '{"version":"1.14.22"}');
fs.writeFileSync(path.join(snowDir, 'config/runtime.json'), '{"webuiPort":35099,"webuiHost":"127.0.0.1","hookAutoLoad":false}');
fs.writeFileSync(path.join(snowDir, 'config/webui.json'), '{"mustChangePassword":false}');
fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({ snowluma: { dir: snowDir, autoLaunch: false }, server: { publicHost: '127.0.0.1:33210' } }));
const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    console.log('mock protocol:', req.method, url.pathname);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    if (url.pathname === '/api/login') return res.end(JSON.stringify({ token: 'browser-fixture-token', mustChangePassword: false }));
    if (url.pathname.endsWith('/stream')) return res.end('');
    if (url.pathname === '/api/agreements') return res.end(JSON.stringify({ version: 'fixture', currentVersion: 'fixture', consentRequired: false, accepted: true }));
    if (url.pathname === '/api/system') return res.end(JSON.stringify({ hostname: 'browser-fixture', distro: 'Ubuntu 22.04', archLabel: 'x64', nodeVersion: '22.17.1', uptime: 600, processUptime: 60, cpu: { average: 0, perCore: [0, 0], loadAvg: [0, 0, 0], cores: 2, model: 'fixture' }, memory: { total: 2147483648, used: 0, free: 2147483648, usagePercent: 0 }, runtime: { rss: 0, heapUsed: 0, heapTotal: 0, external: 0, pid: 1, version: 'v22.17.1' } }));
    if (['/api/qq-list', '/api/processes', '/api/connections', '/api/logs'].includes(url.pathname)) return res.end('[]');
    return res.end(JSON.stringify({ ok: true, success: true, list: [], recent: [], config: {}, appearance: {}, mustChangePassword: false }));
  }
  const rel = path.posix.normalize(url.pathname).replace(/^\//, '');
  const file = path.join(client, rel || 'index.html');
  const safe = !path.relative(client, file).startsWith('..');
  const selected = safe && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(client, 'index.html');
  const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(selected)] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type }); fs.createReadStream(selected).pipe(res);
});
await new Promise(resolve => api.listen(35099, '127.0.0.1', resolve));
const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, QQ_AGENT_MODE: 'server', QQ_AGENT_DATA_DIR: temp, QQ_AGENT_PORT: '33210', QQ_AGENT_BIND_HOST: '127.0.0.1', QQ_AGENT_CONSOLE_PASSWORD: 'browser-fixture-password' }, stdio: 'inherit' });
let closing = false;
async function close() { if (closing) return; closing = true; child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000).unref(); }); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => close().then(() => process.exit()));
child.once('exit', () => { if (!closing) close().then(() => process.exit()); });
