// 平台抽象层测试。
//
// 为什么要测：本次 Linux 移植的核心改动几乎全在 platform.js ——
// 数据目录落点、SnowLuma 运行时选择、打开器命令、进程匹配。
// 这些一旦搞错，症状是「装完启动即失败」或「停止按钮没反应」，都很难查。
//
// 关键设计：Linux 分支用**fixture 目录模拟 /proc**，所以本测试在 Windows 上
// 也能完整验证 Linux 的进程解析逻辑 —— 不需要真的有 Linux 机器。
//
// 运行：node test/platform-test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

// 被测模块。
// ⚠️ 动态 import 必须用 file:// URL：Windows 上裸的 "F:\...\platform.js"
//    会被 ESM 加载器当成协议名 f: 而报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
const platform = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'platform.js')).href);

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error });
    console.log(`  ✗ ${name}`);
    console.log(`      ${error.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ── 临时目录辅助 ──────────────────────────────────────────────────────────
const tmpRoots = [];
function makeTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `platform-test-${prefix}-`));
  tmpRoots.push(dir);
  return dir;
}
function cleanup() {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/** 在 fixture 根下造一个假进程：/proc/<pid>/cmdline（NUL 分隔） */
function fakeProc(procRoot, pid, argv) {
  const dir = path.join(procRoot, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cmdline'), argv.join('\0') + '\0');
}

// ============================================================ 数据目录
section('数据目录（XDG 规范）');

test('QQ_AGENT_DATA_DIR 覆盖优先级最高', () => {
  const target = makeTmp('data-override');
  const saved = process.env.QQ_AGENT_DATA_DIR;
  try {
    process.env.QQ_AGENT_DATA_DIR = target;
    const got = platform.resolveDataDir({ profileSuffix: () => '' });
    assert.equal(got, path.resolve(target));
  } finally {
    if (saved === undefined) delete process.env.QQ_AGENT_DATA_DIR;
    else process.env.QQ_AGENT_DATA_DIR = saved;
  }
});

test('XDG_DATA_HOME 生效时作为 Linux 数据根', () => {
  const base = makeTmp('xdg');
  const savedXdg = process.env.XDG_DATA_HOME;
  const savedOverride = process.env.QQ_AGENT_DATA_DIR;
  try {
    delete process.env.QQ_AGENT_DATA_DIR;
    process.env.XDG_DATA_HOME = base;
    assert.equal(platform.xdgDataHome(), path.resolve(base));
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedXdg;
    if (savedOverride !== undefined) process.env.QQ_AGENT_DATA_DIR = savedOverride;
  }
});

test('XDG_DATA_HOME 未设时回落到 ~/.local/share', () => {
  const savedXdg = process.env.XDG_DATA_HOME;
  try {
    delete process.env.XDG_DATA_HOME;
    const got = platform.xdgDataHome();
    assert.equal(got, path.join(os.homedir(), '.local', 'share'));
  } finally {
    if (savedXdg !== undefined) process.env.XDG_DATA_HOME = savedXdg;
  }
});

test('多实例 profile 后缀会追加到数据目录名', () => {
  const saved = process.env.QQ_AGENT_DATA_DIR;
  try {
    delete process.env.QQ_AGENT_DATA_DIR;
    // 不依赖当前平台：两种情况都必须带 -2 后缀
    const got = platform.resolveDataDir({ profileSuffix: () => '-2' });
    assert.ok(got.endsWith('-2'), `期望以 -2 结尾，实际 ${got}`);
    assert.ok(
      got.includes('qq-agent-2') || got.includes('data-2'),
      `期望包含 qq-agent-2 或 data-2，实际 ${got}`,
    );
  } finally {
    if (saved !== undefined) process.env.QQ_AGENT_DATA_DIR = saved;
  }
});

test('Windows 下默认落在 APP_ROOT/data（保持既有行为）', () => {
  const saved = process.env.QQ_AGENT_DATA_DIR;
  try {
    delete process.env.QQ_AGENT_DATA_DIR;
    const got = platform.resolveDataDir({ profileSuffix: () => '' });
    if (platform.isWindows) {
      assert.equal(got, path.join(platform.APP_ROOT, 'data'));
    } else {
      // Linux：必须是用户主目录下，不能落在安装目录（这正是 B-1 要修的问题）
      assert.ok(!got.startsWith(platform.APP_ROOT),
        `Linux 数据目录不应落在安装目录内，实际 ${got}`);
      assert.ok(got.includes('qq-agent'), `期望包含 qq-agent，实际 ${got}`);
    }
  } finally {
    if (saved !== undefined) process.env.QQ_AGENT_DATA_DIR = saved;
  }
});

test('数据目录必须是绝对路径', () => {
  const saved = process.env.QQ_AGENT_DATA_DIR;
  try {
    delete process.env.QQ_AGENT_DATA_DIR;
    assert.ok(path.isAbsolute(platform.resolveDataDir({ profileSuffix: () => '' })));
  } finally {
    if (saved !== undefined) process.env.QQ_AGENT_DATA_DIR = saved;
  }
});

// ============================================================ SnowLuma 运行时
section('SnowLuma 运行时探测');

test('返回发行包内存在的 node 可执行文件', () => {
  const dir = makeTmp('sl-bundled');
  const name = platform.isWindows ? 'node.exe' : 'node';
  fs.writeFileSync(path.join(dir, name), '');
  const got = platform.snowlumaNodeBin(dir);
  assert.equal(got, path.join(dir, name));
});

test('目录里没有 node 时返回空串（不抛异常）', () => {
  const dir = makeTmp('sl-empty');
  assert.equal(platform.snowlumaNodeBin(dir), '');
});

test('传入空目录时返回空串', () => {
  assert.equal(platform.snowlumaNodeBin(''), '');
  assert.equal(platform.snowlumaNodeBin(null), '');
});

test('启动脚本名按平台区分（Windows bat / Linux sh）', () => {
  const dir = makeTmp('sl-script');
  const wanted = platform.isWindows ? 'launcher.bat' : 'launcher.sh';
  fs.writeFileSync(path.join(dir, wanted), '');
  assert.equal(platform.snowlumaLauncherScript(dir), path.join(dir, wanted));
});

test('启动脚本 spawn 规格：Windows 用 cmd /c，Linux 用 /bin/sh', () => {
  const dir = makeTmp('sl-spawn');
  const wanted = platform.isWindows ? 'launcher.bat' : 'launcher.sh';
  fs.writeFileSync(path.join(dir, wanted), '');
  const spec = platform.snowlumaLauncherSpawn(dir);
  assert.ok(spec, '应返回 spawn 规格');
  if (platform.isWindows) {
    assert.equal(spec.command, 'cmd.exe');
    assert.deepEqual(spec.args, ['/c', path.join(dir, wanted)]);
  } else {
    assert.equal(spec.command, '/bin/sh');
    assert.deepEqual(spec.args, [path.join(dir, wanted)]);
  }
});

test('没有启动脚本时返回 null', () => {
  assert.equal(platform.snowlumaLauncherSpawn(makeTmp('sl-none')), null);
});

// ============================================================ 打开器
section('打开目录 / URL');

test('URL 与目录都能构造出命令', () => {
  assert.ok(platform.openExternalCommand('https://example.com'));
  assert.ok(platform.openExternalCommand('/tmp'));
});

test('空值返回 null', () => {
  assert.equal(platform.openExternalCommand(''), null);
  assert.equal(platform.openExternalCommand(null), null);
  assert.equal(platform.openExternalCommand('   '), null);
});

test('Linux/macOS 用 xdg-open，目录与 URL 同一条命令', () => {
  if (platform.isWindows) {
    // Windows 分支单独验证
    assert.equal(platform.openExternalCommand('/tmp').command, 'explorer.exe');
    assert.equal(platform.openExternalCommand('https://a.b').command, 'cmd.exe');
  } else {
    assert.equal(platform.openExternalCommand('/tmp').command, 'xdg-open');
    assert.equal(platform.openExternalCommand('https://a.b').command, 'xdg-open');
  }
});

test('openExternal 在 spawn 抛异常时返回 false 而不是崩', () => {
  const throwingSpawn = () => { throw new Error('spawn 失败'); };
  assert.equal(platform.openExternal('/tmp', { spawnFn: throwingSpawn }), false);
});

test('openExternal 调用 spawn 时带上目标路径', () => {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { unref() {} };
  };
  const ok = platform.openExternal('/some/dir', { spawnFn: fakeSpawn });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[calls[0].args.length - 1], '/some/dir');
  assert.equal(calls[0].opts.detached, true);
});

test('openExternal 没有 spawnFn 时返回 false', () => {
  assert.equal(platform.openExternal('/tmp', {}), false);
});

// ============================================================ /proc 进程解析
section('Linux /proc 进程解析（用 fixture 模拟）');

test('能读出 /proc/<pid>/cmdline 并还原成命令行', () => {
  const procRoot = makeTmp('proc');
  fakeProc(procRoot, 4242, ['/home/u/qq-agent/snowluma/node', '/home/u/qq-agent/snowluma/index.mjs']);
  const procs = platform.listProcessesProc({ procRoot });
  assert.equal(procs.length, 1);
  assert.equal(procs[0].pid, 4242);
  assert.ok(procs[0].commandline.includes('index.mjs'));
  assert.ok(procs[0].commandline.includes('snowluma/node'));
});

test('非数字条目被跳过', () => {
  const procRoot = makeTmp('proc');
  fs.mkdirSync(path.join(procRoot, 'self'));
  fs.writeFileSync(path.join(procRoot, 'uptime'), '123');
  fakeProc(procRoot, 100, ['/bin/true']);
  assert.equal(platform.listProcessesProc({ procRoot }).length, 1);
});

test('空 cmdline 的内核线程被跳过', () => {
  const procRoot = makeTmp('proc');
  const dir = path.join(procRoot, '7');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cmdline'), '');   // 内核线程
  assert.equal(platform.listProcessesProc({ procRoot }).length, 0);
});

test('/proc 不存在时返回空数组而不是抛异常', () => {
  assert.deepEqual(platform.listProcessesProc({ procRoot: '/不存在的路径' }), []);
});

test('单个进程读失败不影响其它进程', () => {
  const procRoot = makeTmp('proc');
  fs.mkdirSync(path.join(procRoot, '55'));          // 没有 cmdline 文件
  fakeProc(procRoot, 56, ['/bin/ok']);
  assert.equal(platform.listProcessesProc({ procRoot }).length, 1);
});

// ============================================================ 进程匹配
section('按命令行匹配进程（停止外部 SnowLuma 的依据）');

const SL_DIR = platform.isWindows ? 'C:\\qq-agent\\snowluma' : '/home/u/qq-agent/snowluma';
const SL_INDEX = path.join(SL_DIR, 'index.mjs');

test('匹配到目标 SnowLuma 进程', () => {
  const procs = [
    { pid: 1, commandline: `${path.join(SL_DIR, 'node')} ${SL_INDEX}` },
    { pid: 2, commandline: '/usr/bin/other --flag' },
  ];
  assert.deepEqual(platform.findPidsByCommandline(SL_INDEX, procs), [1]);
});

test('反斜杠与正斜杠都能匹配（跨平台路径风格）', () => {
  const mixed = [
    { pid: 10, commandline: 'C:\\qq-agent\\snowluma\\node.exe C:\\qq-agent\\snowluma\\index.mjs' },
  ];
  const needle = 'C:/qq-agent/snowluma/index.mjs';
  assert.deepEqual(platform.findPidsByCommandline(needle, mixed), [10]);
});

test('大小写不敏感（Windows 路径）', () => {
  const procs = [{ pid: 11, commandline: 'C:/QQ-AGENT/SnowLuma/INDEX.MJS' }];
  assert.deepEqual(platform.findPidsByCommandline('c:/qq-agent/snowluma/index.mjs', procs), [11]);
});

test('排除自身 pid，避免把自己杀掉', () => {
  const procs = [{ pid: process.pid, commandline: SL_INDEX }];
  assert.deepEqual(platform.findPidsByCommandline(SL_INDEX, procs), []);
});

test('匹配不到时返回空数组', () => {
  const procs = [{ pid: 3, commandline: '/usr/bin/node /other/index.mjs' }];
  assert.deepEqual(platform.findPidsByCommandline(SL_INDEX, procs), []);
});

test('空 needle 返回空数组（防止误杀所有 node）', () => {
  const procs = [{ pid: 4, commandline: 'node x.mjs' }];
  assert.deepEqual(platform.findPidsByCommandline('', procs), []);
  assert.deepEqual(platform.findPidsByCommandline(null, procs), []);
});

test('procs 为空或非法时不抛异常', () => {
  assert.deepEqual(platform.findPidsByCommandline('/x/index.mjs', []), []);
  assert.deepEqual(platform.findPidsByCommandline('/x/index.mjs', null), []);
});

// ============================================================ kill
section('结束进程');

test('killPids 对不存在的 pid 静默忽略', () => {
  // 用一个几乎不可能存在的 pid，验证不抛异常
  const done = platform.killPids([999999999], 'SIGTERM');
  assert.ok(Array.isArray(done));
});

test('killPids 空输入返回空数组', () => {
  assert.deepEqual(platform.killPids([], 'SIGTERM'), []);
  assert.deepEqual(platform.killPids(null, 'SIGTERM'), []);
});

// ============================================================ 平台描述
section('平台能力描述');

test('describePlatform 返回完整字段', () => {
  const d = platform.describePlatform();
  assert.equal(typeof d.platform, 'string');
  assert.equal(typeof d.isWindows, 'boolean');
  assert.equal(typeof d.isLinux, 'boolean');
  assert.ok(path.isAbsolute(d.appRoot));
  assert.equal(d.supported, true);
});

test('非 Windows 下给出系统 QQ 候选路径', () => {
  const c = platform.systemQqCandidates();
  if (platform.isWindows) {
    assert.deepEqual(c, []);
  } else {
    assert.ok(c.includes('/opt/QQ/qq'), '应包含官方 deb 的安装位置');
  }
});

test('findSystemQq 在找不到时返回空串', () => {
  assert.equal(typeof platform.findSystemQq(), 'string');
});

// ============================================================ 汇总
cleanup();

console.log(`\n${'='.repeat(56)}`);
console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('\n失败详情：');
  for (const f of failures) {
    console.log(`  • ${f.name}`);
    console.log(`    ${f.error.stack?.split('\n').slice(0, 3).join('\n    ') ?? f.error.message}`);
  }
}
console.log('='.repeat(56));

process.exit(failed ? 1 : 0);
