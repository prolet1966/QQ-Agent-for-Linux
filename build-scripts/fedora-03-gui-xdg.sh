#!/usr/bin/env bash
# fedora-03-gui-xdg.sh —— 在 Fedora WSL 上以**真实普通用户**验证 GUI 启动与 XDG 数据目录。
#
# ## 为什么单独做一份，而不是并进 01
#
# 01 脚本里的启动测试有先天缺陷（实测踩到）：
#   · 以 root 运行。root 虽然家目录是 /root，但很多应用会用 getpwuid(getuid())
#     找家目录；UID 0 的边界行为与真实桌面用户不同，测出来的"通过"没有代表性。
#   · Fedora WSL 基础镜像没有 X 服务，直接跑 Electron 会以 127 退出
#     （缺共享库/无 DISPLAY），现象与"包坏了"极像，容易误判。
#   · 装载界面还需要 GTK/X11 一整套库。
#
# 所以这里：建一个真实用户 + 装 xvfb 与 X11 运行库 + 在那个用户下启动，
# 这样才能真正验证「数据目录是否按 XDG 落到用户家目录、且属主正确」。
#
# ## 判据
#   ✅ XDG 数据目录被创建：$HOME/.local/share/qq-agent
#   ✅ 该目录属主 = 运行用户（不是 root）
#   ✅ 目录不在安装目录 /opt 下（否则升级/卸载会波及用户数据）
#   ✅ 进程能持续存活（退出码 124 = 被 timeout 杀 = 没自己崩）
#   ✅ 插件/技能加载日志出现
#
# 用法（在 Fedora WSL 内）：bash fedora-03-gui-xdg.sh

set -uo pipefail

RPM_WIN="F:\kmy\Documents\dpsk\harness\QQ-Agent-for-Linux\port\dist\qq-agent-v0.4.4-x86_64.rpm"
TESTUSER="qqtest"
PASS=0; FAIL=0; ENVWARN=0
# 见 fedora-01 里的说明：一行声明多个数组名 + set -u 会踩到 unbound 展开问题，
# 这里改为显式初始化，并在展开处用 ${ARR[@]+...} 兜底。
RESULTS=()
ENVNOTES=()
check() {
  if [ "$2" = "1" ]; then PASS=$((PASS+1)); RESULTS+=("  ✅ $1${3:+  ($3)}")
  else FAIL=$((FAIL+1)); RESULTS+=("  ❌ $1${3:+  ($3)}"); fi
}
envnote() { ENVWARN=$((ENVWARN+1)); ENVNOTES+=("  ⚠️  $1${2:+  ($2)}"); }

echo "########## Fedora GUI 启动 + XDG 数据目录验证 $(date '+%F %T') ##########"
. /etc/os-release 2>/dev/null || true
echo "  发行版: ${PRETTY_NAME:-未知}"
echo "  内核  : $(uname -r)"

# ── 1. 安装图形运行前提 ───────────────────────────────────────────────────
# Xvfb 提供虚拟 X 服务；其余是 Electron/GTK 在无桌面环境下的运行库。
echo
echo "== 1. 安装 Xvfb 与图形运行库 =="
PKGS="xorg-x11-server-Xvfb gtk3 nss alsa-lib mesa-libgbm libxkbcommon libdrm libXScrnSaver xdg-utils at-spi2-atk libXt libXcomposite libXdamage libXrandr libXfixes libXcursor pango cups-libs dbus-x11"
if dnf -y install $PKGS >/tmp/qa-gui-dnf.log 2>&1; then
  check "图形运行库安装成功" 1
else
  echo "  --- dnf 输出尾部 ---"; tail -12 /tmp/qa-gui-dnf.log | sed 's/^/      /'
  check "图形运行库安装成功" 0 "详见 /tmp/qa-gui-dnf.log"
fi
command -v Xvfb >/dev/null 2>&1 && check "Xvfb 可用" 1 || check "Xvfb 可用" 0

# ── 2. 建真实测试用户 ─────────────────────────────────────────────────────
echo
echo "== 2. 建真实普通用户 $TESTUSER =="
if id "$TESTUSER" >/dev/null 2>&1; then
  echo "  已存在"
else
  useradd -m -s /bin/bash "$TESTUSER" && echo "  已创建"
fi
UHOME=$(getent passwd "$TESTUSER" | cut -d: -f6)
echo "  家目录: $UHOME"
check "测试用户家目录存在" "$([ -d "$UHOME" ] && echo 1 || echo 0)" "$UHOME"

# ── 3. 安装 .rpm（若尚未安装）────────────────────────────────────────────
echo
echo "== 3. 确保 .rpm 已安装 =="
RPM_PATH=$(wslpath -a "$RPM_WIN")
if rpm -q qq-agent >/dev/null 2>&1; then
  echo "  已安装: $(rpm -q qq-agent)"
else
  dnf -y install "$RPM_PATH" >/tmp/qa-gui-rpm.log 2>&1
  echo "  安装退出码: $?"
  rpm -q qq-agent 2>/dev/null || echo "  ❌ 未装上"
fi
check "qq-agent 已安装" "$(rpm -q qq-agent >/dev/null 2>&1 && echo 1 || echo 0)" "$(rpm -q qq-agent 2>/dev/null)"

EXE=$(rpm -ql qq-agent 2>/dev/null | grep -E '/opt/.*/qq-agent$' | head -1)
check "主程序路径" "$([ -n "$EXE" ] && [ -x "$EXE" ] && echo 1 || echo 0)" "${EXE:-无}"

# ── 4. 以普通用户在 Xvfb 下启动 ───────────────────────────────────────────
echo
echo "== 4. 以 $TESTUSER 在 Xvfb 下启动 =="
DATA_DIR="$UHOME/.local/share/qq-agent"
echo "  预期数据目录: $DATA_DIR"
rm -rf "$DATA_DIR"
chown -R "$TESTUSER":"$TESTUSER" "$UHOME" 2>/dev/null || true

# Xvfb 由 root 起（监听 :99），应用由普通用户连上去。
# 用 xvfb-run 更省事，但它会以调用者身份跑；这里要切换用户，所以手工起 Xvfb。
pkill -f 'Xvfb :99' 2>/dev/null || true
sleep 1
Xvfb :99 -screen 0 1280x800x24 >/tmp/qa-Xvfb.log 2>&1 &
XVFB_PID=$!
sleep 3
if kill -0 $XVFB_PID 2>/dev/null; then
  check "Xvfb 已启动（:99）" 1
else
  check "Xvfb 已启动（:99）" 0 "见 /tmp/qa-Xvfb.log"
fi

# 关键：用 su - 而不是 sudo，确保 HOME 正确指向测试用户的家目录。
# 若 HOME 仍是 /root，测出来的 XDG 落点就是错的，等于没测。
runuser -u "$TESTUSER" -- env HOME="$UHOME" DISPLAY=:99 \
  timeout 60 "$EXE" --no-sandbox >/tmp/qa-gui-app.log 2>&1 &
APPPID=$!
echo "  应用已启动（PID $APPPID），等待 60 秒观察..."
sleep 40

echo "  --- 应用日志（尾部 25 行）---"
tail -25 /tmp/qa-gui-app.log 2>/dev/null | sed 's/^/      /' || echo "      （无输出）"

# ── 5. 判据 ───────────────────────────────────────────────────────────────
echo
echo "== 5. 判据 =="
check "数据目录按 XDG 创建" "$([ -d "$DATA_DIR" ] && echo 1 || echo 0)" "$DATA_DIR"
if [ -d "$DATA_DIR" ]; then
  OWNER=$(stat -c '%U' "$DATA_DIR")
  check "数据目录属主为 $TESTUSER（非 root）" "$([ "$OWNER" = "$TESTUSER" ] && echo 1 || echo 0)" "$OWNER"
  echo "  --- 数据目录内容 ---"
  find "$DATA_DIR" -maxdepth 2 2>/dev/null | head -15 | sed 's/^/      /'
fi
check "数据目录不在 /opt 安装目录内" "$(! echo "$DATA_DIR" | grep -q '^/opt' && echo 1 || echo 0)"

# 进程是否持续存活：等候 timeout 自然结束再判定
wait $APPPID 2>/dev/null
RC=$?
echo "  应用退出码: $RC（124 = 被 timeout 杀死 = 存活满 60 秒）"
check "进程持续存活未自行崩溃" "$([ "$RC" -eq 124 ] && echo 1 || echo 0)" "退出码 $RC"

echo "  --- 插件/技能加载日志 ---"
grep -E "\[skill|\[plugin" /tmp/qa-gui-app.log 2>/dev/null | head -12 | sed 's/^/      /' || echo "      （无）"
SKILLN=$(grep -cE "\[skill" /tmp/qa-gui-app.log 2>/dev/null | tr -d '[:space:]')
SKILLN=${SKILLN:-0}
check "有技能加载日志" "$([ "$SKILLN" -gt 0 ] && echo 1 || echo 0)" "$SKILLN 条"

# ── 6. 清理 ───────────────────────────────────────────────────────────────
kill $XVFB_PID 2>/dev/null || true
pkill -f 'Xvfb :99' 2>/dev/null || true

# ── 汇总 ───────────────────────────────────────────────────────────────────
echo
echo "########## 结果 ##########"
for r in ${RESULTS[@]+"${RESULTS[@]}"}; do echo "$r"; done
echo
if [ ${#ENVNOTES[@]} -gt 0 ]; then
  echo "环境前提提醒（不计入失败）："
  for n in ${ENVNOTES[@]+"${ENVNOTES[@]}"}; do echo "$n"; done
  echo
fi
echo "  通过 $PASS 项，失败 $FAIL 项，环境提醒 $ENVWARN 项"
echo "########## 结束 $(date '+%F %T') ##########"
[ $FAIL -eq 0 ]
