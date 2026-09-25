// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig, updateConfig, ROOT, DATA_DIR } from './config.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments, expandForwardNodes } from './onebot.js';
import { ChatStore } from './store.js';
import { MemoryStore } from './memory.js';
import { StickerManager } from './sticker-manager.js';
import { SendQueue } from './sender.js';
import { SessionRegistry } from './sessions.js';
import { Orchestrator } from './orchestrator.js';
import { ReminderStore } from './reminders.js';
import { VideoReader } from './video-reader.js';
import { cacheHitRate } from './llm.js';
import { isPeakHour, priceAt, resolveModelPrice, modelLabel, splitModelLabel, UNKNOWN_VENDOR } from './model-prices.js';
import { initPriceFeed } from './price-feed.js';
import { startTelemetryLoop } from './telemetry.js';
import { startCacheWarm, loadPersistedPrefix, seedPrefixFromSessions, warmOnce } from './cache-warm.js';
import { loadPlugins, watchPlugins } from './plugin-loader.js';
import { skillManager } from './skills/manager.js';
import { extractCandidateUrls, dispatchMediaLinks } from './media-links.js';
import { createRoutes } from './routes.js';
import * as instanceLockModule from './instance-lock.js';
import { logger } from './logger.js';
import { startCommunitySync, isGloballyBlocked, FIXED_PRICE_FEED_URL } from './community.js';
// 平台抽象层：Windows / Linux 的差异（进程查询、打开器、QQ 路径、SnowLuma 运行时）
// 全部收敛在 platform.js，本文件不再直接出现 wmic / explorer.exe / cmd.exe / node.exe。
import * as platform from './platform.js';

// 全局 fetch（undici）默认连接建立超时只有 10 秒，openrouter.ai 这类海外端点
// 握手慢时会直接报 "Connect Timeout Error ... timeout: 10000ms"（注意这不是
// 请求超时——那是 llm.js 里 180 秒的 AbortSignal）。这里放宽到 30 秒。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时只退回默认超时，绝不崩主进程。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', error?.message ?? error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..', 'ui');

// ── 白名单判断（移植自原版 allowed()） ───────────────────────────────────
function allowed(kind, id, cfg) {
  const s = String(id);
  const denyList = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty === true;
}

// ── 版本更新检查 ─────────────────────────────────────────────────────
// 线上版本信息只有一份：kondius.cn/qq-agent/version.json（发版时手动改）。
// 由后端代取而不是前端直连：绕过 CORS，且失败信息能统一回给 UI。
const UPDATE_INFO_URL = 'https://kondius.cn/qq-agent/version.json';

function localVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch { return '0.0.0'; }
}

/** x.y.z 三段数字比较；返回 1 / 0 / -1。非数字段按 0 处理，够用。 */
function compareSemver(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/* createApp 产生的所有 appLog 函数（模块级 WeakSet）。
   用于识别"调用方传入的 log 是不是上一次 createApp 留下的 appLog"，
   防止监听器链式递归（见 createApp 内的递归护栏注释）。 */
const appLogFns = new WeakSet();

export function createApp({ log = console.log } = {}) {
  const cfg = getConfig();

  // 详尽日志：把 createApp 的 log 接到分级日志系统（落盘 + 内存缓冲 + SSE）。
  // 关键：logger 的 mirrorConsole 已经会走 console，所以这里**只写 logger、不再调原 log**，
  // 否则 appLog → logger.info → console(log) → 若 log 又被指回 appLog 就会无限递归（selftest 就是这么挂的）。
  // logger.mirrorConsole = true 时 console 输出不丢；调用方传入的自定义 log（如测试的静默 log）
  // 通过 logger 的 onLog 监听器另行转发，不经过 console。
  const appLog = (...args) => {
    logger.info('app', ...args);
  };
  // 把调用方传入的 log（如 Electron 的 console.log 或测试的静默 log）挂到 logger 的监听器上，
  // 与 mirrorConsole 解耦：mirrorConsole 管 console，监听器管调用方的 log。
  //
  // ⚠️ 递归护栏（15GB 日志事故根因）：
  //   若调用方传入的 log 本身就是上一次 createApp 留下的 appLog
  //   （同进程内二次 createApp：Electron 重启核心 / 测试串行多轮），
  //   监听器链会形成 appLog→logger→监听器→appLog 的无限递归，
  //   每轮递归给文本再包一层 [app] 前缀 —— 一条日志膨胀成几千条、
  //   每条带几千个 [app] 前缀，几个小时内日志文件就能写到 15GB。
  //   这里用 WeakSet 识别"这个 log 是不是 appLog"，是则跳过挂载。
  if (!appLogFns.has(log)) {
    logger.onLog((entry) => {
      try { log(`[${entry.module}] ${entry.text}`); } catch { /* ignore */ }
    });
  }
  appLogFns.add(appLog);
  // 关掉 logger 的 console 镜像，避免与上面的监听器重复打印（调用方 log 通常就是 console.log）。
  logger.mirrorConsole = false;
  // 后续内部调用统一指向 appLog（关键事件落盘 + 走调用方 log）
  log = appLog;
  // 启动时清理过期日志文件
  logger.prune();

  // ── 进程单实例锁（防止桌面端 + headless 双开导致重复回复群消息）──
  // 与 Electron 的 requestSingleInstanceLock 互补：那只管 Electron 进程之间，
  // 这里管"同一数据目录下任何形态的 QQ Agent 核心"（含 node src/server.js）。
  const { acquireInstanceLock, releaseInstanceLock } = instanceLockModule;
  const lockResult = acquireInstanceLock();
  if (!lockResult.ok) {
    // 不抛异常上抛让进程退出 —— 创建期的失败应当让整个启动失败。
    throw new Error(`[单实例] ${lockResult.reason}。如需多开测试，请用不同的 QQ_AGENT_DATA_DIR。`);
  }
  /* 抢到锁后立刻注册退出清理：正常 exit / SIGINT / SIGTERM 都会释放锁文件。
     曾经只在 stop() 里释放 —— 进程被直接杀掉（任务管理器结束、控制台叉掉）
     时锁文件残留，下次启动要靠"PID 已死"探测才能清掉，多一层失败面。 */
  instanceLockModule.registerLockCleanup();
  const sseClients = new Set();

  // ── SnowLuma 程序目录与进程管理 ──
  function snowlumaDir() {
    const configured = String(getConfig().snowluma?.dir || '').trim();
    if (configured) return configured;
    const bundled = path.join(ROOT, 'snowluma');
    if (fs.existsSync(bundled)) return bundled;
    // 安装版：asar 里的文件不可执行，electron-builder 会把 snowluma/ 解包到
    // resources/app.asar.unpacked/snowluma（见 package.json asarUnpack）
    const unpacked = bundled.replace('app.asar', 'app.asar.unpacked');
    if (unpacked !== bundled && fs.existsSync(unpacked)) return unpacked;
    return '';
  }

  /**
   * 决定用什么运行时来跑 SnowLuma 的 index.mjs。按可靠性从高到低三级兜底：
   *
   *   1. SnowLuma 发行包自带的 node
   *      （Windows：node.exe；Linux：node）—— 版本与它自己的 ABI 匹配，最稳
   *   2. 系统 PATH 里的 node —— Linux 上「完整版」不需要，但「Lite 版」依赖它
   *      （SnowLuma 文档：Lite 需 Node.js 22.13+，23 系需 23.4+）
   *   3. Electron 自带的 Node —— 靠 ELECTRON_RUN_AS_NODE=1 让 Electron 进程
   *      退化成纯 Node 运行时。好处是**不要求用户单独装 Node**
   *
   * 三者都没有时返回 { bin: '' }，由调用方回退到启动脚本。
   */
  function resolveSnowlumaNode(dir) {
    // 1) 发行包自带
    const bundled = platform.snowlumaNodeBin(dir);
    if (bundled) return { bin: bundled, label: 'SnowLuma 自带', viaElectronNode: false };

    // 2) 系统 node
    for (const candidate of platform.isWindows ? ['node.exe', 'node'] : ['node']) {
      const found = whichSync(candidate);
      if (found) return { bin: found, label: `系统 ${candidate}`, viaElectronNode: false };
    }

    // 3) Electron 自带 Node
    if (process.versions?.electron) {
      return { bin: process.execPath, label: 'Electron 内置 Node', viaElectronNode: true };
    }

    return { bin: '', label: '', viaElectronNode: false };
  }

  /** 在 PATH 里找一个可执行文件（不依赖外部 which 命令，跨平台）。 */
  function whichSync(name) {
    const exts = platform.isWindows
      ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
    const dirs = String(process.env.PATH || '').split(platform.isWindows ? ';' : ':').filter(Boolean);
    for (const d of dirs) {
      for (const ext of exts) {
        const p = path.join(d, name + (platform.isWindows ? ext.toLowerCase() : ''));
        try {
          fs.accessSync(p, fs.constants.X_OK);
          return p;
        } catch { /* 继续找 */ }
      }
    }
    return '';
  }

  function snowlumaWsPort() {
    try {
      const wsUrl = String(getConfig().snowluma?.wsUrl || 'ws://127.0.0.1:3001');
      const u = new URL(wsUrl);
      if (u.port) return Number(u.port);
    } catch { /* ignore */ }
    return 3001;
  }

  /** SnowLuma 的 WebUI 端口：进程一启动就监听，与是否登录无关。
   * 用来判定「SnowLuma 进程活着」。 */
  function snowlumaWebuiPort() {
    try {
      const dir = snowlumaDir();
      if (dir) {
        const rtPath = path.join(dir, 'config', 'runtime.json');
        if (fs.existsSync(rtPath)) {
          const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
          if (Number(rt.webuiPort)) return Number(rt.webuiPort);
        }
      }
    } catch { /* ignore */ }
    return 5099;
  }

  /** 从 SnowLuma 的 runtime.json 读取 WebUI 地址（http(s)://host:port/）。拿不到就返回空串。 */
  function snowlumaWebuiUrl() {
    try {
      const dir = snowlumaDir();
      if (!dir) return '';
      const rtPath = path.join(dir, 'config', 'runtime.json');
      if (!fs.existsSync(rtPath)) return '';
      const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
      const host = String(rt.webuiHost || '127.0.0.1');
      const port = Number(rt.webuiPort) || 5099;
      const tls = !!(rt.webuiTls && rt.webuiTls.enabled);
      return `${tls ? 'https' : 'http'}://${host}:${port}/`;
    } catch {
      // 配置读不到时，从最近日志里找 "listening http(s)://…" 兜底
      for (const line of [...snowlumaLogs].reverse()) {
        const m = /listening\s+(https?:\/\/[\w.:-]+)/i.exec(line.text || '');
        if (m) return m[1];
      }
      return '';
    }
  }

  function isPortOpen(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (result) => { try { socket.destroy(); } catch { /* ignore */ } resolve(result); };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  // SnowLuma 内置控制台日志（环形缓冲，最近 500 行）
  // 内置 SnowLuma 状态与日志。未采用多进程方案：由 Electron 主进程提供 IPC 控制与日志转发，
  // 确保 SnowLuma 随 QQ Agent 退出、无需单独管理窗口。
  const snowlumaLogs = [];
  let snowlumaProc = null;
  let snowlumaLaunching = false;   // SnowLuma 启动互斥标记（防连点「运行」按钮并发拉起多个）
  let snowlumaStopping = false;
  let pluginWatcher = null;        // 开发模式热重载 watcher（stop() 时要 close，否则句柄泄漏）
  let obPortPollTimer = null;      // OneBot WS 端口就绪轮询（stop() 时要 clear，start() 里赋值）

  function pushSnowlumaLog(text, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    snowlumaLogs.push(line);
    if (snowlumaLogs.length > 500) snowlumaLogs.splice(0, snowlumaLogs.length - 500);
    emit('snowluma-log', line);
  }

  function snowlumaStatus() {
    return { embedded: !!snowlumaProc, pid: snowlumaProc?.pid ?? null };
  }

  /** 关闭 SnowLuma。内置拉起的直接 kill；外部启动的（launcher 脚本 / 手动 node）按
   *  「命令行含 <snowluma目录>/index.mjs」匹配进程后结束 —— 否则 UI 的「停止」
   *  对外启动实例毫无作用，用户只能去任务管理器，而残留实例会继续抢占管道与端口。
   *  返回是否执行了关闭动作。
   *
   *  ── Linux 移植改造点 ───────────────────────────────────────────────
   *  原实现用 WMIC（`wmic process where "name='node.exe'"`）查命令行。
   *  Linux 上没有 wmic，而这正是「停止」按钮唯一的兜底路径 ——
   *  不改的话外部启动的 SnowLuma 在 Linux 上永远停不掉。
   *  现改用 platform.listProcesses()：Windows 走 PowerShell（保留原有 UTF-8
   *  处理，中文路径不乱码），Linux 直接读 /proc，零依赖。 */
  async function stopSnowluma() {
    const proc = snowlumaProc;
    if (proc) {
      try {
        proc.kill();
        pushSnowlumaLog('已请求关闭 SnowLuma。', 'stdout');
        return true;
      } catch (error) {
        pushSnowlumaLog(`关闭 SnowLuma 失败：${error?.message ?? error}`, 'stderr');
        throw error;
      }
    }

    // 外部启动的实例：查命令行匹配（只结束 SnowLuma 自己的 node，决不按进程名乱杀）
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      const procs = await platform.listProcesses(execFileAsync);

      // 匹配依据：命令行里同时出现 index.mjs 与 snowluma 目录。
      // Windows 下路径可能带反斜杠，platform 内部已统一成正斜杠再做比较。
      const dir = path.resolve(String(snowlumaDir() || ''));
      const indexMjs = path.join(dir, 'index.mjs');
      let target = platform.findPidsByCommandline(indexMjs, procs);
      if (!target.length) {
        // 目录不含 index.mjs（或配置指向别处）时，退回「命令行含 index.mjs 且含 snowluma」
        target = procs
          .filter((p) => {
            const cmd = String(p.commandline || '').replace(/\\/g, '/').toLowerCase();
            return cmd.includes('index.mjs') && cmd.includes('snowluma') && p.pid !== process.pid;
          })
          .map((p) => p.pid);
      }

      if (!target.length) return false;

      platform.killPids(target, 'SIGTERM');
      pushSnowlumaLog(`已请求关闭外部启动的 SnowLuma（pid=${target.join(',')}）。`, 'stdout');
      snowlumaProc = null;
      emit('snowluma-status', { running: false, embedded: false, pid: null });
      return true;
    } catch (error) {
      pushSnowlumaLog(`关闭外部 SnowLuma 失败：${error?.message ?? error}`, 'stderr');
      return false;
    }
  }

  // ── QQ 客户端进程管理 ──
  //
  // Windows：「便携 QQ」——独立安装目录 + 独立 user-data-dir，与用户日常 QQ 完全隔离。
  // Linux  ：「系统 QQ」——Linux 上没有便携端这个概念，应使用官方 deb 安装的 QQ
  //          （落在 /opt/QQ/qq），由 SnowLuma 注入它。同样用独立的
  //          --user-data-dir 做隔离，避免碰到用户自己登录的 QQ。
  //
  // ⚠️ 无论哪个平台，都**绝不按进程名杀 QQ** —— 只结束路径或 user-data-dir 匹配的进程，
  //    否则会把用户正在用的 QQ 一起杀掉。
  const qqPortableLogs = [];
  let qqPortableProc = null;
  let qqPortableLaunching = false;   // 启动互斥标记（防连点「启动 QQ」并发拉起）

  /** 是否使用 Windows 便携端；Linux/macOS 走系统 QQ。 */
  function usesPortableQq() {
    return platform.isWindows;
  }

  function qqPortableDir() {
    return path.join(ROOT, 'runtime', 'qq-portable');
  }

  function qqPortableDataDir() {
    return path.join(ROOT, 'runtime', 'qq-portable-data');
  }

  /**
   * QQ 可执行文件路径。
   *   Windows：<ROOT>/runtime/qq-portable/QQ.exe
   *   Linux  ：探测系统安装（/opt/QQ/qq 等），找不到返回空串
   */
  function qqClientExe() {
    if (usesPortableQq()) return path.join(qqPortableDir(), 'QQ.exe');
    return platform.findSystemQq();
  }

  /** 兼容旧名（外部与路由仍可能引用） */
  function qqPortableExe() {
    return qqClientExe();
  }

  function pushQqLog(text, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    qqPortableLogs.push(line);
    if (qqPortableLogs.length > 500) qqPortableLogs.splice(0, qqPortableLogs.length - 500);
    emit('qq-portable-log', line);
  }

  /** 检查 QQ 客户端是否可用（Windows：便携端已打包；Linux：系统已安装 QQ） */
  function qqPortableReady() {
    if (usesPortableQq()) return fs.existsSync(qqClientExe());
    return !!qqClientExe();
  }

  /**
   * 列出 QQ 相关进程，返回 [{ pid, exePath, commandline }]。
   *
   * ── 这里踩过一个很隐蔽的坑，务必别再改回去（Windows 分支）────────────
   * 原来首选 `wmic process ... /format:csv`。它有两个问题：
   *
   * 1. **编码**：wmic 按**系统 ANSI 代码页（中文系统是 GBK）**输出，
   *    而 Node 按 UTF-8 读 —— 路径里的中文会变成乱码。
   *    实测：`qq-agent - 副本` → `qq-agent - ????`。
   *    于是拿乱码路径去和真实路径比，**永远比不上**，
   *    表现就是"QQ 明明在跑，界面却说未启动"。
   *    ⚠️ 纯英文路径下这个 bug 完全不暴露，所以特别难查。
   * 2. **CSV**：路径里有逗号就会错位。
   * 3. 而且 wmic 在 Win11 24H2+ 已被移除，本来也不能当主路径。
   *
   * 改用 PowerShell + **显式强制 UTF-8 输出** + JSON。
   * ⚠️ 只写 PowerShell 是不够的：PS 5.1 默认同样按 ANSI 输出，
   *    必须带上 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`
   *    （这行是实测对比出来的，去掉就又是乱码）。
   * 用 JSON 而不是 CSV，顺带解决逗号错位。
   *
   * ── Linux 分支 ──────────────────────────────────────────────────────
   * 不需要 PowerShell，platform.listProcesses() 直接读 /proc/<pid>/cmdline，
   * 天然是 UTF-8，不存在编码问题。
   */
  async function listQqProcesses() {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const all = await platform.listProcesses(execFileAsync);

    if (platform.isWindows) {
      // 只保留 QQ.exe，与原有行为一致
      return all
        .filter((p) => /(^|[\\/])QQ\.exe$/i.test(String(p.exePath || '')))
        .map((p) => ({ pid: p.pid, path: String(p.exePath || ''), commandline: p.commandline }));
    }

    // Linux：QQ 进程名可能是 qq / QQ / linuxqq，用可执行路径判断更可靠
    return all
      .filter((p) => {
        const exe = String(p.exePath || '');
        if (/[\\/](qq|QQ|linuxqq)$/.test(exe)) return true;
        // /proc 拿不到 exePath 时的兜底：命令行首段是 qq
        const first = String(p.commandline || '').split(' ')[0] || '';
        return /[\\/](qq|QQ|linuxqq)$/.test(first);
      })
      .map((p) => ({ pid: p.pid, path: String(p.exePath || ''), commandline: p.commandline }));
  }

  /**
   * 检查 QQ 客户端是否在运行（只认我们启动的那一个，不碰用户自己的 QQ）。
   *
   * 匹配策略：
   *   Windows：可执行路径在 runtime/qq-portable 下
   *   Linux  ：命令行里带我们专属的 --user-data-dir=<qq-portable-data>
   */
  async function qqPortableRunningPid() {
    // 1) 本进程拉起过的那个：spawn 时就拿到 pid 了，不用查系统 ——
    //    最快，也不受任何编码/权限问题影响。
    if (qqPortableProc && !qqPortableProc.killed) {
      try {
        process.kill(qqPortableProc.pid, 0);   // signal 0 = 只探测存活
        return qqPortableProc.pid;
      } catch { /* 已退出，往下走 */ }
    }
    // 2) 查系统：覆盖"上次启动的 QQ 还在跑，但应用重启过"的情况
    const procs = await listQqProcesses();

    if (platform.isWindows) {
      const portableDir = qqPortableDir().replace(/\\/g, '/').toLowerCase();
      const match = procs.find((p) => String(p.path).replace(/\\/g, '/').toLowerCase().startsWith(portableDir));
      return match?.pid ?? null;
    }

    // Linux：靠 user-data-dir 认领，绝不误判用户自己开的 QQ
    const dataDir = qqPortableDataDir().replace(/\\/g, '/').toLowerCase();
    const match = procs.find((p) => String(p.commandline || '').replace(/\\/g, '/').toLowerCase().includes(dataDir));
    return match?.pid ?? null;
  }

  /** 启动 QQ 客户端（如已在运行则跳过） */
  async function launchPortableQQ() {
    if (!qqPortableReady()) {
      return { ok: false, error: 'QQ 客户端不可用：Windows 请先运行 npm run setup 准备便携端；Linux 请安装官方 QQ（sudo apt install ./QQ_*.deb）' };
    }
    // 启动互斥：连点「启动 QQ」时，第一次还在 spawn，第二次直接拒绝
    if (qqPortableLaunching) {
      pushQqLog('QQ 客户端正在启动中，忽略重复的启动请求');
      return { ok: true, alreadyRunning: true, launching: true };
    }
    const existingPid = await qqPortableRunningPid();
    if (existingPid) {
      pushQqLog(`QQ 客户端已在运行（pid=${existingPid}），无需重复启动`);
      return { ok: true, alreadyRunning: true, pid: existingPid };
    }

    qqPortableLaunching = true;
    try {
      const exe = qqClientExe();
      const dataDir = qqPortableDataDir();
      fs.mkdirSync(dataDir, { recursive: true });

      try {
        const child = spawn(exe, [`--user-data-dir=${dataDir}`], {
          // Windows：cwd 指向便携端目录（它依赖同目录的资源文件）
          // Linux  ：系统 QQ 不依赖 cwd，用数据目录即可，避免在只读安装目录下启动
          cwd: usesPortableQq() ? qqPortableDir() : dataDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: false, // QQ 需要显示窗口让用户扫码
          detached: true
        });
        qqPortableProc = child;
        child.unref();

        const label = usesPortableQq() ? '便携 QQ' : '系统 QQ';
        // Linux 下的常见失败：无 X/Wayland 显示（无头环境）。
        // 这里提前把原因说清楚，免得用户只看到「启动失败」四个字。
        if (!usesPortableQq() && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
          pushQqLog(
            '⚠️ 未检测到 DISPLAY / WAYLAND_DISPLAY，QQ 在无图形环境下无法显示扫码窗口。'
            + '无头机器请用 VNC / X11 转发，或先在有桌面的会话里完成扫码登录。',
            'stderr',
          );
        }
        pushQqLog(`${label} 启动中（pid=${child.pid}，可执行文件：${exe}），数据目录：${dataDir}`);
        child.stdout?.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushQqLog(line, 'stdout');
          }
        });
        child.stderr?.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushQqLog(line, 'stderr');
          }
        });
        child.on('exit', (code, signal) => {
          qqPortableProc = null;
          pushQqLog(`QQ 客户端进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
          emit('qq-portable-status', { running: false, pid: null });
        });
        child.on('error', (error) => {
          pushQqLog(`QQ 客户端启动失败：${error?.message ?? error}`, 'stderr');
        });
        emit('qq-portable-status', { running: true, pid: child.pid });
        return { ok: true, launched: true, pid: child.pid };
      } catch (error) {
        pushQqLog(`QQ 客户端启动失败：${error?.message ?? error}`, 'stderr');
        return { ok: false, error: String(error?.message ?? error) };
      }
    } finally {
      qqPortableLaunching = false;
    }
  }

  /** 关闭 QQ 客户端（只结束匹配的 PID，绝不碰用户自己的 QQ） */
  async function stopPortableQQ() {
    const pid = await qqPortableRunningPid();
    if (!pid) {
      pushQqLog('QQ 客户端未在运行');
      return { ok: true, stopped: false, reason: 'not_running' };
    }
    try {
      process.kill(pid, 'SIGTERM');
      pushQqLog(`已请求关闭 QQ 客户端（pid=${pid}）`);
      // 等待进程退出
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const still = await qqPortableRunningPid();
        if (!still) {
          pushQqLog('QQ 客户端已退出');
          emit('qq-portable-status', { running: false, pid: null });
          return { ok: true, stopped: true, pid };
        }
      }
      // 还没退，强制 kill
      process.kill(pid, 'SIGKILL');
      pushQqLog(`QQ 客户端已强制结束（pid=${pid}）`);
      emit('qq-portable-status', { running: false, pid: null });
      return { ok: true, stopped: true, pid, forced: true };
    } catch (error) {
      pushQqLog(`关闭 QQ 客户端失败：${error?.message ?? error}`, 'stderr');
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** QQ 客户端状态摘要 */
  async function qqPortableStatus() {
    const pid = await qqPortableRunningPid();
    return {
      ready: qqPortableReady(),
      running: pid !== null,
      pid,
      dir: qqPortableDir(),
      dataDir: qqPortableDataDir()
    };
  }

  /** 拉起 SnowLuma。优先用发行包自带的 Node 直接运行（日志进内置控制台）；
   *  找不到运行时再回退到平台启动脚本（Windows launcher.bat / Linux launcher.sh）。 */
  async function launchSnowluma() {
    const dir = snowlumaDir();
    if (!dir) return { ok: false, error: '找不到 SnowLuma 目录：请确认项目内 snowluma/ 文件夹存在，或在设置里填写 SnowLuma 目录' };
    // ⚠️ 端口探测必须用 WebUI 端口（2026-09-19）：WS 3001 是 OneBot 实例开的，
    // OneBot 实例只有**账号登录后**才创建 —— "SnowLuma 起了但还没登录"是常态
    // （用户先启动 QQ Agent，再扫码）。用 3001 判"运行中"会把正常状态误判成
    // "未运行"，于是又拉起第二个 SnowLuma 实例 → 两个进程抢 mojo 管道与端口，
    // 用户看到的是"管道异常/连接不上/时好时坏"这类无法自圆其说的现象。
    // WebUI 端口进程一启动就监听，与登录无关，才是"进程活着"的准确信号。
    const probePort = snowlumaWebuiPort();

    // ── 启动互斥（防多次点击「运行 SnowLuma」端口冲突 / 多实例）──
    // 三道防线，按成本从低到高：
    //   1. 本进程正在启动中（用户连点按钮）→ 直接拒绝
    //   2. 本进程已拉起过 SnowLuma（snowlumaProc 活着）→ 已在运行
    //   3. 端口已被任何进程占用（包括上次残留 / 别的实例）→ 已在运行
    if (snowlumaLaunching) {
      pushSnowlumaLog('SnowLuma 正在启动中，忽略重复的启动请求', 'stdout');
      return { ok: true, alreadyRunning: true, launching: true };
    }
    if (snowlumaProc && !snowlumaProc.killed) {
      pushSnowlumaLog(`SnowLuma 已由本实例拉起（pid=${snowlumaProc.pid}），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true, pid: snowlumaProc.pid };
    }
    if (await isPortOpen('127.0.0.1', probePort)) {
      pushSnowlumaLog(`SnowLuma 已在运行（WebUI 端口 ${probePort} 已就绪），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true };
    }

    snowlumaLaunching = true;
    try {
      const indexMjs = path.join(dir, 'index.mjs');
      // ── Linux 移植改造点（B-2）────────────────────────────────────────
      // 原实现写死 `node.exe`，且回退路径写死 `launcher.bat` + `cmd.exe`。
      // SnowLuma 各平台发行包结构不同：
      //   Windows：index.mjs + node.exe  + launcher.bat
      //   Linux  ：index.mjs + node      + launcher.sh    ← 没有 .exe
      // 所以 Linux 上原来**两条启动路径全断**：
      //   内置模式因 node.exe 不存在而不进入，回退模式因 launcher.bat 不存在而报错。
      // 现改为交给 platform.js 按平台选择，并对 Linux 额外提供「用系统 node」
      // 与「用 Electron 自带 Node」两级兜底。
      const nodeBin = resolveSnowlumaNode(dir);
      if (fs.existsSync(indexMjs) && nodeBin.bin) {
        try {
          const spawnOpts = {
            cwd: dir,
            stdio: ['ignore', 'pipe', 'pipe'],
            // windowsHide 在非 Windows 上被 Node 忽略，保留不影响跨平台
            windowsHide: true,
            detached: false,
          };
          // Electron 自带 Node 方式：同一个可执行文件，靠环境变量切换成 Node 模式
          if (nodeBin.viaElectronNode) {
            spawnOpts.env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
          }
          const child = spawn(nodeBin.bin, [indexMjs], spawnOpts);
          snowlumaProc = child;
          child.unref();
          pushSnowlumaLog(`SnowLuma 启动中（内置模式，pid=${child.pid}，运行时：${nodeBin.label}）…`, 'stdout');
          child.stdout.on('data', (d) => {
            for (const line of String(d).split(/\r?\n/)) {
              if (line.trim()) pushSnowlumaLog(line, 'stdout');
            }
          });
          child.stderr.on('data', (d) => {
            for (const line of String(d).split(/\r?\n/)) {
              if (line.trim()) pushSnowlumaLog(line, 'stderr');
            }
          });
          child.on('exit', (code, signal) => {
            snowlumaProc = null;
            pushSnowlumaLog(`SnowLuma 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
            emit('snowluma-status', { running: false, embedded: false, pid: null });
          });
          child.on('error', (error) => {
            pushSnowlumaLog(`SnowLuma 启动失败：${error?.message ?? error}`, 'stderr');
          });
          emit('snowluma-status', { running: true, embedded: true, pid: child.pid });
          return { ok: true, launched: true, embedded: true, pid: child.pid };
        } catch (error) {
          pushSnowlumaLog(`内置模式启动失败，尝试回退独立窗口：${error?.message ?? error}`, 'stderr');
          snowlumaProc = null;
        }
      }
      // 回退：用平台启动脚本独立拉起（Windows launcher.bat / Linux launcher.sh）
      // 此模式下 SnowLuma 有自己的输出目标，日志不进内置控制台。
      const launcherSpec = platform.snowlumaLauncherSpawn(dir);
      if (!launcherSpec) {
        return {
          ok: false,
          error: `目录里既没有可用的 Node 运行时，也没有启动脚本：${dir}\n`
            + `确认该目录是 SnowLuma 的发行包根目录（应含 index.mjs 与 `
            + `${platform.isWindows ? 'node.exe / launcher.bat' : 'node / launcher.sh'}）。`,
        };
      }
      const child = spawn(launcherSpec.command, launcherSpec.args, {
        cwd: dir,
        detached: true,
        stdio: 'ignore',
        windowsHide: false // 保留 SnowLuma 自己的控制台窗口
      });
      child.unref();
      pushSnowlumaLog(
        `SnowLuma 已用独立窗口启动（${platform.isWindows ? 'launcher.bat' : 'launcher.sh'}，`
        + '此模式下日志不进内置控制台）',
        'stdout',
      );
      return { ok: true, launched: true, embedded: false };
    } finally {
      // 启动动作结束后释放互斥标记（端口就绪与否由上面的端口探测兜底）
      snowlumaLaunching = false;
    }
  }

  const emit = (type, payload) => {
    // 说明：这里曾经先走一个进程内事件总线（createEventBus），但全项目**没有任何订阅者**，
    // 属于纯空转；更糟的是它给人"存在进程内订阅者"的错觉。真正的消费者只有 SSE。
    let line = null;
    if (type === 'session-update' && payload?.sessionId) {
      try {
        // peek：只序列化、不修改，不需要 get() 那份全量 structuredClone
        // （运行中的会话每次更新都广播，克隆大会话会拖慢事件投递）
        const s = sessions?.peek(payload.sessionId);
        if (s) {
          line = `event: ${type}\ndata: ${JSON.stringify({
            sessionId: s.id,
            chatKey: s.chatKey,
            startedAt: s.startedAt,
            status: s.status,
            waitUntil: s.waitUntil ?? null,
            activity: s.activity ?? '',
            webSearchCount: s.webSearchCount ?? 0,
            rounds: s.rounds ?? 0,
            usage: s.usage ?? null,
            trigger: s.triggerSummary ?? '',
            triggerSummary: s.triggerSummary ?? '',
            messages: s.messages ?? [],
            // sent/finishReason/error/endedAt 必须随 SSE 推下去：
            // 曾经载荷里没有它们，"已发送到 QQ"徽标只能等 HTTP 轮询带回来；
            // 而会话一结束轮询就不再拉详情（只刷 running/waiting），
            // 用户只能手动刷新才看得到最终发言 —— 这就是"详情更新不及时"。
            sent: s.sent ?? [],
            finishReason: s.finishReason ?? null,
            error: s.error ?? null,
            endedAt: s.endedAt ?? null
          })}\n\n`;
        }
      } catch { /* 失败就退回原 payload */ }
    }
    if (!line) line = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of sseClients) {
      // 同步异常 + 已经不可写的连接都要清理，否则集合只增不减、每次都白写
      if (res.writableEnded || res.destroyed) { sseClients.delete(res); continue; }
      try {
        res.write(line);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  // ── 组件 ──
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 0);   // 0 = 不限
  const memory = new MemoryStore();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 0);   // 0 = 不限
  const onebot = new OneBotClient({
    wsUrl: cfg.snowluma?.wsUrl,
    httpUrl: cfg.snowluma?.httpUrl,
    accessToken: cfg.snowluma?.accessToken,
    httpToken: cfg.snowluma?.httpAccessToken || cfg.snowluma?.accessToken,
    onEvent: (event) => handleOneBotEvent(event).catch((error) => log('[ingest] 处理事件出错:', error?.message ?? error))
  });
  const stickers = new StickerManager(onebot);
  const sender =   new SendQueue({
    onebot, store,
    onSent: ({ chatKey, text }) => log(`[发送 -> ${chatKey}] ${String(text).slice(0, 60)}`),
    log
  });
  const reminders = new ReminderStore();
  const videoReader = new VideoReader(onebot);
  const orchestrator = new Orchestrator({ store, memory, stickers, sender, sessions, onebot, emit, reminders, videoReader });

  // 远程价格表固定为官网公开地址；不从用户配置读取，避免被页面/配置篡改。
  initPriceFeed(FIXED_PRICE_FEED_URL);

  // 云端统一屏蔽名单：启动先用 data 缓存，后台同步；网络失败不影响本地拦截。
  const communitySyncTimer = startCommunitySync(log);
  communitySyncTimer.unref?.();

  // 前缀缓存保活：默认关闭（会主动联网），开关改动无需重启。
  // 放在这里是为了让它在 orchestrator / 插件加载之前就位 —— 保活构造前缀要用到
  // skillManager 的当前状态，而它晚于本行加载；所以首次 tick 延迟 20 秒兜住。
  const cacheWarm = startCacheWarm(log);

  // 启动即预热（2026-09-20）：保活原先只能等"本次运行"构造出前缀才知道要预热什么，
  // 于是**每个会话的第一次调用永远赶不上预热**（实测 11:12:17 首次调用命中 32%，
  // 而预热 11:12:34 才发出）。这里在启动时载入上次运行落盘的前缀，直接暖一次 ——
  // 第一条群消息的调用就能命中。插件还没加载完，所以延迟 15 秒等 skillManager 就位。
  {
    const bootWarm = setTimeout(async () => {
      try {
        // 优先用落盘的前缀；没有（首次安装/刚清过数据）就从会话存档里借一份。
        // 少了这条兜底，"启动预热"在第一次重启后永远没有样本 —— 而第一次调用
        // 恰恰是最需要它的那一次。
        const ok = loadPersistedPrefix() || seedPrefixFromSessions();
        if (!ok) return;
        const r = await warmOnce({ log });
        if (r.ok) log(`[cache-warm] 启动预热完成（${r.prompt} tok，命中 ${r.cached}）`);
      } catch { /* 启动预热失败不影响任何功能 */ }
    }, 15000);
    bootWarm.unref?.();
  }

  // OneBot 连接状态推送
  onebot.onStatus((status) => emit('onebot-status', status));

  // ── 从 SnowLuma 配置自动同步 OneBot 令牌 ──
  // SnowLuma 给每个登录过的账号生成独立随机 token（config/onebot_<uin>.json），
  // 且**永久保留**——不表示"当前在线"。多账号场景下"取第一个文件"会拿错 token
  // （WS 401 无限重试）。策略改为：收集所有 per-uin 文件的 token 作为候选，
  // 401 时轮换下一个重连，连上后记住生效的那个（天然支持 SnowLuma 里切账号）。
  let lastSyncTokenSig = '';

  /** 从单个配置对象里提取 ws/http token（找不到网络段时返回 null）。 */
  function extractTokens(data) {
    const http = (data?.networks?.httpServers || []).find((s) => (s.port === 3000) || (s.name === 'http-default')) || (data?.networks?.httpServers || [])[0];
    const ws = (data?.networks?.wsServers || []).find((s) => (s.port === 3001) || (s.name === 'ws-default')) || (data?.networks?.wsServers || [])[0];
    return { wsToken: String(ws?.accessToken ?? ''), httpToken: String(http?.accessToken ?? '') };
  }

  /** 收集所有候选 token（含 onebot_0.json 的空令牌兜底），按"最可能正确"排序。
   *
   * ⚠️ 排序规则（2026-09-19 修订）：以前按文件名排序，多账号时 candidates[0]
   * 几乎总是错的（1633537058 < 3113678561，但在线的是后者），每次启动都要
   * 先吃一轮 401 再轮换到正确令牌。现在排序：
   *   1. 当前配置里已保存的 token（上次连成功过的，最可信）
   *   2. 文件序的其余候选
   *   3. 空令牌兜底（SnowLuma 允许无 token 连接，永远排最后）
   * 去重保持首次出现的顺序。
   */
  function readSnowlumaTokenCandidates() {
    const out = [];
    const seen = new Set();
    const push = (c) => {
      const key = `${c.wsToken}|${c.httpToken}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(c);
    };
    try {
      const dir = snowlumaDir();
      if (!dir) return out;
      const cfgDir = path.join(dir, 'config');
      // 当前配置的令牌优先：上次连接成功时 applyTokens 已把它写进 data/config.json。
      const cur = getConfig().snowluma || {};
      const curWs = String(cur.accessToken || '');
      const curHttp = String(cur.httpAccessToken || cur.accessToken || '');
      if (curWs || curHttp) push({ wsToken: curWs, httpToken: curHttp });
      let files = [];
      try {
        files = fs.readdirSync(cfgDir).filter((f) => /^onebot_\d+\.json$/.test(f) && !/^onebot_0\.json$/.test(f)).sort();
      } catch { /* ignore */ }
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(cfgDir, f), 'utf8'));
          push(extractTokens(data));
        } catch { /* 单个文件坏了跳过，不影响其他候选 */ }
      }
      // 空令牌兜底：SnowLuma 允许无 token 连接（onebot_0.json 模板就是空）
      push({ wsToken: '', httpToken: '' });
    } catch (error) {
      log('[onebot] 读取 SnowLuma OneBot 配置失败:', error?.message ?? error);
    }
    return out;
  }

  /** 候选游标：401 时递增轮换。连上后会钉住当前生效下标。 */
  let tokenCandidateIndex = 0;

  function applyTokens({ wsToken, httpToken }) {
    onebot.accessToken = wsToken;
    onebot.httpToken = httpToken || wsToken;
    const cur = getConfig();
    if (cur.snowluma?.accessToken !== wsToken || cur.snowluma?.httpAccessToken !== (httpToken || wsToken)) {
      updateConfig({ snowluma: { ...cur.snowluma, accessToken: wsToken, httpAccessToken: httpToken || wsToken } });
      log(`[onebot] 应用 OneBot 访问令牌（WS ${wsToken ? '有' : '无'} / HTTP ${httpToken ? '有' : '无'}）`);
    }
  }

  /** 把候选列表同步进配置 + 挂到 onebot 实例（不立即连接）。返回是否有变化。 */
  function syncSnowlumaTokens() {
    try {
      const candidates = readSnowlumaTokenCandidates();
      if (!candidates.length) return false;
      const sig = candidates.map((c) => `${c.wsToken}|${c.httpToken}`).join(';');
      if (sig === lastSyncTokenSig) return false;
      // 游标重置：候选集变化了，从头开始试
      tokenCandidateIndex = 0;
      applyTokens(candidates[0]);
      onebot.tokenCandidates = candidates;   // 401 轮换用
      lastSyncTokenSig = sig;
      log(`[onebot] 已收集 ${candidates.length} 个 OneBot 令牌候选（当前配置令牌优先，401 时自动轮换）`);
      return true;
    } catch (error) {
      log('[onebot] 同步 SnowLuma 令牌失败:', error?.message ?? error);
      return false;
    }
  }

  // 401 / 未连接时：轮换下一个候选 token 重连（3 秒重连循环已有，轮换成本为零）
  let tokenSyncRetryAt = 0;
  function maybeRecoverOnebot() {
    const now = Date.now();
    if (now - tokenSyncRetryAt < 5000) return;   // 限频
    tokenSyncRetryAt = now;
    // ⚠️ 先重读磁盘：全新安装是"先启动后登录"，候选集是启动时的 [空令牌]；
    // 登录后 per-uin 文件才带着真令牌落盘。不回读就会拿空令牌 401 到天荒地老。
    const refreshed = syncSnowlumaTokens();
    const candidates = onebot.tokenCandidates || [];
    if (!candidates.length) return;
    if (refreshed) {
      // 候选集变了（sig 变化时内部已重置游标并应用候选[0]）→ 直接拿新集合的第一个试
      onebot.reconnect();
      return;
    }
    // 磁盘没变化：指向下一个候选（首次触发也从 0→1 开始换：刚被 401 拒的就是当前这个）
    tokenCandidateIndex = (tokenCandidateIndex + 1) % candidates.length;
    const c = candidates[tokenCandidateIndex];
    applyTokens(c);
    onebot.reconnect();
  }
  onebot.onStatus((status) => {
    if (status.connected) {
      // 连上了：把当前生效的候选钉住 —— 写进游标，并把该令牌挪到候选列表首位，
      // 这样下次断线重连（无论是否 401）第一个试的就是它，不再无谓地先撞错误令牌。
      const cands = onebot.tokenCandidates || [];
      const cur = { wsToken: String(onebot.accessToken || ''), httpToken: String(onebot.httpToken || '') };
      const hit = cands.findIndex((c) => c.wsToken === cur.wsToken && c.httpToken === cur.httpToken);
      tokenCandidateIndex = hit >= 0 ? hit : 0;
      if (cands.length > 1) log('[onebot] 连接成功，当前令牌候选已生效');
      return;
    }
    if (String(status.error || '').includes('401')) maybeRecoverOnebot();
  });

  // ── 入站事件处理 ──
  let atNameCache = new Map(); // groupId:userId -> name
  async function resolveAtName(groupId, userId) {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key);
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = info?.card || info?.nickname || null;
      if (name) {
        atNameCache.set(key, String(name));
        if (atNameCache.size > 500) atNameCache.clear(); // 简单防膨胀
        return String(name);
      }
    } catch { /* ignore */ }
    return null;
  }

  async function resolveReply(messageId) {
    try {
      const msg = await onebot.getMsg(messageId);
      const senderName = msg?.sender?.card || msg?.sender?.nickname || '';
      let text = '';
      if (Array.isArray(msg?.message)) {
        text = msg.message.map((s) => (s.type === 'text' ? s.data?.text ?? '' : `[${s.type}]`)).join('').trim();
      } else if (typeof msg?.message === 'string') {
        text = msg.message;
      }
      // senderId 一并带回：引用块显示为 名字(QQ:xxx)，与发言人标签同口径 ——
      // 没有它，模型分不清引用的是"哪个张三"
      return { sender: String(senderName), senderId: String(msg?.sender?.user_id ?? ''), text: String(text).slice(0, 120) };
    } catch {
      return null;
    }
  }

  async function ingestMessage(kind, id, event) {
    const cfgNow = getConfig();
    if (!allowed(kind, id, cfgNow)) return; // 白名单外的聊天完全不记录

    const segments = Array.isArray(event.message) ? event.message : null;
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
    const senderName = String(event.sender?.card || event.sender?.nickname || senderId || '');

    // 屏蔽名单：被屏蔽群员的消息直接丢弃 —— 不存档、不触发会话、不进提示词背景。
    // 放在最前面：连合并转发展开这种网络请求都不值得为它做。
    // 两道屏蔽：全局（所有群+私聊）优先，其次按群。
    if (senderId) {
      const globalBlocked = isGloballyBlocked(senderId);
      if (globalBlocked) return;
      if (kind === 'group' && (cfgNow.blocklist?.[id] || []).map(String).includes(senderId)) return;
    }
    const media = segments ? extractMediaFromSegments(segments) : [];

    let text;
    if (segments) {
      text = await segmentsToText(segments, {
        resolveReply: (mid) => resolveReply(mid),
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : null,
        // 语音转写（`media.transcribe`）要用它去 get_record 取音频
        onebot
      });
    } else {
      text = String(event.raw_message ?? event.message ?? '').trim();
    }

    // 合并转发：占位符 → 展开真实内容（模型要读懂、看懂转发的聊天记录）
    // 实测结论（2026-09-05，SnowLuma/NapCat）：get_forward_msg 只认 message_id；
    // res_id（转发卡片里那个 id）会过期，报 "payload is empty"。
    // 媒体里的 url 此时是新鲜的，一并收进 media（取图/金句都能用）。
    // 展开失败时占位符留在存档里，模型可用 read_forward 工具稍后重试。
    if (segments && (text.includes('[合并转发') || text.includes('[转发消息')) && event.message_id != null) {
      try {
        const r = await onebot.call('get_forward_msg', { message_id: Number(event.message_id) });
        const nodes = Array.isArray(r?.messages) ? r.messages : (Array.isArray(r?.data?.messages) ? r.data.messages : []);
        const ex = await expandForwardNodes(nodes);
        if (ex && ex.text) {
          text = ex.text;
          if (ex.media?.length) media.push(...ex.media);
        }
      } catch (e) {
        log(`[ingest] 展开合并转发失败（保留占位符）: ${e?.message ?? e}`);
      }
    }

    if (!text && !media.length) return;

    // ── 指令禁言：群内任何人 @机器人 + 发送指定指令 → 该群暂时固定 1 档（仅艾特）──
    // 在存档前处理：指令本身也要留档（让机器人知道被禁言了），但先设置禁言状态。
    if (kind === 'group') {
      maybeTriggerCommandMute(id, text, event);
    }

    store.appendIncoming(`${kind}:${id}`, {
      mid: event.message_id,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]' ,
      media
    });
    emit('chat-update', `${kind}:${id}`);
    orchestrator.onIncoming(`${kind}:${id}`);

    // 链接媒体转发（确定性）：刻意不 await —— 百兆级下载/上传不能卡住 ingest 热路径。
    // 内部已把错误全部收口（含 provider 抛错），这里再挂一次 catch 只为防漏网。
    forwardLinkedMedia(kind, id, text).catch((e) => log(`[media] 链接转发失败：${e?.message ?? e}`));
  }

  /**
   * 指令禁言：检测"@机器人 + 指定指令"，命中则把该群响应档位暂时固定为 1 档。
   * 禁言状态写入 config.commandMute.active[群号] = 到期时间戳（0 = 直到手动解除）。
   */
  function maybeTriggerCommandMute(groupId, text, event) {
    const cm = getConfig().commandMute;
    if (!cm || cm.enabled !== true) return;
    const command = String(cm.command || '').trim();
    if (!command) return;
    // 必须同条消息里既 @机器人 又含指令
    const selfId = onebot.selfId;
    const botName = getConfig().persona?.botName || '';
    const selfNick = getConfig().persona?.selfNickname || onebot.selfNickname || '';
    const atMe = text.includes(`@${selfNick}`) || (botName && text.includes(`@${botName}`))
      || (selfId && new RegExp(`\\[CQ:at(?:,[^\\]]*?)?qq=${selfId}[^\\]]*\\]`).test(text));
    if (!atMe) return;
    if (!text.includes(command)) return;
    // 设置禁言：durationMin>0 则到期时间戳，否则 0（直到手动解除）
    const durationMs = Math.max(0, Number(cm.durationMin) || 0) * 60000;
    const until = durationMs > 0 ? Date.now() + durationMs : 0;
    const active = { ...(getConfig().commandMute?.active || {}) };
    active[String(groupId)] = until;
    updateConfig({ commandMute: { active: { __replace__: active } } });
    const untilStr = until ? new Date(until).toLocaleTimeString('zh-CN', { hour12: false }) : '直到手动解除';
    log(`[指令禁言] 群 ${groupId} 已被「${command}」禁言，响应档位临时固定为 1 档（仅艾特），${untilStr} 解除`);
    emit('chat-update', `group:${groupId}`);
  }

  // ── 链接媒体转发（确定性触发） ──────────────────────────────────────────

  /**
   * 确定性触发：消息里出现 B站/抖音链接 → 下载并转发。
   *
   * 与 LLM 型（注册工具）的区别正在这里：插件开着，条件满足就一定会跑，
   * 模型想忽略也忽略不掉 —— 整条链路上没有任何"让模型决定"的环节。
   *
   * 一个提供者都不在（插件未装/未启用）时立刻返回 —— 零网络请求、零副作用。
   * 调度细节（候选链接提取、多提供者协商、失败文案）在 src/media-links.js，
   * 那部分是纯逻辑、可被测试直接驱动；这里只负责从 skillManager 取提供者。
   */
  async function forwardLinkedMedia(kind, id, text) {
    const providers = skillManager.getCapabilityProviders('media.download');
    if (!providers.length) return;
    await dispatchMediaLinks({
      urls: extractCandidateUrls(text),
      providers,
      ctx: { onebot, sender, kind, chatId: id, text },
      log
    });
  }

  async function ingestPoke(event) {    // OneBot v11: notice_type=notify, sub_type=poke；群拍 target_id，私聊拍自己
    const isGroup = event.group_id != null;
    const id = isGroup ? String(event.group_id) : String(event.user_id);
    const cfgNow = getConfig();
    if (!allowed(isGroup ? 'group' : 'private', id, cfgNow)) return;

    const operatorId = String(event.user_id ?? '');
    // 自己拍的拍（send_poke 的 OneBot 回显）不触发处理——与 message_sent 同理，发送时已留档
    if (operatorId && operatorId === onebot.selfId) return;
    // 屏蔽名单对拍一拍同样生效（操作者是被屏蔽群员则丢弃）：全局优先，其次按群
    if (operatorId) {
      if (isGloballyBlocked(operatorId)) return;
      if (isGroup && (cfgNow.blocklist?.[id] || []).map(String).includes(operatorId)) return;
    }
    const targetId = String(event.target_id ?? event.user_id ?? '');
    const selfId = onebot.selfId;
    // 拍一拍也要记下真实群名片：原先这里硬编码"（拍一拍事件）"，
    // 会覆盖同一 QQ 在普通消息里的真实昵称 —— 记忆整理时取名字会拿到这个占位符，
    // 导致"317183522 的名字叫（拍一拍事件）"这种脏数据。
    const chatKeyNow = `${isGroup ? 'group' : 'private'}:${id}`;
    let operatorName = isGroup ? ((await resolveAtName(id, operatorId)) || '') : '';
    if (!operatorName) {
      const prior = (store.recent(chatKeyNow, { limit: 500 }) || [])
        .find((m) => !m.self && String(m.senderId) === operatorId
          && String(m.senderName || '') && String(m.senderName) !== '（拍一拍事件）');
      operatorName = prior ? String(prior.senderName) : operatorId;
    }
    // 目标名字同样补齐（被拍者的群名片；解析不到就留 QQ 号，formatEntry 会拼 (QQ:xxx)）
    const targetName = (isGroup && String(targetId) !== String(selfId))
      ? ((await resolveAtName(id, targetId)) || targetId)
      : targetId;
    // 展示名：管理员备注 > 群名片（与消息历史同口径）
    const notes = cfgNow.memberNotes || {};
    const opLabel = notes[operatorId] || operatorName || operatorId;
    const tgtLabel = String(targetId) === String(selfId)
      ? '我'
      : (notes[targetId] || targetName || targetId);
    // 文案统一为「X 拍了拍 Y」视角（机器人被拍时 Y=我）。
    // 旧文案"你拍了拍（来自 张三）"视角混乱（读起来像"我拍了别人"），
    // 是机器人被拍时识别错乱的主因。名字带 QQ 号，与发言人标签同口径。
    const opWithId = String(operatorId) ? `${opLabel}(QQ:${operatorId})` : opLabel;
    const tgtWithId = (String(targetId) === String(selfId) || !String(targetId)) ? tgtLabel : `${tgtLabel}(QQ:${targetId})`;
    const text = operatorId === targetId
      ? `[拍一拍] ${opWithId} 拍了拍自己`
      : `[拍一拍] ${opWithId} 拍了拍 ${tgtWithId}`;
    // 拍一拍是"轻量召唤"信号：作为触发批发给模型（isPoke 标记让档位判定
    // 按 1 档响应），但**不进【过去状态】历史**——buildPastState 会跳过 isPoke，
    // 存档里只留一条轻量记录（聊天记录页仍可见，模型历史里不出现）。
    store.appendIncoming(chatKeyNow, {
      mid: null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId: operatorId,
      senderName: operatorName,
      text,
      media: [],
      isPoke: true
    });
    emit('chat-update', `${isGroup ? 'group' : 'private'}:${id}`);
    orchestrator.onIncoming(`${isGroup ? 'group' : 'private'}:${id}`);
  }

  async function handleOneBotEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      // 自己发的消息（message_sent / self_id 相同）不触发处理（发送时已自行记录）
      if (String(event.user_id ?? event.sender?.user_id ?? '') === onebot.selfId) return;
      if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', String(event.group_id), event);
      if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', String(event.user_id), event);
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event);
    }
    // 撤回事件：群撤回 group_recall / 好友撤回 friend_recall
    // 用户撤回的消息，后续会话不再发给大模型（从存档里标记/删除）。
    if (event.post_type === 'notice' && (event.notice_type === 'group_recall' || event.notice_type === 'friend_recall')) {
      return handleRecall(event);
    }
    // meta/心跳等事件忽略
  }

  /** 处理消息撤回：把对应 mid 的存档消息标记为已撤回（后续提示词过滤掉）。 */
  function handleRecall(event) {
    const isGroup = event.notice_type === 'group_recall';
    const chatKey = isGroup ? `group:${String(event.group_id)}` : `private:${String(event.user_id)}`;
    const mid = event.message_id;
    if (mid == null) return;
    const marked = store.markRecalled(chatKey, mid);
    if (marked) {
      log(`[撤回] ${chatKey} 消息 #${mid} 已被撤回，后续不再发给模型`);
      emit('chat-update', chatKey);
    }
  }

  // ── HTTP API ──
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      } catch { /* ignore */ }
    });
  });

  function json(res, code, data) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  // ── 请求体读取 ──────────────────────────────────────────────────────────
  // 抛出的错误必须是**可暴露的 HTTP 错误**（带 .expose 标记），由 /api 分发层
  // 统一转成 4xx。否则：JSON.parse 异常会冒成 500；"超限直接 throw" 会让没读完的
  // socket 变脏 —— 客户端连接池下次复用这条连接就是 ECONNRESET。
  const MAX_BODY_BYTES = 2 * 1024 * 1024;
  const HARD_BODY_LIMIT = 16 * 1024 * 1024;   // 超此值不再排空，直接断链
  function httpError(status, message) {
    const e = new Error(message);
    e.expose = true;
    e.status = status;
    return e;
  }

  async function readBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > HARD_BODY_LIMIT) {
        req.destroy();
        throw httpError(413, '请求体过大');
      }
      if (size > maxBytes) {
        tooLarge = true;          // 继续读干净（内容丢弃），保证连接可复用
        chunks.length = 0;
        continue;
      }
      chunks.push(chunk);
    }
    if (tooLarge) throw httpError(413, `请求体过大（上限 ${Math.round(maxBytes / 1024)}KB）`);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw httpError(400, '请求体不是合法 JSON');
    }
  }

  // ── 来源校验（CSRF / DNS rebinding 防护）────────────────────────────────
  // 服务只监听回环，但**浏览器里的任意网页都能向 127.0.0.1 发简单请求**，
  // 而 CORS 只挡"读响应"、挡不住"副作用"（改配置、暂停、重置数据…）。
  // 所以所有 /api/* 都必须来自回环 Host；带 Origin/Referer 时必须同源。
  function isLoopbackHostHeader(host) {
    return /^127\.0\.0\.1(:\d+)?$/.test(host)
      || /^localhost(:\d+)?$/.test(host)
      || /^\[::1\](:\d+)?$/.test(host);
  }

  function originAllowed(req) {
    const host = String(req.headers.host ?? '');
    if (!isLoopbackHostHeader(host)) return false;
    const origin = String(req.headers.origin ?? '');
    if (origin) {
      try {
        const u = new URL(origin);
        return isLoopbackHostHeader(u.host) && u.host === host;
      } catch { return false; }
    }
    const referer = String(req.headers.referer ?? '');
    if (referer) {
      try { return new URL(referer).host === host; } catch { return false; }
    }
    // 无来源信息（curl / 本机脚本 / 地址栏直达）—— 放行
    return true;
  }

  function authorize(req) {
    const token = String(getConfig().server?.token ?? '');
    if (!token) return true;
    const url = new URL(req.url, 'http://127.0.0.1');
    return req.headers['x-console-token'] === token || url.searchParams.get('token') === token;
  }

  // ── 配置脱敏 ────────────────────────────────────────────────────────────
  // 凡是字段名命中这些模式的，值一律替换为空串（保留"有/无"的 hasXxx 标记）。
  // 覆盖：apiKey / api_key / accessToken / httpAccessToken / token / secret / password / cookie …
  // ⚠️ cookie 必须在内：media-download 插件的 bilibiliCookie / douyinCookie
  //    是登录凭据，曾经 pattern 不认导致 /api/config 明文返回。
  const SECRET_KEY_PATTERN = /(apikey|api_key|accesstoken|access_token|communitykey|cookie|secret|password|privatekey|private_key)/i;
  // 形如 apiKeyFrom 的字段存的是"密钥来源标识"（如 manual），不是密钥本身，不要脱敏
  const SECRET_KEY_EXCLUDE = /from$/i;

  function sanitizeConfig(cfg) {
    const out = JSON.parse(JSON.stringify(cfg ?? {}));
    const seen = new WeakSet();

    const walk = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') { walk(value); continue; }
        if (SECRET_KEY_EXCLUDE.test(key)) continue;
        // 已生成的 hasXxx 布尔标记本身也会被 apikey 模式匹配到，
        // 不排除就会连锁生成 hasHasXxx
        if (/^has/i.test(key) && typeof value === 'boolean') continue;
        if (SECRET_KEY_PATTERN.test(key)) {
          // ⚠️ 必须"删除字段"而不是"置为空串"。
          // 前端保存设置时会把整个 config 展开成 patch 回传（...c.webSearch?.deepseek），
          // 若这里留一个空串，deepMerge 会拿空串覆盖掉服务端保存的真 Key ——
          // 表现为：用户点一次"保存设置"，所有搜索 Key 就被静默清空。
          // 删掉字段则展开时不会带上该键，服务端原值得以保留。
          delete node[key];
          const flagName = `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
          node[flagName] = Boolean(String(value ?? '').trim());
        }
      }
    };
    walk(out);

    // 密钥集合整体清空（不逐 key 暴露存在性）
    if (out.dshProviderKeys && typeof out.dshProviderKeys === 'object') {
      const has = {};
      for (const [k, v] of Object.entries(out.dshProviderKeys)) has[k] = Boolean(String(v ?? '').trim());
      out.dshProviderKeys = {};
      out.dshProviderKeyPresence = has;
    }

    // 提供商列表：删掉 key 字段（同样不能置空串，否则回传时覆盖真实 Key），补 hasKey
    if (Array.isArray(out.providers)) {
      for (const p of out.providers) {
        const real = (cfg?.dshProviderKeys || {})[p.id] || p.apiKey;
        delete p.apiKey;
        p.hasKey = Boolean(String(real ?? '').trim());
      }
    }
    // 顶层 api：walk 已生成 hasApiKey，这里补一个简写的 hasKey 供旧代码读取
    if (out.api) out.api.hasKey = out.api.hasApiKey ?? Boolean(String(cfg?.api?.apiKey ?? '').trim());

    return out;
  }

  // ── 明文密钥端点守卫 ────────────────────────────────────────────────────
  /**
   * 这是本地单机程序，控制台就在本机浏览器打开，「显示密钥」是用户自己的操作，
   * 不该被禁用。真正的风险来自**外部网页**冒用浏览器读 127.0.0.1（CSRF /
   * DNS rebinding）—— 所以防线是「校验请求来源」。
   *
   * ⚠️ 历史实现里有一句 `if (req.headers['x-console-token']) return true`：
   *    只看"有没有这个头"、不看值，等于任何人加个头就能读明文密钥。
   *    已删除 —— 来源校验交由 originAllowed() 统一负责。
   */
  function keyEndpointAllowed(req) {
    const token = String(getConfig().server?.token ?? '');
    if (token) {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.headers['x-console-token'] === token || url.searchParams.get('token') === token) return true;
    }
    return originAllowed(req);
  }

  /**
   * 提供商对象脱敏：去掉明文 apiKey，只留 hasKey。
   * upsertProvider / addModelsToProvider / removeModelFromProvider 的返回值都带
   * 明文 key（来自 withResolvedKey），不能直接 json 给前端。
   */
  function sanitizeProvider(p) {
    if (!p || typeof p !== 'object') return p;
    const { apiKey, ...rest } = p;
    return { ...rest, apiKey: '', hasKey: Boolean(String(apiKey ?? '').trim()) };
  }

  // 声明式路由表（src/routes.js）：把所有依赖一次性注入。
  // 路由 handler 通过闭包取用这些依赖，handleHttp 只负责匹配分发。
  const apiRoutes = createRoutes({
    store, memory, sessions, onebot, orchestrator,
    emit, log,
    localVersion, compareSemver, UPDATE_INFO_URL,
    sanitizeConfig, keyEndpointAllowed, sanitizeProvider,
    readBody, authorize,
    snowlumaDir, snowlumaWsPort, snowlumaWebuiUrl, snowlumaWebuiPort, snowlumaStatus, snowlumaLogs,
    launchSnowluma, stopSnowluma,
    qqPortableStatus, qqPortableLogs, launchPortableQQ, stopPortableQQ,
    visionScan, isPortOpen,
    buildUsageStats, buildUsageBreakdown,
    reloadSkills
  });

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // SSE
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      if (!originAllowed(req)) return json(res, 403, { error: '请求来源不被信任' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      // 心跳：半开 TCP（拔网线 / NAT 超时，没有 FIN）不会触发 req 'close'，
      // 少了心跳这些客户端会永久留在 sseClients 里，之后每次 emit 都白写一遍。
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* 下面 error/close 会清理 */ }
      }, 15000);
      heartbeat.unref?.();
      const cleanup = () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      };
      // 异步写错误不会走 try/catch，必须显式兜住，否则会变成 uncaughtException
      res.on('error', cleanup);
      res.on('close', cleanup);
      req.on('close', cleanup);
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      // 来源校验：挡住"恶意网页借浏览器打 127.0.0.1"（CSRF / DNS rebinding）。
      // 必须在 authorize 之后、路由分发之前。
      if (!originAllowed(req)) {
        return json(res, 403, { error: '请求来源不被信任（仅接受本机控制台的同源请求）' });
      }
      const method = req.method;

      // 声明式路由分发（路由表在 src/routes.js）
      try {
        for (const route of apiRoutes) {
          if (route.method !== '*' && route.method !== method) continue;
          let match = null;
          if (typeof route.pattern === 'string') {
            if (route.pattern !== pathname) continue;
          } else {
            match = route.pattern.exec(pathname);
            if (!match) continue;
          }
          return await route.handler({ req, res, url, pathname, method, match, json });
        }
      } catch (error) {
        // readBody 等抛出的"可暴露错误"统一转 4xx；其余记日志、返回 500 而不是让连接挂掉
        if (error?.expose && Number.isInteger(error.status)) {
          return json(res, error.status, { error: String(error.message || '请求无效') });
        }
        log(`[api] ${method} ${pathname} 处理失败：${error?.stack ?? error?.message ?? error}`);
        return json(res, 500, { error: '服务器内部错误' });
      }
      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }


    // 静态 UI
    if (req.method === 'GET') {
      // 路径穿越防护：
      // 旧实现 file.replace(/\.\./g,'') 只删字面 ".." —— "/....//" 删完仍还原出 ".."，
      // 且 startsWith 校验在 path.join 之后做（顺序颠倒），形同虚设。
      // 正确做法：先 URL 解码 → 规范化 → 拼接 → 用 path.relative 判断跳出界。
      let decoded;
      try {
        decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      // 去掉前导斜杠后按 / 与 \ 切段，逐段校验
      const segs = decoded.replace(/^([/\\])+/, '').split(/[/\\]+/);
      // 逐段过滤：拒绝空段、"."、".."、以及任何含控制字符的段
      let blocked = false;
      const clean = [];
      for (const seg of segs) {
        if (seg === '' || seg === '.') continue;      // 空段/当前目录，忽略
        if (seg === '..') { blocked = true; break; }  // 任何 .. 直接拒绝，不做消解
        if (/[\x00-\x1f]/.test(seg)) { blocked = true; break; }
        clean.push(seg);
      }
      if (blocked || clean.length === 0) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      const fullPath = path.join(UI_DIR, ...clean);
      // 二次校验：解析后的路径必须仍在 UI_DIR 内
      const relCheck = path.relative(UI_DIR, fullPath);
      if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      try {
        const data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
        const headers = { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' };
        if (ext === '.html') {
          // CSP 用 HTTP 头再声明一次：header 里的 frame-ancestors 才生效
          // （meta 版本会被浏览器忽略该指令），同时给不解析 meta 的场景兜底。
          // ⚠️ script-src 与 index.html 的 meta 版本同款（sha256 hash 精确放行
          //    首屏主题预置脚本，不含 unsafe-inline）—— 两处口径必须一致，
          //    否则 meta 被剥离的场景下 unsafe-inline 立即生效。
          headers['content-security-policy'] = [
            "default-src 'self'",
            "script-src 'self' 'sha256-xBF5qExTuqfXHlYtKYaaldGJshQgQOr5zvcGHjbPL7w='",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: http: https:",
            "media-src 'self' data: blob:",
            "connect-src 'self' https://kondius.cn",
            "font-src 'self' data:",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'"
          ].join('; ');
          headers['x-content-type-options'] = 'nosniff';
          headers['referrer-policy'] = 'no-referrer';
        }
        res.writeHead(200, headers);
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    res.writeHead(404);
    res.end();
  }

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  // ── 启停 ──
  async function listenOn(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(port); // 必须把实际端口传回去，Electron 壳要用它加载页面
      });
    });
  }

  async function start() {
    // ── 启动顺序（2026-09-18 按耗时画像重排）────────────────────────────
    // 旧顺序的瓶颈：HTTP → 遥测 → Skill加载(串行import) → SnowLuma启动(最长20s等端口)
    //              → OneBot连接 → 就绪日志。Skill 与 SnowLuma 互不依赖却串行，
    //              白白把两段等待加在一起。
    // 新顺序：HTTP（页面先活）→ 遥测(纯后台) → **Skill 与 SnowLuma 并行** →
    //         OneBot 连接 → 就绪。会话索引的磁盘对账（reconcileInBackground）
    //         在 HTTP 起来后就排上，不占启动关键路径。
    const basePort = Number(getConfig().server?.port) || 3210;
    let port = null;
    let lastError = null;
    for (let p = basePort; p < basePort + 10; p++) {
      try {
        port = await listenOn(p);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');

    // 匿名用量遥测：启动 90 秒后发第一次，之后每 6 小时一次；失败静默不影响使用
    startTelemetryLoop(log);

    // 会话索引后台对账：启动读的是毫秒级缓存，这里异步补扫磁盘修正差异
    // （缓存缺失的新文件/外部删除的文件）。不 await —— 不挡任何启动步骤。
    sessions.reconcileInBackground();

    // 用量档案预热：首次打开用量页的卡顿来自"冷 parse 全部会话文件"
    //（2290 个 / 178MB 实测 1.3~1.9 秒）。启动后台先预热一次（collectUsageRows
    // 内部分片让步，不阻塞事件循环），用户点开用量页时档案已就绪，
    // 只剩窗口过滤（毫秒级）。不 await；失败静默（用量页会自己再算）。
    collectUsageRows({ range: '7' }).catch(() => {});

    // ── Skill 加载 与 SnowLuma 拉起并行（互不依赖）──
    const skillsReady = (async () => {
      try {
        const pluginResult = await reloadSkills({ reason: 'boot' });
        const okCount = pluginResult.loaded.length;
        const failCount = pluginResult.failed.length;
        if (okCount > 0) log(`[skill] 已加载 ${okCount} 个 Skill`);
        for (const f of pluginResult.failed) {
          log(`[skill] ❌ ${f.id || '(未知)'}：${f.error}`);
        }
        if (failCount > 0) log(`[skill] ${failCount} 个 Skill 加载失败`);

        const toolCount = orchestrator.refreshToolDefs();
        log(`[skill] 工具集已刷新：${toolCount} 个工具`);

        // 热重载日志：reloadSkills({reason:'boot'}) 里已经把 watcher 建好了
        // （默认开 config.extensions.hotReload，QQ_AGENT_DEV=1 可强制打开）
        if (pluginWatcher) {
          // 明确告知"落地的代码会被执行"，让用户知道这个行为的边界
          log('[skill] 热重载已启用：放入 plugins/ 或 skills/ 的目录会自动加载并执行'
            + '（要关闭请设 config.extensions.hotReload=false）');
        } else {
          log('[skill] 热重载未启用（config.extensions.hotReload=false）：改动后需重启');
        }
      } catch (error) {
        log('[skill] 加载失败:', error?.message ?? error);
      }
    })();

    const snowlumaReady = (async () => {
      if (!getConfig().snowluma?.autoLaunch) return;
      try {
        // 等待就绪用 WebUI 端口（进程即起即听）；OneBot WS 端口要等账号登录，
        // 在这里等 3001 是"永远等不到"的（没人扫码就一直挂着 20 秒）。
        const webuiPort = snowlumaWebuiPort();
        if (!(await isPortOpen('127.0.0.1', webuiPort))) {
          const r = await launchSnowluma();
          if (r.ok && r.launched) {
            for (let i = 0; i < 20 && !(await isPortOpen('127.0.0.1', webuiPort)); i++) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        }
      } catch (error) {
        log('[snowluma] 自动启动失败:', error?.message ?? error);
      }
    })();

    await Promise.all([skillsReady, snowlumaReady]);

    // OneBot 连接前先尝试从 SnowLuma 配置同步令牌（脱敏副本/首次登录场景尤其重要）
    if (syncSnowlumaTokens()) {
      const c = getConfig();
      onebot.wsUrl = String(c.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(c.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      // accessToken/httpToken 已由 applyTokens 直接挂到实例（候选[0]）
    }
    await onebot.connect();

    // ── OneBot 端口就绪轮询（2026-09-19）────────────────────────────────────
    // WS 3001 只有「QQ 登录 → Hook 检出 → OneBot 实例拉起」后才监听。常见时序：
    // QQ Agent 先启动（此时 3001 未开）→ connectLoop 吃 ECONNREFUSED → 退避
    // 涨到 30 秒 → 用户在这中间扫码登录 → 3001 开了，但下一次重试可能还要等
    // 二十多秒，用户看到的就是"登录了半天连不上 / 重启就好了"。
    // 这里加一个主动轮询：每 2 秒探一次 WS 端口，端口一开立即触发重连（走
    // connectLoop 的代际互斥，不会产生并发连接）。已连接后轮询自动停止；
    // 断线（SnowLuma 重启等）时轮询自动恢复 —— 恢复延迟从"最多 30 秒"降到
    // "最多 2 秒 + 一次连接建立"。
    const obWsPort = snowlumaWsPort();
    obPortPollTimer = setInterval(async () => {
      if (onebot.connected) return;          // 连着：无事可做（轮询本身极廉价）
      const open = await isPortOpen('127.0.0.1', obWsPort);
      if (open && !onebot.connected) {
        // 端口从关到开：立即重连（reconnect 会重置退避，秒级恢复）
        onebot.reconnect();
      }
    }, 2000);
    obPortPollTimer.unref?.();
    // ── WS 就绪后的账号信息兜底（2026-09-19）────────────────────────────────
    // SnowLuma 重启/换号后，QQ Agent 侧的 WS 可能先于 OneBot 实例完全就绪连上，
    // open 时的 get_login_info 失败 → selfInfo 恒空 → UI"检测不到账号"。
    // onebot.js 里已有 15 秒延迟补拉；这里再挂一道 45 秒后的终检：
    // 连着但仍没有 selfInfo 就强制补一次并广播状态（长期运行的兜底，幂等）。
    setTimeout(() => {
      if (!onebot.connected || onebot.selfInfo) return;
      onebot.call('get_login_info').then((info) => {
        if (info) {
          onebot.selfInfo = info;
          emit('onebot-status', { connected: true, everConnected: true, error: '' });
          log('[onebot] 账号信息延迟恢复成功');
        }
      }).catch(() => { /* 仍失败：连接层已尽力，UI 状态如实反映 */ });
    }, 45_000).unref?.();
    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    orchestrator.startReminderLoop();   // 提醒（闹钟）调度：到点往群里发提醒
    log(`控制台已就绪：http://127.0.0.1:${port}`);

    // ── 用量档案后台预热（2026-09-22）────────────────────────────────────
    // 首次打开用量页要先把全部会话文件解析一遍（实测 170MB ≈ 3.1 秒）——
    // 启动后闲置时先付掉，用户点「今日」就不用等。延迟 8 秒避开启动高峰
    // （插件加载 / 价格表 / 遥测都挤在头几秒），解析本身分片让步不阻塞事件循环。
    const usageWarmTimer = setTimeout(() => {
      warmUsageArchive()
        .then((r) => { if (r) log(`[usage] 用量档案已后台预热（${r.files} 个会话，${r.ms}ms）`); })
        .catch((error) => log(`[usage] 后台预热失败（首次打开用量页时会现场重算）：${error?.message ?? error}`));
    }, 8000);
    usageWarmTimer.unref?.();
    log(`OneBot（SnowLuma）: ws=${getConfig().snowluma?.wsUrl} http=${getConfig().snowluma?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  // ── Skill 重扫：UI「刷新」按钮的唯一后端入口 ──────────────────────────
  // 之前「刷新」只重读内存注册表（GET /api/skills），不碰磁盘 —— watcher 丢事件
  // （目录删除重建后 fs.watch 句柄失效、网络盘、杀毒软件）时，点多少次刷新都
  // 看不到新插件。这里把"重扫磁盘 + 激活 + 刷工具 + 重建 watcher"做成一个
  // 幂等函数，启动流程和手动重扫共用，行为完全一致。
  async function reloadSkills({ reason = 'manual' } = {}) {
    const result = await loadPlugins({ log });
    for (const st of skillManager.list()) {
      if (st.enabled && st.loaded) {
        try { skillManager.activate(st.id); } catch (error) { log(`[skill] 激活 ${st.id} 失败：${error?.message ?? error}`); }
      }
    }
    try { orchestrator.refreshToolDefs(); } catch { /* 刷新失败不影响主流程 */ }

    // watcher 自愈：fs.watch 监听的目录被删除再重建后收不到任何事件，
    // 这里关掉旧的重新建。热重载关闭时保持关闭（尊重用户配置）。
    const hotReloadOn = process.env.QQ_AGENT_DEV === '1'
      || getConfig().extensions?.hotReload !== false;
    try { pluginWatcher?.close?.(); } catch { /* ignore */ }
    pluginWatcher = null;
    if (hotReloadOn) pluginWatcher = watchPlugins({ log, onReload: () => reloadSkills({ reason: 'watch' }) });

    if (reason !== 'boot') {
      log(`[skill] 重扫完成（${reason}）：${result.loaded.length} 成功，${result.failed.length} 失败`
        + (result.pruned?.length ? `，卸载 ${result.pruned.length} 个已删除的 Skill` : ''));
      emit('status', { configUpdated: true });
    }
    return result;
  }

  async function stop() {
    // 先停掉热重载 watcher：否则 stop() 之后文件变动仍会触发重载 + 广播
    try { pluginWatcher?.close?.(); } catch { /* ignore */ }
    pluginWatcher = null;
    await orchestrator.abortAll();
    orchestrator.stopReminderLoop();
    if (communitySyncTimer) clearInterval(communitySyncTimer);
    try { cacheWarm?.stop?.(); } catch { /* ignore */ }
    if (obPortPollTimer) clearInterval(obPortPollTimer);
    // 索引缓存立刻落盘：正常运行中靠防抖（5s），退出前必须写一次，
    // 否则最后的会话变动丢失、下次启动要靠后台对账补（慢路径）
    sessions.flushIndexCache();
    // 关闭所有 SSE 长连接，避免 server.close() 一直等它们
    for (const c of [...sseClients]) {
      try { c.end(); } catch { /* ignore */ }
    }
    sseClients.clear();
    onebot.close();
    server.close();
    // 内置启动的 SnowLuma：QQ Agent 退出时一并关掉，避免留一个无窗口的后台进程。
    // 注意：SnowLuma 退出时不一定能立刻把 config 落盘，但我们的 stop 不会再去读它，
    // 下次启动会读到完整文件。
    try { snowlumaProc?.kill(); } catch { /* ignore */ }
    // 便携 QQ：默认保留运行（避免误杀用户登录态），如需清理可在 UI 手动关闭
    // try { await stopPortableQQ(); } catch { /* ignore */ }
    // 释放单实例锁（下次启动才能再抢到）
    releaseInstanceLock();
  }

  return { server, onebot, store, memory, stickers, sender, sessions, orchestrator, start, stop, emit, getConfig, updateConfig, launchSnowluma, stopSnowluma, snowlumaStatus, launchPortableQQ, stopPortableQQ, qqPortableStatus, reloadSkills };
}

/**
 * 成本看板数据：按天 / 按会话 / 按群聚合最近 N 天的用量。
 *
 * 数据源是 data/sessions/*.json（会话留档），每个会话对象里已有
 * usage.{promptTokens, completionTokens, cachedTokens} 与 chatKey / model / rounds。
 * 没有历史汇总文件也能算 —— 直接扫留档即可。
 */
/**
 * 解析时间范围参数。
 *   'today' → 今天 00:00 起
 *   '24h'   → 最近 24 小时（滚动窗口，可能跨天）
 *   '3'|'7'|'14'|'30' → 最近 N 个自然日
 */
function resolveRange(raw) {
  const s = String(raw || '7').trim().toLowerCase();
  const now = Date.now();
  if (s === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { mode: 'today', start: d.getTime(), end: now, label: '今天' };
  }
  if (s === '24h') {
    return { mode: '24h', start: now - 24 * 60 * 60 * 1000, end: now, label: '最近 24 小时' };
  }
  // 前端"全部"按钮：不设起始时间。曾经静默回落"近 7 天"（Number('all')||7），
  // 用户以为在看全量历史实际被截断 —— 与"求和一致"的产品口径冲突。
  if (s === 'all') {
    return { mode: 'all', start: 0, end: now, label: '全部' };
  }
  const n = Math.min(30, Math.max(1, Number(s) || 7));
  // 按自然日：从 N-1 天前的 0 点算起，保证"7 天"是 7 个完整日历日
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return { mode: 'days', start: d.getTime() - (n - 1) * 24 * 60 * 60 * 1000, end: now, label: `最近 ${n} 天` };
}

/** 本地时区的 YYYY-MM-DD（用于按天分桶）。 */
function dayKeyOf(ts) {
  const d = new Date(Number(ts) || 0);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * 收集时间窗内的所有"调用行"。
 * 每行是一次真实 API 调用（有 raw 时）或一次会话聚合（无 raw 时），
 * 都带自己的 token、发生时刻、模型、所属会话。
 */
// ── 用量行缓存 ──
// collectUsageRows 要遍历并 JSON.parse 全部会话文件。实测 300 个文件 / 25MB 时
// 单次约 200ms，而前端每 15 秒轮询一次、stats 与 breakdown 还各扫一遍。
// 会话文件是"结束写一次、之后不再改"，所以缓存很安全。
//
// 失效策略（双保险，任一条命中就重算）：
//   1. 目录快照变化：文件数或目录 mtime 变了（新增/删除会话）
//   2. TTL 到期：20 秒。兜住"内容被改写但目录快照不变"这类边缘情况。
//      原来是 5 秒，但轮询间隔 4 秒、用户切页签的时机又很随机，
//      导致切过去时缓存经常刚好过期 → 每次都走 200ms 的冷启动（"黑一下"）。
//      用量统计不是实时数据，20 秒的新鲜度完全够用。
//      另外前端还有一层：切过去先用上次数据立即渲染，不等网络。
//
// ⚠️ 数据量增长后的实测（2026-09-17，真实部署 2144 个会话 / 172MB）：
//    全量 parse 需要 ~1.9s —— 20 秒 TTL 到期后的每次重算都会把主进程
//    event loop 阻塞近 2 秒，期间 HTTP/SSE/消息处理全部排队 —— 前端表现
//    就是"用量页卡住、整个控制台无响应"。两条治理（同步进 collectUsageRows）：
//    A. **增量解析**：目录快照没变时复用上一轮解析结果（不只 TTL 内 ——
//       sig 相同就复用，只是重做时间窗过滤与派生字段），冷启动只在
//       真有新会话落盘时才发生。TTL 仍然保留，兜"内容被改写"的边缘情况。
//    B. **流式分片解析**：真要冷启动时，把 172MB 的同步 parse 拆成
//       每 50 个文件一让步（setImmediate）的异步流水线 —— 单次让步前的
//       阻塞 <100ms，消息处理/界面请求不再被长阻塞。
//      会话文件"结束写一次、之后不改"的语义不变，A 的复用与原缓存同样安全。
const usageRowsCache = { key: '', at: 0, rows: null, win: null };
const USAGE_CACHE_TTL_MS = 20000;
// 已解析会话的档案（增量解析的持久层）：sig（目录快照）→ 每会话的展开行/计数。
// 与 usageRowsCache 的区别：后者是"某个时间窗的最终 rows"，前者是
// "全部会话的原始素材" —— 换 range 时不必重新读盘。
const usageArchive = { sig: '', at: 0, sessions: null };   // sessions: Map(file -> {rows[], searchCount, toolCounts})
// 让步前最多同步解析的文件数（B 方案的切片粒度）
const USAGE_PARSE_CHUNK = 50;
// 让步前最多同步 stat 的文件数（档案命中时只剩 stat，粒度可以粗一些）
const USAGE_STAT_CHUNK = 400;

/** 目录快照：文件数 + 目录 mtime。成本低（一次 stat），足以捕捉增删。 */
function sessionsDirSignature() {
  const dir = path.join(DATA_DIR, 'sessions');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const st = fs.statSync(dir);
    return files.length + ':' + st.mtimeMs + ':' + files.reduce((a, f) => a + f.length, 0);
  } catch {
    return '';
  }
}

/**
 * 读盘解析单个会话文件 → { rows, searchCount, toolCounts, started }。
 * 纯函数（不含时间窗过滤）：窗口过滤在 collectUsageRows 里做 —— 这样
 * 换 range（今天/7天/全部）时可以完全复用这份解析结果。
 */
function parseUsageSessionFile(dir, f) {
  const out = { rows: [], searchCount: 0, toolCounts: Object.create(null), started: 0, mtime: 0, size: -1 };
  try {
    const fp = path.join(dir, f);
    const st = fs.statSync(fp);
    out.mtime = st.mtimeMs;
    // size 与 mtime 一起当"这个文件没变过"的判据：NTFS 的 mtime 粒度是 100ns，
    // 单独用 mtime 已经够稳；多存一个 size 是白送的保险（同一个 mtime 刻度内
    // 被改写且长度恰好相同 —— 概率极低但不是零）。
    out.size = st.size;
    const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const started = Number(s.startedAt) || 0;
    out.started = started;
    if (!started) return out;
    out.searchCount = Number(s.webSearchCount) || 0;
    // 逐次调用展开：每条 message.raw 有独立的 usage / created / model
    const exactRows = [];
    for (const m of (s.messages || [])) {
      const name = m && m.toolCall && m.toolCall.name;
      if (name) out.toolCounts[String(name)] = (out.toolCounts[String(name)] || 0) + 1;
      const raw = m?.raw;
      if (!raw || typeof raw !== 'object') continue;
      const ru = raw.usage || {};
      const rp = Number(ru.prompt_tokens) || 0;
      const rc = Number(ru.completion_tokens) || 0;
      if (!rp && !rc) continue;
      const at = Number(raw.created) ? Number(raw.created) * 1000 : started;
      exactRows.push({
        promptTokens: rp,
        completionTokens: rc,
        cachedTokens: Number(ru.prompt_tokens_details?.cached_tokens) || 0,
        at,
        model: String(raw.model || s.model || '') || '(未知)'
      });
    }
    if (exactRows.length) {
      for (const c of exactRows) {
        out.rows.push({ ...c, vendor: String(s.vendor || ''), chatKey: String(s.chatKey || '(未知)'), sessionId: s.id, exact: true });
      }
    } else {
      const u = s.usage || {};
      const p = Number(u.promptTokens) || 0;
      const c = Number(u.completionTokens) || 0;
      if (p || c) {
        out.rows.push({
          promptTokens: p,
          completionTokens: c,
          cachedTokens: Number(u.cachedTokens) || 0,
          at: started,
          model: String(s.model || '') || '(未知)',
          chatKey: String(s.chatKey || '(未知)'),
          vendor: String(s.vendor || ''),
          sessionId: s.id,
          exact: false
        });
      }
    }
  } catch { /* 坏文件跳过（与旧行为一致） */ }
  return out;
}

/**
 * （异步）刷新"已解析档案"到当前目录快照。
 * 只重读**变化过的文件**（新文件 + mtime/size 变了的文件），其余复用 ——
 * 2144 个文件只有几个新增时，重读量从 172MB 降到几 MB。
 * 解析按 USAGE_PARSE_CHUNK 分片、片间 setImmediate 让步，不长阻塞事件循环。
 *
 * ⚠️ 2026-09-22 修：这里曾经有一行"前置复用条件"，只有目录签名前两段
 *    （文件数 : 目录 mtime）完全一致才肯以旧档案为底，否则 `prev = new Map()`
 *    —— 于是**每落一个新会话文件就把已解析的整份档案全部丢弃、全量重解析**。
 *    机器人正常运行时新会话每几分钟落一个，等于这个增量缓存从未生效过。
 *    实测（800 文件 / 121MB 合成数据）：增量解析 5ms，被整体丢弃后 2157ms，
 *    而用量页"点今日"走的正是这条路径 —— 这就是"加载非常久"的直接原因。
 *
 *    那行条件本来是想兜"目录被换掉/清空"的场景，但下面**逐文件**比对
 *    (mtime, size) 已经覆盖了它：文件被删就不在 files 列表里、被改写则
 *    mtime/size 必变。所以现在无条件以现有档案为底，稳定性由逐文件判据保证。
 */
async function refreshUsageArchive(dir, files, sig) {
  // ⚠️ 这里**故意不做** "sig 相同就直接返回" 的短路（2026-09-22 实测踩到）：
  //    sessionsDirSignature 只是「文件数 : 目录 mtime : 文件名总长」，
  //    而会话文件是**原地改写**的（会话跑完 #persist 落盘、运行中节流保存），
  //    NTFS 下改写文件内容不会动父目录的 mtime —— 于是"内容变了但签名没变"
  //    会让档案一直沿用旧的解析结果。实测：把一个会话从 4 次调用改写成 40 次，
  //    档案里仍然是 4 —— 而且只要目录没有增删文件，这个错值就**永远**不修正。
  //    多付的代价只是一次"每文件一次 stat"的扫描（1200 文件 ≈ 5ms）；
  //    真正省钱的判据是下面逐文件的 (mtime, size) 比对，那是零读盘的。
  const prev = usageArchive.sessions || new Map();
  const next = new Map();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const old = prev.get(f);
    let st;
    try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
    if (old && old.mtime === st.mtimeMs && old.size === st.size) {
      next.set(f, old);   // 文件没变：复用上次的解析结果（零读盘）
      // 纯 stat 的批次也可能很长（上万文件），同样分片让步
      if ((i + 1) % USAGE_STAT_CHUNK === 0) await new Promise((r) => setImmediate(r));
      continue;
    }
    next.set(f, parseUsageSessionFile(dir, f));
    // 分片让步：单文件最大 ~1MB，50 个一批的同步解析 < 100ms
    if ((i + 1) % USAGE_PARSE_CHUNK === 0) await new Promise((r) => setImmediate(r));
  }
  usageArchive.sessions = next;
  usageArchive.sig = sig;
  usageArchive.at = Date.now();
  return next;
}

/**
 * 后台预热用量档案（2026-09-22）。
 *
 * 用量统计的第一道工序是把全部会话文件 JSON.parse 一遍（实测 1200 文件 /
 * 170MB ≈ 3.1 秒）。不预热的话，**每次启动后第一次打开用量页都要等这 3 秒**，
 * 用户看到的就是"点今日加载非常久"—— 而这 3 秒完全可以在启动后闲置时先付掉。
 *
 * 由 start() 在启动 8 秒后调用：那时插件加载、价格表、遥测都已就位，档案解析
 * 又是分片让步的，不会长阻塞事件循环。没有任何会话文件（全新安装）直接跳过。
 *
 * @returns {Promise<{files:number, ms:number}|null>}
 */
async function warmUsageArchive() {
  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  if (!files.length) return null;
  const t0 = Date.now();
  const archive = await refreshUsageArchive(dir, files, sessionsDirSignature());
  return { files: archive.size, ms: Date.now() - t0 };
}

/**
 * 历史文件指纹：只统计"已完结"的会话文件（最后写盘时刻早于今天 0 点）。
 *
 * 为什么日快照判据不用目录签名（sessionsDirSignature）：目录签名含目录 mtime，
 * 机器人每结束一个新会话就落一个新文件 → 签名必变。旧判据下签名一变，
 * **全部历史日快照同时失效** → 每次统计把窗口内每一天从档案全量重算
 * （每天遍历全部会话行 + 逐行计价，同步无让步），数据量大时事件循环被
 * 阻塞数秒、所有接口排队 —— 长期使用后"用量页卡死在加载界面"的根因。
 *
 * 而已完结文件（会话写完一次后不再改写）的集合对历史日是稳定的：
 * 新增会话只影响"今天"（今天永远实时聚合、不进快照）。指纹不变 →
 * 历史快照持续有效；清理/删除旧会话文件会改变指纹 → 相关快照正确失效。
 * 每天 0 点跨越会让指纹变一次（昨天写完的文件被纳入）→ 一天仅重算一次。
 *
 * 指纹从已解析档案派生（每文件 mtime 在 refreshUsageArchive 时已 stat），
 * 零额外 IO。格式带 h: 前缀，与旧目录签名天然不同 —— 旧快照首次统计时
 * 自动失效重算一遍，随即迁移成新格式，无需专门迁移代码。
 */
function historySignatureOf(archive, todayStartMs) {
  let count = 0, mtimeSum = 0;
  for (const parsed of archive.values()) {
    if (!parsed || !parsed.mtime || parsed.mtime >= todayStartMs) continue;
    count++;
    mtimeSum += parsed.mtime;
  }
  return `h:${count}:${mtimeSum}`;
}

async function collectUsageRows({ range }) {
  const win = resolveRange(range);
  // 命中缓存就直接返回（注意 rows 会被调用方改写字段，所以必须给副本）
  const sig = sessionsDirSignature() + '@' + String(range);
  if (usageRowsCache.rows && usageRowsCache.key === sig
      && (Date.now() - usageRowsCache.at) < USAGE_CACHE_TTL_MS) {
    return {
      // 深拷贝：曾经 slice() 只是浅拷贝，调用方往行对象上写字段（如 dayKey）
      // 会写穿到缓存对象；当前写入恰好幂等无害，但承诺的"防污染"并不成立
      rows: usageRowsCache.rows.map((r) => ({ ...r })),
      win: win || usageRowsCache.win,
      searchCount: usageRowsCache.searchCount || 0,
      toolCounts: { ...(usageRowsCache.toolCounts || {}) }
    };
  }

  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { rows: [], win, searchCount: 0, toolCounts: {} }; }

  // ── 数据量治理（2026-09-17，见"用量行缓存"注释的 A/B 方案）──
  // 档案层增量解析 + 分片让步；时间窗过滤只对窗口内的素材做。
  const archive = await refreshUsageArchive(dir, files, sig.split('@')[0]);

  const rows = [];
  // 会话级计数：搜索次数、各工具的调用次数。
  // 注意这些是"次数"不是"成本"：搜索通常是资源包或免费的，
  // 所以只列数量、绝不参与成本计算（用户明确要求）。
  let searchCount = 0;
  const toolCounts = Object.create(null);

  for (const f of files) {
    const parsed = archive.get(f);
    if (!parsed || !parsed.started) continue;
    // 这个会话是否落在时间窗口内（工具/搜索计数按会话归属，没有独立时间戳）
    if (parsed.started >= win.start && parsed.started <= win.end) {
      searchCount += parsed.searchCount || 0;
      for (const [name, n] of Object.entries(parsed.toolCounts)) {
        toolCounts[name] = (toolCounts[name] || 0) + n;
      }
    }
    // 逐次调用行：窗口内才收进 rows（行自带 at，可精确到调用时刻）
    for (const r of parsed.rows) {
      if (r.at < win.start || r.at > win.end) continue;
      rows.push(r);
    }
  }
  // 模型身份 = 渠道 + 模型 id。
  // 渠道取**会话自己记录的** vendor（创建会话时由当时的配置派生）。
  // 老会话没这个字段 → 标为「未知渠道」，绝不拿当前配置去倒推历史 ——
  // 用户很可能早就换过渠道了，猜出来的结果是错的。
  for (const r of rows) {
    r.vendor = String(r.vendor || '').trim() || UNKNOWN_VENDOR;
    r.modelKey = modelLabel(r.vendor, r.model);
  }
  // 写缓存：存的是"清洗完的 rows"，取用时给副本避免调用方污染
  // ⚠️ rows 里的对象来自档案层（可能被多个 range 的缓存共享引用）——
  //    上面 vendor/modelKey 的改写是幂等的，但调用方还会写 dayKey，
  //    所以缓存里也存一份浅拷贝行（同 range 复用时的防污染，与旧行为一致）。
  usageRowsCache.key = sig;
  usageRowsCache.at = Date.now();
  usageRowsCache.rows = rows.map((r) => ({ ...r }));
  usageRowsCache.win = win;
  usageRowsCache.searchCount = searchCount;
  usageRowsCache.toolCounts = { ...toolCounts };
  return { rows, win, searchCount, toolCounts };
}

// ── 按日快照（2026-09-19）──────────────────────────────────────────
//
// 问题：collectUsageRows 即使有档案层缓存，冷启动（2144 文件 / 172MB）仍要
// 全量流式解析；"今天之前的每一天"的数据是**不可变的**（会话结束写一次、
// 之后不改），每次打开用量页都从头统计它们是纯浪费。
//
// 方案：把"已完结自然日"（今天之前）的聚合结果固化到
// data/usage-daily.json。读取路径优先快照；只有快照缺失/失效的日才回退
// 到"从档案聚合"。写快照时机：每次统计完顺手补齐（异步、不阻塞响应）。
//
// 有效性判据：每条日快照带生成时的目录快照 sig。sig 没变 → 该日必然没
// 新增会话（会话文件不改写），直接用。sig 变了 → 重算该日（分片解析会
// 复用 mtime 相同的旧解析结果，增量代价很小）。"今天"永远不进快照。
//
// ⚠️ 成本口径：快照存 costOfRows 聚合结果。价格表（自定义价/远程价）变化
//    会让历史成本跟着变 —— 快照固定的是"生成当时的计价"。这是刻意取舍：
//    量级收益（秒→毫秒）远大于"改价后历史成本不联动"的小误差；想重算
//    任何一天，删掉快照文件对应条目即可。
const USAGE_DAILY_FILE = path.join(DATA_DIR, 'usage-daily.json');
const USAGE_DAILY_VERSION = 1;

function loadUsageDaily() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_DAILY_FILE, 'utf8'));
    if (parsed?.version === USAGE_DAILY_VERSION && parsed.days && typeof parsed.days === 'object') {
      return parsed.days;
    }
  } catch { /* 无文件/坏文件 = 全部重算 */ }
  return {};
}

function saveUsageDaily(days) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${USAGE_DAILY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: USAGE_DAILY_VERSION, savedAt: Date.now(), days }, null, 1), 'utf8');
    fs.renameSync(tmp, USAGE_DAILY_FILE);
  } catch { /* 快照写失败只是慢一点，绝不能影响统计主流程 */ }
}

/**
 * 已完结自然日列表：从窗口起点（或快照里最早的日）到昨天。
 * 今天永远实时算（数据还在长）。
 */
function completedDayKeys(fromTs) {
  const out = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  // 昨天的 0 点（今天之前最后一个已完结日）
  d.setDate(d.getDate() - 1);
  const start = new Date(Number(fromTs) || 0);
  start.setHours(0, 0, 0, 0);
  while (d.getTime() >= start.getTime()) {
    out.push(dayKeyOf(d.getTime()));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

/**
 * 「数据元年」——最早**可能**有数据的自然日 0 点。
 *
 * 为什么需要它（2026-09-22）：'all' 范围给 completedDayKeys 传的起点是 0，
 * 于是从 1970-01-01 一路枚举到昨天 —— 实测 20718 个空日。代价有三层：
 *   1. 枚举本身要遍历两万多次（13ms，还算便宜）；
 *   2. 每个空日都会生成一条快照写进 usage-daily.json → 文件被灌到 9.95MB，
 *      而这份文件**每次统计**都要 JSON.parse 一遍（≈65ms）；
 *   3. 更糟的是 days 维度会吐 20718 个数据点，前端折线图直接画两万个点。
 *
 * 取两侧较小值，宁可保守（算早不算晚，绝不把真有数据的日子切掉）：
 *   ① 档案里最早一个会话的开始时刻；
 *   ② 日快照里最早一个"确有数据"（runs 或 token 非零）的日。
 * 两边都拿不到 → 返回 0，等于不做任何下限（老行为），安全兜底。
 */
function usageDataFloorMs(archive, snapshotDays) {
  let floorMs = Infinity;
  for (const parsed of archive.values()) {
    const t = Number(parsed?.started) || 0;
    if (t > 0 && t < floorMs) floorMs = t;
  }
  // 日键是 YYYY-MM-DD，字典序即时间序，不必逐条 new Date（两万条 Date 解析不便宜）
  let floorKey = '';
  for (const [dayKey, snap] of Object.entries(snapshotDays || {})) {
    const t = snap?.aggregates?.totals;
    if (!t) continue;
    if (!((Number(t.runs) || 0) > 0 || (Number(t.totalTokens) || 0) > 0)) continue;
    if (!floorKey || dayKey < floorKey) floorKey = dayKey;
  }
  if (floorKey) {
    const k = new Date(floorKey + 'T00:00:00').getTime();
    if (!isNaN(k) && k < floorMs) floorMs = k;
  }
  if (!isFinite(floorMs)) return 0;
  const d = new Date(floorMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 裁掉日快照里"数据元年"之前的日（只会是空日）与未来日。
 *
 * 保守三条，确保它永远不会删掉真实数据：
 *   ① 元年拿不到（0 / 非有限数）→ 一条都不裁；
 *   ② 只裁 **严格早于** 元年的日 —— 元年当天及以后原样保留；
 *   ③ 只裁字典序比较这一天（不做任何数值猜测）。
 * 被裁掉的日子如果将来真有数据，会作为"快照缺失"被正常重算，不会丢。
 *
 * @returns {number} 实际裁掉的条数（>0 时需要回写快照）
 */
function pruneUsageDaily(snapshotDays, floorMs) {
  if (!floorMs || !isFinite(floorMs)) return 0;
  const floorKey = dayKeyOf(floorMs);
  const tomorrowKey = dayKeyOf(Date.now() + 24 * 60 * 60 * 1000);
  let removed = 0;
  for (const dayKey of Object.keys(snapshotDays)) {
    if (dayKey < floorKey || dayKey > tomorrowKey) { delete snapshotDays[dayKey]; removed++; }
  }
  return removed;
}

/**
 * 从档案层聚合出"某一个自然日"的统计（不使用快照 —— 这是重算路径）。
 * 返回与 buildUsageStats 的 days/chats/models 三段同构的聚合体。
 */
function aggregateDayFromArchive(archive, dayKey) {
  const dayStart = new Date(dayKey + 'T00:00:00');
  if (isNaN(dayStart.getTime())) return null;
  const dayEnd = dayStart.getTime() + 24 * 60 * 60 * 1000 - 1;
  const rows = [];
  let searchCount = 0;
  const toolCounts = Object.create(null);
  for (const parsed of archive.values()) {
    if (!parsed || !parsed.started) continue;
    if (parsed.started >= dayStart.getTime() && parsed.started <= dayEnd) {
      searchCount += parsed.searchCount || 0;
      for (const [name, n] of Object.entries(parsed.toolCounts)) {
        toolCounts[name] = (toolCounts[name] || 0) + n;
      }
    }
    for (const r of (parsed.rows || [])) {
      if (r.at >= dayStart.getTime() && r.at <= dayEnd) rows.push(r);
    }
  }
  for (const r of rows) {
    r.vendor = String(r.vendor || '').trim() || UNKNOWN_VENDOR;
    r.modelKey = modelLabel(r.vendor, r.model);
  }
  const totals = costOfRows(rows);
  const chats = groupBy(rows, 'chatKey', 0);
  const models = groupBy(rows, 'modelKey', 0).map((m) => {
    const { vendor, model } = splitModelLabel(m.key);
    return { ...m, vendor, model };
  });
  return { totals, chats, models, searchCount, toolCounts };
}

/**
 * 快照加速版统计：days 维度全部走快照 + 今天实时聚合。
 * 其余维度（chats/models/totals）= 各日快照聚合 + 今天实时。
 * 任一需要的日快照缺失/失效 → 重算该日并回写快照。
 *
 * @returns {Promise<{stats: object, usedSnapshotDays: number, recomputedDays: number}>}
 */
async function buildUsageStatsWithSnapshots({ range = '7' } = {}) {
  const win = resolveRange(range);
  const todayKey = dayKeyOf(Date.now());
  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { files = []; }
  const dirSig = sessionsDirSignature();
  const archive = await refreshUsageArchive(dir, files, dirSig);
  // 日快照有效性判据 = 历史文件指纹（不是目录签名，原因见 historySignatureOf 注释）
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const historySig = historySignatureOf(archive, todayStart.getTime());

  // 需要的已完结日：窗口起点到昨天；快照里已有的更早日子只在 all 模式需要
  const snapshotDays = loadUsageDaily();
  // ⚠️ 顺序要紧：先读出快照（数据元年的判据之一），再算起点、再枚举日。
  //
  // 起点 = 「窗口起点」与「数据元年」的**较晚者**。两条同时要满足：
  //   ① 'all' 不能给 0 —— 那会从 1970-01-01 枚举两万多个空日（见元年函数注释）；
  //   ② 元年之前的日子必然是空的，枚举出来只会在快照里写一批空条目、
  //      下一次调用又按"空日裁剪"删掉 —— 一边写一边删，**每次统计都重算那几个空日**。
  //      实测（R49 / usage-daily-test 抓到的）：只有 3 天数据的部署上，
  //      7 天窗口会稳定地每次重算 3 个空日，等于把刚修好的性能又还回去一部分。
  //      枚举与裁剪用同一个下限，"写什么"就等于"留什么"，churn 自然消失。
  // 元年拿不到（= 整份数据里一条会话都没有）：'all' 干脆一天都不枚举，
  // 其他范围退回窗口起点（Math.max(start, 0) 即起点本身）。
  const floorMs = usageDataFloorMs(archive, snapshotDays);
  const fromTs = win.mode === 'all'
    ? (floorMs || Infinity)
    : Math.max(win.start, floorMs);
  const wantedDays = completedDayKeys(fromTs);
  let recomputed = 0;

  // days 维度：每日一条聚合（快照优先，缺失则重算）
  const byDay = [];
  const needDays = [];
  for (const dayKey of wantedDays) {
    const snap = snapshotDays[dayKey];
    if (snap && snap.sig === historySig && snap.aggregates) {
      byDay.push({ day: dayKey, ...snap.aggregates.totals });
    } else {
      needDays.push(dayKey);
    }
  }
  for (const dayKey of needDays) {
    const agg = aggregateDayFromArchive(archive, dayKey);
    if (!agg) continue;
    byDay.push({ day: dayKey, ...agg.totals });
    snapshotDays[dayKey] = { sig: historySig, aggregates: agg };
    recomputed++;
  }
  byDay.sort((a, b) => a.day.localeCompare(b.day));

  // 今天（窗口含今天才需要）：实时聚合
  const includesToday = win.end >= new Date(todayKey + 'T00:00:00').getTime();
  let todayAgg = null;
  if (includesToday) {
    todayAgg = aggregateDayFromArchive(archive, todayKey);
  }

  // 合并各维度：已完结日快照 + 今天实时
  const mergeGroups = (groupsList) => {
    const map = new Map();
    for (const groups of groupsList) {
      for (const g of groups || []) {
        const key = String(g.key ?? '');
        if (!map.has(key)) map.set(key, { key, ...g, runs: 0, exactCalls: 0, cost: 0 });
        const t = map.get(key);
        t.cost += Number(g.cost) || 0;
        t.peakCost += Number(g.peakCost) || 0;
        t.offPeakCost += Number(g.offPeakCost) || 0;
        t.peakTokens += Number(g.peakTokens) || 0;
        t.offPeakTokens += Number(g.offPeakTokens) || 0;
        t.promptTokens += Number(g.promptTokens) || 0;
        t.completionTokens += Number(g.completionTokens) || 0;
        t.cachedTokens += Number(g.cachedTokens) || 0;
        t.totalTokens += Number(g.totalTokens) || 0;
        t.runs += Number(g.runs) || 0;
        t.exactCalls += Number(g.exactCalls) || 0;
      }
    }
    let out = [...map.values()];
    out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
    return out;
  };

  const snapAggs = [...wantedDays].map((k) => snapshotDays[k]?.aggregates).filter(Boolean);
  const totalsAggs = snapAggs.map((a) => a.totals);
  if (todayAgg) totalsAggs.push(todayAgg.totals);
  const totals = totalsAggs.reduce((acc, t) => {
    if (!acc) return { ...t, runs: t.runs, exactCalls: t.exactCalls };
    return {
      cost: (acc.cost || 0) + (t.cost || 0),
      peakCost: (acc.peakCost || 0) + (t.peakCost || 0),
      offPeakCost: (acc.offPeakCost || 0) + (t.offPeakCost || 0),
      peakTokens: (acc.peakTokens || 0) + (t.peakTokens || 0),
      offPeakTokens: (acc.offPeakTokens || 0) + (t.offPeakTokens || 0),
      promptTokens: (acc.promptTokens || 0) + (t.promptTokens || 0),
      completionTokens: (acc.completionTokens || 0) + (t.completionTokens || 0),
      cachedTokens: (acc.cachedTokens || 0) + (t.cachedTokens || 0),
      totalTokens: (acc.totalTokens || 0) + (t.totalTokens || 0),
      runs: (acc.runs || 0) + (t.runs || 0),
      exactCalls: (acc.exactCalls || 0) + (t.exactCalls || 0),
      hasPeakModel: Boolean(acc.hasPeakModel || t.hasPeakModel)
    };
  }, null) || { cost: 0, peakCost: 0, offPeakCost: 0, peakTokens: 0, offPeakTokens: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cacheHitRate: 0, peakRatio: 0, exactCalls: 0, hasPeakModel: false, runs: 0 };
  // 派生比率不能相加，重算
  totals.cacheHitRate = totals.promptTokens ? Math.min(1, totals.cachedTokens / totals.promptTokens) : 0;
  totals.peakRatio = (totals.peakTokens + totals.offPeakTokens) ? totals.peakTokens / (totals.peakTokens + totals.offPeakTokens) : 0;

  const chats = mergeGroups([...snapAggs.map((a) => a.chats), ...(todayAgg ? [todayAgg.chats] : [])]);
  const models = mergeGroups([...snapAggs.map((a) => a.models), ...(todayAgg ? [todayAgg.models] : [])])
    .map((m) => {
      const { vendor, model } = splitModelLabel(m.key);
      return { ...m, vendor, model };
    });
  let searchCount = snapAggs.reduce((a, x) => a + (x.searchCount || 0), 0) + (todayAgg?.searchCount || 0);
  const toolCounts = {};
  for (const a of snapAggs) {
    for (const [k, v] of Object.entries(a.toolCounts || {})) toolCounts[k] = (toolCounts[k] || 0) + v;
  }
  for (const [k, v] of Object.entries(todayAgg?.toolCounts || {})) toolCounts[k] = (toolCounts[k] || 0) + v;

  // 快照回写（有新增/失效重算的日子才写）
  // 顺带裁掉数据元年之前的空日：老版本被 'all' 范围灌进来的两万条空日
  // 就靠这一句自愈（正常运行时每次统计都过一遍，裁剪本身是字符串比较，可忽略）。
  const prunedDays = pruneUsageDaily(snapshotDays, floorMs);
  if (recomputed > 0 || needDays.length > 0 || prunedDays > 0) {
    // 只保留窗口需要的 + 已有的（不清老数据——删掉将来还得重算）
    saveUsageDaily(snapshotDays);
  }

  return {
    stats: {
      range: String(range),
      rangeLabel: win.label,
      mode: win.mode,
      totals,
      searchCount: searchCount || 0,
      toolCounts: toolCounts || {},
      days: byDay,
      chats,
      models
    },
    recomputedDays: recomputed,
    prunedDays,
    usedSnapshotDays: wantedDays.length - recomputed
  };
}

/** 用配置解析价格（成本只与实际调用的模型有关，与当前选中模型无关）。 */
/**
 * 取某次调用的单价。
 *
 * 按「渠道：模型 id」优先查 —— 用户可以为某个渠道下的模型单独定价
 * （A6API 的 GLM-5.3-Flash 与 OpenRouter 的可能是两个价）。
 * 查不到再退回裸模型 id（通用价），最后才是全局兜底。
 *
 * ⚠️ 必须与前端展示/批量编辑用的身份一致，否则用户设的渠道价永远不会生效。
 */
function priceOf(model, vendor) {
  const cfg = getConfig();
  if (vendor) {
    const byVendor = resolveModelPrice(modelLabel(vendor, model), cfg);
    // 命中自定义价才算数；否则退回通用价（避免渠道名干扰官方表匹配）
    if (byVendor.source === 'custom') return byVendor;
  }
  return resolveModelPrice(model, cfg);
}

/** 对一批行计价，返回总额与峰谷拆分。 */
function costOfRows(rows) {
  const cfg = getConfig();
  let cost = 0, peakCost = 0, offPeakCost = 0, peakTokens = 0, offPeakTokens = 0;
  let promptTokens = 0, completionTokens = 0, cachedTokens = 0, exactCalls = 0, hasPeakModel = false;
  for (const r of rows) {
    const p = priceOf(r.model, r.vendor);
    if (p.peak) hasPeakModel = true;
    const tier = p.peak ? priceAt({ in: p.in, out: p.out, cached: p.cached, peak: p.peak }, r.at) : p;
    const prompt = Number(r.promptTokens) || 0;
    const completion = Number(r.completionTokens) || 0;
    const cached = Math.min(Number(r.cachedTokens) || 0, prompt);
    const fresh = Math.max(0, prompt - cached);
    const c = (fresh / 1_000_000) * tier.in + (cached / 1_000_000) * tier.cached + (completion / 1_000_000) * tier.out;
    cost += c;
    const tk = prompt + completion;
    if (isPeakHour(r.at)) { peakCost += c; peakTokens += tk; } else { offPeakCost += c; offPeakTokens += tk; }
    promptTokens += prompt;
    completionTokens += completion;
    cachedTokens += cached;
    if (r.exact) exactCalls += 1;
  }
  return {
    cost, peakCost, offPeakCost, peakTokens, offPeakTokens,
    promptTokens, completionTokens, cachedTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    peakRatio: (peakTokens + offPeakTokens) ? peakTokens / (peakTokens + offPeakTokens) : 0,
    exactCalls, hasPeakModel, runs: rows.length
  };
}

/** 按某个字段分组后各自计价。 */
function groupBy(rows, field, limit = 0) {
  const map = new Map();
  for (const r of rows) {
    const k = String(r[field] ?? '(未知)');
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  let out = [...map.entries()].map(([key, list]) => ({ key, ...costOfRows(list) }));
  out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
  if (limit) out = out.slice(0, limit);
  return out;
}

/** 主统计：按天 / 按会话 / 按模型三个维度。
 * 2026-09-19 起优先走"按日快照"路径（历史日聚合固化在 data/usage-daily.json，
 * 只实时算今天），快照层出错时自动回落到旧的实时聚合 —— 用量页绝不能白屏。
 *
 * 2026-09-22 加三道闸（长期使用后"用量页卡死在加载"的治理之三）：
 *   1. 结果缓存 3 小时（用户要求）：见下方 USAGE_STATS_CACHE_TTL_MS 注释。
 *   2. 微缓存 5 秒：前端轮询 + SSE 事件都会打到这里，5 秒内的重复请求直接复用。
 *      （已被第 1 条覆盖，保留是因为它先于结果缓存判定、命中更快，也兜住
 *        "force 重算后立刻又被轮询打一次"的情况。）
 *   3. 防重入：同一 range 的统计在跑时，后续请求搭同一趟车（共享同一 Promise），
 *      避免多个统计叠加着阻塞事件循环。 */
const USAGE_STATS_MICRO_TTL_MS = 5000;

/**
 * 结果缓存 TTL（2026-09-22，用户要求）。
 *
 * 用户原话："用量界面点今日的时候会加载非常久 …… 我认为可以改成 3 小时自动
 * 统计一次，外加用户手动刷新的时候统计。"
 *
 * 为什么值得缓存整个结果：统计本身不贵了（档案增量解析 + 快照），但**入口太多**
 * —— 15 秒轮询、SSE 事件、切页签、来回点时间范围按钮，每个入口都会把
 * 「读目录 → 增量解析 → 逐日聚合 → 逐行计价 → 读 10MB 快照」重走一遍。
 * 缓存整个结果，这些入口全部退化成一次 Map.get。
 *
 * 语义要点：
 *   - 命中时 `computedAt` **保持真正算出来的时刻**，前端据此显示"数据更新于 HH:MM"
 *     —— 新鲜度是可见的，不会假装数字是刚算的。
 *   - force=true（用户点了「刷新」）跳过缓存重新统计并覆盖缓存。
 *   - 想调新鲜度：改这一个常量即可（单位毫秒）。
 */
const USAGE_STATS_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const usageStatsCache = new Map();   // range -> { at, stats }
let usageStatsInflight = null;       // { key, promise }
let usageStatsMicro = { key: '', at: 0, stats: null };

/** 清空统计结果缓存（测试用；也留给将来"重置用量统计"这类操作）。 */
function resetUsageStatsCache() {
  usageStatsCache.clear();
  usageStatsMicro = { key: '', at: 0, stats: null };
}

async function buildUsageStats({ range = '7', force = false } = {}) {
  const key = String(range);
  // force 必须**同时**绕过两层缓存。踩过的坑：微缓存判定写在前面却没看 force，
  // 于是"点刷新"在两次请求间隔 <5 秒时直接吃微缓存 —— 结果是刷新按钮按下去
  // 数字纹丝不动（实测 computedAt 完全不变），比慢更让人困惑。
  if (!force) {
    // ① 5 秒微缓存（先判，命中最快：轮询 + SSE 事件风暴不再叠加统计）
    if (usageStatsMicro.stats && usageStatsMicro.key === key
        && Date.now() - usageStatsMicro.at < USAGE_STATS_MICRO_TTL_MS) {
      return usageStatsMicro.stats;
    }
    // ② 3 小时结果缓存
    const cached = usageStatsCache.get(key);
    if (cached && Date.now() - cached.at < USAGE_STATS_CACHE_TTL_MS) {
      usageStatsMicro = { key, at: Date.now(), stats: cached.stats };
      return cached.stats;
    }
  }
  // ③ 防重入：同 range 正在算就搭同一趟车
  if (usageStatsInflight && usageStatsInflight.key === key) {
    return usageStatsInflight.promise;
  }
  const promise = (async () => {
    let stats = null;
    try {
      const r = await buildUsageStatsWithSnapshots({ range });
      if (r.stats && r.stats.totals) stats = r.stats;
    } catch (error) {
      console.warn('[usage] 快照统计路径失败，回落实时聚合：', error?.message ?? error);
    }
    if (!stats) {
      const { rows, win, searchCount, toolCounts } = await collectUsageRows({ range });
      const totals = costOfRows(rows);
      // 单日/24小时场景下"按天"没有意义（只有一行），由前端决定是否隐藏
      // 按天分桶需要 dayKey 字段
      for (const r of rows) r.dayKey = dayKeyOf(r.at);
      const byDay = win.mode === 'days'
        ? groupBy(rows, 'dayKey').map((x) => ({ day: x.key, ...x })).sort((a, b) => a.day.localeCompare(b.day))
        : [];
      const chats = groupBy(rows, 'chatKey', 0);
      // 不截断：截断会让"各行成本之和 ≠ 总成本"，用户核对时会困惑。
      // 行数多时由前端滚动容器处理。
      const models = groupBy(rows, 'modelKey', 0).map((m) => {
        const { vendor, model } = splitModelLabel(m.key);
        return { ...m, vendor, model };
      });
      stats = {
        range: String(range),
        rangeLabel: win.label,
        mode: win.mode,
        totals,
        // 次数类统计：只看数量，不参与成本计算
        searchCount: searchCount || 0,
        toolCounts: toolCounts || {},
        days: byDay,
        chats,
        models
      };
    }
    // 真正算出来的时刻：前端靠它显示"数据更新于 HH:MM"。缓存复用时不会被改写。
    stats.computedAt = Date.now();
    return stats;
  })();
  usageStatsInflight = { key, promise };
  try {
    const stats = await promise;
    usageStatsCache.set(key, { at: Date.now(), stats });
    usageStatsMicro = { key, at: Date.now(), stats };
    return stats;
  } finally {
    if (usageStatsInflight && usageStatsInflight.promise === promise) usageStatsInflight = null;
  }
}

/**
 * 下钻明细：在某个维度取某个值，再按另一个维度展开。
 *   dim/key 定位子集，by 决定展开方式
 * 例：dim=chat&key=group:123&by=model → 该群下各模型的成本
 */
async function buildUsageBreakdown({ range = '7', dim = '', key = '', by = '' } = {}) {
  const { rows, win } = await collectUsageRows({ range });
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  // dim/by 为 model 时按复合身份匹配（模型 + 供应商）
  const fieldOf = (d) => (d === 'day' ? 'dayKey' : d === 'model' ? 'modelKey' : 'chatKey');
  const subset = dim ? rows.filter((r) => String(r[fieldOf(dim)] ?? '') === key) : rows;
  // 同样不截断：保证明细各项之和 = 该子集总成本
  const groups = groupBy(subset, fieldOf(by) || 'chatKey', 0);
  const sum = costOfRows(subset);
  // 峰谷信息跟随子集（弹窗外部上方展示用）
  return {
    range: String(range),
    dim, key, by,
    totals: sum,
    showPeak: sum.hasPeakModel && (sum.peakCost > 0 || sum.offPeakCost > 0),
    rows: groups.map((g) => ({
      key: g.key,
      cost: g.cost,
      promptTokens: g.promptTokens,
      completionTokens: g.completionTokens,
      cachedTokens: g.cachedTokens,
      totalTokens: g.totalTokens,
      cacheHitRate: g.cacheHitRate,
      runs: g.runs,
      exactCalls: g.exactCalls
    }))
  };
}

// ── 测试钩子（仅测试 import；生产代码不得依赖）──────────────────────
export function __testUsageDaily() {
  return {
    buildUsageStatsWithSnapshots,
    buildUsageStats,
    buildUsageBreakdown,
    collectUsageRows,
    loadUsageDaily,
    saveUsageDaily,
    completedDayKeys,
    aggregateDayFromArchive,
    // 2026-09-22 新增（R68）：数据元年下限 / 快照裁剪 / 结果缓存 / 后台预热
    usageDataFloorMs,
    pruneUsageDaily,
    resetUsageStatsCache,
    warmUsageArchive,
    sessionsDirSignature,
    USAGE_STATS_CACHE_TTL_MS,
    USAGE_DAILY_FILE
  };
}
