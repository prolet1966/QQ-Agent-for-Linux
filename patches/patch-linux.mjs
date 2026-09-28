/**
 * patch-linux.mjs — 把 QQ-Agent V0.4.4 的 app 树适配到 Linux。
 *
 * 设计纪律（继承本项目历史教训）：
 *   1. 每个补丁都是「锚点精确匹配 + 幂等」：已打过就跳过，锚点找不到就 **报错退出**，
 *      绝不静默跳过（历史上 skipIf 撞车导致静默跳过，node --check 也看不出来）。
 *   2. 用 () => 替换串，避免 String.replace 的 `$$` 陷阱。
 *   3. 每打完一个文件立刻 node --check 语法校验。
 *   4. 输出逐条报告，最终给出 通过/失败 计数。
 *
 * 用法：node patch-linux.mjs <appDir> [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const appDir = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!appDir) {
  console.error('用法: node patch-linux.mjs <appDir> [--dry-run]');
  process.exit(2);
}

const report = [];
let failed = 0;

/** 从 fn 体内自动推导「函数名|参数表」签名，避免手抄出错 */
function read(file) {
  return fs.readFileSync(path.join(appDir, file), 'utf8');
}
function write(file, text) {
  fs.writeFileSync(path.join(appDir, file), text, 'utf8');
}

/**
 * 补丁：把 oldStr 换成 newStr。
 *
 * ⚠️ 行尾陷阱（本项目实测踩到）：Windows 侧的 app 树文件**全部是 CRLF**，
 *    而补丁锚点写在源码里天然是 LF —— 直接比对必然 0 命中。
 *    这里的做法：匹配前把「文件内容」和「锚点/替换串」都归一化成 LF，
 *    替换完成后再按文件原本的主流行尾写回。这样锚点与行尾无关，也不破坏文件。
 *
 * @param {string} file    相对 appDir 的文件
 * @param {string} id      补丁标识
 * @param {string|function} marker 幂等判据。字符串 = 文件里含此标记即已打过；
 *        字符串数组或 (src)=>bool = 自定义判据（**必需**：多个补丁改同一文件时，
 *        共享一个标记会让第二个补丁被误判成"已打过"，实测踩到过）。
 * @param {string} oldStr  锚点（归一化后必须恰好出现 1 次）
 * @param {string} newStr  替换内容（内部一律用 LF 书写）
 */
function patch(file, id, marker, oldStr, newStr) {
  const full = path.join(appDir, file);
  const raw = fs.readFileSync(full, 'utf8');

  // 归一化：\r\n → \n，孤立 \r → \n
  const src = raw.replace(/\r\n?/g, '\n');
  const oldN = oldStr.replace(/\r\n?/g, '\n');
  const newN = newStr.replace(/\r\n?/g, '\n');
  // 幂等标记也可能含换行，同样归一化后再比对
  const markerN = typeof marker === 'string' ? marker.replace(/\r\n?/g, '\n') : '';
  const markerList = Array.isArray(marker) ? marker : null;

  let already = false;
  if (markerList) already = markerList.every((m) => src.includes(m));
  else if (markerN) already = src.includes(markerN);

  if (already) {
    report.push({ file, id, state: 'SKIP(已打过)' });
    return;
  }
  const hits = src.split(oldN).length - 1;
  if (hits === 0) {
    report.push({ file, id, state: 'FAIL(锚点未找到)' });
    failed++;
    return;
  }
  if (hits > 1) {
    report.push({ file, id, state: `FAIL(锚点命中 ${hits} 次，需唯一)` });
    failed++;
    return;
  }
  if (!dryRun) {
    const out = src.replace(oldN, () => newN);
    // 恢复原文件的行尾风格（CRLF 文件仍写 CRLF）
    const crlf = (raw.match(/\r\n/g) || []).length;
    const lfOnly = (raw.match(/(?<!\r)\n/g) || []).length;
    const useCrlf = crlf > 0 && crlf >= lfOnly;
    fs.writeFileSync(full, useCrlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');
  }
  report.push({ file, id, state: dryRun ? 'DRY(可打)' : 'OK' });
}

// ─────────────────────────────────────────────────────────────
// 1) 数据目录 XDG 化（electron/main.js）
//    原逻辑：安装版取 exe 同级 data/ → Linux 上面是 /opt/qq-agent/data，
//    属 root，普通用户根本写不进去。必须改到 ~/.local/share。
// ─────────────────────────────────────────────────────────────
patch(
  'electron/main.js',
  'data-dir-xdg',
  'QQA_LINUX_PATCH:data-dir-xdg',
  `function resolveDataDir() {
  if (process.env.QQ_AGENT_DATA_DIR) return process.env.QQ_AGENT_DATA_DIR;`,
  `function resolveDataDir() {
  if (process.env.QQ_AGENT_DATA_DIR) return process.env.QQ_AGENT_DATA_DIR;
  /* QQA_LINUX_PATCH:data-dir-xdg
     Linux：安装目录（/opt/qq-agent）属 root、只读，绝不能往里写运行期数据。
     遵循 XDG 规范落到用户主目录：
       QQ_AGENT_DATA_DIR > \${XDG_DATA_HOME:-~/.local/share}/qq-agent/data
     二次实例仍走 data-<N> 后缀（与 Windows 行为一致，端口偏移逻辑也依赖它）。 */
  if (process.platform !== 'win32') {
    const xdg = process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share');
    const dir = path.join(xdg, 'qq-agent', dataDirName());
    try { fs.mkdirSync(dir, { recursive: true }); } catch (error) {
      logCritical('data', \`[数据目录创建失败] \${describeError(error)}\`);
    }
    return dir;
  }`
);

// ─────────────────────────────────────────────────────────────
// 2) SnowLuma「停止」：wmic 换成 POSIX 实现（src/app.js）
// ─────────────────────────────────────────────────────────────
patch(
  'src/app.js',
  'snowluma-stop-posix',
  'QQA_LINUX_PATCH:snowluma-stop-posix',
  `    try {
      const queryCmd = 'wmic process where "name=\\'node.exe\\'" get ProcessId,CommandLine /format:list';`,
  `    /* QQA_LINUX_PATCH:snowluma-stop-posix
       Linux：没有 wmic/taskkill。改用 /proc 扫描命令行（POSIX 标准做法，
       不依赖 procps 是否安装），匹配 index.mjs + snowluma 目录后 process.kill。
       只杀命令行里同时含 index.mjs 与本站 snowluma 目录的进程，绝不按名字乱杀。 */
    if (process.platform !== 'win32') {
      try {
        const dirNorm = path.resolve(String(snowlumaDir() || ''));
        const pids = [];
        for (const name of fs.readdirSync('/proc')) {
          if (!/^\\d+$/.test(name)) continue;
          let cmdline;
          try {
            cmdline = fs.readFileSync(\`/proc/\${name}/cmdline\`, 'utf8').split('\\0').join(' ');
          } catch { continue; }
          if (!/index\\.mjs/.test(cmdline)) continue;
          if (dirNorm && !cmdline.includes(dirNorm)) continue;
          pids.push(Number(name));
        }
        if (!pids.length) return false;
        for (const pid of pids) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ }
        }
        pushSnowlumaLog(\`已请求关闭外部启动的 SnowLuma（pid=\${pids.join(',')}）。\`, 'stdout');
        snowlumaProc = null;
        emit('snowluma-status', { running: false, embedded: false, pid: null });
        return true;
      } catch (error) {
        pushSnowlumaLog(\`关闭外部 SnowLuma 失败：\${error?.message ?? error}\`, 'stderr');
        return false;
      }
    }
    try {
      const queryCmd = 'wmic process where "name=\\'node.exe\\'" get ProcessId,CommandLine /format:list';`
);

// ─────────────────────────────────────────────────────────────
// 3) SnowLuma「启动」：Linux 用自己的 node，且回退分支不认 launcher.bat
// ─────────────────────────────────────────────────────────────
patch(
  'src/app.js',
  'snowluma-launch-posix',
  'QQA_LINUX_PATCH:snowluma-launch-posix',
  `      const indexMjs = path.join(dir, 'index.mjs');
      const nodeExe = path.join(dir, 'node.exe');
      if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) {`,
  `      const indexMjs = path.join(dir, 'index.mjs');
      /* QQA_LINUX_PATCH:snowluma-launch-posix
         Windows 包自带 node.exe；Linux 官方发行版自带同名无扩展名的 node
         （SnowLuma-vX-linux-x64.tar.gz 解包即得）。两者都探测，取存在的那个；
         都没有则回退系统 node（SnowLuma 要求 ^22.13 || >=23.4）。 */
      const nodeCandidates = process.platform === 'win32'
        ? [path.join(dir, 'node.exe')]
        : [path.join(dir, 'node'), '/usr/bin/node', '/usr/local/bin/node', 'node'];
      let nodeExe = '';
      for (const cand of nodeCandidates) {
        if (cand === 'node') { nodeExe = cand; break; }
        if (fs.existsSync(cand)) { nodeExe = cand; break; }
      }
      if (fs.existsSync(indexMjs) && nodeExe) {`
);

patch(
  'src/app.js',
  'snowluma-launch-node-bin',
  'QQA_LINUX_PATCH:snowluma-launch-node-bin',
  `          const child = spawn(nodeExe, [indexMjs], {
            cwd: dir,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            detached: false
          });`,
  `          // QQA_LINUX_PATCH:snowluma-launch-node-bin
          // Linux 上给自带 node 补执行位（tar 包解出来通常已带，防万一）。
          if (process.platform !== 'win32' && path.isAbsolute(nodeExe)) {
            try { fs.chmodSync(nodeExe, 0o755); } catch { /* 忽略 */ }
          }
          const child = spawn(nodeExe, [indexMjs], {
            cwd: dir,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            detached: false
          });`
);

// ─────────────────────────────────────────────────────────────
// 3c) ★ SnowLuma 运行目录镜像（src/app.js）
//
//     这是 Linux 移植最容易漏、也最致命的一处。已核对 v1.14.19 的 index.mjs：
//       - CONFIG_DIR = "config"（纯相对路径）
//       - IdentityService.openForUin(uin, dataRoot = "data")（纯相对路径）
//       - 两者都**没有任何环境变量可以覆盖**
//       - 而原生件（snowluma / websocket / ffmpeg addon）是按 import.meta.url
//         模块相对解析的，与 cwd 无关
//     应用原本以 cwd: dir 拉起 SnowLuma，dir 就是只读的 /opt/qq-agent/.../snowluma
//     → 首次运行写 config/, data/ 必然失败 → 启动即坏。
//
//     对策见下方注释。只改 snowlumaDir() 一个函数，让 spawn 的 cwd、
//     runtime.json 读取、onebot_*.json 扫描三处自动一致。
// ─────────────────────────────────────────────────────────────
patch(
  'src/app.js',
  'snowluma-runtime-mirror',
  'QQA_LINUX_PATCH:snowluma-runtime-mirror',
  `  function snowlumaDir() {
    const configured = String(getConfig().snowluma?.dir || '').trim();
    if (configured) return configured;
    const bundled = path.join(ROOT, 'snowluma');
    if (fs.existsSync(bundled)) return bundled;
    // 安装版：asar 里的文件不可执行，electron-builder 会把 snowluma/ 解包到
    // resources/app.asar.unpacked/snowluma（见 package.json asarUnpack）
    const unpacked = bundled.replace('app.asar', 'app.asar.unpacked');
    if (unpacked !== bundled && fs.existsSync(unpacked)) return unpacked;
    return '';
  }`,
  `  function snowlumaRealDir() {
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

  /* QQA_LINUX_PATCH:snowluma-runtime-mirror
     Linux 上 SnowLuma 用「相对 cwd」的路径写 config/ 与 data/
     （v1.14.19 的 index.mjs 里 CONFIG_DIR = "config"、
       IdentityService.openForUin(uin, dataRoot = "data")，
       且没有任何环境变量可覆盖这两个位置），而应用原本以 cwd: dir 拉起它，
     dir 指向只读的 /opt/qq-agent/resources/app/snowluma → 首次运行就写失败。

     原生件（snowluma / websocket / ffmpeg addon）是按 import.meta.url
     模块相对解析的，与 cwd 无关，所以换 cwd 不会破坏原生加载。

     对策：在用户主目录造一个「符号链接镜像目录」——
       静态件（index.mjs / *.js / native/ / node / client/ 等）软链回只读安装目录，
       config / data / logs 刻意**不软链**，让 SnowLuma 在镜像里自行创建。
     效果：程序仍从 /opt 读（用户不可篡改、升级覆盖即生效），运行期数据落在用户主目录。

     只改这一个函数的原因：snowlumaDir() 是 spawn 的 cwd、
     snowlumaWebuiPort()/snowlumaWebuiUrl() 读 config/runtime.json、
     以及 onebot_*.json 令牌扫描这三处共同的入口。改这里三处自动一致，
     比逐个打 4 个补丁少得多的失败面，也不会漏改。 */
  let snowlumaMirrorCache = null;
  function ensureSnowlumaRuntimeMirror(realDir) {
    if (snowlumaMirrorCache) return snowlumaMirrorCache;
    try {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const xdg = process.env.XDG_DATA_HOME || (home ? path.join(home, '.local', 'share') : '');
      if (!xdg) return realDir;
      const mirror = path.join(xdg, 'qq-agent', 'snowluma');
      fs.mkdirSync(mirror, { recursive: true });
      for (const name of fs.readdirSync(realDir)) {
        if (name === 'config' || name === 'data' || name === 'logs') continue;
        const link = path.join(mirror, name);
        const target = path.join(realDir, name);
        try {
          if (fs.lstatSync(link).isSymbolicLink()) {
            if (fs.readlinkSync(link) === target) continue;
            fs.unlinkSync(link);
          } else {
            continue;
          }
        } catch { /* 不存在 -> 往下创建 */ }
        try { fs.symlinkSync(target, link); } catch { /* 单个失败不致命 */ }
      }
      snowlumaMirrorCache = mirror;
      return mirror;
    } catch (error) {
      pushSnowlumaLog('[SnowLuma] 运行目录镜像创建失败，回退到安装目录（数据可能写不进去）：' + String(error?.message ?? error), 'stderr');
      return realDir;
    }
  }

  function snowlumaDir() {
    const real = snowlumaRealDir();
    if (!real) return real;
    if (process.platform === 'win32') return real;
    // 用户在设置里显式指定了 SnowLuma 目录 -> 尊重原样，不做镜像
    const configured = String(getConfig().snowluma?.dir || '').trim();
    if (configured) return configured;
    return ensureSnowlumaRuntimeMirror(real);
  }`
);

// ─────────────────────────────────────────────────────────────
// 4) 桌面环境集成（src/routes.js）：explorer.exe / cmd.exe start
//    → Linux 用 xdg-open。没有 xdg-open 时如实报错，不静默失败。
// ─────────────────────────────────────────────────────────────
patch(
  'src/routes.js',
  'routes-open-data-dir',
  ['openWith(DATA_DIR)'],
  `          spawn('explorer.exe', [DATA_DIR], { detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true, dir: DATA_DIR });`,
  `          openWith(DATA_DIR);
          return json(res, 200, { ok: true, dir: DATA_DIR });`
);

patch(
  'src/routes.js',
  'routes-open-snowluma-dir',
  ['openWith(dir)'],
  `        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });`,
  `        openWith(dir);
        return json(res, 200, { ok: true });`
);

patch(
  'src/routes.js',
  'routes-open-webui',
  ['openWith(webuiUrl)'],
  `        spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, webuiUrl });`,
  `        openWith(webuiUrl);
        return json(res, 200, { ok: true, webuiUrl });`
);

// 4b) 注入 openWith 帮助函数（放在 routes.js 的 import 之后）
patch(
  'src/routes.js',
  'routes-openwith-helper',
  'function openWith(',
  `import { spawn } from 'node:child_process';`,
  `import { spawn } from 'node:child_process';

/* QQA_LINUX_PATCH:open-with
   跨平台「在系统里打开」：Windows 用 explorer.exe / cmd start，
   Linux 用 xdg-open（桌面环境标准入口）。失败抛错，让上层接口如实回 500，
   不要静默吞掉 —— 用户点了按钮没反应最难排查。 */
function openWith(target) {
  const isUrl = /^https?:\\/\\//i.test(String(target));
  let cmd;
  let args;
  if (process.platform === 'win32') {
    cmd = isUrl ? 'cmd.exe' : 'explorer.exe';
    args = isUrl ? ['/c', 'start', '', String(target)] : [String(target)];
  } else {
    cmd = 'xdg-open';
    args = [String(target)];
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', (error) => {
    console.error(\`[openWith] 调用 \${cmd} 失败：\${error?.message ?? error}\`);
  });
  child.unref();
  return true;
}`
);

// 5) 便携 QQ：Linux 上明确「不适用」，而不是显示成"未安装"让用户以为装漏了
patch(
  'src/app.js',
  'portable-qq-unsupported',
  'QQA_LINUX_PATCH:portable-qq',
  `  /** 检查便携 QQ 是否已安装 */
  function qqPortableReady() {
    return fs.existsSync(qqPortableExe());
  }`,
  `  /** 检查便携 QQ 是否已安装 */
  function qqPortableReady() {
    // QQA_LINUX_PATCH:portable-qq
    // 便携 QQ 是 Windows 专属功能（Windows QQ.exe + --user-data-dir）。
    // Linux 上协议端（SnowLuma）直接用 QQ NT 协议登录，不需要客户端 QQ，
    // 因此这里恒为 false，UI 会显示为未安装 —— 属预期行为。
    if (process.platform !== 'win32') return false;
    return fs.existsSync(qqPortableExe());
  }`
);

// ─────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────
console.log('\n=== Linux 适配补丁报告 ===');
for (const r of report) {
  const flag = r.state.startsWith('OK') || r.state.startsWith('SKIP') || r.state.startsWith('DRY') ? ' ' : '!';
  console.log(`${flag} [${r.state}] ${r.file}  ← ${r.id}`);
}
const ok = report.filter((r) => r.state === 'OK').length;
const skip = report.filter((r) => r.state.startsWith('SKIP')).length;
console.log(`\n合计: 应用 ${ok} · 跳过 ${skip} · 失败 ${failed}${dryRun ? ' (dry-run)' : ''}`);

// 语法校验
// ⚠️ 已知环境坑（实测踩到）：在受限沙箱里，Node 不允许把子进程输出经管道捕获
//    （stdio: 'pipe' 会抛 EPERM）。那**不是语法错误**，绝不能误判成失败把构建搞红。
let envSkipped = 0;
if (!dryRun) {
  console.log('\n=== node --check 语法校验 ===');
  const files = [...new Set(report.map((r) => r.file))];
  for (const f of files) {
    const full = path.join(appDir, f);
    if (!fs.existsSync(full)) continue;
    try {
      execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
      console.log(`  语法 OK   ${f}`);
    } catch (error) {
      const msg = String(error?.stderr?.toString() || error?.message || '');
      const isEnvLimit = !error?.stderr && /EPERM|EACCES|ENOENT|spawnSync/.test(msg);
      if (isEnvLimit) {
        envSkipped++;
        console.log(`  [跳过] ${f} —— 环境限制，无法执行语法校验`);
        console.log(`         ${msg.split('\n')[0]}`);
        console.log('         这不是语法错误：本环境不允许经管道捕获子进程输出。');
        console.log('         请在正常环境（WSL / CI）重跑本步骤。');
      } else {
        console.log(`  语法 失败 ${f}\n${msg}`);
        failed++;
      }
    }
  }
}

if (failed) {
  console.error(`\n补丁过程有 ${failed} 处失败，已中止。`);
  process.exit(1);
}
if (dryRun) {
  console.log('\n[dry-run] 锚点全部命中。');
  console.log('注意：dry-run **不写文件、也不做 node --check**，');
  console.log('      要真正验证语法请跑 scripts/02-test-patch.sh（在副本上真打一遍）。');
} else if (envSkipped > 0) {
  console.log(`\n补丁已全部应用。但有 ${envSkipped} 个文件的语法校验因环境限制被跳过——`);
  console.log('请在 WSL / CI 上重跑以完成语法校验。');
} else {
  console.log('\n所有 Linux 适配补丁已应用且语法校验通过。');
}
