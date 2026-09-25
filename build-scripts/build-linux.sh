#!/usr/bin/env bash
# build-linux.sh —— 在 WSL 内安装依赖并构建 Linux 安装包。
#
# 前置：
#   · 源码已同步到 $HOME/qq-agent-linux/app（见 setup-src.sh）
#   · Linux 版 SnowLuma 已放入 app/snowluma/（见 fetch-snowluma.sh）
#
# 产出：$HOME/qq-agent-linux/dist/ 下的 .deb / .rpm / .AppImage
#
# 注意 electron-builder 的两个现实约束：
#   1. 首次运行要下载 Electron 二进制（约 100MB+），走 npmmirror 镜像更快
#   2. rpm 目标需要 rpm 与 rpmbuild；deb 目标需要 dpkg/fakeroot（WSL 默认已有）

set -uo pipefail

APP="$HOME/qq-agent-linux/app"
DIST="$HOME/qq-agent-linux/dist"
LOG="$HOME/qq-agent-linux/build.log"

mkdir -p "$HOME/qq-agent-linux"
exec > >(tee -a "$LOG") 2>&1

echo "############ 构建开始 $(date '+%F %T') ############"
cd "$APP" || { echo "源码目录不存在: $APP"; exit 1; }

echo
echo "=== 0. 环境 ==="
echo "  node : $(node -v)"
echo "  npm  : $(npm -v)"
echo "  arch : $(uname -m)"
echo "  npm registry: $(npm config get registry)"
echo "  ELECTRON_MIRROR: ${ELECTRON_MIRROR:-（未设置）}"

# 国内镜像：Electron 与 electron-builder 的二进制都从这里取，否则大概率超时
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"

echo
echo "=== 1. SnowLuma 检查 ==="
if [ -d "$APP/snowluma" ] && [ -f "$APP/snowluma/index.mjs" ]; then
  echo "  snowluma/ 存在，index.mjs 就位"
  echo "  原生件："
  ls -1 "$APP/snowluma/native" 2>/dev/null | sed 's/^/    /'
  if ls "$APP/snowluma/native" 2>/dev/null | grep -q "win32"; then
    echo "  ⚠️  警告：native/ 下仍有 Windows 原生件，Linux 上不可用"
  fi
  if [ -f "$APP/snowluma/node" ]; then
    echo "  ✅ 自带 Linux node 运行时存在"
  else
    echo "  ⚠️  没有 snowluma/node，将依赖系统 node 或 Electron 内置 Node"
  fi
else
  echo "  ⚠️  snowluma/ 缺失或不完整 —— 先运行 fetch-snowluma.sh"
  echo "      （构建仍会继续，以便先验证打包链路本身）"
fi

echo
echo "=== 2. npm install ==="
if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  echo "  node_modules 已存在，跳过安装"
else
  npm install --no-audit --no-fund --loglevel=error
  echo "  npm install 退出码: $?"
fi
echo "  已装依赖:"
ls node_modules 2>/dev/null | head -20 | sed 's/^/    /'

echo
echo "=== 3. 平台层测试（构建前先确认代码自洽）==="
node test/platform-test.mjs 2>&1 | tail -4

echo
echo "=== 4. electron-builder 构建 deb / rpm / AppImage ==="
rm -rf "$DIST"
npx electron-builder --linux deb rpm AppImage --x64 --publish never
BUILD_RC=$?
echo "  electron-builder 退出码: $BUILD_RC"

echo
echo "=== 5. 产物清单 ==="
if [ -d "$DIST" ]; then
  find "$DIST" -maxdepth 1 -type f -printf "%10s  %p\n" 2>/dev/null | sort -k2
  echo
  echo "  各包大小："
  ls -lh "$DIST" 2>/dev/null | tail -n +2 | awk '{printf "    %-46s %s\n", $9, $5}'
else
  echo "  未生成 dist/ 目录"
fi

echo
echo "############ 构建结束 $(date '+%F %T') 退出码=$BUILD_RC ############"
exit $BUILD_RC
