#!/usr/bin/env bash
# rpm-smoke-test.sh —— 在 Ubuntu 上测试 .rpm 包（WSL 里装不了 rpm，用等价验证）。
#
# 为什么不能像 deb 那样直接装：
#   WSL 是 Ubuntu，包管理器是 dpkg/apt。用 `rpm -i` 装 rpm 会把文件塞进系统，
#   且 rpm 的依赖解析会因 RPM 数据库与 dpkg 并存而混乱，污染环境且难回滚。
#
# 等价验证的思路（覆盖安装后真正影响运行的要素）：
#   1. 用 rpm2cpio 解出完整文件树 —— 验证包内容与路径布局
#   2. 检查 Payload 是否完整（条目数、关键文件、可执行位）
#   3. 对照 .deb 的同一份检查清单 —— 两个包内容必须一致，否则其中一个有问题
#   4. 把解出的树按真实安装路径跑一次二进制 —— 这是最接近「真装了」的验证
#
# 已验证的局限（如实记录，不假装等价）：
#   · 没有经过 rpm 数据库注册，无法验证 pre/post 脚本在 rpm 体系下的执行
#   · 没有经过依赖解析（rpm -qpR 已单独核对依赖名，见 inspect-packages.sh）

set -uo pipefail

RPM="$HOME/qq-agent-linux/app/dist/qq-agent-v0.4.4-x86_64.rpm"
WORK="$HOME/qq-agent-linux/rpm-extract"
DATA_DIR="$HOME/.local/share/qq-agent-rpmtest"
LOG="$HOME/qq-agent-linux/rpm-smoke.log"

PASS=0; FAIL=0
declare -a RESULTS
check() {
  local name="$1" ok="$2" detail="${3:-}"
  if [ "$ok" = "1" ]; then PASS=$((PASS+1)); RESULTS+=("  ✅ $name${detail:+  ($detail)}")
  else FAIL=$((FAIL+1)); RESULTS+=("  ❌ $name${detail:+  ($detail)}"); fi
}

echo "############ rpm 冒烟测试 $(date '+%F %T') ############"
[ -f "$RPM" ] || { echo "❌ rpm 不存在"; exit 1; }

# ── 1. 解包 ────────────────────────────────────────────────────────────────
echo
echo "== 1. 解出文件树（rpm2cpio | cpio）=="
rm -rf "$WORK"; mkdir -p "$WORK"
cd "$WORK"
if rpm2cpio "$RPM" | cpio -idm --quiet 2>/dev/null; then
  check "rpm2cpio 解包成功" "1"
else
  check "rpm2cpio 解包成功" "0"
  exit 1
fi
cd - >/dev/null
TOTAL=$(find "$WORK" -type f | wc -l)
echo "  解出文件数: $TOTAL"

# ── 2. 路径布局 ────────────────────────────────────────────────────────────
echo
echo "== 2. 安装路径布局 =="
EXE="$WORK/opt/QQ Agent/qq-agent"
echo "  主程序: ${EXE#$WORK}"
check "主程序就位" "$([ -f "$EXE" ] && echo 1 || echo 0)"
check "主程序可执行" "$([ -x "$EXE" ] && echo 1 || echo 0)"
check "主程序为 x86-64 ELF" "$(file -b "$EXE" 2>/dev/null | grep -q 'x86-64' && echo 1 || echo 0)"

DESKTOP=$(find "$WORK" -name "*.desktop" | head -1)
check ".desktop 存在" "$([ -n "$DESKTOP" ] && echo 1 || echo 0)"
if [ -n "$DESKTOP" ]; then
  echo "  --- .desktop ---"
  grep -E '^(Name|Exec|Icon|Categories|StartupWMClass)=' "$DESKTOP" | sed 's/^/    /'
fi
ICON=$(find "$WORK" -path "*icons*" -name "qq-agent.*" | head -1)
check "图标存在" "$([ -n "$ICON" ] && echo 1 || echo 0)" "${ICON:+$(basename "$ICON")}"

# ── 3. 内置 SnowLuma ──────────────────────────────────────────────────────
echo
echo "== 3. 内置 SnowLuma ==="
SNOW="$WORK/opt/QQ Agent/resources/app.asar.unpacked/snowluma"
check "snowluma 已解包" "$([ -d "$SNOW" ] && echo 1 || echo 0)"
check "index.mjs" "$([ -f "$SNOW/index.mjs" ] && echo 1 || echo 0)"
check "自带 node" "$([ -f "$SNOW/node" ] && echo 1 || echo 0)"
check "自带 node 可执行" "$([ -x "$SNOW/node" ] && echo 1 || echo 0)"
check "native/snowluma-linux-x64.node" "$([ -f "$SNOW/native/snowluma-linux-x64.node" ] && echo 1 || echo 0)"
check "native/websocket-linux-x64.node" "$([ -f "$SNOW/native/websocket-linux-x64.node" ] && echo 1 || echo 0)"
check "无 Windows 残留" "$(find "$SNOW" \( -name '*win32*' -o -name '*.bat' -o -name 'node.exe' \) 2>/dev/null | grep -q . && echo 0 || echo 1)"

# 用解出的 SnowLuma 自测：它的 node 能不能跑它的 index.mjs 的版本检查
NODEBIN="$SNOW/node"
if [ -x "$NODEBIN" ]; then
  check "自带 node 可运行" "$("$NODEBIN" --version 2>/dev/null | grep -q '^v' && echo 1 || echo 0)" "$("$NODEBIN" --version 2>/dev/null)"
fi

# ── 4. 与 .deb 内容对照 ───────────────────────────────────────────────────
echo
echo "== 4. 与 .deb 内容对照（两个包必须一致）=="
DEB="$HOME/qq-agent-linux/app/dist/qq-agent-v0.4.4-amd64.deb"
if [ -f "$DEB" ]; then
  DEB_WORK="/tmp/deb-extract-$$"
  rm -rf "$DEB_WORK"; mkdir -p "$DEB_WORK"
  dpkg-deb -x "$DEB" "$DEB_WORK" 2>/dev/null
  DEB_FILES=$(find "$DEB_WORK" -type f | sed "s|^$DEB_WORK||" | sort)
  RPM_FILES=$(find "$WORK" -type f | sed "s|^$WORK||" | sort)
  # .desktop 与图标路径在两个包里可能略有差异，只比对主程序与 snowluma 部分
  DEB_KEY=$(echo "$DEB_FILES" | grep -E "app\.asar|snowluma" | sort)
  RPM_KEY=$(echo "$RPM_FILES" | grep -E "app\.asar|snowluma" | sort)
  D_N=$(echo "$DEB_KEY" | grep -c . || true)
  R_N=$(echo "$RPM_KEY" | grep -c . || true)
  echo "  deb 关键条目: $D_N   rpm 关键条目: $R_N"
  DIFF=$(diff <(echo "$DEB_KEY") <(echo "$RPM_KEY") | head -10 || true)
  if [ "$D_N" = "$R_N" ] && [ -z "$DIFF" ]; then
    check "两包 app.asar/snowluma 内容一致" "1" "$D_N 条"
  else
    check "两包 app.asar/snowluma 内容一致" "0" "deb=$D_N rpm=$R_N"
    echo "$DIFF" | sed 's/^/      /'
  fi
  rm -rf "$DEB_WORK"
else
  echo "  .deb 不存在，跳过对照"
fi

# ── 5. 真实执行（最接近「装上了」的验证）──────────────────────────────────
echo
echo "== 5. 用解出的文件树真实启动一次 =="
echo "  （直接跑解出的二进制；Electron 靠自身目录定位资源，所以能反映安装后的行为）"
rm -rf "$DATA_DIR"
export QQ_AGENT_DATA_DIR="$DATA_DIR"

DISPLAY_OK=0
if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  CMD=("$EXE" --no-sandbox --disable-gpu)
  DISPLAY_OK=1
  echo "  启动方式: 直接启动（DISPLAY=${DISPLAY:-}）"
elif command -v xvfb-run >/dev/null 2>&1; then
  CMD=(xvfb-run -a "$EXE" --no-sandbox --disable-gpu)
  DISPLAY_OK=1
  echo "  启动方式: xvfb-run"
else
  CMD=()
  echo "  启动方式: 无图形环境"
fi

if [ $DISPLAY_OK -eq 1 ]; then
  timeout 25 "${CMD[@]}" > "$LOG" 2>&1 &
  APP_PID=$!
  for i in $(seq 1 25); do sleep 1; [ -d "$DATA_DIR" ] && break; done
  sleep 2
  ALIVE=$(kill -0 "$APP_PID" 2>/dev/null && echo 1 || echo 0)
  kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true
  pkill -f "rpm-extract" 2>/dev/null || true

  check "进程启动存活" "$ALIVE"
  check "数据目录创建于 XDG 位置" "$([ -d "$DATA_DIR" ] && echo 1 || echo 0)" "$DATA_DIR"
  check "数据目录不在解包目录内" "$([ -d "$DATA_DIR" ] && ! echo "$DATA_DIR" | grep -q "$WORK" && echo 1 || echo 0)"

  echo "  --- 启动日志关键行 ---"
  grep -E "skill:|window|QQ Agent|数据目录|platform|平台" "$LOG" 2>/dev/null | head -12 | sed 's/^/    /' || true
  echo "  --- 日志末尾 ---"
  tail -8 "$LOG" 2>/dev/null | sed 's/^/    /'
else
  check "可启动" "0" "无图形环境"
fi

# ── 汇总 ───────────────────────────────────────────────────────────────────
echo
echo "############ rpm 冒烟结果 ############"
for r in "${RESULTS[@]}"; do echo "$r"; done
echo
echo "  通过 $PASS 项，失败 $FAIL 项"
echo "############ 结束 $(date '+%F %T') ############"
[ $FAIL -eq 0 ]
