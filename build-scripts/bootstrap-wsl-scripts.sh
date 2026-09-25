#!/usr/bin/env bash
# bootstrap-wsl-scripts.sh —— 把 Windows 工作区的构建脚本同步到 WSL 的 /tmp/qs/
#
# 为什么需要它：从 PowerShell 调 `wsl -- bash -c '...'` 时，脚本里的 $VAR 会被
# PowerShell 先展开，for 循环与转义又极易出错（实测踩过多次）。
# 这里把「复制 + 转换行尾 + 加执行位」全部放进文件，外层只传一条不含变量的命令。
#
# 另外把 /tmp/qs 先删后建：昨天观察到它被别的东西创建成了一个普通文件，
# 导致 cp 失败。

set -euo pipefail

SRC_DIR="/mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/app/build-scripts"
DST_DIR="/tmp/qs"

echo "[bootstrap] 源: $SRC_DIR"
[ -d "$SRC_DIR" ] || { echo "  源目录不存在"; exit 1; }

# 先清掉可能存在的同名文件（不是目录）或旧目录
rm -rf "$DST_DIR"
mkdir -p "$DST_DIR"

cp "$SRC_DIR"/*.sh "$DST_DIR"/

# Windows 上写的文件可能是 CRLF；bash 对 CRLF 极其敏感（shebang、case 都会坏）
for f in "$DST_DIR"/*.sh; do
  sed -i 's/\r$//' "$f"
done
chmod 755 "$DST_DIR"/*.sh

echo "[bootstrap] 完成，脚本清单："
ls -la "$DST_DIR" | sed 's/^/  /'
