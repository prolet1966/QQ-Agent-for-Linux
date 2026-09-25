#!/usr/bin/env bash
# fedora-01-rpm-smoke.sh —— 在**真实 Fedora 用户态**上安装 .rpm 并冒烟测试。
#
# ## 与 rpm-01-smoke.sh 的分工
#
# rpm-01-smoke.sh 是通用 rpm 系测试（可在 Fedora/RHEL/Rocky/Alma 上跑）。
# 本脚本是它的 **Fedora 特化版**，额外补上 Fedora 独有的关注点：
#
#   1. ★ 依赖名能否被 dnf 解析
#      electron-builder 生成的 .rpm 默认照抄 Debian 系依赖名，
#      而 RPM 系叫法不同（libgtk-3-0 vs gtk3、libasound2 vs alsa-lib 等）。
#      依赖名写错时 `rpm -qpR` 照样能打印出来，但 `dnf install` 会直接失败。
#      这是 .rpm 最容易翻车、也最必须真机验证的一点。
#   2. dnf 事务与弱依赖（Recommends/Supplements）行为
#   3. SELinux / firewalld 默认状态对协议端注入的影响
#   4. rpm 数据库的完整往返（装 → 查 → 验 → 卸 → 确认干净）
#
# ## 能力边界（必须如实写进结论）
#
# 本环境是 Fedora 用户态跑在 WSL 的微软内核上，因此：
#   ✅ 能验：dnf 依赖解析与事务、安装路径与权限、rpm 数据库注册、
#           %post/%pre 脚本、卸载与残留、文件校验
#   ❌ 不能验：Fedora 自带内核相关行为、真实图形栈/硬件
# 报告里会明确标注，不冒充"真机全项通过"。
#
# 用法：bash fedora-01-rpm-smoke.sh <rpm路径> [期望SHA256]

set -uo pipefail

RPM="${1:-}"
EXPECT_SHA="${2:-}"
PASS=0; FAIL=0; ENVWARN=0
# ★ 数组初始化要能扛住 set -u 与 bash 版本差异。
#   踩过的坑：`declare -a RESULTS ENVNOTES` 这种一行声明两个名字的写法，
#   在某些 bash（本机 Fedora 44 是 5.3.9）下会让 ENVNOTES 在汇总段落
#   展开成 "${ENVNOTES[@]}" 时报 "ENVNOTES: unbound variable"，
#   而明细里根本没调用过 envnote 时这个坑才暴露 —— 测试项全跑完了却打不出结果。
#   改成显式逐个赋值，并用 ${ARR[@]+...} 形式兜住"可能未设置"的展开。
RESULTS=()
ENVNOTES=()

check() {
  if [ "$2" = "1" ]; then PASS=$((PASS+1)); RESULTS+=("  ✅ $1${3:+  ($3)}")
  else FAIL=$((FAIL+1)); RESULTS+=("  ❌ $1${3:+  ($3)}"); fi
}
envnote() { ENVWARN=$((ENVWARN+1)); ENVNOTES+=("  ⚠️  $1${2:+  ($2)}"); }

[ -n "$RPM" ] && [ -f "$RPM" ] || { echo "用法: bash $0 <rpm路径> [期望SHA256]"; exit 2; }

echo "########## Fedora .rpm 冒烟测试 $(date '+%F %T') ##########"

# ── 必须真的是 Fedora ─────────────────────────────────────────────────────
if [ ! -f /etc/fedora-release ]; then
  echo "  ❌ 没有 /etc/fedora-release —— 本脚本必须在 Fedora 上运行"
  exit 2
fi
. /etc/os-release 2>/dev/null || true
echo "  发行版 : ${PRETTY_NAME:-未知}"
echo "  内核   : $(uname -r)"
echo "  架构   : $(uname -m)"
echo "  glibc  : $(rpm -q glibc 2>/dev/null | head -1)"
echo "  运行环境: $(grep -qi microsoft /proc/version && echo 'WSL（微软内核；仅用户态为 Fedora）' || echo '独立/虚拟机')"
echo "  包     : $(basename "$RPM")"
echo "  用户   : $(id -un)"

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/qq-agent"

# ── 0. 包完整性（吸取 .deb 传输被破坏的教训）──────────────────────────────
echo
echo "== 0. 包完整性 =="
LOCAL_SHA=$(sha256sum "$RPM" | awk '{print $1}')
LOCAL_SIZE=$(stat -c%s "$RPM")
echo "  大小      : $LOCAL_SIZE 字节 ($(du -h "$RPM" | cut -f1))"
echo "  实际 SHA256: $LOCAL_SHA"
if [ -n "$EXPECT_SHA" ]; then
  echo "  期望 SHA256: $EXPECT_SHA"
  if [ "$LOCAL_SHA" = "$EXPECT_SHA" ]; then
    check "包完整性（SHA256 一致）" 1
  else
    check "包完整性（SHA256 一致）" 0 "不一致 —— 传输可能损坏，停止"
    exit 1
  fi
else
  echo "  （未提供期望值，跳过比对）"
fi

# ── 1. rpm 元数据 + ★依赖名解析 ───────────────────────────────────────────
echo
echo "== 1. rpm 元数据 =="
rpm -qip "$RPM" 2>/dev/null | sed 's/^/      /'
echo "  --- 声明的依赖 ---"
rpm -qpR "$RPM" 2>/dev/null | sed 's/^/      /' | tee /tmp/qa-rpm-deps.txt
NEED=$(rpm -qpR "$RPM" 2>/dev/null | grep -v '^rpmlib(' | grep -v '^/bin/sh' || true)
NNEED=$(echo "$NEED" | grep -c . || true)
echo "  需解析依赖条数: $NNEED"

echo
echo "== 2. ★ 依赖名能否被 Fedora 仓库解析 =="
# 这一步是 .rpm 验证的核心：Debian 系的依赖名在 Fedora 上找不到，
# `dnf install` 会直接失败，而单看 rpm 元数据完全看不出来。
MISSING=""
while IFS= read -r dep; do
  [ -z "$dep" ] && continue
  # dnf provides 能解析「包名」与「lib*.so.1()(64bit)」两种写法
  if ! dnf -q provides "$dep" >/dev/null 2>&1; then
    MISSING="$MISSING $dep"
  fi
done <<< "$NEED"

if [ -z "$MISSING" ]; then
  check "全部依赖都能在 Fedora 仓库解析" 1 "$NNEED 条"
else
  echo "  ❌ 以下依赖在 Fedora 上无提供者:"
  for m in $MISSING; do echo "        $m"; done
  check "全部依赖都能在 Fedora 仓库解析" 0 "缺失:$(echo $MISSING | tr ' ' ',')"
fi

# ── 3. ★ 真正安装 ─────────────────────────────────────────────────────────
echo
echo "== 3. ★ dnf 真实安装（依赖解析 + 事务 + 数据库注册）=="
dnf -y remove qq-agent >/dev/null 2>&1 || true
rm -rf "$DATA_DIR" 2>/dev/null || true

INSTALL_LOG=$(dnf install -y "$RPM" 2>&1)
RC=$?
echo "$INSTALL_LOG" | tail -30 | sed 's/^/  /'
check "dnf 安装成功" "$([ $RC -eq 0 ] && echo 1 || echo 0)" "退出码 $RC"

echo
echo "== 4. rpm 数据库已注册 =="
RPMQ=$(rpm -q qq-agent 2>/dev/null || echo "未注册")
check "rpm -q 能查到" "$(echo "$RPMQ" | grep -q '^qq-agent' && echo 1 || echo 0)" "$RPMQ"

FILE_CNT=$(rpm -ql qq-agent 2>/dev/null | wc -l)
echo "  已注册文件数: $FILE_CNT"
check "文件已登记" "$([ "$FILE_CNT" -gt 100 ] && echo 1 || echo 0)" "$FILE_CNT 个"

if rpm -V qq-agent >/dev/null 2>&1; then
  check "rpm -V 文件校验通过" 1
else
  echo "  --- rpm -V 差异（前 8 行）---"
  rpm -V qq-agent 2>/dev/null | head -8 | sed 's/^/      /'
  check "rpm -V 文件校验通过" 0 "有差异"
fi

echo "  --- 依赖是否已由 dnf 装上 ---"
dnf -q repoquery --installed --requires qq-agent 2>/dev/null | head -20 | sed 's/^/      /' || true

# ── 5. 文件布局 ────────────────────────────────────────────────────────────
echo
echo "== 5. 文件布局 =="
EXE=$(rpm -ql qq-agent 2>/dev/null | grep -E '/opt/.*/qq-agent$' | head -1)
check "主程序存在" "$([ -n "$EXE" ] && [ -f "$EXE" ] && echo 1 || echo 0)" "${EXE:-无}"
if [ -n "$EXE" ]; then
  check "主程序可执行" "$([ -x "$EXE" ] && echo 1 || echo 0)"
  check "为 x86-64 ELF" "$(file -b "$EXE" | grep -q 'x86-64' && echo 1 || echo 0)"
  check "动态链接库齐全（ldd）" "$(ldd "$EXE" 2>/dev/null | grep -q 'not found' && echo 0 || echo 1)" \
        "$(ldd "$EXE" 2>/dev/null | grep -c 'not found') 个未解析"
fi
DESKTOP=$(rpm -ql qq-agent 2>/dev/null | grep '\.desktop$' | head -1)
check ".desktop 已安装" "$([ -n "$DESKTOP" ] && [ -f "$DESKTOP" ] && echo 1 || echo 0)" "${DESKTOP##*/}"
ICON=$(rpm -ql qq-agent 2>/dev/null | grep -E '\.(png|svg)$' | head -1)
check "图标已安装" "$([ -n "$ICON" ] && echo 1 || echo 0)" "${ICON##*/}"

# ── 6. 内置协议端与 Electron 运行时 ───────────────────────────────────────
echo
echo "== 6. 内置 SnowLuma 与 Electron 运行时 =="
if [ -n "$EXE" ]; then
  RES="$(dirname "$EXE")/resources"
  SNOW="$RES/app.asar.unpacked/snowluma"
  check "SnowLuma 已解包（asar 外，否则无法 spawn）" "$([ -d "$SNOW" ] && echo 1 || echo 0)"
  check "SnowLuma index.mjs" "$([ -f "$SNOW/index.mjs" ] && echo 1 || echo 0)"
  check "SnowLuma 内置 node 可执行" "$([ -x "$SNOW/node" ] && echo 1 || echo 0)"
  NODEV=$("$SNOW/node" --version 2>/dev/null || echo FAIL)
  check "内置 node 可运行" "$(echo "$NODEV" | grep -q '^v' && echo 1 || echo 0)" "$NODEV"
  check "native/snowluma-linux-x64.node" "$([ -f "$SNOW/native/snowluma-linux-x64.node" ] && echo 1 || echo 0)"
  check "native/websocket-linux-x64.node" "$([ -f "$SNOW/native/websocket-linux-x64.node" ] && echo 1 || echo 0)"
  check "无 Windows 残留（.bat / node.exe / win32）" \
        "$(find "$SNOW" \( -name '*win32*' -o -name '*.bat' -o -name 'node.exe' \) 2>/dev/null | grep -q . && echo 0 || echo 1)"
  ELEC="$EXE"
  check "Electron 主程序为 ELF" "$(file -b "$ELEC" | grep -q ELF && echo 1 || echo 0)"
fi

# ── 7. ★ 数据目录 XDG 落点（不是安装目录）─────────────────────────────────
# ★ 以 root 运行时**不能**用本节点判定失败。
#   原因（实测）：root 的家目录是 /root，且很多应用会用 getpwuid(getuid())
#   取家目录 —— UID 0 的边界行为与真实桌面用户不同。更关键的是 WSL 里
#   没有 /run/user/0 会话总线，Electron 会以 127 退出，数据目录自然没被创建。
#   若把这种情况记成 ❌，就会把"环境不具备"误报成"包有问题"。
#   真实普通用户下的 XDG 验证由 fedora-03-gui-xdg.sh 负责（已 11/11 通过）。
echo
echo "== 7. 数据目录 XDG 落点 =="
if [ "$(id -u)" -eq 0 ]; then
  envnote "以 root 运行，本节不做 XDG 判定" "root 家目录与边界行为不具代表性；见 fedora-03 普通用户验证"
  echo "  当前用户: root（跳过启动与数据目录判定）"
  echo "  预期落点（普通用户下）: \$HOME/.local/share/qq-agent"
  DATA_DIR=""
else
  RUN=""
  if command -v xvfb-run >/dev/null 2>&1; then
    RUN="xvfb-run -a $EXE --no-sandbox"
  elif [ -n "${DISPLAY:-}" ]; then
    RUN="$EXE --no-sandbox"
  fi

  if [ -n "$RUN" ] && [ -n "$EXE" ]; then
    echo "  启动方式: $RUN"
    timeout 45 $RUN > /tmp/qa-fedora-smoke.log 2>&1
    RC2=$?
    echo "  退出码: $RC2（124=超时被杀，即进程持续存活）"
    check "数据目录按 XDG 创建" "$([ -d "$DATA_DIR" ] && echo 1 || echo 0)" "$DATA_DIR"
    check "数据目录不在 /opt 内" "$(! echo "$DATA_DIR" | grep -q '^/opt' && echo 1 || echo 0)"
    if [ -d "$DATA_DIR" ]; then
      OWNER=$(stat -c '%U' "$DATA_DIR")
      check "数据目录属主为当前用户" "$([ "$OWNER" = "$(id -un)" ] && echo 1 || echo 0)" "$OWNER"
    fi
    echo "  --- 插件/技能加载日志 ---"
    grep -E "\[skill|\[plugin" /tmp/qa-fedora-smoke.log 2>/dev/null | head -8 | sed 's/^/      /' || echo "      （无）"
  else
    envnote "无 xvfb 也无 DISPLAY，跳过启动测试" "GUI 启动由 fedora-03-gui-xdg.sh 覆盖"
    DATA_DIR=""
  fi
fi

# ── 8. Fedora 特有的运行时前提 ────────────────────────────────────────────
echo
echo "== 8. Fedora 特有前提（SELinux / firewalld / ptrace）=="
if command -v getenforce >/dev/null 2>&1; then
  SE=$(getenforce 2>/dev/null)
  echo "  SELinux: $SE"
  [ "$SE" = "Enforcing" ] && envnote "SELinux=Enforcing" "可能阻止协议端注入 QQ 进程；失败时看 /var/log/audit/audit.log"
else
  echo "  SELinux: 未安装 selinux 工具"
fi
if command -v systemctl >/dev/null 2>&1; then
  FW=$(systemctl is-active firewalld 2>/dev/null || echo unknown)
  echo "  firewalld: $FW"
fi
PS=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo "N/A")
echo "  ptrace_scope: $PS"
[ "$PS" != "0" ] && [ "$PS" != "N/A" ] && envnote "ptrace_scope = $PS" "协议端注入要求为 0"

# ── 9. 卸载往返 ────────────────────────────────────────────────────────────
echo
echo "== 9. 卸载测试（rpm 数据库往返）=="
UNINSTALL_LOG=$(dnf -y remove qq-agent 2>&1)
RC3=$?
check "dnf 卸载成功" "$([ $RC3 -eq 0 ] && echo 1 || echo 0)" "退出码 $RC3"
RPMQ2=$(rpm -q qq-agent 2>/dev/null || echo "已移除")
check "rpm -q 已查不到" "$(echo "$RPMQ2" | grep -q '^qq-agent' && echo 0 || echo 1)" "$RPMQ2"
# ★ 必须先确认包真的没了，再数残留文件。
#   踩过的坑（两个独立 bug，都让"卸载干净"被误报成失败）：
#     1. `$(rpm -ql ... | wc -l || echo 0)` 输出带换行时变成 "1\n0"，
#        `[ "$LEFTOVER" -eq 0 ]` 直接报 "[: 10: integer expected"。
#     2. `rpm -ql <未安装的包>` 输出为空，但空输出末尾的换行会被 `wc -l`
#        数成 1 —— 于是"没有任何残留"变成了"残留 1 条"。
#   所以：包已卸载时残留数按 0 记，只有包还在时才真去数文件。
if rpm -q qq-agent >/dev/null 2>&1; then
  LEFTOVER=$(rpm -ql qq-agent 2>/dev/null | grep -c . | tr -d '[:space:]')
else
  LEFTOVER=0
fi
[ -z "$LEFTOVER" ] && LEFTOVER=0
check "无残留文件登记" "$([ "$LEFTOVER" -eq 0 ] && echo 1 || echo 0)" "$LEFTOVER 条"
# 卸载保留用户数据这一项只在第 7 节真的跑过启动时才有意义（见第 7 节说明）。
if [ -n "$DATA_DIR" ]; then
  check "卸载后用户数据保留" "$([ -d "$DATA_DIR" ] && echo 1 || echo 0)" "$DATA_DIR"
else
  envnote "未验证「卸载保留用户数据」" "第 7 节未在普通用户下启动过；该项由 fedora-03 覆盖"
fi

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
