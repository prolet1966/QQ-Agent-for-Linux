#!/usr/bin/env bash
# pipeline.sh —— 一条命令跑完整个 Linux 打包流程。
#
# 为什么需要它：WSL 的 /tmp 会在两次 `wsl` 调用之间被清空（实测 /tmp/qs 多次消失），
# 所以「先 bootstrap、再调用 /tmp/qs/xxx.sh」的两步式做法不可靠。
# 本脚本从 F: 盘直接读取自己需要的所有脚本，不依赖 /tmp 里预先存在的东西，
# 且每一步都幂等：已完成的步骤会跳过，中断后重跑不会重做无用功。
#
# 用法（在 Windows PowerShell 里，一条命令）：
#   wsl -d Ubuntu -- bash /mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/app/build-scripts/pipeline.sh
#
# 阶段可用环境变量控制（默认全跑）：
#   SKIP_NPM=1     跳过 npm install
#   SKIP_BUILD=1   跳过 electron-builder

set -uo pipefail

WIN_ROOT="/mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port"
APP="$HOME/qq-agent-linux/app"
DIST="$APP/dist"

echo "############ pipeline 开始 $(date '+%F %T') ############"

# ── 阶段 0：确认脚本自身可读（WSL 直接跑 F: 上的文件）────────────────────
echo
echo "== 阶段 0：环境 =="
echo "  发行版 : $(. /etc/os-release && echo "$PRETTY_NAME")"
echo "  架构   : $(uname -m)"
echo "  node   : $(node -v)  npm: $(npm -v)"
echo "  磁盘   : $(df -h /home | tail -1 | awk '{print $4}') 可用"

# ── 阶段 1：同步源码（幂等，保留 snowluma 与 node_modules）────────────────
echo
echo "== 阶段 1：同步源码 =="
if [ -d "$WIN_ROOT/app/src" ]; then
  TARBALL="/tmp/qq-pipe-src.tgz"
  tar -czf "$TARBALL" -C "$WIN_ROOT/app" \
      --exclude=./snowluma --exclude=./snowluma.win-backup \
      --exclude=./node_modules --exclude=./data --exclude=./dist .
  # 只清理代码目录，保留已装好的 snowluma/ 与 node_modules/
  for d in src electron ui plugins skills assets test build-scripts; do
    rm -rf "$APP/$d"
  done
  rm -f "$APP/package.json" "$APP/README.md" "$APP/LICENSE" "$APP/prices.json"
  mkdir -p "$APP"
  tar -xzf "$TARBALL" -C "$APP"
  rm -f "$TARBALL"
  echo "  已同步，app 文件数: $(find "$APP" -type f -not -path '*/node_modules/*' | wc -l)"
else
  echo "  ⚠️  源目录不可读，跳过同步（沿用 WSL 内现有源码）"
fi

# ── 阶段 2：确保 Linux 版 SnowLuma 就位（幂等）───────────────────────────
echo
echo "== 阶段 2：SnowLuma Linux 版 =="
if [ -f "$APP/snowluma/index.mjs" ] && [ -f "$APP/snowluma/node" ]; then
  echo "  已就位，跳过安装"
else
  echo "  未就位，开始安装"
  PKG="$WIN_ROOT/SnowLuma-v1.14.19-linux-x64.tar.gz"
  EXPECT="f0cbd19809327c3959c64083a008c136d9b7538f34a6763c21415fcf9d75f7a5"
  if [ ! -f "$PKG" ]; then
    echo "  ❌ 安装包不存在: $PKG"
    echo "     下载方式（Windows 侧，WSL 直连会断流）："
    echo "       gh release download v1.14.19 --repo SnowLuma/SnowLuma \\"
    echo "         --pattern 'SnowLuma-v1.14.19-linux-x64.tar.gz' \\"
    echo "         --dir '$WIN_ROOT' --clobber"
    exit 1
  fi
  ACTUAL=$(sha256sum "$PKG" | awk '{print $1}')
  if [ "$ACTUAL" != "$EXPECT" ]; then
    echo "  ❌ SHA256 不匹配"
    echo "     实际: $ACTUAL"
    echo "     期望: $EXPECT"
    exit 1
  fi
  echo "  ✅ SHA256 校验通过"
  rm -rf "$APP/snowluma"
  mkdir -p "$APP/snowluma"
  tar -xzf "$PKG" -C "$APP/snowluma" --strip-components=1
fi
echo "  index.mjs : $(stat -c%s "$APP/snowluma/index.mjs" 2>/dev/null) 字节"
echo "  自带 node : $("$APP/snowluma/node" --version 2>/dev/null)"
echo "  native/   : $(ls "$APP/snowluma/native" 2>/dev/null | tr '\n' ' ')"

# ── 阶段 3：npm install（幂等）──────────────────────────────────────────
cd "$APP"
if [ "${SKIP_NPM:-0}" = "1" ]; then
  echo
  echo "== 阶段 3：npm install（已按要求跳过）=="
elif [ -d node_modules/electron ] && [ -d node_modules/electron-builder ]; then
  echo
  echo "== 阶段 3：npm install（依赖已存在，跳过）=="
  echo "  electron: $(node -p "require('./node_modules/electron/package.json').version" 2>/dev/null)"
else
  echo
  echo "== 阶段 3：npm install =="
  export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
  npm install --no-audit --no-fund --loglevel=error
  echo "  npm install 退出码: $?"
fi

# ── 阶段 4：构建前自检 ──────────────────────────────────────────────────
echo
echo "== 阶段 4：构建前自检 =="
node test/platform-test.mjs 2>&1 | tail -3
echo "  package.json 关键字段："
node -e "
const j=require('./package.json');
console.log('    electron     :', j.devDependencies.electron, /[\^~]/.test(j.devDependencies.electron)?'(⚠️ 范围会导致构建失败)':'✅ 精确');
console.log('    author       :', typeof j.author==='object'? j.author.name : j.author);
console.log('    maintainer   :', j.build.linux.maintainer || (typeof j.maintainer==='object'? j.maintainer.email : '(缺失，deb 会失败)'));
console.log('    targets      :', j.build.linux.target.map(t=>t.target).join(', '));
"

# ── 阶段 5：构建 ────────────────────────────────────────────────────────
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo
  echo "== 阶段 5：构建（已按要求跳过）=="
else
  echo
  echo "== 阶段 5：electron-builder 构建 deb / rpm / AppImage =="
  export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
  rm -rf "$DIST"
  npx electron-builder --linux deb rpm AppImage --x64 --publish never
  echo "  electron-builder 退出码: $?"
fi

# ── 阶段 6：产物清单 ────────────────────────────────────────────────────
echo
echo "== 阶段 6：产物 =="
if [ -d "$DIST" ]; then
  ls -lh "$DIST" | tail -n +2 | awk '{printf "  %-48s %s\n", $9, $5}'
else
  echo "  dist/ 不存在"
fi

echo
echo "############ pipeline 结束 $(date '+%F %T') ############"
