#!/usr/bin/env bash
# rpm-01-smoke.sh —— 在**真正的 rpm 系发行版**上安装 .rpm 并冒烟测试。
#
# ## 为什么必须单独写一份
#
# 之前的 .rpm 是在 Ubuntu（WSL）里"等价验证"的：用 rpm2cpio 解包 + 与 .deb 对照。
# 那不是真正的 rpm 安装，以下两项**从未验证过**：
#   1. rpm 数据库注册（依赖解析、文件冲突检测）
#   2. pre/post 脚本在 rpm 体系下的执行
# 这份脚本就是来补这个缺口的。**必须在 Fedora / RHEL / Rocky / Alma 上运行**，
# 在 Debian 系上跑没有意义（装不了 rpm）。
#
# ## 环境命名差异
#   RHEL 系包名与 Debian 不同（gtk3 vs libgtk-3-0、alsa-lib vs libasound2 等），
#   所以这里用 `dnf install` 让它在本地仓库里解析，不再手工列包名。
#
# 用法：sudo bash rpm-01-smoke.sh /path/to/洛版-for-Linux.rpm
#      （其实脚本内部自己调 sudo，无需以 root 运行）

set -uo pipefail

RPM="${1:-}"
PASS=0; FAIL=0; ENVWARN=0
declare -a RESULTS ENVNOTES

check() {
  if [ "$2" = "1" ]; then PASS=$((PASS+1)); RESULTS+=("  ✅ $1${3:+  ($3)}")
  else FAIL=$((FAIL+1)); RESULTS+=("  ❌ $1${3:+  ($3)}"); fi
}
envnote() { ENVWARN=$((ENVWARN+1)); ENVNOTES+=("  ⚠️  $1${2:+  ($2)}"); }

[ -n "$RPM" ] && [ -f "$RPM" ] || { echo "用法: bash $0 <rpm路径>"; exit 2; }

# ── 前提：必须是 rpm 系发行版 ─────────────────────────────────────────────
echo "############ .rpm 真机冒烟测试 $(date '+%F %T') ############"
PM=""
command -v dnf >/dev/null 2>&1 && PM=dnf
[ -z "$PM" ] && command -v yum >/dev/null 2>&1 && PM=yum
[ -z "$PM" ] && command -v zypper >/dev/null 2>&1 && PM=zypper

if [ -z "$PM" ]; then
  echo "  ❌ 找不到 dnf / yum / zypper —— 这不是 rpm 系发行版"
  echo "     本脚本必须在 Fedora / RHEL / Rocky / Alma / openSUSE 上运行。"
  echo "     （Debian/Ubuntu 请用 vm-02-smoke.sh 测 .deb）"
  exit 2
fi
. /etc/os-release 2>/dev/null || true
echo "  发行版 : ${PRETTY_NAME:-未知}"
echo "  包管理 : $PM"
echo "  架构   : $(uname -m)"
echo "  包     : $(basename "$RPM")"

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/qq-agent"

# ── 0. 清理 ────────────────────────────────────────────────────────────────
echo
echo "== 0. 清理上次残留 =="
sudo $PM remove -y qq-agent >/dev/null 2>&1 || true
rm -rf "$DATA_DIR" 2>/dev/null || true
echo "  完成"

# ── 1. rpm 元数据（不装也能看）────────────────────────────────────────────
echo
echo "== 1. rpm 元数据 =="
if command -v rpm >/dev/null 2>&1; then
  echo "  --- 包信息 ---"
  rpm -qip "$RPM" 2>/dev/null | sed 's/^/      /'
  echo "  --- 声明的依赖 ---"
  rpm -qpR "$RPM" 2>/dev/null | sed 's/^/      /'
  check "rpm 元数据可读" "1"
else
  check "rpm 命令可用" "0" "缺 rpm 工具"
fi

# ── 2. ★ 真正安装（这是 WSL 里做不到的）──────────────────────────────────
echo
echo "== 2. ★ 真正安装（含 rpm 数据库注册与依赖解析）=="
INSTALL_LOG=$(sudo $PM install -y "$RPM" 2>&1)
RC=$?
echo "$INSTALL_LOG" | tail -25 | sed 's/^/  /'
check "安装成功" "$([ $RC -eq 0 ] && echo 1 || echo 0)" "退出码 $RC"

echo
echo "== 3. rpm 数据库已注册 =="
RPMQ=$(rpm -q qq-agent 2>/dev/null || echo "未注册")
check "rpm -q 能查到" "$(echo "$RPMQ" | grep -q '^qq-agent' && echo 1 || echo 0)" "$RPMQ"
echo "  --- 已装文件列表（前 10）---"
rpm -ql qq-agent 2>/dev/null | head -10 | sed 's/^/      /'

echo "  --- 是否有依赖问题 ---"
if rpm -V qq-agent >/dev/null 2>&1; then
  echo "      ✅ rpm -V 校验通过（文件未被改动/缺失）"
  check "rpm -V 文件校验" "1"
else
  echo "      ⚠️  rpm -V 报告差异："
  rpm -V qq-agent 2>/dev/null | head -5 | sed 's/^/         /'
  check "rpm -V 文件校验" "0"
fi

# ── 4. 文件布局 ────────────────────────────────────────────────────────────
echo
echo "== 4. 文件布局 =="
EXE=$(rpm -ql qq-agent 2>/dev/null | grep -E '/opt/.*/qq-agent$' | head -1)
check "主程序存在" "$([ -n "$EXE" ] && [ -f "$EXE" ] && echo 1 || echo 0)" "${EXE:-无}"
if [ -n "$EXE" ]; then
  check "可执行" "$([ -x "$EXE" ] && echo 1 || echo 0)"
  check "为 x86-64 ELF" "$(file -b "$EXE" | grep -q 'x86-64' && echo 1 || echo 0)"
fi
DESKTOP=$(rpm -ql qq-agent 2>/dev/null | grep '\.desktop$' | head -1)
check ".desktop 已安装" "$([ -n "$DESKTOP" ] && [ -f "$DESKTOP" ] && echo 1 || echo 0)" "${DESKTOP##*/}"

# ── 5. 内置协议端与运行时 ──────────────────────────────────────────────────
echo
echo "== 5. 内置 SnowLuma 与 Electron =="
if [ -n "$EXE" ]; then
  RES="$(dirname "$EXE")/resources"
  SNOW="$RES/app.asar.unpacked/snowluma"
  check "SnowLuma 已解包" "$([ -d "$SNOW" ] && echo 1 || echo 0)"
  check "index.mjs" "$([ -f "$SNOW/index.mjs" ] && echo 1 || echo 0)"
  check "自带 node 可执行" "$([ -x "$SNOW/node" ] && echo 1 || echo 0)"
  NODEV=$("$SNOW/node" --version 2>/dev/null || echo FAIL)
  check "自带 node 可运行" "$(echo "$NODEV" | grep -q '^v' && echo 1 || echo 0)" "$NODEV"
  check "native/snowluma-linux-x64.node" "$([ -f "$SNOW/native/snowluma-linux-x64.node" ] && echo 1 || echo 0)"
  check "无 Windows 残留" "$(find "$SNOW" \( -name '*win32*' -o -name '*.bat' -o -name 'node.exe' \) 2>/dev/null | grep -q . && echo 0 || echo 1)"
fi

# ── 6. ★ 数据目录 XDG 落点 ────────────────────────────────────────────────
echo
echo "== 6. ★ 数据目录遵循 XDG =="
CMD=""; MODE=""
if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  CMD="$EXE --no-sandbox"; MODE="直接启动（DISPLAY=${DISPLAY:-}）"
elif command -v xvfb-run >/dev/null 2>&1; then
  CMD="xvfb-run -a $EXE --no-sandbox"; MODE="xvfb-run"
fi
echo "  启动方式: ${MODE:-无图形且无 xvfb，跳过}"

if [ -n "$CMD" ]; then
  timeout 40 $CMD > /tmp/qa-rpm-smoke.log 2>&1
  RC2=$?
  echo "  退出码: $RC2（124=超时被杀，即持续存活）"
  check "数据目录按 XDG 创建" "$([ -d "$DATA_DIR" ] && echo 1 || echo 0)" "$DATA_DIR"
  check "数据目录不在安装目录内" "$([ -d "$DATA_DIR" ] && ! echo "$DATA_DIR" | grep -q '^/opt' && echo 1 || echo 0)"
  if [ -d "$DATA_DIR" ]; then
    OWNER=$(stat -c '%U' "$DATA_DIR")
    check "数据目录属主是当前用户" "$([ "$OWNER" = "$(id -un)" ] && echo 1 || echo 0)" "$OWNER"
  fi
  echo "  --- 技能加载日志 ---"
  grep -E "\[skill|\[plugin" /tmp/qa-rpm-smoke.log 2>/dev/null | head -10 | sed 's/^/      /' || echo "      （无）"
else
  envnote "无图形环境且无 xvfb，跳过启动测试"
fi

# ── 7. SELinux（RHEL 系特有，值得单独看）──────────────────────────────────
echo
echo "== 7. SELinux 状态（RHEL 系常见阻碍）=="
if command -v getenforce >/dev/null 2>&1; then
  SE=$(getenforce 2>/dev/null)
  echo "  getenforce: $SE"
  if [ "$SE" = "Enforcing" ]; then
    envnote "SELinux 处于 Enforcing" "可能阻止 SnowLuma 注入 QQ 进程；若注入失败可先看 audit.log"
  fi
else
  echo "  （未安装 SELinux 工具）"
fi

# ── 8. 环境前提 ────────────────────────────────────────────────────────────
echo
echo "== 8. 环境前提提醒 =="
[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && envnote "无图形环境" "扫码登录需要桌面会话"
HASQQ=""; for p in /opt/QQ/qq /usr/bin/qq; do [ -x "$p" ] && HASQQ="$p"; done
[ -z "$HASQQ" ] && envnote "未安装 Linux 版 QQ" "协议端需要注入它"
PS=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo "N/A")
[ "$PS" != "0" ] && [ "$PS" != "N/A" ] && envnote "ptrace_scope = $PS" "应为 0"

# ── 9. 卸载 ────────────────────────────────────────────────────────────────
echo
echo "== 9. 卸载测试 =="
sudo $PM remove -y qq-agent >/dev/null 2>&1
RPMQ2=$(rpm -q qq-agent 2>/dev/null || echo "已移除")
check "卸载成功" "$(echo "$RPMQ2" | grep -q '^qq-agent' && echo 0 || echo 1)" "$RPMQ2"
check "卸载后用户数据保留" "$([ -d "$DATA_DIR" ] && echo 1 || echo 0)"

# ── 汇总 ───────────────────────────────────────────────────────────────────
echo
echo "############ 结果 ############"
for r in "${RESULTS[@]}"; do echo "$r"; done
echo
if [ ${#ENVNOTES[@]} -gt 0 ]; then
  echo "环境前提提醒："
  for n in "${ENVNOTES[@]}"; do echo "$n"; done
  echo
fi
echo "  通过 $PASS 项，失败 $FAIL 项"
echo "############ 结束 $(date '+%F %T') ############"
[ $FAIL -eq 0 ]
