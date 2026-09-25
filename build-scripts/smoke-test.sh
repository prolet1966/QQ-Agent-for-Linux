#!/usr/bin/env bash
# smoke-test.sh —— 在 WSL 真机安装 .deb 并做冒烟测试。
#
# 目标原文要求：「两者在 WSL 真机安装并跑通冒烟测试无误后，再制作通用版 AppImage」。
# 所以这不是可选项，必须真的装、真的跑。
#
# 冒烟测试要验的是「移植改造是否真的生效」，而不是「界面好不好看」：
#   1. 包能装上
#   2. 可执行文件就位、架构正确
#   3. .desktop 集成正确
#   4. 数据目录落在 XDG 位置（不在安装目录内）—— 这是 B-1 的验收点
#   5. 程序能启动到「连协议端」这一步
#
# 关于图形环境：WSLg 提供 DISPLAY。若不可用，用 xvfb-run 兜底。
# 无论哪种，都只验「进程能起来且不立刻崩」，不验界面。

set -uo pipefail

DEB="$HOME/qq-agent-linux/app/dist/qq-agent-v0.4.4-amd64.deb"
DATA_DIR="$HOME/.local/share/qq-agent"
LOG="$HOME/qq-agent-linux/smoke.log"

PASS=0
FAIL=0
declare -a RESULTS

check() {
  local name="$1" ok="$2" detail="${3:-}"
  if [ "$ok" = "1" ]; then
    PASS=$((PASS+1)); RESULTS+=("  ✅ $name${detail:+  ($detail)}")
  else
    FAIL=$((FAIL+1)); RESULTS+=("  ❌ $name${detail:+  ($detail)}")
  fi
}

echo "############ 冒烟测试开始 $(date '+%F %T') ############"
echo "  包: $(basename "$DEB")"

# ── 0. 前置 ────────────────────────────────────────────────────────────────
[ -f "$DEB" ] || { echo "❌ .deb 不存在: $DEB"; exit 1; }

echo
echo "== 0. 清理上次安装（保证是干净环境）=="
sudo dpkg -r qq-agent >/dev/null 2>&1 || true
rm -rf "$DATA_DIR" /tmp/smoke-data
echo "  已清理"

# ── 1. 安装 ────────────────────────────────────────────────────────────────
echo
echo "== 1. 安装 .deb（走 apt 以便自动解依赖）=="
INSTALL_OUT=$(sudo apt-get install -y -qq "$DEB" 2>&1)
INSTALL_RC=$?
echo "$INSTALL_OUT" | tail -12 | sed 's/^/  /'
check "apt 安装成功" "$([ $INSTALL_RC -eq 0 ] && echo 1 || echo 0)" "退出码 $INSTALL_RC"

# ── 2. 包状态 ──────────────────────────────────────────────────────────────
echo
echo "== 2. 包状态与文件布局 =="
STATUS=$(dpkg-query -W -f='${Status}' qq-agent 2>/dev/null || echo "missing")
echo "  dpkg status: $STATUS"
check "dpkg 状态为 installed" "$(echo "$STATUS" | grep -q 'install ok installed' && echo 1 || echo 0)"

EXE=$(dpkg -L qq-agent 2>/dev/null | grep -E '/opt/.*/qq-agent$' | head -1)
echo "  主程序路径: ${EXE:-未找到}"
check "主程序存在" "$([ -n "$EXE" ] && [ -f "$EXE" ] && echo 1 || echo 0)" "${EXE:-无}"
if [ -n "$EXE" ]; then
  check "主程序可执行" "$([ -x "$EXE" ] && echo 1 || echo 0)"
  check "主程序为 x86-64 ELF" "$(file -b "$EXE" | grep -q 'x86-64' && echo 1 || echo 0)"
fi

DESKTOP=$(dpkg -L qq-agent 2>/dev/null | grep '\.desktop$' | head -1)
echo "  .desktop: ${DESKTOP:-未找到}"
check ".desktop 已安装" "$([ -n "$DESKTOP" ] && [ -f "$DESKTOP" ] && echo 1 || echo 0)"
if [ -n "$DESKTOP" ]; then
  echo "  --- .desktop 内容 ---"
  grep -E '^(Name|Exec|Icon|Categories|Comment|StartupWMClass)=' "$DESKTOP" 2>/dev/null | sed 's/^/    /'
  check ".desktop 有 Exec" "$(grep -q '^Exec=' "$DESKTOP" && echo 1 || echo 0)"
  check ".desktop 有 Icon" "$(grep -q '^Icon=' "$DESKTOP" && echo 1 || echo 0)"
fi

ICON=$(dpkg -L qq-agent 2>/dev/null | grep -E 'icons/.*/qq-agent\.(png|svg)$' | head -1)
check "图标已安装" "$([ -n "$ICON" ] && echo 1 || echo 0)" "${ICON:-无}"

# ── 3. 内置 SnowLuma（目标硬要求）─────────────────────────────────────────
echo
echo "== 3. 内置 SnowLuma Linux 协议端 =="
RES=$(dirname "$EXE"); RES="$RES/resources"
SNOW="$RES/app.asar.unpacked/snowluma"
echo "  路径: $SNOW"
if [ -d "$SNOW" ]; then
  check "snowluma 已解包（非 asar 内）" "1"
  check "index.mjs 存在" "$([ -f "$SNOW/index.mjs" ] && echo 1 || echo 0)"
  check "自带 node 存在" "$([ -f "$SNOW/node" ] && echo 1 || echo 0)"
  check "自带 node 可执行" "$([ -x "$SNOW/node" ] && echo 1 || echo 0)"
  NODEVER=$("$SNOW/node" --version 2>/dev/null || echo "无法执行")
  check "自带 node 可运行" "$(echo "$NODEVER" | grep -q '^v' && echo 1 || echo 0)" "$NODEVER"
  NAT="$SNOW/native"
  check "native/snowluma-linux-x64.node" "$([ -f "$NAT/snowluma-linux-x64.node" ] && echo 1 || echo 0)"
  check "native/websocket-linux-x64.node" "$([ -f "$NAT/websocket-linux-x64.node" ] && echo 1 || echo 0)"
  check "无 Windows 残留" "$(find "$SNOW" \( -name '*win32*' -o -name '*.bat' -o -name 'node.exe' \) 2>/dev/null | grep -q . && echo 0 || echo 1)"
else
  check "snowluma 已解包" "0" "目录不存在"
fi

# ── 4. Linux 版 Electron 运行时 ───────────────────────────────────────────
echo
echo "== 4. 内置 Electron 运行时 =="
check "chrome-sandbox 存在" "$([ -f "$RES/../chrome-sandbox" ] && echo 1 || echo 0)"
check "libEGL.so 存在" "$([ -f "$RES/../libEGL.so" ] && echo 1 || echo 0)"
check "resources/app.asar 存在" "$([ -f "$RES/app.asar" ] && echo 1 || echo 0)"

# ── 5. ⭐ 数据目录 XDG 落点（B-1 的验收点）────────────────────────────────
echo
echo "== 5. 数据目录 XDG 规范（本次移植的核心验收点）=="
echo "  预期: $DATA_DIR"
echo "  初始存在? $([ -d "$DATA_DIR" ] && echo 是 || echo 否)"

# 启动一次，看它是否把数据建到 XDG 位置
DISPLAY_MODE=""
if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  DISPLAY_MODE="直接启动（有 DISPLAY=${DISPLAY:-}）"
  CMD=("$EXE")
elif command -v xvfb-run >/dev/null 2>&1; then
  DISPLAY_MODE="xvfb-run（无 DISPLAY，用虚拟屏）"
  CMD=(xvfb-run -a "$EXE")
else
  DISPLAY_MODE="无图形环境且无 xvfb"
  CMD=()
fi
echo "  启动方式: $DISPLAY_MODE"

if [ ${#CMD[@]} -gt 0 ]; then
  echo "  启动中（最多等 25 秒）..."
  timeout 25 "${CMD[@]}" --no-sandbox --disable-gpu > "$LOG" 2>&1 &
  APP_PID=$!
  # 轮询等待数据目录出现
  for i in $(seq 1 25); do
    sleep 1
    [ -d "$DATA_DIR" ] && break
  done
  # 让它多跑一会儿再收
  sleep 2
  ALIVE=$(kill -0 "$APP_PID" 2>/dev/null && echo 1 || echo 0)
  kill "$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
  pkill -f "app.asar" 2>/dev/null || true

  check "进程曾启动存活" "$ALIVE" "存活=$ALIVE"
  check "数据目录已创建于 XDG 位置" "$([ -d "$DATA_DIR" ] && echo 1 || echo 0)"
  check "数据目录不在安装目录内" "$([ -d "$DATA_DIR" ] && ! echo "$DATA_DIR" | grep -q '/opt/' && echo 1 || echo 0)"

  if [ -d "$DATA_DIR" ]; then
    echo "  --- 数据目录内容 ---"
    ls -la "$DATA_DIR" | head -14 | sed 's/^/    /'
  fi

  echo "  --- 启动日志（末尾 25 行）---"
  tail -25 "$LOG" 2>/dev/null | sed 's/^/    /'
else
  check "有图形环境可启动" "0" "$DISPLAY_MODE"
fi

# ── 6. 卸载 ────────────────────────────────────────────────────────────────
echo
echo "== 6. 卸载测试（保留用户数据）=="
sudo dpkg -r qq-agent >/dev/null 2>&1
ST2=$(dpkg-query -W -f='${Status}' qq-agent 2>/dev/null || echo "missing")
check "卸载成功" "$(echo "$ST2" | grep -q 'install ok installed' && echo 0 || echo 1)" "$ST2"
check "用户数据未被删除" "$([ -d "$DATA_DIR" ] && echo 1 || echo 0)" "卸载不该动用户数据"

# ── 汇总 ───────────────────────────────────────────────────────────────────
echo
echo "############ 冒烟测试结果 ############"
for r in "${RESULTS[@]}"; do echo "$r"; done
echo
echo "  通过 $PASS 项，失败 $FAIL 项"
echo "############ 结束 $(date '+%F %T') ############"
[ $FAIL -eq 0 ]
