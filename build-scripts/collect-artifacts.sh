#!/usr/bin/env bash
# collect-artifacts.sh —— 把 WSL 里构建好的安装包与校验和收回到 Windows 工作区。
#
# 为什么必须收回：WSL 的 /tmp 今天被清过多次，整个发行版也可能被重置。
# 构建产物只留在 WSL 里等于没交付。工作区（F:）才是持久位置。
#
# 同时生成 SHA256SUMS.txt —— 用户下载后可以自行核对完整性，
# 这在通过 QQ 群 / 网盘分发时尤其重要。

set -euo pipefail

DIST="$HOME/qq-agent-linux/app/dist"
OUT="/mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/dist"

echo "== 1. 准备输出目录 =="
mkdir -p "$OUT"
echo "  $OUT"

echo
echo "== 2. 拷贝产物 =="
for f in "$DIST"/*.deb "$DIST"/*.rpm "$DIST"/*.AppImage; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  printf "  %-42s %s ... " "$name" "$(du -h "$f" | cut -f1)"
  cp -f "$f" "$OUT/$name"
  # 校验拷贝完整性：两边 sha256 必须一致
  a=$(sha256sum "$f" | awk '{print $1}')
  b=$(sha256sum "$OUT/$name" | awk '{print $1}')
  if [ "$a" = "$b" ]; then echo "✅"; else echo "❌ 校验失败"; exit 1; fi
done

echo
echo "== 3. 生成 SHA256SUMS.txt =="
cd "$OUT"
sha256sum *.deb *.rpm *.AppImage 2>/dev/null | tee SHA256SUMS.txt | sed 's/^/  /'

echo
echo "== 4. 连同构建脚本一起收回（便于在别的机器复现）=="
SCRIPTS_OUT="$OUT/../build-scripts"
mkdir -p "$SCRIPTS_OUT"
cp -f /mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/app/build-scripts/*.sh "$SCRIPTS_OUT/" 2>/dev/null || true
echo "  已拷至 $(cd "$SCRIPTS_OUT" && pwd)：$(ls "$SCRIPTS_OUT" | wc -l) 个脚本"

echo
echo "== 5. 最终清单 =="
ls -la --time-style=+"%m-%d %H:%M" "$OUT" | tail -n +2 | awk '{printf "  %-44s %12s  %s %s\n", $NF, $5, $6, $7}'
echo
echo "  总计: $(du -sh "$OUT" | cut -f1)"
