#!/usr/bin/env bash
# vm-02-smoke.sh —— 在真实 Ubuntu 虚拟机里安装 .deb 并跑冒烟测试。
#
# 与 WSL 里那份 smoke-test.sh 的区别（为什么要重测一遍）：
#   WSL 不是真机：没有完整 systemd 用户会话、图形栈残缺、内核参数行为不同。
#   真实 VM 能验出 WSL 验不出的东西，尤其是：
#     · dpkg 的依赖解析是否真的能装上（WSL 里我手动补过依赖）
#     · 数据目录在真实 HOME 下的落点
#     · 图形环境存在时，Electron 能否真的起一个窗口进程
#
# 判据分两类，必须分清（不然会把环境问题误判成包的问题）：
#   包本身：文件布局、协议端解包、Electron 运行时、可执行位、XDG 落点
#   环境前提：图形环境、系统 QQ、ptrace_scope —— 缺了不算包的错
#
# 用法：bash vm-02-smoke.sh /path/to/洛版-for-Linux.deb

set -uo pipefail

DEB="${1:-}"
PASS=0; FAIL=0; ENVWARN=0
declare -a RESULTS ENVNOTES

check() {
  if [ "$2" = "1" ]; then PASS=$((PASS+1)); RESULTS+=("  ✅ $1${3:+  ($3)}")
  else FAIL=$((FAIL+1)); RESULTS+=("  ❌ $1${3:+  ($3)}"); fi
}
envnote() { ENVWARN=$((ENVWARN+1)); ENVNOTES+=("  ⚠️  $1${2:+  ($2)}"); }

[ -n "$DEB" ] && [ -f "$DEB" ] || { echo "用法: bash $0 <deb路径>"; exit 2; }

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/qq-agent"

echo "############ .deb 冒烟测试（真实虚拟机）$(date '+%F %T') ############"
echo "  包  : $(basename "$DEB")"
echo "  HOME: $HOME"
echo "  数据目录预期: $DATA_DIR"

# ── 0. 干净起点 ────────────────────────────────────────────────────────────
echo
echo "== 0. 清理上次残留 =="
sudo dpkg -r qq-agent >/dev/null 2>&1 || true
sudo apt-get -qq autoremove -y >/dev/null 2>&1 || true
rm -rf "$DATA_DIR" 2>/dev/null || true
echo "  完成"

# ── 1. 安装 ────────────────────────────────────────────────────────────────
echo
echo "== 1. 安装（apt，含依赖解析）=="
INSTALL_LOG=$(sudo apt-get install -y "$DEB" 2>&1)
RC=$?
echo "$INSTALL_LOG" | grep -E "Setting up|Unpacking|update-alternatives|^E:|error" | sed 's/^/  /'
check "apt 安装成功" "$([ $RC -eq 0 ] && echo 1 || echo 0)" "退出码 $RC"

echo
echo "== 2. 包注册与文件布局 =="
ST=$(dpkg-query -W -f='${Status}' qq-agent 2>/dev/null || echo missing)
check "dpkg 状态为 installed" "$(echo "$ST" | grep -q 'install ok installed' && echo 1 || echo 0)" "$ST"

EXE=$(dpkg -L qq-agent 2>/dev/null | grep -E '/opt/.*/qq-agent$' | head -1)
check "主程序存在" "$([ -n "$EXE" ] && [ -f "$EXE" ] && echo 1 || echo 0)" "${EXE:-无}"
if [ -n "$EXE" ]; then
  check "主程序可执行" "$([ -x "$EXE" ] && echo 1 || echo 0)"
  check "为 x86-64 ELF" "$(file -b "$EXE" | grep -q 'x86-64' && echo 1 || echo 0)"
fi

DESKTOP=$(dpkg -L qq-agent 2>/dev/null | grep '\.desktop$' | head -1)
check ".desktop 已安装" "$([ -n "$DESKTOP" ] && [ -f "$DESKTOP" ] && echo 1 || echo 0)" "${DESKTOP##*/}"
[ -n "$DESKTOP" ] && grep -E '^(Name|Exec|Icon|Categories)=' "$DESKTOP" | sed 's/^/      /'

# ── 3. 内置协议端与运行时 ──────────────────────────────────────────────────
echo
echo "== 3. 内置 SnowLuma 与 Electron（目标硬要求）=="
if [ -n "$EXE" ]; then
  RES="$(dirname "$EXE")/resources"
  SNOW="$RES/app.asar.unpacked/snowluma"
  check "SnowLuma 已解包到 asar 之外" "$([ -d "$SNOW" ] && echo 1 || echo 0)"
  check "index.mjs 存在" "$([ -f "$SNOW/index.mjs" ] && echo 1 || echo 0)"
  check "自带 node 可执行" "$([ -x "$SNOW/node" ] && echo 1 || echo 0)"
  NODEV=$("$SNOW/node" --version 2>/dev/null || echo FAIL)
  check "自带 node 可运行" "$(echo "$NODEV" | grep -q '^v' && echo 1 || echo 0)" "$NODEV"
  check "native/snowluma-linux-x64.node" "$([ -f "$SNOW/native/snowluma-linux-x64.node" ] && echo 1 || echo 0)"
  check "无 Windows 残留" "$(find "$SNOW" \( -name '*win32*' -o -name '*.bat' -o -name 'node.exe' \) 2>/dev/null | grep -q . && echo 0 || echo 1)"
  check "Electron 运行时完整" "$([ -f "$RES/app.asar" ] && [ -f "$(dirname "$EXE")/libEGL.so" ] && echo 1 || echo 0)"
fi

# ── 4. ★ 数据目录 XDG 落点（移植的核心验收点）─────────────────────────────
echo
echo "== 4. ★ 数据目录遵循 XDG（本次移植的核心验收点）=="
echo "  启动前存在? $([ -d "$DATA_DIR" ] && echo 是 || echo 否)"

# 用 --version 之类快速探一下不行 —— 得真的启动。无图形时用 xvfb-run 兜底。
CMD=()
if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  CMD=("$EXE" --no-sandbox)
  MODE="直接启动（DISPLAY=${DISPLAY:-}）"
elif command -v xvfb-run >/dev/null 2>&1; then
  CMD=(xvfb-run -a "$EXE" --no-sandbox)
  MODE="xvfb-run（无图形环境，用虚拟屏）"
else
  MODE=""
fi
echo "  启动方式: ${MODE:-无法启动（无图形且无 xvfb）}"

if [ -n "$MODE" ]; then
  timeout 40 "${CMD[@]}" > /tmp/qa-vm-smoke.log 2>&1
  LAUNCH_RC=$?
  echo "  启动退出码: $LAUNCH_RC（124=超时被杀，即持续存活）"

  check "数据目录已按 XDG 创建" "$([ -d "$DATA_DIR" ] && echo 1 || echo 0)" "$DATA_DIR"
  check "数据目录不在安装目录内" "$([ -d "$DATA_DIR" ] && ! echo "$DATA_DIR" | grep -q '^/opt' && echo 1 || echo 0)"
  check "包不加 sudo 即可运行" "$([ $LAUNCH_RC -ne 13 ] && echo 1 || echo 0)"

  if [ -d "$DATA_DIR" ]; then
    echo "  --- 数据目录内容 ---"
    ls -la "$DATA_DIR" | tail -n +2 | head -12 | sed 's/^/      /'
    # 属主必须是当前用户（用 sudo 跑过会让属主变 root）
    OWNER=$(stat -c '%U' "$DATA_DIR")
    check "数据目录属主是当前用户" "$([ "$OWNER" = "$(id -un)" ] && echo 1 || echo 0)" "$OWNER"
  fi

  echo "  --- 启动日志里的技能/插件加载 ---"
  grep -E "\[skill|\[plugin" /tmp/qa-vm-smoke.log 2>/dev/null | head -12 | sed 's/^/      /' || echo "      （无）"

  echo "  --- 日志里的错误（已排除 GPU/沙箱噪声）---"
  grep -iE "error|fatal|cannot find|not a function" /tmp/qa-vm-smoke.log 2>/dev/null \
    | grep -viE "gpu|zygote|network_service|crashpad|渲染进程|cpufreq" \
    | head -8 | sed 's/^/      /' || echo "      ✅ 无"
else
  envnote "无图形环境且无 xvfb，跳过启动测试" "装 xvfb 或在桌面会话里跑"
fi

# ── 5. 环境前提检查（缺了不算包的错）──────────────────────────────────────
echo
echo "== 5. 环境前提（这些缺了会导致功能不可用，但不是包的问题）=="

if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  echo "  ✅ 有图形环境（可扫码登录 QQ）"
else
  envnote "无图形环境" "扫码登录 QQ 需要在桌面会话"
fi

HASQQ=""
for p in /opt/QQ/qq /usr/bin/qq /usr/local/bin/qq /usr/lib/qq/qq; do
  [ -x "$p" ] && HASQQ="$p"
done
if [ -n "$HASQQ" ]; then
  echo "  ✅ 系统 QQ: $HASQQ"
else
  envnote "未安装 Linux 版 QQ" "协议端需要注入它，见安装指南第三节"
fi

PS=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo "N/A")
if [ "$PS" = "0" ]; then
  echo "  ✅ ptrace_scope = 0（协议端可注入）"
else
  envnote "ptrace_scope = $PS" "应为 0，否则协议端报 COMPONENT_LOAD_FAILED"
fi

# ── 6. 卸载与数据保留 ──────────────────────────────────────────────────────
echo
echo "== 6. 卸载测试 =="
sudo dpkg -r qq-agent >/dev/null 2>&1
ST2=$(dpkg-query -W -f='${Status}' qq-agent 2>/dev/null || echo missing)
check "卸载成功" "$(echo "$ST2" | grep -q 'install ok installed' && echo 0 || echo 1)" "$ST2"
check "卸载后用户数据保留" "$([ -d "$DATA_DIR" ] && echo 1 || echo 0)"

# ── 汇总 ───────────────────────────────────────────────────────────────────
echo
echo "############ 结果 ############"
for r in "${RESULTS[@]}"; do echo "$r"; done
echo
if [ ${#ENVNOTES[@]} -gt 0 ]; then
  echo "环境前提提醒（不影响上面的包验证结论）："
  for n in "${ENVNOTES[@]}"; do echo "$n"; done
  echo
fi
echo "  包相关：通过 $PASS 项，失败 $FAIL 项"
echo "  环境提醒：$ENVWARN 条"
echo "############ 结束 $(date '+%F %T') ############"
[ $FAIL -eq 0 ]
