#!/usr/bin/env bash
# bisect-linux-config.sh —— 逐项二分定位 electron-builder 的 linux 段配置错误。
#
# 背景：报错只说「configuration.linux should be one of these: null」，
# **不指出是哪个键/值有问题**，只能逐项排除。
#
# 做法：用 app-builder-lib 自带的 schema 校验器，对多种候选配置组合分别校验，
# 找出第一个失败的组合，从而锁定问题项。
# 直接调用官方校验器比读文档可靠 —— 文档写支持的键，实际 schema 未必一致。

set -uo pipefail

APP="$HOME/qq-agent-linux/app"
cd "$APP"

node --input-type=module -e "
import { createRequire } from 'node:module';
const require = createRequire('$APP/package.json');
const schema = require('$APP/node_modules/app-builder-lib/scheme.json');
const Ajv = require('$APP/node_modules/ajv/dist/ajv.js');
" 2>/dev/null || true

# 上面若因 ajv 版本路径问题失败，改用最直接的办法：
# 用 electron-builder 自己的校验器跑同一段配置，但逐项增删。
node --input-type=commonjs -e "
const path = require('path');
const fs = require('fs');

const schemaPath = '$APP/node_modules/app-builder-lib/scheme.json';
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

// 尝试多种 ajv 入口
let Ajv = null;
for (const p of ['ajv','ajv/dist/ajv','ajv/dist/2019','ajv/dist/2020']) {
  try { Ajv = require(path.join('$APP/node_modules', p)); break; } catch {}
}
if (!Ajv) { console.log('  ⚠️ 找不到 ajv，无法直接校验'); process.exit(0); }

const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
// schema 是 json-schema draft-07 混用，关闭未知关键字报错
let validate;
try {
  validate = ajv.compile(schema);
} catch (e) {
  console.log('  ⚠️ 编译 schema 失败: ' + e.message);
  process.exit(0);
}

// 候选组合：逐个加入我配置里的 linux 子项，看哪一个先失败
const BASE = { appId: 'cn.kondius.qq-agent', productName: 'QQ Agent' };

const CANDIDATES = [
  ['仅 target',              { target: [{target:'deb',arch:['x64']}] }],
  ['+ category',             { category: 'Network' }],
  ['+ icon',                 { icon: 'assets/icon.png' }],
  ['+ artifactName',         { artifactName: 'qq-agent-v\${version}-\${arch}.\${ext}' }],
  ['+ synopsis',             { synopsis: 'x' }],
  ['+ description',          { description: 'x' }],
  ['+ maintainer(字符串)',    { maintainer: 'prolet1966 <hs75311a@126.com>' }],
  ['+ syncDesktopName',      { syncDesktopName: true }],
  ['+ desktop.entry 嵌套',    { desktop: { entry: { Name:'QQ Agent' } } }],
  ['+ desktop 直接属性',      { desktop: { Name:'QQ Agent', Comment:'x', Categories:'Network;' } }],
];

let acc = {};
console.log('== 逐项加入 linux 子项，验证 schema ==');
let firstBad = null;
for (const [label, add] of CANDIDATES) {
  const test = { ...BASE, linux: { ...acc, ...add } };
  const ok = validate(test);
  console.log('  ' + (ok ? '✅' : '❌') + '  ' + label);
  if (!ok) {
    console.log('       错误: ' + validate.errors.slice(0,3).map(e=>e.instancePath+' '+e.message).join(' | '));
    if (!firstBad) firstBad = label;
    // 失败的不并入累积集合，继续测后面的
  } else {
    acc = { ...acc, ...add };
  }
}

console.log();
console.log('== 结论 ==');
if (firstBad) {
  console.log('  第一个让校验失败的项: ' + firstBad);
} else {
  console.log('  ✅ 所有单项都合法 —— 问题可能是多项组合或键的顺序');
}

console.log();
console.log('== 完整的 linux 段逐字节核对（当前 package.json）==');
const pkg = JSON.parse(fs.readFileSync('$APP/package.json','utf8'));
const linux = pkg.build.linux;
for (const [k,v] of Object.entries(linux)) {
  console.log('  ' + k + ' = ' + JSON.stringify(v).slice(0,120));
}

console.log();
console.log('== 用完整配置实测 ==');
const fullTest = { ...BASE, ...pkg.build };
const okFull = validate(fullTest);
console.log('  完整 build 配置校验: ' + (okFull ? '✅ 通过' : '❌ 失败'));
if (!okFull) {
  for (const e of validate.errors.slice(0, 10)) {
    console.log('    ' + e.instancePath + '  ->  ' + e.message);
  }
}
" 2>&1
