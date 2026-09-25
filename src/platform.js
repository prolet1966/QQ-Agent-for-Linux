// 平台抽象层：把 Windows / Linux 的差异集中在这里。
//
// 为什么要有这个文件：
//   原版把 wmic / taskkill / explorer.exe / cmd.exe / node.exe / QQ.exe / launcher.bat
//   直接写散在 app.js、routes.js 里，移植 Linux 时要满仓库改，还容易漏。
//   现在所有平台相关的命令与路径都收敛到本模块，业务代码只调用语义化的函数：
//       platform.killProcessesMatching(...)
//       platform.openFolder(dir)
//       platform.snowlumaNodeBin(dir)
//   出问题时只需要看这一个文件。
//
// 契约：本模块所有导出函数在**任意平台**都必须可调用且不抛异常。
//       Windows 上调 Linux 分支、或反过来，都应安全降级（返回 [] / false / null）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 平台判定 ──────────────────────────────────────────────────────────────
export const isWindows = process.platform === 'win32';
export const isLinux = process.platform === 'linux';
export const isMac = process.platform === 'darwin';
export const isPosix = !isWindows;

// 项目根目录（src/ 的上一级）
export const APP_ROOT = path.resolve(__dirname, '..');

// ── 数据目录（XDG 规范）────────────────────────────────────────────────────
/**
 * Linux 下的数据目录根。
 *
 * 遵循 XDG Base Directory Specification：
 *   $XDG_DATA_HOME（缺省 ~/.local/share）/qq-agent
 *
 * 为什么必须这样：打包安装到 /opt/qq-agent 后，安装目录对普通用户是只读的。
 * 原版把 data/ 放在 ROOT 下，在 Linux 上会直接写不进去（EACCES），
 * 或者要求用户 sudo 运行 —— 后者更糟，会让数据文件属主变成 root。
 */
export function xdgDataHome() {
  const env = String(process.env.XDG_DATA_HOME || '').trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), '.local', 'share');
}

/**
 * 解析数据目录。优先级（与原版保持一致，只改默认落点）：
 *
 *   1. QQ_AGENT_DATA_DIR      —— 显式覆盖，测试与便携场景用，永远优先
 *   2. PROFILE 推导的数据目录   —— 多实例：qq-agent / qq-agent-2 / qq-agent-3
 *   3. 平台默认                —— Windows: <app>/data ；Linux: ~/.local/share/qq-agent
 *
 * @param {{ profileSuffix?: () => string }} opts
 * @returns {string} 绝对路径
 */
export function resolveDataDir({ profileSuffix = () => '' } = {}) {
  const override = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (override) return path.resolve(override);

  const suffix = profileSuffix();

  if (isWindows) {
    // Windows 上保持原行为：数据放项目/安装目录下的 data/。
    // 不改成 %APPDATA% 是为了不破坏已有用户的既有数据与升级路径。
    return path.join(APP_ROOT, `data${suffix}`);
  }

  // Linux / macOS：落到用户主目录，安装目录只读也没问题
  return path.join(xdgDataHome(), `qq-agent${suffix}`);
}

// ── SnowLuma 运行时 ───────────────────────────────────────────────────────
/**
 * SnowLuma 自带 Node 运行时的路径。
 *
 * 各平台发行包结构：
 *   Windows：index.mjs + node.exe  + launcher.bat
 *   Linux  ：index.mjs + node      + launcher.sh     ← 没有 .exe
 *
 * 返回第一个存在的候选路径；都不存在返回空串（调用方据此决定回退策略）。
 */
export function snowlumaNodeBin(dir) {
  if (!dir) return '';
  const candidates = isWindows
    ? ['node.exe', 'node']
    : ['node', 'node.exe'];   // Linux 优先无扩展名
  for (const name of candidates) {
    const p = path.join(dir, name);
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* 权限问题按不存在处理 */ }
  }
  return '';
}

/** SnowLuma 的启动脚本路径（各平台脚本名不同）。 */
export function snowlumaLauncherScript(dir) {
  if (!dir) return '';
  const name = isWindows ? 'launcher.bat' : 'launcher.sh';
  const p = path.join(dir, name);
  try {
    return fs.existsSync(p) ? p : '';
  } catch {
    return '';
  }
}

/**
 * 用启动脚本拉起 SnowLuma 时的 spawn 参数。
 *
 * Windows：cmd /c launcher.bat          —— 靠 cmd.exe 解释批处理
 * Linux  ：/bin/sh launcher.sh          —— 直接交给 sh；脚本自带 +x 时也可直接 exec
 *
 * 返回 { command, args }；无法构造时返回 null。
 */
export function snowlumaLauncherSpawn(dir) {
  const script = snowlumaLauncherScript(dir);
  if (!script) return null;
  if (isWindows) {
    return { command: 'cmd.exe', args: ['/c', script] };
  }
  return { command: '/bin/sh', args: [script] };
}

// ── 系统 QQ 客户端 ────────────────────────────────────────────────────────
/**
 * Linux 上没有「便携 QQ」这个概念 —— 应使用发行版/官方安装的 QQ 客户端。
 * SnowLuma 负责注入它。这里只负责找到可执行文件。
 *
 * 候选路径按常见程度排列（官方 deb 装到 /opt/QQ/qq）。
 */
export function systemQqCandidates() {
  if (isWindows) return [];
  return [
    '/opt/QQ/qq',
    '/usr/bin/qq',
    '/usr/local/bin/qq',
    '/usr/lib/qq/qq',
    '/opt/tencent-qq/qq',
  ];
}

/** 找到系统 QQ 的可执行路径；找不到返回空串。 */
export function findSystemQq() {
  for (const p of systemQqCandidates()) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* 不存在或不可执行 */ }
  }
  return '';
}

// ── 打开文件管理器 / URL ──────────────────────────────────────────────────
/**
 * 打开目录或 URL 的命令。
 *
 * Windows：explorer.exe <路径>        打开 URL 需要 cmd /c start
 * Linux  ：xdg-open <路径或URL>       目录和 URL 都支持，统一用一条命令
 *
 * 返回 { command, args }；无法构造时返回 null。
 */
export function openExternalCommand(target) {
  const value = String(target || '').trim();
  if (!value) return null;

  if (isWindows) {
    // URL 交给 shell 关联处理；文件路径交给 explorer
    if (/^https?:\/\//i.test(value)) {
      return { command: 'cmd.exe', args: ['/c', 'start', '', value] };
    }
    return { command: 'explorer.exe', args: [value] };
  }

  // Linux / macOS：xdg-open 对目录与 URL 都适用
  return { command: 'xdg-open', args: [value] };
}

/**
 * 打开目录或 URL 的实际执行体。失败不抛异常，返回 false 由调用方决定怎么报错。
 * spawnFn 由调用方注入（便于测试时替换）。
 */
export function openExternal(target, { spawnFn, detached = true } = {}) {
  const spec = openExternalCommand(target);
  if (!spec || typeof spawnFn !== 'function') return false;
  try {
    const child = spawnFn(spec.command, spec.args, {
      detached,
      stdio: 'ignore',
    });
    child?.unref?.();
    return true;
  } catch {
    return false;
  }
}

// ── 进程查询与结束 ────────────────────────────────────────────────────────
/**
 * 列出进程，返回 [{ pid, commandline }]。
 *
 * Windows：PowerShell Get-CimInstance（原版实现，强制 UTF-8 输出避免中文路径乱码）
 * Linux  ：直接读 /proc —— 零依赖、不需要 ps、不依赖 locale
 *
 * ⚠️ Windows 分支的编码坑是实测踩出来的，注释保留在 app.js 里，不要改回去：
 *    wmic 按系统 ANSI 代码页输出，Node 按 UTF-8 读 → 中文路径变乱码
 *    → 路径比对永远失败 → 界面显示「QQ 未启动」但实际在跑。
 *
 * @param {(cmd: string, args: string[], opts: object) => Promise<{stdout: string}>} execFileAsync
 *        仅 Windows 分支需要；Linux 分支不使用外部命令
 */
export async function listProcesses(execFileAsync, { timeout = 20000 } = {}) {
  if (isWindows) {
    if (typeof execFileAsync !== 'function') return [];
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
          + 'Get-CimInstance Win32_Process | '
          + 'Select-Object ProcessId,Name,ExecutablePath,CommandLine | '
          + 'ConvertTo-Json -Compress',
      ], { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      const txt = String(stdout || '').trim();
      if (!txt) return [];
      const data = JSON.parse(txt);
      const arr = Array.isArray(data) ? data : [data];
      return arr
        .map((p) => ({
          pid: Number(p.ProcessId),
          name: String(p.Name ?? ''),
          exePath: String(p.ExecutablePath ?? ''),
          commandline: String(p.CommandLine ?? ''),
        }))
        .filter((p) => p.pid > 0);
    } catch {
      // 查不到就当没有。不要退回 wmic —— 它给的乱码路径会导致误判，比返回空更糟。
      return [];
    }
  }

  // Linux：扫 /proc
  return listProcessesProc();
}

/** 读 /proc 列出进程（Linux 专用，同步实现但很快）。 */
export function listProcessesProc({ procRoot = '/proc' } = {}) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const raw = fs.readFileSync(path.join(procRoot, name, 'cmdline'));
      // /proc/<pid>/cmdline 用 NUL 分隔参数
      const parts = raw.toString('utf8').split('\0').filter(Boolean);
      if (!parts.length) continue;   // 内核线程没有 cmdline
      out.push({ pid, commandline: parts.join(' '), argv: parts });
    } catch {
      // 进程刚退出、或非本用户进程 → 跳过
      continue;
    }
  }
  return out;
}

/**
 * 找到命令行里包含指定子串的进程 pid（排除自己）。
 *
 * 用于「停止外部启动的 SnowLuma」：按命令行里含 <snowluma目录>/index.mjs 匹配，
 * 绝不按进程名乱杀。
 *
 * @param {string} needle 要匹配的子串（建议传绝对路径的 index.mjs）
 * @param {Array<{pid:number, commandline:string}>} procs 进程列表
 */
export function findPidsByCommandline(needle, procs) {
  const target = String(needle || '').replace(/\\/g, '/').toLowerCase();
  if (!target) return [];
  const self = process.pid;
  const hits = [];
  for (const p of procs || []) {
    if (!p || p.pid === self) continue;
    const cmd = String(p.commandline || '').replace(/\\/g, '/').toLowerCase();
    if (cmd.includes(target)) hits.push(p.pid);
  }
  return hits;
}

/**
 * 结束一组进程。返回成功结束的 pid 列表。
 * 跨平台：process.kill 在 POSIX 与 Windows 上语义一致（Windows 只支持 SIGTERM/SIGKILL）。
 */
export function killPids(pids, signal = 'SIGTERM') {
  const done = [];
  for (const pid of pids || []) {
    try {
      process.kill(pid, signal);
      done.push(pid);
    } catch { /* 已退出或无权限 */ }
  }
  return done;
}

// ── 平台能力描述（供 UI / 诊断页展示）────────────────────────────────────
export function describePlatform() {
  return {
    platform: process.platform,
    isWindows,
    isLinux,
    isMac,
    appRoot: APP_ROOT,
    xdgDataHome: isPosix ? xdgDataHome() : null,
    systemQq: isWindows ? '' : findSystemQq(),
    supported: process.platform === 'win32' || process.platform === 'linux',
  };
}

export default {
  isWindows,
  isLinux,
  isMac,
  isPosix,
  APP_ROOT,
  xdgDataHome,
  resolveDataDir,
  snowlumaNodeBin,
  snowlumaLauncherScript,
  snowlumaLauncherSpawn,
  systemQqCandidates,
  findSystemQq,
  openExternalCommand,
  openExternal,
  listProcesses,
  listProcessesProc,
  findPidsByCommandline,
  killPids,
  describePlatform,
};
