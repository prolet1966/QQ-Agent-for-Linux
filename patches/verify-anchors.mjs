/**
 * verify-anchors.mjs — 只读校验 patch-linux.mjs 的每个锚点在目标 app 树里
 * 是否「恰好命中一次」。不修改任何文件。
 *
 * 为什么必须先做这一步：本项目历史上多次出现补丁锚点撞车导致**静默跳过**，
 * node --check 也看不出来。改文件之前先证明锚点唯一。
 *
 * 用法：node verify-anchors.mjs "<appDir>"
 *
 * ⚠️ 必须做行尾归一化：Windows 侧的 app 树文件**全部是 CRLF**，而本文件里的锚点
 *    天然是 LF。不归一化就会 100% 误报"锚点不匹配"。
 *    （第一版就踩了这个坑，与 patch-linux.mjs 同源。）
 */

import fs from 'node:fs';
import path from 'node:path';

/** 行尾归一化：\r\n → \n，孤立 \r → \n */
const norm = (s) => s.replace(/\r\n?/g, '\n');

const appDir = process.argv[2];
if (!appDir) {
  console.error('用法: node verify-anchors.mjs <appDir>');
  process.exit(2);
}

/** 与 patch-linux.mjs 中逐个补丁一一对应的锚点清单 */
const ANCHORS = [
  {
    id: 'data-dir-xdg', file: 'electron/main.js',
    old: `function resolveDataDir() {\n  if (process.env.QQ_AGENT_DATA_DIR) return process.env.QQ_AGENT_DATA_DIR;`
  },
  {
    id: 'snowluma-stop-posix', file: 'src/app.js',
    old: `    try {\n      const queryCmd = 'wmic process where "name=\\'node.exe\\'" get ProcessId,CommandLine /format:list';`
  },
  {
    id: 'snowluma-launch-posix', file: 'src/app.js',
    old: `      const indexMjs = path.join(dir, 'index.mjs');\n      const nodeExe = path.join(dir, 'node.exe');\n      if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) {`
  },
  {
    id: 'snowluma-launch-node-bin', file: 'src/app.js',
    old: `          const child = spawn(nodeExe, [indexMjs], {\n            cwd: dir,\n            stdio: ['ignore', 'pipe', 'pipe'],\n            windowsHide: true,\n            detached: false\n          });`
  },
  {
    id: 'snowluma-runtime-mirror', file: 'src/app.js',
    old: `  function snowlumaDir() {\n    const configured = String(getConfig().snowluma?.dir || '').trim();\n    if (configured) return configured;\n    const bundled = path.join(ROOT, 'snowluma');\n    if (fs.existsSync(bundled)) return bundled;\n    // 安装版：asar 里的文件不可执行，electron-builder 会把 snowluma/ 解包到\n    // resources/app.asar.unpacked/snowluma（见 package.json asarUnpack）\n    const unpacked = bundled.replace('app.asar', 'app.asar.unpacked');\n    if (unpacked !== bundled && fs.existsSync(unpacked)) return unpacked;\n    return '';\n  }`
  },
  {
    id: 'routes-open-data-dir', file: 'src/routes.js',
    old: `          spawn('explorer.exe', [DATA_DIR], { detached: true, stdio: 'ignore' }).unref();\n          return json(res, 200, { ok: true, dir: DATA_DIR });`
  },
  {
    id: 'routes-open-snowluma-dir', file: 'src/routes.js',
    old: `        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();\n        return json(res, 200, { ok: true });`
  },
  {
    id: 'routes-open-webui', file: 'src/routes.js',
    old: `        spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();\n        return json(res, 200, { ok: true, webuiUrl });`
  },
  {
    id: 'routes-openwith-helper', file: 'src/routes.js',
    old: `import { spawn } from 'node:child_process';`
  },
  {
    id: 'portable-qq-unsupported', file: 'src/app.js',
    old: `  /** 检查便携 QQ 是否已安装 */\n  function qqPortableReady() {\n    return fs.existsSync(qqPortableExe());\n  }`
  },
];

console.log('=== 锚点唯一性校验（只读）===\n');
let bad = 0;

for (const a of ANCHORS) {
  const full = path.join(appDir, a.file);
  if (!fs.existsSync(full)) {
    console.log(`!! 文件不存在  ${a.file}  ← ${a.id}`);
    bad++;
    continue;
  }
  const src = norm(fs.readFileSync(full, 'utf8'));
  const old = norm(a.old);
  const hits = src.split(old).length - 1;
  if (hits === 1) {
    console.log(`OK  命中1次  ${a.file}  ← ${a.id}`);
  } else {
    console.log(`!!  命中${hits}次 ${a.file}  ← ${a.id}   ${hits === 0 ? '（锚点不匹配，需重新摘取）' : '（锚点不唯一，需加长）'}`);
    bad++;
  }
}

// 附带统计：确认这些 Windows-only 关键字仍存在（说明确实是待改的 V0.4.4）
console.log('\n=== Windows-only 关键字盘点 ===');
const scan = ['src/app.js', 'src/routes.js', 'electron/main.js'];
const KEYWORDS = ['wmic', 'explorer.exe', 'cmd.exe', 'launcher.bat', 'node.exe', 'QQ.exe', 'powershell'];
for (const f of scan) {
  const full = path.join(appDir, f);
  if (!fs.existsSync(full)) continue;
  const src = fs.readFileSync(full, 'utf8');
  const found = KEYWORDS.filter((k) => src.includes(k));
  console.log(`${f}: ${found.length ? found.join(', ') : '（无）'}`);
}

console.log(`\n结论：${bad === 0 ? '全部锚点唯一，补丁可安全应用。' : `有 ${bad} 处锚点问题，需修正 patch-linux.mjs 后再打包。`}`);
process.exit(bad === 0 ? 0 : 1);
