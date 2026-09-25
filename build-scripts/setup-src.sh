#!/usr/bin/env bash
# 把改造后的源码从 Windows 暂存目录同步到 WSL 的 Linux 文件系统。
#
# 为什么用脚本文件而不是 wsl -- bash -c '...'：
#   PowerShell 会先把单引号脚本里的 $SRC / $DST 当作自己的变量展开成空字符串，
#   导致 mkdir '' / cp '' 之类的诡异失败。写成文件执行可以彻底避开引号嵌套问题，
#   脚本内容也不再被任何一侧的 shell 二次解析。
#
# 用法（在 WSL 内执行）：bash setup-src.sh

set -euo pipefail

SRC="/mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/app"
DST="$HOME/qq-agent-linux/app"
TARBALL="/tmp/qq-app-src.tgz"

# 同步时必须排除的项：
#   snowluma       —— 已由 fetch-snowluma.sh 放入 Linux 版，覆盖会退回 Windows 构建
#   node_modules   —— WSL 侧自己装，跨 9p 拷极慢
#   data / dist    —— 用户数据与上次产物
EXCLUDES=(
  --exclude=./snowluma
  --exclude=./snowluma.win-backup
  --exclude=./node_modules
  --exclude=./data
  --exclude=./dist
)

if [ -d "$DST/snowluma" ] && [ -f "$DST/snowluma/index.mjs" ]; then
  echo "  ⚠️  检测到目标已有 snowluma/，本次同步将跳过它（保留现有版本）"
fi

echo "== 1/5 校验源目录 =="
[ -d "$SRC" ] || { echo "源目录不存在: $SRC"; exit 1; }
echo "  源文件数: $(find "$SRC" -type f | wc -l)"

echo "== 2/5 清理代码（保留 snowluma/ 与 node_modules/）=="
# 只删代码目录，不整体 rm -rf：避免把已下好的 Linux 版 SnowLuma 与依赖删掉
for d in src electron ui plugins skills assets test build-scripts; do
  rm -rf "$DST/$d"
done
rm -f "$DST/package.json" "$DST/README.md" "$DST/LICENSE" "$DST/prices.json"
mkdir -p "$DST"

echo "== 3/5 在 Linux 侧打包源（/mnt/f 逐个文件拷很慢，先打包）=="
tar -czf "$TARBALL" -C "$SRC" "${EXCLUDES[@]}" .
echo "  包大小: $(du -h "$TARBALL" | cut -f1)"

echo "== 4/5 解包到 Linux 文件系统 =="
tar -xzf "$TARBALL" -C "$DST"
rm -f "$TARBALL"
echo "  目标文件数: $(find "$DST" -type f | wc -l)"

echo "== 5/5 校验关键文件与 affinity =="
for f in package.json src/platform.js src/app.js src/config.js src/routes.js \
         electron/main.js test/platform-test.mjs skills/affinity/skill.json \
         skills/affinity/index.js; do
  if [ -f "$DST/$f" ]; then
    printf "  OK      %s\n" "$f"
  else
    printf "  缺失    %s\n" "$f"
  fi
done

echo
echo "== affinity 校验（应为你的魔改版：name=好感度 / 961 人档案描述）=="
node -e "
const fs=require('fs');
const p=process.env.HOME+'/qq-agent-linux/app/skills/affinity/skill.json';
const j=JSON.parse(fs.readFileSync(p,'utf8'));
console.log('  name    :', j.name);
console.log('  version :', j.version);
console.log('  author  :', j.author);
console.log('  caps    :', (j.capabilities||[]).join(', '));
" 2>/dev/null || echo "  (node 校验跳过)"

echo
echo "== 完成：$DST =="
du -sh "$DST"
