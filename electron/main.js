// Electron 桌面壳：启动核心服务器（同一进程），打开会话式控制台窗口。
// 傻瓜式：托盘常驻、关窗不退出、可选开机自启。
import { app, BrowserWindow, Tray, Menu, nativeImage, session, shell, dialog, ipcMain } from 'electron';
// ⚠️⚠️ webUtils **绝不能走具名导入**：ESM 的具名导入在导出名不存在时是
// SyntaxError —— 整个 main.js 模块加载失败 → 主进程起不来 → 双击 exe 毫无反应
// （R41 就是这么把应用搞成"打不开"的，且开发版因为跑的是旧代码没暴露）。
// 改成 namespace 导入：缺失时是 undefined，绝不影响模块加载，下面再运行时兜底。
import * as electronApi from 'electron';
const webUtils = electronApi.webUtils ?? electronApi.default?.webUtils ?? null;
// R66：screen 同样走命名空间取 —— 理由与上面 webUtils 完全一样（具名导入缺失
// 即 SyntaxError，会把整个主进程模块带走）。它用于窗口位置回填时的屏幕可见性校验。
const screenApi = electronApi.screen ?? electronApi.default?.screen ?? null;
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataDirName, describeInstance, profileSuffix } from '../src/profile.js';
// 平台抽象层：本文件负责在启动最早期定下数据目录，跨平台规则收敛在 platform.js，
// 避免 Electron 壳与 src/config.js 各写一套、两边算出不同的目录。
import * as platform from '../src/platform.js';
// R66：窗口几何存档的解析与屏幕可见性校验（纯函数，见 test/window-state-test.mjs）
import {
  parseWindowState, resolveWindowBounds,
  WINDOW_DEFAULT_W, WINDOW_DEFAULT_H, WINDOW_MIN_W, WINDOW_MIN_H
} from './window-state.js';


// Windows 上部分显卡驱动会导致渲染进程黑屏；禁用硬件加速是最稳妥的修复
app.disableHardwareAcceleration();

// ⚠️ Chromium 子进程沙箱在本机会被系统安全策略拦杀（2026-09-21 20:00 前后开始，此前一直
// 正常）：沙箱化的 GPU 进程启动即 exit_code=1，重试 6 次后 Chromium 判定
// "GPU process isn't usable. Goodbye."（FATAL）→ 整个应用自杀；沙箱化的渲染进程同样
// 被杀（reason=killed exitCode=1），窗口定格在最后一帧 —— 表现为"卡在启动画面"，
// 残留"主进程活着但零子进程、零监听端口"的僵尸，用户每点一次 .bat 就多一个。
// 实测：--no-sandbox 下全部子进程正常、完整启动、接口正常（22:26/22:28 两次验证）。
// 安全权衡：本项目界面只从 127.0.0.1 本机服务加载、CSP 锁死自身脚本、GPU 走软件
// 渲染（disableHardwareAcceleration），不渲染不可信网页；关沙箱损失可控，而
// "起不来"是完全不可用，两害相权取其轻。
app.commandLine.appendSwitch('no-sandbox');

// R70：彻底不拉 GPU 进程，从源头掐断 R44 那条致命链。
//
// R44 记下的死法是：GPU 进程被本机安全策略杀掉 → Chromium 重试 6 次 →
// 判定 "GPU process isn't usable. Goodbye." → **整个进程自杀**（不是某个功能失效，
// 是应用凭空消失）。上面那句 `disableHardwareAcceleration()` 只把渲染换成软件实现，
// **GPU 进程照样会被创建**（走 SwiftShader），所以它挡不住这条链——这也是为什么
// 2026-09-22 加上 no-sandbox 之后，安装版 0.4.1 仍然在 22:17:17 启动、22:17:20 崩
// （0xC0000005，存活 3 秒）。
//
// `--disable-gpu` 直接不建 GPU 进程：没有 GPU 进程，就没有"GPU 进程被杀"这条
// 致命路径。代价是所有绘制走 CPU 光栅化 —— 本应用的窗口只是个控制台页面，
// 没有 canvas/WebGL 诉求，实测无差别。
// `--disable-software-rasterizer` 顺手关掉用不上的 SwiftShader 后端，少一个
// 会被误伤的子进程。
// 一键回退：万一哪台机器上这个开关造成了渲染异常（而不是它要修的那种崩溃），
// 设置环境变量 QQ_AGENT_ENABLE_GPU=1 即可恢复原来的行为，不必改代码重新打包。
if (String(process.env.QQ_AGENT_ENABLE_GPU ?? '').trim() !== '1') {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

// ── R70：崩溃证据链（为什么闪退必须在这里就要留下东西）──
// 在此之前，所有致命事件（未捕获异常 / 未处理 Promise / 渲染进程崩溃 / 无响应 /
// 退出清理）全部只走 console.error。打包版没有终端接管 stdout，**data/logs 里
// 一行都不会有** —— 2026-09-22 那次 3 秒闪退就是这样变成悬案的：日志停在普通
// INFO 上，最后只能靠事件查看器 + 安装目录 debug.log 反推。
//
// ⚠️ 必须**动态 import**：src/config.js 在模块求值的瞬间就把 DATA_DIR 固化了
//    （`process.env.QQ_AGENT_DATA_DIR || ...`），而那个 env 变量是本文件下面
//    resolveDataDir() 才写进去的。静态 import 会让它抢跑，日志落去默认目录，
//    于是"日志看着正常但永远找不到崩溃原因"。所以等 ready 之后再绑定。
let coreLogger = null;
let coreLoggerBound = false;
async function bindCoreLogger() {
  if (coreLoggerBound) return;
  coreLoggerBound = true;
  try {
    const mod = await import('../src/logger.js');
    coreLogger = mod?.logger ?? null;
  } catch (error) {
    console.error('[log] 绑定 logger 失败（继续退化到 console）:', error?.message ?? error);
  }
}
/** 关键事件：尽量落盘，两者都失败也不许拖累调用方。 */
function logCritical(module, text) {
  try { coreLogger?.error(module, text); } catch { /* 落盘失败忽略 */ }
  try { console.error(`[${module}] ${text}`); } catch { /* 连 console 都异常就算了 */ }
}

/** 关键生命周期事件（非致命，但事后必须查得出来：它到底是被关掉的还是凭空没的）。 */
function logKey(module, text) {
  try { coreLogger?.info(module, text); } catch { /* 忽略 */ }
  try { console.log(`[${module}] ${text}`); } catch { /* 忽略 */ }
}

/** 把任意 throw 值整理成可落盘的文本（Error 取 stack，其余尽量 JSON 化）。 */
function describeError(error) {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  try {
    const s = typeof error === 'object' && error !== null ? JSON.stringify(error) : String(error);
    return String(s || '(空异常)');
  } catch { return String(error); }
}

/**
 * R70：崩溃转储（crashpad）。
 * 2026-09-22 那次闪退的 Report ID 只有一个 50ebb260…，WER 存档目录是空的、应用日志
 * 里也没有任何痕迹，所以只能靠旁证推凶手。打开 crashpad 之后，原生崩溃会在
 * <userData>/Crashpad/dumps 留一份 minidump，下次就能直接看到调用栈死在哪一层。
 * uploadToServer=false + 空 submitURL：只落本地，不外传任何东西。
 */
function startCrashReporter() {
  try {
    const cr = electronApi.crashReporter ?? null;
    if (!cr?.start) return;
    cr.start({
      productName: 'QQ Agent',
      submitURL: '',
      uploadToServer: false,
      compress: false,
      globalExtra: { version: app.getVersion?.() ?? 'unknown' }
    });
    try { coreLogger?.info('crashpad', '崩溃转储已启用（本地留存，不上传）'); } catch { /* 忽略 */ }
  } catch (error) {
    console.error('[crashpad] 启用失败（不影响启动）:', error?.message ?? error);
  }
}

/**
 * R70：子进程监护。R44 那条致命链的第一现场就是「GPU 进程启动即被杀」——
 * 以前完全看不见，只能等整个进程自杀了再从事件查看器反推。现在每个非正常退出的
 * 子进程都留一行：GPU / Utility / Zygote 谁死、是被杀还是崩了、退出码多少，
 * 一眼就能看出是不是又被系统侧拦了。
 */
function watchChildProcesses() {
  let abnormal = 0;
  app.on('child-process-gone', (_e, details) => {
    const line = `type=${details?.type ?? '?'} reason=${details?.reason ?? '?'} exitCode=${details?.exitCode ?? '?'} pid=${details?.osProcessId ?? '?'}`;
    if (details?.reason && details.reason !== 'clean-exit') {
      abnormal += 1;
      logCritical('child', `[子进程异常退出 #${abnormal}] ${line}`);
    } else {
      try { coreLogger?.info('child', `[子进程退出] ${line}`); } catch { /* 忽略 */ }
    }
  });
}

// 主进程兜底：未捕获异常不应静默吞掉。
// headless 入口（src/server.js）exit(1) 的理由在那里不成立 —— 那个有外层
// 守护重启。Electron 没有外层守护，进程挂掉后用户只能看到"托盘图标消失"。
// 折衷：拉起一个可见的错误对话框把异常亮给用户（至少知道为什么挂了），
// 确认后再退出 —— "半死不活地挂着"（定时器丢失/连接悬空但窗口还在）
// 是最难排查的状态，宁可死得明明白白。
// R70：两条兜底都改走 logCritical（原先是 console.error，打包版不落盘）。
// 内容从 error.stack 取全文 —— 崩溃就有这一次机会留下证据，不要只给 message。
process.on('unhandledRejection', (error) => {
  logCritical('fatal', `[未处理 Promise] ${describeError(error)}`);
});
process.on('uncaughtException', (error) => {
  logCritical('fatal', `[未捕获异常] ${describeError(error)}`);
  try {
    // dialog 在 app ready 前也允许调用（Electron 文档保证）。
    dialog.showErrorBox(
      'QQ Agent 发生未捕获错误',
      '程序遇到无法恢复的错误，即将退出。\n\n' +
      String(error?.stack ?? error?.message ?? error) +
      '\n\n完整日志见 data/logs/ 下的当日日志文件。'
    );
  } catch { /* 弹窗失败不拦截退出 */ }
  app.exit(1);
});

// AppUserModelID：让 Windows 把窗口归到「QQ Agent」身份下（任务栏分组/图标/通知），
// 否则 dev 模式下会被当成裸 electron.exe，钉任务栏变成 electron 图标
app.setAppUserModelId('cn.kondius.qq-agent');

// ── 数据目录 ──
// Windows：固定在「应用根目录/data」（保持原设计，不往 %APPDATA% 塞）。
//   压缩包用户：data 本来就在压缩包目录里，直接用（项目内 data/）；
//   安装版用户：安装目录/exe 旁边的 data/。选压缩包目录当安装目录时
//   天然接管里面的 data/（config、记忆、聊天记录、telemetry id 全保留），零迁移零 bug。
//   NSIS 覆盖安装只替换它自己装的文件，运行时生成的 data/ 不在清单里 → 升级不丢数据。
//
// ── Linux 移植改造点 ────────────────────────────────────────────────
// 原实现无条件把数据放「exe 旁边的 data/」。在 Linux 上这是**坏的**：
//   · 安装到 /opt/qq-agent 后，安装目录对普通用户只读 → 启动即 EACCES；
//   · 若改用 sudo 运行，生成的 session/记忆/配置文件属主变成 root，
//     后续以普通用户运行又读不了，升级时更麻烦；
//   · 也违反目标里的「数据目录遵循 XDG 规范落到用户主目录」。
// 现改为：解析规则统一交给 src/platform.js（Windows 行为不变，
// Linux 落到 $XDG_DATA_HOME/qq-agent，缺省 ~/.local/share/qq-agent）。
function resolveDataDir() {
  if (process.env.QQ_AGENT_DATA_DIR) return process.env.QQ_AGENT_DATA_DIR;

  // 开发模式：项目内 data/（与原行为一致，方便本地调试）
  if (!app.isPackaged) {
    return path.resolve(fileURLToPath(import.meta.url), '..', '..', dataDirName());
  }

  // 打包运行：交给平台层决定
  const platformDir = platform.resolveDataDir({ profileSuffix });

  // ── 旧数据迁移 ──
  // 只处理 Windows 的「外置 %APPDATA% 时期」（2026-09-06 短命版本）遗留。
  // Linux 上没有这段历史，不做迁移，避免误搬用户其它目录里的同名文件夹。
  // 仅主实例接管；第二实例绝不能把主实例旧数据复制进 data-2。
  if (platform.isWindows && dataDirName() === 'data') {
    try {
      if (!fs.existsSync(platformDir)) {
        const legacy = path.join(app.getPath('userData'), 'data');
        if (fs.existsSync(legacy) && fs.readdirSync(legacy).length > 0) {
          fs.cpSync(legacy, platformDir, { recursive: true });
          console.log('[data] 已从 %APPDATA% 迁回数据目录:', legacy, '→', platformDir);
        }
      }
    } catch (error) {
      logCritical('data', `[旧数据迁移失败（不影响启动）] ${describeError(error)}`);
    }
  }

  return platformDir;
}
process.env.QQ_AGENT_DATA_DIR = resolveDataDir();

// 单实例锁：重复启动（双击 .bat）不产生第二个实例，而是唤出已有窗口。
// 没有锁的话第二个实例会双份连 SnowLuma，群消息会被双重回复。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // ⚠️ 不能静默退出（R45）：已有一个实例占着锁时，新实例原来的行为是 app.quit() 后
  //    一声不响地消失。用户看到的是"双击了没反应"，而眼前那个窗口可能是上一次
  //    卡死留下的定格画面 —— 于是反复双击、反复无反应。这里明确告知一句。
  app.whenReady().then(() => {
    dialog.showMessageBox({
      type: 'info',
      title: 'QQ Agent',
      message: 'QQ Agent 已经在运行了',
      detail: '已为你唤出正在运行的窗口。\n如果那个窗口一直停在启动画面，请从右下角托盘图标选择「退出」，再重新打开。',
      buttons: ['知道了']
    }).catch(() => {}).finally(() => app.quit());
  });
} else {
  // 第二实例启动时：唤出窗口，并顺手把"卡住的自己"救回来 —— 用户再点一次
  // 就是在告诉我们"界面没出来"，这时候重载页面正是他想要的结果。
  app.on('second-instance', async () => {
    showWindow();
    // 用户再点一次 = 在告诉我们"界面没出来"。先看清楚是"没起来"还是"起来后卡住了"，
    // 两种情况的救援手段不同（reload 只对前者有效）—— 见 healIfStuck 的注释。
    const probe = await probePage(mainWindow);
    if (probe.state === 'gone') return;                  // showWindow 已经新建过窗口了
    if (probe.state === 'ready') {
      console.log('[window] 用户再次启动：页面正常，仅唤出窗口');
      return;
    }
    await healIfStuck('用户再次启动', probe.state);
  });
}

/**
 * 页面活性探针（R69 重写）。
 *
 * 旧版只问「启动 loading 壳撤了没」（`appReady === true || !#loading-overlay`）——
 * 而这两者在启动成功后**永久为真**，于是看门狗对"跑了几小时之后界面冻住"完全无感。
 *
 * 新版返回四态：
 *   'ready' —— JS 有应答且启动已就绪（是否真活着还要再看心跳在不在动，见 startBootWatchdog）
 *   'boot'  —— JS 有应答，但仍停在 loading 壳上（启动没完成）
 *   'hung'  —— JS 在 4 秒内**没有应答** → 渲染主线程被占满 / 僵死
 *   'gone'  —— 窗口或页面已销毁
 *
 * 为什么"超时"就是僵死的可靠信号（R69 实测，Electron 33.4.11）：
 *   渲染主线程跑同步死循环期间，executeJavaScript **连续 4 次全部超时**
 *   （1.6s / 5.6s / 9.6s / 13.6s），循环一结束立刻恢复应答；而同一时间内
 *   `render-process-gone` 触发 0 次（进程活着，只是不干活）。
 *   → "问一句有没有回音"本身就是最直接的活性探针。
 *
 * 心跳 `__qaBeat` 是**辅助**信号（由 ui/app/00-core.js 每秒递增）：它能抓到
 * "JS 还能应答、但界面已经冻住"那类僵死。窗口隐藏时 Chromium 会节流定时器，
 * 所以主进程只在窗口可见时才拿它做判定（见 startBootWatchdog）。
 */
async function probePage(win) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return { state: 'gone', beat: -1 };
  let r;
  try {
    r = await Promise.race([
      win.webContents.executeJavaScript(
        'String(((typeof __qaBeat !== "undefined" && __qaBeat) || 0) + "|" + ((typeof appReady !== "undefined" && appReady === true) || !document.getElementById("loading-overlay")))'
      ),
      new Promise((res) => setTimeout(() => res('timeout'), 4000))
    ]);
  } catch {
    return { state: 'hung', beat: -1 };   // 执行本身抛错，与"不回话"同样处理
  }
  if (r === 'timeout') return { state: 'hung', beat: -1 };
  const [beatRaw, readyRaw] = String(r).split('|');
  return { state: readyRaw === 'true' ? 'ready' : 'boot', beat: Number(beatRaw) || 0 };
}

/**
 * R71：启动卡住时，把「启动画面自己想说的话」捞回主进程日志。
 *
 * 渲染进程的 bootLogs / #loading-status（setLoadingStatus 写的那几条，比如
 * "服务还没响应：xxx"）以前只存在于 DOM 里 —— 群友发来主进程日志时，
 * 恰恰看不到这句最关键的失败原因（2026-09-23 实测：主进程日志只有
 * 三条看门狗记录，页面那侧为什么没起来完全是黑盒）。
 * 看门狗重载前捞一次，日志就能自证卡在哪一步。
 */
async function harvestBootDiagnostics(reason) {
  try {
    const wc = mainWindow?.webContents;
    if (!wc || wc.isDestroyed()) return;
    // state === 'boot' 意味着渲染主线程能应答，但仍然加 3 秒超时兜底，
    // 免得取证本身把看门狗卡住（R69 的教训：任何探针都必须带超时）。
    const info = await Promise.race([
      wc.executeJavaScript(
        'JSON.stringify({status:(document.getElementById("loading-status")||{}).textContent||"",logs:(typeof bootLogs!=="undefined"?bootLogs.slice(-8):[]),overlay:!!document.getElementById("loading-overlay")})'
      ),
      new Promise((res) => setTimeout(() => res(null), 3000))
    ]);
    if (info) logCritical('renderer', `[启动画面自述 reason=${reason}] ${info}`);
    else logCritical('renderer', `[启动画面自述 reason=${reason}] 3 秒内渲染进程没有回话`);
  } catch (error) {
    logCritical('renderer', `[启动画面自述失败 reason=${reason}] ${describeError(error)}`);
  }
}

// 卡住自救。⚠️ 两类故障的救援手段**不能混用**：
//   boot —— 页面没起来，`reload()` 有效（R45 起一直这么干）。
//   hung —— 渲染主线程不回话。**`reload()` 对它完全无效**（R69 实测：9.67s 调用 reload，
//           20.65s 阻塞自己结束、20.69s 才真正生效 —— 导航请求排在阻塞的主线程后面，
//           只能干等），必须把窗口整个重建。
// 服务跑在主进程里、一直活着，所以重建窗口即可恢复，不需要动后端。
let bootMisses = 0;
let bootReloads = 0;
let hangMisses = 0;
let windowRebuilds = 0;
let bootWatchdog = null;
let lastBeat = -1;
let rebuilding = false;

/** 毁掉当前窗口再建一个。只在"页面彻底不回话"时走这条路（reload 已证明无效）。 */
async function rebuildWindow(reason) {
  if (rebuilding) return true;            // 上一次还没建完
  if (windowRebuilds >= 2) return false;  // 重建也救不回来，交给调用方收尾
  rebuilding = true;
  windowRebuilds += 1;
  logCritical('window', `[渲染进程无应答] reason=${reason}，重建窗口第 ${windowRebuilds} 次`);
  const port = core?.lastPort ?? 3210;
  const old = mainWindow;
  mainWindow = null;
  try {
    // ⚠️ 必须先摘掉 closed 监听再 destroy：closed 是异步触发的，否则它会在
    //    createWindow() 之后才到，把刚建好的新窗口置成 null —— 看门狗随后
    //    以为"没有窗口可管"而停手，重建等于白做。
    old?.removeAllListeners('closed');
    old?.destroy();
  } catch { /* 已经销毁过了 */ }
  try {
    createWindow(port);
  } catch (error) {
    logCritical('window', `[重建窗口失败] ${describeError(error)}`);
    rebuilding = false;
    return false;
  }
  rebuilding = false;
  return true;
}

// 返回值语义：true = "不用管了"（已恢复，或已采取措施）；false = "自愈预算用尽，该告诉用户了"。
// ⚠️ 曾经重载完也返回 false，结果看门狗第一次动手就把自己关掉并弹错误框 —— 页面还在重载中就被判死刑。
async function healIfStuck(reason, state) {
  if (state === 'boot') {
    if (bootReloads >= 2) return false;
    // R71：重载之前先把启动画面上的自述捞进日志（否则重载会把现场冲掉）
    await harvestBootDiagnostics(reason);
    bootReloads += 1;
    logCritical('window', `[看门狗：页面停在启动画面] reason=${reason}，重载第 ${bootReloads} 次`);
    try { mainWindow?.webContents.reload(); } catch { /* 窗口已销毁 */ }
    return true;
  }
  return await rebuildWindow(reason);
}

/** 自愈预算耗尽：停手并把情况说清楚（后端一直是好的，坏的只有界面这一层）。 */
function giveUpWatchdog(reason) {
  clearInterval(bootWatchdog);
  bootWatchdog = null;
  logCritical('window', `[看门狗放弃自愈] reason=${reason}`);
  try {
    dialog.showMessageBox({
      type: 'error',
      title: 'QQ Agent 界面没有响应',
      message: '界面已无响应（自动重载 / 重建窗口都试过，仍未恢复）',
      detail: '后端服务是正常运行的，坏的是界面这一层。\n请从右下角托盘选择「强制退出」后重开；若持续出现，把 data/logs/ 当天的日志发给开发者。',
      buttons: ['知道了']
    }).catch(() => {});
  } catch { /* 弹窗失败不拦退出 */ }
}

function startBootWatchdog() {
  // 每 5 秒自检一次。重建窗口时会再调一次，所以开头必须先把旧的清掉（幂等）。
  // ⚠️ 常驻不解除武装：曾经"一就绪就 clearInterval"，结果页面先正常启动、
  //    之后再卡死（例如用户中途重载/网络抖动）就再也没人管了。现在只要恢复就绪
  //    就把连续失败计数和重载预算一起清零 —— 看门狗全程在岗，但只在真出事时才动手。
  if (bootWatchdog) clearInterval(bootWatchdog);
  bootWatchdog = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(bootWatchdog); bootWatchdog = null; return; }
    const probe = await probePage(mainWindow);
    if (probe.state === 'gone') { clearInterval(bootWatchdog); bootWatchdog = null; return; }

    if (probe.state === 'ready') {
      // 心跳只在窗口**可见**时参与判定：窗口隐藏时 Chromium 会节流甚至暂停定时器，
      // 心跳停摆是正常的（缩到托盘就是这种状态），不能当僵死处理。
      const visible = mainWindow.isVisible() && !mainWindow.isMinimized();
      // beat <= 0 表示页面里还没有心跳（旧版页面 / 刚导航完），此时不拿它下判断。
      if (!visible || probe.beat <= 0 || probe.beat !== lastBeat) {
        lastBeat = probe.beat;
        bootMisses = 0; hangMisses = 0; bootReloads = 0; windowRebuilds = 0;
        return;
      }
      // 可见 + JS 有应答 + 心跳不动 → 界面冻住而 JS 还活着（渲染/合成层面的僵死）
      hangMisses += 1;
      if (hangMisses < 3) return;
      hangMisses = 0;
      if (!(await healIfStuck('看门狗：心跳停摆', 'hung'))) giveUpWatchdog('心跳停摆');
      return;
    }

    if (probe.state === 'hung') {
      // 连续 2 次无应答才动手（每轮自带 4 秒探测超时 ≈ 10 秒），避免一次偶发抖动就重建窗口
      hangMisses += 1;
      if (hangMisses < 2) return;
      hangMisses = 0;
      if (!(await healIfStuck('看门狗：页面无应答', 'hung'))) giveUpWatchdog('页面无应答');
      return;
    }

    // 'boot'：启动未就绪 —— 沿用原来的重载策略（reload 对"页面没起来"是有效的）
    bootMisses += 1;
    if (bootMisses < 5) return;
    bootMisses = 0;
    if (!(await healIfStuck('看门狗：启动未就绪', 'boot'))) giveUpWatchdog('启动未就绪');
  }, 5000);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON_PATH = path.resolve(__dirname, '..', 'assets', 'icon.png');
// 无边框窗口的窗口控制桥（preload.cjs 而不是 .js —— 见该文件顶部说明）
const PRELOAD_PATH = path.resolve(__dirname, 'preload.cjs');

let mainWindow = null;
let core = null;
let tray = null;
let quitting = false;

function applyAutoStart() {
  if (!core) return;
  const cfg = core.getConfig();
  app.setLoginItemSettings({ openAtLogin: !!cfg.server?.autoStart });
}

function showWindow() {
  if (mainWindow) {
    mainWindow.show();
    // 缩托盘时曾把窗口从任务栏/切换器注销（见 close 里的 setSkipTaskbar(true)），
    // 这里要注册回来 —— show 之后立刻恢复，任务栏图标与 Alt+Tab 条目才不会缺席。
    try { mainWindow.setSkipTaskbar(false); } catch { /* 老版本无此 API 时忽略 */ }
    mainWindow.focus();
  } else {
    createWindow(core?.lastPort ?? 3210);
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip(describeInstance());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主界面', click: () => { console.log('[tray] 点击：显示主界面'); showWindow(); } },
    { label: '暂停 / 恢复', click: () => core?.orchestrator.setPaused(!core.orchestrator.paused) },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!core.getConfig().server?.autoStart,
      click: (item) => {
        core.updateConfig({ server: { autoStart: item.checked } });
        applyAutoStart();
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => { console.log('[tray] 点击：退出'); quitting = true; app.quit(); } },
    // R69：正常退出要走 before-quit → core.stop() 清理链。万一那条链挂住（例如
    // 某个 await 不返回），用户就彻底没有出路了 —— 给一条跳过清理、立刻结束进程的兜底。
    { label: '强制退出（跳过清理）', click: () => { logKey('tray', '点击：强制退出（app.exit）'); app.exit(0); } }
  ]));
  tray.on('double-click', () => showWindow());
}

// ── 无边框窗口的窗口控制（frame: false）────────────────────────────────────
// 窗口没有系统标题栏，最小化/最大化/关闭只能由页面自绘按钮发起，经 preload 桥到这里。
//
// 为什么用 fromWebContents 反查窗口，而不是记住 mainWindow：
//   1) 事件来源即窗口，天然不会操作到别的窗口，也不需要渲染进程传任何参数；
//   2) mainWindow 在 closed 之后是 null，而事件可能仍在队列里 —— 反查不会误用悬空引用。
// 所有 handler 都做了空值兜底：窗口已销毁时静默忽略，不抛异常。
const windowOf = (event) => BrowserWindow.fromWebContents(event.sender);

ipcMain.on('win:minimize', (event) => windowOf(event)?.minimize());

ipcMain.on('win:toggle-maximize', (event) => {
  const win = windowOf(event);
  if (!win) return;
  // 状态由主进程判断（isMaximized 是权威口径），避免渲染进程与真实状态不同步。
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

// 关闭语义与系统 ✕ 完全一致：走 win.close() 而不是 app.quit()，
// 于是 mainWindow.on('close') 里"缩到托盘"的逻辑照旧生效（关窗不退出是常驻机器人的预期）。
ipcMain.on('win:close', (event) => {
  // R69：自绘 ✕ 是唯一"要经过渲染进程"的关闭路径 —— 渲染进程一旦僵死，
  // 这条就是最先失灵的（Alt+F4 / 托盘退出走主进程，实测仍然有效）。
  // 所以这一笔日志是区分"渲染僵死"与"缩到托盘"的关键：有这行 = 点击已送达主进程。
  const win = windowOf(event);
  console.log(`[close] 收到渲染进程的 win:close（窗口存在=${!!win}）`);
  win?.close();
});

ipcMain.handle('win:is-maximized', (event) => Boolean(windowOf(event)?.isMaximized()));

// ── 外观个性化（R40）────────────────────────────────────────────────────────
// 只有"渲染进程做不到"的三件事才过桥：整窗不透明度、选背景图（原生文件对话框）、
// 清背景图。颜色/底色/底色透明度那些全是 CSS 变量，留在渲染进程里改，不开桥。
//
// 背景图为什么必须复制进 data/ui/：
//   页面跑在 http://127.0.0.1，file:// 图片会被 Chromium 以"跨源本地文件"拦下，
//   CSP 也不放行 file:。复制进来后由 GET /api/ui-bg 同源吐出（见 src/routes.js）。
const UI_BG_DIR = () => path.join(process.env.QQ_AGENT_DATA_DIR || '.', 'ui');

ipcMain.handle('win:set-opacity', (event, value) => {
  const win = windowOf(event);
  if (!win) return false;
  const v = Number(value);
  // 夹到 0.3~1：再低窗口基本看不见（用户会以为程序崩了），高过 1 无意义。
  win.setOpacity(Math.min(1, Math.max(0.3, Number.isFinite(v) ? v : 1)));
  return true;
});

ipcMain.handle('ui:pick-bg-image', async (event) => {
  const win = windowOf(event);
  const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
    title: '选择界面背景图',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
  });
  if (canceled || !filePaths?.length) return { ok: false, canceled: true };
  const src = filePaths[0];
  const ext = (path.extname(src) || '').toLowerCase().slice(1);
  if (!['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) {
    return { ok: false, error: `不支持的图片格式：${ext || '未知'}` };
  }
  const destDir = UI_BG_DIR();
  fs.mkdirSync(destDir, { recursive: true });
  const name = `bg-${Date.now()}.${ext}`;
  fs.copyFileSync(src, path.join(destDir, name));
  // 顺手清掉上一张，避免 data/ui/ 里堆一堆旧背景图
  try {
    for (const f of fs.readdirSync(destDir)) {
      if (f.startsWith('bg-') && f !== name) fs.rmSync(path.join(destDir, f), { force: true });
    }
  } catch { /* 清理失败不影响使用 */ }
  return { ok: true, name };
});

// ── 本地导入技能/插件（R41）────────────────────────────────────────────────
// 两件渲染进程做不到的事：① 弹原生对话框选文件/文件夹；② 把拖进来的 File 反查成
// 磁盘上的真实路径（File.path 自 Electron 32 起废弃，改用 webUtils.getPathForFile）。
//
// 拿到路径后**不由主进程复制** —— 转交给后端 POST /api/skills/import 统一处理，
// 这样"拖进窗口"和"点按钮选文件"走的是同一条校验/落地链路，不会有两套安全规则。
ipcMain.handle('dialog:pick-modules', async (event) => {
  const win = windowOf(event);
  const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
    title: '选择技能/插件（zip 包或文件夹）',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: '技能/插件包', extensions: ['zip'] }, { name: '所有文件', extensions: ['*'] }]
  });
  if (canceled || !filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, paths: filePaths };
});

// 拖放反查路径：渲染进程只有 File 对象，拿不到 path（安全沙箱 + File.path 已废弃）。
// webUtils.getPathForFile 是官方替代，只返回路径、不给任何读写能力。
// 老版本 Electron 没有 webUtils 时回退到废弃的 File.path —— 能用总比整个功能没有强。
ipcMain.handle('file:path-for', (event, file) => {
  try {
    if (webUtils?.getPathForFile) return { ok: true, path: webUtils.getPathForFile(file) };
    const legacy = file?.path;
    if (legacy) return { ok: true, path: legacy, legacy: true };
    return { ok: false, reason: '当前 Electron 版本不支持 webUtils，且 File.path 不可用' };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('ui:clear-bg-image', () => {
  try {
    const destDir = UI_BG_DIR();
    for (const f of fs.readdirSync(destDir)) {
      if (f.startsWith('bg-')) fs.rmSync(path.join(destDir, f), { force: true });
    }
  } catch { /* 目录不存在 = 本来就没有背景图 */ }
  return { ok: true };
});

// ── R66：窗口位置/尺寸持久化 ────────────────────────────────────────────────
// 用户反馈"UI 移动后退出重进位置不能正确保存"。窗口是 frame:false + 顶栏
// `-webkit-app-region: drag`，本来就能像普通窗口一样拖到屏幕任意位置 —— 但主进程
// 过去只写 `new BrowserWindow({ width: 1360, height: 860 })`，既没有 getBounds
// 记录、也没有 x/y 回填，于是**位置每次都从零开始**：怎么拖都白拖。
//
// 存档放 data/window-state.json（与 config.json 同一个数据目录，用户看得见、可删）：
//   { x, y, width, height, maximized }
// 解析 + 屏幕可见性校验全在 ./window-state.js（纯函数，test/window-state-test.mjs
// 直接跑）—— 这里只负责读文件、问屏幕、写文件。
// ⚠️ 校验不可省：换显示器 / 拔副屏后旧坐标可能指向不存在的区域，窗口会开到
//    看不见的地方，用户会以为程序打不开。不合法就回退默认尺寸 + 系统居中。
const WINDOW_STATE_FILE = () => path.join(process.env.QQ_AGENT_DATA_DIR || '.', 'window-state.json');

function readWindowState() {
  let text;
  try { text = fs.readFileSync(WINDOW_STATE_FILE(), 'utf8'); } catch { return null; }   // 没存过
  const parsed = parseWindowState(text);
  if (!parsed) return null;
  let displays = [];
  try { displays = screenApi?.getAllDisplays?.() ?? []; } catch { displays = []; }
  return resolveWindowBounds(parsed, displays, { minW: WINDOW_MIN_W, minH: WINDOW_MIN_H });
}

/** 把当前窗口几何写入 window-state.json（最大化时存"还原态"尺寸）。
 *  @returns {{x:number,y:number,width:number,height:number,maximized:boolean}|null}
 *           实际写盘的内容；拿不到窗口时返回 null（调用方据此如实报"没存上"）。 */
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    // getNormalBounds() 给的是"还原后"的尺寸：从最大化退出再启动时，能先把窗口
    // 摆回原来的大小再重新最大化，而不会把默认 1360×860 当成真实尺寸。
    let b;
    try { b = mainWindow.getNormalBounds(); } catch { b = mainWindow.getBounds(); }
    const out = {
      x: b.x, y: b.y, width: b.width, height: b.height,
      maximized: mainWindow.isMaximized()
    };
    fs.mkdirSync(path.dirname(WINDOW_STATE_FILE()), { recursive: true });
    fs.writeFileSync(WINDOW_STATE_FILE(), JSON.stringify(out), 'utf8');
    return out;
  } catch (error) {
    logCritical('window', `[保存窗口位置失败] ${describeError(error)}`);
    return null;
  }
}

// moved / resize 是逐帧级的频率：防抖 400ms，别每帧写一次盘。
let winStateTimer = null;
function scheduleSaveWindowState() {
  if (winStateTimer) clearTimeout(winStateTimer);
  winStateTimer = setTimeout(() => { winStateTimer = null; saveWindowState(); }, 400);
}
/** 缩托盘/退出前把还没落盘的几何当场写掉（防抖窗口内退出不至于丢） */
function flushWindowState() {
  if (winStateTimer) { clearTimeout(winStateTimer); winStateTimer = null; }
  return saveWindowState();
}

// R67：设置页「保存当前排布」把窗口几何也一并落盘 —— 与 moved/resize 的防抖
// 写盘共用同一条路径，只是这里**不等防抖**、当场写，并把结果回给页面显示。
// 无参数（与 preload 既有的安全边界一致：渲染进程指不了任何窗口）。
ipcMain.handle('win:save-geometry', () => {
  const saved = flushWindowState();
  if (!saved) return { ok: false };
  return { ok: true, ...saved };
});


function createWindow(port) {
  // R66：位置/尺寸回填。有存档就用存档（含 x/y），首启没有则不传 x/y ——
  // 交给系统居中，与改动前一致。
  const winOpts = { width: WINDOW_DEFAULT_W, height: WINDOW_DEFAULT_H };
  const savedWin = readWindowState();
  if (savedWin) Object.assign(winOpts, {
    x: savedWin.x, y: savedWin.y, width: savedWin.width, height: savedWin.height
  });
  mainWindow = new BrowserWindow({
    ...winOpts,
    minWidth: WINDOW_MIN_W,
    minHeight: WINDOW_MIN_H,
    title: describeInstance(),
    // ⚠️⚠️ 必须保持不透明（R46，2026-09-21 深夜）：本机从当晚 ~20:00 起，透明（分层）窗口
    //    的呈现链路坏了 —— 窗口只显示第一帧，之后永不更新；页面内部一切正常
    //    （DOM/JS/CDP 抓图都好，主进程原生弹窗也正常），就是屏幕上永远定格。
    //    用户看到的就是"永远卡在启动画面、点什么都没反应"。实测数据：
    //      transparent: true   → 8/10 轮屏幕冻结（GPU 开关、禁 DComp、禁遮挡检测全都无效）
    //      transparent: false  → 9/9 轮全部正常
    //    圆角改由 Win11 DWM 提供（下面 roundedCorners: true，Electron 33 实测支持
    //    Windows）：真圆角、弧外透出桌面、无需透明窗口。页面自绘的 14px 圆角壳已归零
    //    （style.css --win-radius: 0px）—— 两层圆角叠加会在角落露出 --frame-bg 深色弧片
    //    （用户反馈的"黑色糊在角上"就是它）。
    //    R44 同晚还发现本机安全策略会拦杀沙箱化的 Chromium 子进程（见顶部 no-sandbox），
    //    两件事都指向"系统侧 20:00 前后发生了变化"，应用侧只能自保。
    transparent: false,
    hasShadow: false,
    // 只在页面加载前的一瞬间可见；页面加载后画布被 --frame-bg 接管（跟随主题）。
    backgroundColor: '#141821',
    // Win11 DWM 原生圆角（真圆角）。不支持的平台/系统上窗口为直角矩形，无害回退。
    roundedCorners: true,
    autoHideMenuBar: true,
    icon: ICON_PATH,
    show: false,
    // 无边框：去掉系统标题栏，把标题栏并入页面顶部的导航条（与 PCL 启动器一致）。
    // 保留 thickFrame 默认值（true）—— 这样还能有系统 hit-test 边框与 Aero Snap。
    frame: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 仅暴露窗口控制（最小化/最大化/关闭/查询状态），见 electron/preload.cjs
      preload: PRELOAD_PATH
    }
  });
  Menu.setApplicationMenu(null);
  // 窗口打开先显示 loading 壳，等页面真正加载完成再亮相，避免白屏和用户反复双击
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // 任务栏图标兜底（2026-09-20）：部分 Windows 上无边框透明窗口的任务栏图标
    // 不吃 BrowserWindow 的 icon 选项（表现为空白页图标）。show 之后显式
    // setIcon 一次，两条路都喂到。
    try { mainWindow?.setIcon(ICON_PATH); } catch { /* 图标缺失时忽略 */ }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logCritical('window', `[页面加载失败] code=${code} desc=${desc} url=${url}`);
    setTimeout(() => mainWindow?.loadURL(`http://127.0.0.1:${port}/`).catch(() => {}), 2000);
  });
  // 渲染进程崩溃自动重载：renderer 一死窗口就变成"定格的最后一帧"——
  // 用户看到的是应用卡死（R44：卡在启动画面就是这么来的），且没有任何提示。
  // 崩溃后 1.5s 重新 loadURL（服务在主进程里、一直活着，重载即可恢复）。
  // 连崩 5 次就放弃重载，避免真有代码级崩溃时陷入死循环。
  let rendererCrashCount = 0;
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    // R70：改 logCritical（原先 console.error 不落盘，崩了等于没发生）。
    logCritical('window', `[渲染进程崩溃] ${JSON.stringify(details)}`);
    if (++rendererCrashCount <= 5) {
      setTimeout(() => {
        try { mainWindow?.webContents.loadURL(`http://127.0.0.1:${port}/`); } catch { /* 窗口已销毁 */ }
      }, 1500);
    }
  });
  // R69：Electron 自带的"无响应"事件。它只在**窗口可见且有持续输入事件**时才会触发，
  // 而且要等约 15 秒 —— 所以它不是一个可靠的探活机制（看门狗的 probePage 才是），
  // 但它是"用户此刻正在点、正在着急"的最强信号，收到了就立刻复核一次，不等下一轮 5 秒轮询。
  mainWindow.webContents.on('unresponsive', () => {
    logCritical('window', '[渲染进程无响应] unresponsive：主线程约 15s 未处理输入');
    probePage(mainWindow).then(async (probe) => {
      logCritical('window', `[unresponsive 复核结果] ${probe.state}`);
      if (probe.state === 'hung' || probe.state === 'boot') await healIfStuck('unresponsive 事件', probe.state);
    }).catch((error) => logCritical('window', `[unresponsive 复核失败] ${describeError(error)}`));
  });
  mainWindow.webContents.on('responsive', () => {
    console.log('[window] 渲染进程恢复响应');
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // R71：渲染进程的报错（level 3 = error）直接落盘。此前只 console.log，
    // 打包版不落盘 → 群友发来的日志里永远看不到"页面这一侧为什么没起来"。
    // （2026-09-23 群友卡启动画面案例：主进程日志三行看门狗，页面侧零证据。）
    if (level >= 3) logCritical('renderer', `[渲染进程报错] ${message} (${sourceId}:${line})`);
    else if (level >= 2) console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  // R71：preload 挂掉时 window.qa 桥整个缺失，页面会永远停在启动画面，
  // 而主进程这侧唯一的痕迹就是看门狗报"启动未就绪" —— 必须把 preload 的报错接住。
  mainWindow.webContents.on('preload-error', (_e, path, error) => {
    logCritical('renderer', `[preload 失败] ${path} :: ${describeError(error)}`);
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`).catch((error) => logCritical('window', `[loadURL 失败] ${describeError(error)}`));
  // 启动看门狗（R45，R69 重写探针）：R44 那次"卡在启动画面"的本质是 —— 后端一直在跑、
  // 窗口也活着，只有页面永远停在 loading 壳上，用户没有任何反馈也没有任何出路。
  // 现在主进程每 5 秒问一句"你还活着吗"（probePage），据此分别采取重载 / 重建窗口。
  startBootWatchdog();
  // 外部链接（金句墙/意见墙/上传成功提示里的网址等）一律交给系统默认浏览器，不在应用内弹新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 主窗口只应停留在本机控制台。没有这道拦截时，页面里一个普通 <a href> 或
  // location.href=... 就能把主窗口导航到外部站点（脱离 127.0.0.1 源、
  // 控制台也不再指向本机）。外链改走系统浏览器。
  const isLocalConsole = (u) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(String(u || ''));
  const guardNavigation = (event, url) => {
    if (isLocalConsole(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(String(url || ''))) shell.openExternal(url);
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);
  // 关窗默认缩到托盘（真正退出走托盘菜单），符合"常驻机器人"的使用习惯
  // R69：这条链上原本一行日志都没有 —— "点了 ✕ 到底走了哪个分支"事后完全无从查证，
  // 偶发无响应也因此永远定位不到。现在每一步都记一笔。
  mainWindow.on('close', (event) => {
    const toTray = !quitting && core?.getConfig().server?.closeToTray !== false;
    console.log(`[close] 收到 close 事件：quitting=${quitting} closeToTray=${core?.getConfig().server?.closeToTray} → ${toTray ? '缩到托盘（阻止关闭）' : '真正关闭'}`);
    flushWindowState();              // R66：先把几何落盘，再决定是缩托盘还是真退出
    if (toTray) {
      event.preventDefault();
      // ⚠️ 缩托盘前先把窗口从任务栏/切换器注销（setSkipTaskbar(true)）。
      //    群友反馈的"切屏越切越多、Alt+Tab 里堆出一排 QQ Agent"就是这么来的：
      //    窗口处于"已隐藏但仍注册在切换器"的状态时，Win11 的 DWM 在全屏切换/
      //    桌面切换时有概率把旧条目复制一份成幽灵条目 ——
      //    窗口本身只有一个（全项目只 new 过一次 BrowserWindow，进程枚举可证）。
      //    hide 前注销、show 时（showWindow）再注册回来，让 Explorer 干净地销毁旧条目。
      //    ⚠️ 这段注释曾写成"因为是透明分层窗口"，但 R46 起 transparent 已改成 false；
      //    而幽灵条目与窗口是否透明无关（只与"隐藏但仍注册"有关），所以代码保留。
      try { mainWindow.setSkipTaskbar(true); } catch { /* 老版本无此 API 时忽略 */ }
      mainWindow.hide();
      console.log('[close] 已隐藏到托盘（进程继续运行）');
    }
  });
  mainWindow.on('closed', () => {
    console.log('[close] 窗口已销毁（closed）');
    if (!rebuilding) mainWindow = null;   // R69：重建窗口期间由 rebuildWindow 自己接管
  });
  // 最大化状态回推：渲染进程据此把右上角按钮的图标切成"还原"。
  // 不只我们点的按钮会改状态 —— Win+↑、双击拖拽区、Aero Snap 拖到屏幕边缘都会，
  // 所以必须以主进程事件为准，而不是在页面里自己翻转一个布尔值。
  const pushMaximized = (value) => mainWindow?.webContents.send('win:maximized-changed', value);
  mainWindow.on('maximize', () => pushMaximized(true));
  mainWindow.on('unmaximize', () => pushMaximized(false));
  // R66：窗口几何/最大化状态变化时记一笔（防抖），供下次启动回填。
  mainWindow.on('moved', scheduleSaveWindowState);
  mainWindow.on('resize', scheduleSaveWindowState);
  mainWindow.on('maximize', scheduleSaveWindowState);
  mainWindow.on('unmaximize', scheduleSaveWindowState);
  // 上次退出时是最大化 → 现在也还原成最大化（先按存档尺寸建好再最大化，
  // 这样"还原"按钮能回到存档的那个大小，而不是默认 1360×860）。
  if (savedWin && savedWin.maximized) {
    try { mainWindow.maximize(); } catch { /* 个别平台/时机不支持时忽略 */ }
  }
}

app.whenReady().then(async () => {
  try {
    // R70：崩溃证据链越早挂上越好 —— logger 要等 ready（DATA_DIR 此时才定型），
    // crashpad 和子进程监护同理（GUI 子系统就绪后 crashpad handler 才拉得起来）。
    await bindCoreLogger();
    startCrashReporter();
    watchChildProcesses();
    // 应用只访问本机回环地址：强制直连，防止系统代理（Clash/加速器等）劫持 127.0.0.1 导致白/黑屏
    await session.defaultSession.setProxy({ mode: 'direct' });
    console.log('[window] 代理模式：direct（绕过系统代理）');
    const { createApp } = await import('../src/app.js');
    core = createApp({ log: (...args) => console.log(...args) });
    // 先启动服务拿到真实端口，再开窗口。
    // 原先是 createWindow(core.lastPort ?? 3210) 在前、core.start() 在后 ——
    // 此时 lastPort 尚未赋值，窗口恒按 3210 加载；若端口被占用顺延到 3211+，
    // 首屏必然加载失败，只能靠 did-fail-load 2 秒重试兜底。
    const port = await core.start();
    core.lastPort = port;
    await createWindow(port);
    applyAutoStart();
    createTray();
  } catch (error) {
    logCritical('electron', `[启动失败] ${describeError(error)}`);
    app.quit();
  }
});

// 退出清理：core.stop() 是 async（要 abortAll / 关 SSE / 关 server / 释放单实例锁），
// 而 before-quit 是同步事件 —— 直接调它会让进程在 await 让出后就被销毁，
// 清理链跑一半：锁文件可能残留、会话最后一次进度可能丢、SnowLuma 子进程可能变孤儿。
// 正确做法：拦下这次退出，等 stop() 真正跑完再 app.quit()。
let shuttingDown = false;
app.on('before-quit', (event) => {
  quitting = true;
  flushWindowState();                    // R66：真退出前把窗口几何落盘
  // R69：这里原本一行日志都没有，退出到底卡在哪一步全靠猜。现在进出都记，
  // 并给 core.stop() 计时 —— 万一真的挂住，日志里能直接看出是挂在 stop 上。
  if (shuttingDown || !core) {
    logKey('quit', `before-quit：放行（shuttingDown=${shuttingDown} core=${!!core}）`);
    return;                               // 第二次进入（自己触发的 quit）直接放行
  }
  event.preventDefault();
  shuttingDown = true;
  const t0 = Date.now();
  logKey('quit', 'before-quit：拦下退出，开始 core.stop()');
  Promise.resolve()
    .then(() => core.stop())
    .then(() => logKey('quit', `core.stop() 完成（${Date.now() - t0}ms），继续 quit`))
    .catch((error) => logCritical('quit', `[退出清理失败] ${describeError(error)}`))
    .finally(() => app.quit());
});

// R69：显式注册而不是交给 Electron 默认行为 —— 默认行为一样是退出（非 macOS），
// 但那样就没有任何记录。这里保持同样的行为，只补一行日志。
// R70：这条日志现在是判断"闪退 vs 正常关闭"的分水岭 —— 它出现在日志里，
// 说明进程走完了完整的退出流程；没出现，说明是被杀或原生崩溃。
// R72：rebuildWindow() 会先把旧窗口 destroy —— 窗口数瞬间归零，本事件照样触发，
// 紧接着 app.quit() 把"重建自救"整个带走：日志实证（2026-09-23 群友 0.4.2，
// 11:42:06 看门狗判 hung → 重建 → 本事件 → exitCode=0）。两种时机都要防：
//   ① 同步触发（destroy 时窗口数归零立刻发）：此时 rebuilding=true、新窗口还没建；
//   ② 异步触发（重建完成之后才派发）：此时 rebuilding=false 但 mainWindow 已是新窗口。
// 只要命中其一就说明"关窗"是重建动作的副作用，不是用户真要退出。
app.on('window-all-closed', () => {
  if (rebuilding || (mainWindow && !mainWindow.isDestroyed())) {
    logKey('quit', '所有窗口已关闭 → 正在重建窗口，跳过退出');
    return;
  }
  logKey('quit', '所有窗口已关闭 → 退出（非 macOS 的默认行为）');
  if (process.platform !== 'darwin') app.quit();
});

// R70：进程退出前最后一笔。放盘是同步 appendFileSync，所以这条一定写得进去 ——
// 日志里有 `[quit] 进程退出` ⇒ 完整走完了退出流程（用户关的/托盘退的）；
// 没有这一行 ⇒ 进程是被杀掉的或原生崩溃的，直接去看事件查看器和 Crashpad。
app.on('quit', (_event, exitCode) => {
  logKey('quit', `进程退出 exitCode=${Number(exitCode) || 0}`);
});
