#!/usr/bin/env bash
# vm-04-appimage-structure.sh —— 查看 AppImage 解包后的真实目录结构。
#
# 起因：AppImage 的冒烟测试里有 4 项失败，但那些检查用的是 .deb 的路径布局
# （/opt/QQ Agent/resources/...）。AppImage 是另一种打包格式，结构不同。
# 在改断言之前，先看清它真实的目录树 —— 不能凭猜改断言，
# 否则只是把"断言写错"换成"断言按错误结构写了但恰好通过"。

set -uo pipefail
AI="${1:-/tmp/qq-agent.AppImage}"
WORK=/tmp/qa-ai-tree
rm -rf "$WORK"; mkdir -p "$WORK"
cd "$WORK"

echo "== 解包 =="
"$AI" --appimage-extract >/dev/null 2>&1
ROOT="$WORK/squashfs-root"
[ -d "$ROOT" ] || { echo "❌ 解包失败"; exit 1; }

echo "== 顶层结构 =="
ls -la "$ROOT" | sed 's/^/  /'

echo
echo "== resources/ 内容 =="
ls -la "$ROOT/resources" 2>/dev/null | sed 's/^/  /' || echo "  （不存在）"

echo
echo "== app.asar.unpacked/ 内容 =="
ls -la "$ROOT/resources/app.asar.unpacked" 2>/dev/null | sed 's/^/  /' || echo "  （不存在）"

echo
echo "== 找 snowluma 目录 =="
find "$ROOT" -maxdepth 4 -type d -name "snowluma*" 2>/dev/null | sed 's/^/  /' || echo "  未找到"

echo
echo "== 找可执行的 node =="
find "$ROOT" -maxdepth 5 -type f -name "node" 2>/dev/null | while read -r f; do
  echo "  $f  ($([ -x "$f" ] && echo 可执行 || echo 不可执行), $(du -h "$f" | cut -f1))"
done

echo
echo "== 找 .desktop =="
find "$ROOT" -name "*.desktop" 2>/dev/null | sed 's/^/  /' || echo "  未找到"

echo
echo "== 找 app.asar =="
find "$ROOT" -maxdepth 3 -name "app.asar" 2>/dev/null | sed 's/^/  /' || echo "  未找到"

echo
echo "== 找主程序（可执行的 qq-agent）=="
find "$ROOT" -maxdepth 3 -name "qq-agent" 2>/dev/null | while read -r f; do
  echo "  $f  ($([ -x "$f" ] && echo 可执行 || echo 不可执行))"
done

echo
echo "== 找 native 原生件 =="
find "$ROOT" -name "*.node" 2>/dev/null | head -8 | sed 's/^/  /'

echo
echo "== 找图标 =="
find "$ROOT" -name "*.png" -o -name "*.svg" 2>/dev/null | head -6 | sed 's/^/  /'

echo
echo "== 整体体积分布 =="
du -sh "$ROOT"/* 2>/dev/null | sort -hr | head -10 | sed 's/^/  /'

rm -rf "$WORK"
echo
echo "（已清理临时目录）"
