#!/usr/bin/env bash
# 在临时副本上试跑补丁，验证 patch-linux.mjs 真能命中（不触碰原始 Windows 安装）
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

WIN_APP="/mnt/e/Program Files/QQ Agent/QQ Agent v0.4 setup/resources/app"
TMP="$PWD/.anchor-test"

echo "===== 准备临时副本 ====="
rm -rf "$TMP"; mkdir -p "$TMP"
cp -r "$WIN_APP/electron" "$TMP/"
cp -r "$WIN_APP/src" "$TMP/"
echo "已复制 electron/ 与 src/ 到 $TMP"

echo
echo "===== 补丁 dry-run ====="
node patches/patch-linux.mjs "$TMP" --dry-run

echo
echo "===== 真打一遍（在副本上）====="
node patches/patch-linux.mjs "$TMP"

echo
echo "===== 再打一遍验证幂等（应当全部 SKIP）====="
node patches/patch-linux.mjs "$TMP"

echo
echo "===== 抽查改动结果 ====="
echo "--- main.js 数据目录段 ---"
grep -n "QQA_LINUX_PATCH:data-dir-xdg" -A 12 "$TMP/electron/main.js" | head -20
echo
echo "--- app.js SnowLuma 启动段 ---"
grep -n "nodeCandidates" -A 8 "$TMP/src/app.js" | head -14
echo
echo "--- routes.js openWith ---"
grep -n "function openWith" -A 6 "$TMP/src/routes.js" | head -10
echo
echo "--- app.js SnowLuma 运行目录镜像（Linux 关键补丁）---"
grep -n "QQA_LINUX_PATCH:snowluma-runtime-mirror" -A 4 "$TMP/src/app.js" | head -8
echo "  snowlumaRealDir 已生成:"
grep -n "function snowlumaRealDir" "$TMP/src/app.js" || echo "  !! 未找到，补丁可能没生效"
