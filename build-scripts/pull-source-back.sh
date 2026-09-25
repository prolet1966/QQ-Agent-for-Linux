#!/usr/bin/env bash
# pull-source-back.sh —— 把 WSL 里（已并入插件/技能）的源码同步回 Windows 工作区。
#
# 为什么需要「反向」同步：
#   apply-addons.sh 同时写了两处，但 WSL 侧是权威运行环境（能验证），
#   Windows 工作区是权威存储（持久）。重建或迁移后可能只有一边是新的，
#   所以需要能双向对齐。本脚本以 WSL 为准，覆盖工作区的代码目录。
#
# 排除项说明：
#   node_modules / dist / snowluma —— 体积大或平台相关，不进源码工作区
#   data —— 用户数据

set -euo pipefail

SRC="$HOME/qq-agent-linux/app"
DST="/mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/app"

echo "== 1. 校验源 =="
[ -d "$SRC" ] || { echo "❌ WSL 源不存在: $SRC"; exit 1; }
echo "  plugins: $(find "$SRC/plugins" -maxdepth 1 -mindepth 1 -type d | wc -l) 个"
echo "  skills : $(find "$SRC/skills" -maxdepth 1 -mindepth 1 -type d | wc -l) 个"

echo
echo "== 2. 打包（排除大件与平台相关项）=="
TARBALL="/tmp/pull-back.tgz"
tar -czf "$TARBALL" -C "$SRC" \
  --exclude=./node_modules \
  --exclude=./dist \
  --exclude=./snowluma \
  --exclude=./snowluma.win-backup \
  --exclude=./data \
  --exclude=./build-scripts \
  .
echo "  包大小: $(du -h "$TARBALL" | cut -f1)"

echo
echo "== 3. 清理目标代码目录（保留已在工作区的 build-scripts / test）=="
# 只删代码目录：解包不会删除同名目录里未被覆盖的文件，
# 所以 test/direct-load-test.mjs 这类「只存在于工作区」的文件能保住。
for d in src electron ui plugins skills assets; do
  rm -rf "$DST/$d"
done
mkdir -p "$DST"

echo
echo "== 4. 解包覆盖 =="
tar -xzf "$TARBALL" -C "$DST"
rm -f "$TARBALL"

echo
echo "== 5. 核对 =="
printf "  工作区 plugins: %s 个\n" "$(find "$DST/plugins" -maxdepth 1 -mindepth 1 -type d | wc -l)"
printf "  工作区 skills : %s 个\n" "$(find "$DST/skills" -maxdepth 1 -mindepth 1 -type d | wc -l)"
printf "  platform.js   : %s\n" "$([ -f "$DST/src/platform.js" ] && echo '✅ 在' || echo '❌ 丢')"
printf "  package.json  : %s\n" "$([ -f "$DST/package.json" ] && echo '✅ 在' || echo '❌ 丢')"
printf "  build-scripts : %s 个（应保留）\n" "$(find "$DST/build-scripts" -maxdepth 1 -type f 2>/dev/null | wc -l)"

echo
echo "== 6. 抽查新增条目是否到位 =="
for p in kb-growth body-state 本体情绪; do
  [ -d "$DST/plugins/$p" ] && echo "  ✅ plugins/$p" || echo "  ❌ plugins/$p 缺失"
done
for s in voice-tts-skill 百科查询 todo-skill; do
  [ -d "$DST/skills/$s" ] && echo "  ✅ skills/$s" || echo "  ❌ skills/$s 缺失"
done

echo
echo "== 完成 =="
