#!/usr/bin/env node
// ============================================================================
//  verify-no-missing-requires.mjs —— 依赖图完整性复检（构建/CI 必跑）
//
//  ★ 本文件来自 qqa-build-fix-20261006 修复包，2026-10-07 由 neo-plan 阶段 0
//    纳入仓库并接进流水线。原先它只存在于构建机的手工复检步骤里，CI 完全没有
//    这一层，于是「排除规则过宽把必需文件静默吃掉」没有任何自动信号。
//
//  接入点（三处，缺一不可）：
//    scripts/03-stage.sh      —— 复制完应用代码后立刻跑（产出 tar / stage 树之前）
//    scripts/99-selfcheck.sh  —— --input 模式（CI 里对 ci-app 复检）
//    .github/workflows/build-linux-arm64.yml —— 显式硬门（失败即构建红掉）
//
//  用途：遍历一棵应用树里所有 JS 的**相对 require**，校验目标文件真实存在。
//        这是「排除规则过宽把必需文件静默吃掉」这类缺陷的直接探测手段 ——
//        2026-10-06 的 data-url.js 事故就是靠它定位的（当时只缺这一个模块，
//        但应用仍能启动、冒烟全绿，没有任何其它信号）。
//
//  用法:
//      node scripts/verify-no-missing-requires.mjs <应用树目录>
//      node scripts/verify-no-missing-requires.mjs stage/app      # 构建后
//      node scripts/verify-no-missing-requires.mjs /opt/qq-agent/resources/app   # 装机后
//
//  退出码: 0 = 无缺失；1 = 有缺失（可直接当 CI 闸门）；2 = 用法/目录错误
//
//  ⚠️ 与"只看文件是否在包内"的区别：本脚本跟着 require 图走，
//     能发现"文件被排掉且确实被引用"的真正故障，避免把 .d.ts 之类的
//     正常剥离误报成缺陷。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2];
if (!ROOT) {
  console.error('用法: node scripts/verify-no-missing-requires.mjs <应用树目录>');
  process.exit(2);
}
if (!fs.existsSync(ROOT)) {
  console.error(`目录不存在: ${ROOT}`);
  process.exit(2);
}

const EXTS = ['', '.js', '.cjs', '.mjs', '.json', '.node'];
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

const jsFiles = [];
(function walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && /\.(js|cjs|mjs)$/.test(e.name)) jsFiles.push(p);
  }
})(ROOT);

// 只抓 require('...') 形态的相对路径；import 由 ESM 解析器负责，此处不重复覆盖
const RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const missing = new Map();

for (const file of jsFiles) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
  let m;
  while ((m = RE.exec(src))) {
    const spec = m[1];
    const base = path.resolve(path.dirname(file), spec);
    const ok =
      EXTS.some((e) => isFile(base + e)) ||
      EXTS.some((e) => isFile(path.join(base, 'index' + e))) ||
      isFile(path.join(base, 'package.json'));
    if (!ok) {
      if (!missing.has(spec)) missing.set(spec, []);
      missing.get(spec).push(path.relative(ROOT, file));
    }
  }
}

console.log(`  扫描目录    : ${ROOT}`);
console.log(`  JS 文件数   : ${jsFiles.length}`);
console.log(`  解析不到的相对 require: ${missing.size}`);

if (missing.size === 0) {
  console.log('  ✅ 依赖图完整，无缺失模块');
  process.exit(0);
}

for (const [spec, users] of [...missing].sort()) {
  console.log(`    ❌ ${spec}`);
  for (const u of users) console.log(`         ← ${u}`);
}
console.log('');
console.log('  ❌ 存在缺失模块 —— 多半某条 --exclude 过宽（见 EXCLUDE_PATTERNS 是否锚定到 ./）');
process.exit(1);
