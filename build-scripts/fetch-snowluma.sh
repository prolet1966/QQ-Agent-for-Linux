#!/usr/bin/env bash
# fetch-snowluma.sh —— 下载官方 SnowLuma Linux 协议端并放入 app/snowluma/
#
# 目标要求「包含官方 SnowLuma Linux 协议端（linux-x64 完整版）」。
# 原安装版自带的 snowluma/ 是 Windows 构建（node.exe + *-win32-x64.node + launcher.bat），
# 在 Linux 上完全不可用，必须整体替换。
#
# 版本选择：与 V0.4.4 安装版同版本线（v1.14.19），避免因版本错配导致注入失败。
# 采用「完整版」而非「lite 版」：
#   完整版自带 Node 运行时（约 45MB），部署方不必另装 Node；
#   lite 版依赖系统 Node.js 22.13+ / 23.4+，会额外增加部署约束。

set -euo pipefail

VERSION="${SNOWLUMA_VERSION:-v1.14.19}"
ARCH="linux-x64"
APP="$HOME/qq-agent-linux/app"
SNOW_DIR="$APP/snowluma"
TARBALL="/tmp/snowluma-${VERSION}-${ARCH}.tar.gz"
URL="https://github.com/SnowLuma/SnowLuma/releases/download/${VERSION}/SnowLuma-${VERSION}-${ARCH}.tar.gz"

echo "== SnowLuma Linux 协议端获取 =="
echo "  版本 : $VERSION"
echo "  平台 : $ARCH"
echo "  来源 : $URL"
echo "  目标 : $SNOW_DIR"

echo
echo "== 1. 备份原 Windows 版（若存在）=="
if [ -d "$SNOW_DIR" ] && [ ! -d "${SNOW_DIR}.win-backup" ]; then
  mv "$SNOW_DIR" "${SNOW_DIR}.win-backup"
  echo "  原目录已重命名为 snowluma.win-backup（保留以便核对）"
else
  echo "  无需备份或备份已存在"
fi

echo
echo "== 2. 下载 =="
if [ -f "$TARBALL" ]; then
  echo "  已存在缓存: $TARBALL ($(du -h "$TARBALL" | cut -f1))"
else
  # GitHub releases 的下载会 302 到 objects.githubusercontent.com
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 \
       -o "$TARBALL" "$URL" \
       -w "  HTTP=%{http_code}  大小=%{size_download} 字节  用时=%{time_total}s\n"
fi

echo
echo "== 3. 校验下载完整性 =="
if ! gzip -t "$TARBALL" 2>/dev/null; then
  echo "  ❌ 不是有效的 gzip 文件，下载可能不完整或被拦截"
  exit 1
fi
echo "  ✅ gzip 校验通过，大小 $(du -h "$TARBALL" | cut -f1)"

echo
echo "== 4. 解包到 $SNOW_DIR =="
mkdir -p "$SNOW_DIR"
tar -xzf "$TARBALL" -C "$SNOW_DIR" --strip-components=1

echo
echo "== 5. 解包结果 =="
ls -la "$SNOW_DIR" | sed 's/^/  /'

echo
echo "== 6. 关键项核对 =="
for f in index.mjs node launcher.sh; do
  if [ -e "$SNOW_DIR/$f" ]; then
    if [ -x "$SNOW_DIR/$f" ] || [ "$f" = "index.mjs" ]; then
      printf "  ✅ %-14s %s\n" "$f" "$(stat -c%s "$SNOW_DIR/$f") 字节"
    else
      printf "  ⚠️  %-14s 存在但不可执行，正在补 +x\n" "$f"
      chmod +x "$SNOW_DIR/$f"
    fi
  else
    printf "  ❌ %-14s 缺失\n" "$f"
  fi
done

echo
echo "  native/ 下的原生件（应为 linux-x64）："
ls -1 "$SNOW_DIR/native" 2>/dev/null | sed 's/^/    /' || echo "    (无 native/ 目录)"

echo
echo "  自带 Node 版本: $("$SNOW_DIR/node" --version 2>/dev/null || echo '无法执行')"

echo
echo "== 7. 残留 Windows 件检查 =="
if find "$SNOW_DIR" -name "*win32*" -o -name "*.bat" -o -name "node.exe" 2>/dev/null | grep -q .; then
  echo "  ⚠️  仍存在 Windows 专用文件："
  find "$SNOW_DIR" \( -name "*win32*" -o -name "*.bat" -o -name "node.exe" \) 2>/dev/null | sed 's/^/    /'
else
  echo "  ✅ 无 Windows 残留"
fi

echo
echo "== 完成 =="
du -sh "$SNOW_DIR"
