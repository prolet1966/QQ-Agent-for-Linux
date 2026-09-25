// Linux 平台行为实测：打印平台层的真实输出值。
//
// 与 platform-test.mjs 的分工：
//   platform-test.mjs  断言行为是否符合预期（逻辑正确性）
//   verify-linux.mjs   打印当前环境的真实计算值（事实核对）
//
// 移植后要确认三件事，这个脚本把它们直接打出来，便于人工核对：
//   1. 数据目录确实落在用户主目录、而不是安装目录
//   2. /proc 真读得到进程（而不是只对 fixture 生效）
//   3. 打开器命令确实是 xdg-open

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const platform = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'platform.js')).href);

console.log('===== 平台标识 =====');
const d = platform.describePlatform();
console.log('  process.platform :', process.platform);
console.log('  isWindows        :', d.isWindows);
console.log('  isLinux          :', d.isLinux);
console.log('  supported        :', d.supported);
console.log('  APP_ROOT         :', d.appRoot);

console.log('\n===== 数据目录（XDG）=====');
console.log('  环境变量 XDG_DATA_HOME :', process.env.XDG_DATA_HOME || '(未设置)');
console.log('  环境变量 QQ_AGENT_DATA_DIR :', process.env.QQ_AGENT_DATA_DIR || '(未设置)');
console.log('  xdgDataHome()    :', platform.xdgDataHome());
console.log('  resolveDataDir() :', platform.resolveDataDir({ profileSuffix: () => '' }));
console.log('  多实例(-2)       :', platform.resolveDataDir({ profileSuffix: () => '-2' }));

const dataDir = platform.resolveDataDir({ profileSuffix: () => '' });
const inInstallDir = dataDir.startsWith(d.appRoot);
const inHome = dataDir.startsWith(os.homedir());
console.log('  → 落在安装目录内？', inInstallDir ? '是（❌ 不符合 XDG 要求）' : '否（✅）');
console.log('  → 落在用户主目录？', inHome ? '是（✅）' : '否（⚠️ 请确认）');

console.log('\n===== /proc 真实读取 =====');
const procs = platform.listProcessesProc({});
console.log('  读到进程数 :', procs.length);
const sample = procs.slice(0, 5);
for (const p of sample) {
  const cmd = p.commandline.length > 70 ? p.commandline.slice(0, 70) + '…' : p.commandline;
  console.log(`    pid=${String(p.pid).padEnd(7)} ${cmd}`);
}
console.log('  argv 数组可用 :', Array.isArray(procs[0]?.argv) ? '是' : '否');

// 用一个真实存在的进程验证匹配：以本进程的 node 路径构造
const selfCmd = process.argv[0];
const matched = platform.findPidsByCommandline('platform.js', procs);
console.log('  按命令行搜 "platform.js" 命中 pid :', matched.length ? matched.join(', ') : '(无)');

console.log('\n===== SnowLuma 运行时探测 =====');
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-probe-'));
console.log('  空目录探测结果 :', JSON.stringify(platform.snowlumaNodeBin(fakeDir)));
fs.writeFileSync(path.join(fakeDir, 'node'), '');
console.log('  放入 node 后   :', platform.snowlumaNodeBin(fakeDir));
console.log('  launcher 探测  :', JSON.stringify(platform.snowlumaLauncherScript(fakeDir)));
fs.writeFileSync(path.join(fakeDir, 'launcher.sh'), '');
console.log('  放入 launcher.sh 后 :', platform.snowlumaLauncherScript(fakeDir));
const spec = platform.snowlumaLauncherSpawn(fakeDir);
console.log('  spawn 规格     :', spec ? `${spec.command} ${spec.args.join(' ')}` : 'null');
fs.rmSync(fakeDir, { recursive: true, force: true });

console.log('\n===== 打开器 =====');
console.log('  目录 :', JSON.stringify(platform.openExternalCommand('/tmp')));
console.log('  URL  :', JSON.stringify(platform.openExternalCommand('https://example.com')));

console.log('\n===== 系统 QQ =====');
console.log('  候选路径 :', platform.systemQqCandidates().join(', '));
console.log('  实际找到 :', platform.findSystemQq() || '(未安装)');

console.log('\n===== 结论 =====');
const checks = [
  ['数据目录不在安装目录内', !inInstallDir],
  ['数据目录在用户主目录内', inHome],
  ['/proc 可读', procs.length > 0],
  ['打开器为 xdg-open', platform.openExternalCommand('/tmp')?.command === 'xdg-open'],
  ['平台被识别为 Linux', platform.isLinux],
];
let allOk = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  if (!ok) allOk = false;
}
process.exit(allOk ? 0 : 1);
