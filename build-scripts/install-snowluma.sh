#!/usr/bin/env bash
# install-snowluma.sh —— 把已下载好的 SnowLuma Linux 包安装进 app/snowluma/
#
# 与 fetch-snowluma.sh 的分工：
#   fetch-snowluma.sh   负责「下载」（WSL 内直连 GitHub 会断流，实际走不通）
#   install-snowluma.sh 负责「安装」（包已在 Windows 侧用 gh 下好并校验过 SHA256）
#
# 为什么要拆开：WSL 直连 GitHub release 资源会 302 到 objects.githubusercontent.com，
# 实测 90 秒零字节 + SSL 断流。而 Windows 侧的 gh 走 API 通道，6.7 秒就下完了。
# 所以下载在 Windows 做，安装在这里做。

set -euo pipefail

PKG="/mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/SnowLuma-v1.14.19-linux-x64.tar.gz"
APP="$HOME/qq-agent-linux/app"
SNOW="$APP/snowluma"
EXPECT_SHA="f0cbd19809327c3959c64083a008c136d9b7538f34a6763c21415fcf9d75f7a5"

echo "== 1/5 校验安装包 =="
[ -f "$PKG" ] || { echo "  包不存在: $PKG"; exit 1; }
ACTUAL_SHA=$(sha256sum "$PKG" | awk '{print $1}')
echo "  文件   : $(basename "$PKG")"
echo "  大小   : $(du -h "$PKG" | cut -f1)"
echo "  实际SHA: $ACTUAL_SHA"
echo "  期望SHA: $EXPECT_SHA"
if [ "$ACTUAL_SHA" != "$EXPECT_SHA" ]; then
  echo "  ❌ SHA256 不匹配，拒绝安装"
  exit 1
fi
echo "  ✅ 校验通过"
gzip -t "$PKG" && echo "  ✅ gzip 完整性通过"

echo
echo "== 2/5 处理已存在的 snowluma/ =="
if [ -d "$SNOW" ]; then
  # 判断是不是 Windows 构建
  if ls "$SNOW/native" 2>/dev/null | grep -q win32 || [ -f "$SNOW/node.exe" ]; then
    echo "  检测到 Windows 构建，移到 snowluma.win-backup"
    rm -rf "$SNOW.win-backup"
    mv "$SNOW" "$SNOW.win-backup"
  else
    echo "  已有非 Windows 构建，直接覆盖"
    rm -rf "$SNOW"
  fi
else
  echo "  目标不存在，全新安装"
fi

echo
echo "== 3/5 解包到 $SNOW =="
mkdir -p "$SNOW"
tar -xzf "$PKG" -C "$SNOW" --strip-components=1
echo "  解包完成"

echo
echo "== 4/5 关键项核对 =="
for f in index.mjs node launcher.sh; do
  if [ -e "$SNOW/$f" ]; then
    printf "  ✅ %-14s %s 字节\n" "$f" "$(stat -c%s "$SNOW/$f")"
  else
    printf "  ❌ %-14s 缺失\n" "$f"
  fi
done
echo
echo "  native/ 内容（应为 linux-x64）："
ls -1 "$SNOW/native" 2>/dev/null | sed 's/^/    /' || echo "    (无 native 目录)"
echo
echo "  自带 Node 版本: $("$SNOW/node" --version 2>/dev/null || echo '无法执行（可能是架构不符）')"

echo
echo "== 5/5 Windows 残留检查 =="
LEFTOVER=$(find "$SNOW" \( -name "*win32*" -o -name "*.bat" -o -name "node.exe" \) 2>/dev/null || true)
if [ -n "$LEFTOVER" ]; then
  echo "  ⚠️  仍有 Windows 文件："
  echo "$LEFTOVER" | sed 's/^/    /'
else
  echo "  ✅ 无 Windows 残留"
fi

echo
echo "== 目录总览 =="
ls -la "$SNOW" | sed 's/^/  /'
echo
du -sh "$SNOW"
