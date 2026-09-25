#!/usr/bin/env bash
# dump-schema.sh —— 打印 WSL 上实际安装的 electron-builder 对 linux 段支持的配置键。
#
# 为什么要查：我按文档加的几个键（maintainer / desktopName / syncDesktopName）
# 触发了 schema 硬校验失败：
#   "Invalid configuration object ... configuration.linux should be one of these: null"
# 这个报错信息**不说**是哪个键错，只能拿实际 schema 对照。
# 注意版本差异：不同 electron-builder 版本支持的键不同，必须查本机这一份。

set -uo pipefail

APP="$HOME/qq-agent-linux/app"
SCHEMA="$APP/node_modules/app-builder-lib/scheme.json"

echo "== electron-builder 版本 =="
node -p "require('$APP/node_modules/electron-builder/package.json').version" 2>/dev/null || echo "  读取失败"
echo "== app-builder-lib 版本 =="
node -p "require('$APP/node_modules/app-builder-lib/package.json').version" 2>/dev/null || echo "  读取失败"

echo
echo "== schema 文件 =="
ls -la "$SCHEMA" 2>/dev/null || { echo "  不存在: $SCHEMA"; exit 1; }

echo
echo "== LinuxConfiguration 支持的键 =="
node -e "
const s = require('$SCHEMA');
const props = s.definitions?.LinuxConfiguration?.properties || {};
const keys = Object.keys(props).sort();
console.log('  共 ' + keys.length + ' 个');
for (const k of keys) console.log('    ' + k);
" 2>/dev/null || echo "  解析失败"

echo
echo "== 顶层 Configuration 里与桌面集成相关的键 =="
node -e "
const s = require('$SCHEMA');
const props = s.definitions?.Configuration?.properties || {};
const interesting = Object.keys(props).filter(k => /desktop|maintainer|author|appId/i.test(k)).sort();
for (const k of interesting) console.log('    ' + k);
" 2>/dev/null || echo "  解析失败"

echo
echo "== 我当前配置里用到的 linux 键（逐一核对是否合法）=="
node -e "
const path = require('path');
const fs = require('fs');
const pkg = require('$APP/package.json');
const schema = require('$SCHEMA');
const valid = new Set(Object.keys(schema.definitions?.LinuxConfiguration?.properties || {}));
const used = Object.keys(pkg.build?.linux || {});
for (const k of used) {
  console.log('    ' + (valid.has(k) ? '✅' : '❌ 非法') + '  ' + k);
}
const bad = used.filter(k => !valid.has(k));
if (bad.length) {
  console.log();
  console.log('  ⚠️  非法键（必须删除）: ' + bad.join(', '));
} else {
  console.log();
  console.log('  ✅ 全部合法');
}
" 2>/dev/null || echo "  解析失败"
