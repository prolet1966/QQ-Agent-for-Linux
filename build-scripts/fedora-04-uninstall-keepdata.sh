#!/usr/bin/env bash
# fedora-04-uninstall-keepdata.sh —— 验证 .rpm 卸载后用户数据是否保留。
#
# ## 为什么要单独验这一条
#
# 这是「数据目录遵循 XDG、放在用户家目录而不是安装目录」的直接收益：
# 卸载/升级程序不该动用户的会话记忆、配置、日志。
# fedora-01 因为以 root 运行（家目录 /root 不具代表性）跳过了这项，
# fedora-03 验证了安装侧的 XDG 落点，这里补上卸载侧的保留性 —— 两侧合起来才完整。
#
# 判据：
#   1. 以普通用户启动一次，数据目录被创建且有内容
#   2. dnf remove 之后，安装目录已消失
#   3. 数据目录**仍然存在**，且内容（config.json / logs / sessions）未被清空
#   4. 数据目录属主不变
#
# 用法（在 Fedora WSL 内）：bash fedora-04-uninstall-keepdata.sh

set -uo pipefail

RPM_WIN="F:\kmy\Documents\dpsk\harness\QQ-Agent-for-Linux\port\dist\qq-agent-v0.4.4-x86_64.rpm"
TESTUSER="qqtest"
PASS=0; FAIL=0
RESULTS=()
check() {
  if [ "$2" = "1" ]; then PASS=$((PASS+1)); RESULTS+=("  ✅ $1${3:+  ($3)}")
  else FAIL=$((FAIL+1)); RESULTS+=("  ❌ $1${3:+  ($3)}"); fi
}

echo "########## 卸载保留用户数据验证 $(date '+%F %T') ##########"

RPM_PATH=$(wslpath -a "$RPM_WIN")
UHOME=$(getent passwd "$TESTUSER" | cut -d: -f6)
DATA_DIR="$UHOME/.local/share/qq-agent"
EXE="/opt/QQ Agent/qq-agent"

echo "  测试用户  : $TESTUSER ($UHOME)"
echo "  数据目录  : $DATA_DIR"

# ── 1. 确保已安装并启动过一次 ─────────────────────────────────────────────
echo
echo "== 1. 安装并启动一次，让数据目录成型 =="
rpm -q qq-agent >/dev/null 2>&1 || dnf -y install "$RPM_PATH" >/tmp/qa-04-install.log 2>&1
check "qq-agent 已安装" "$(rpm -q qq-agent >/dev/null 2>&1 && echo 1 || echo 0)" "$(rpm -q qq-agent 2>/dev/null)"

rm -rf "$DATA_DIR"
pkill -f 'Xvfb :99' 2>/dev/null || true
sleep 1
Xvfb :99 -screen 0 1280x800x24 >/tmp/qa-04-Xvfb.log 2>&1 &
XVFB_PID=$!
sleep 3

runuser -u "$TESTUSER" -- env HOME="$UHOME" DISPLAY=:99 \
  timeout 40 "$EXE" --no-sandbox >/tmp/qa-04-app.log 2>&1 || true

BEFORE_COUNT=$(find "$DATA_DIR" -type f 2>/dev/null | grep -c . || echo 0)
BEFORE_LIST=$(find "$DATA_DIR" -maxdepth 1 2>/dev/null | grep -c . || echo 0)
echo "  启动后数据目录文件数: $BEFORE_COUNT"
find "$DATA_DIR" -maxdepth 1 2>/dev/null | sed 's/^/      /' | head -12
check "数据目录已创建且有内容" "$([ "$BEFORE_COUNT" -gt 0 ] && echo 1 || echo 0)" "$BEFORE_COUNT 个文件"

# ── 2. 卸载 ───────────────────────────────────────────────────────────────
echo
echo "== 2. 卸载 .rpm =="
dnf -y remove qq-agent >/tmp/qa-04-remove.log 2>&1
RC=$?
check "dnf 卸载成功" "$([ $RC -eq 0 ] && echo 1 || echo 0)" "退出码 $RC"

# ── 3. 关键判据 ───────────────────────────────────────────────────────────
echo
echo "== 3. 关键判据 =="
# ★ 断言要按 rpm 的真实语义写，不能按"我以为应该"写。
#   实测：卸载后 /opt/QQ Agent 下会留下 locales/、resources/ 等**空目录骨架**，
#   但**没有任何文件残留**（把 rpm 清单与实际文件做差集，结果为空）。
#   这是 rpm 对共享路径的正常处理：本包拥有的文件会被删掉，
#   目录被当作共享路径，未声明为可回收就保留。
#   若把"空目录仍在"记成 ❌，就是把正常行为误报成缺陷。
#   真正该断言的是：**文件**被彻底清除。
if [ -d "/opt/QQ Agent" ]; then
  LEFT_FILES=$(find "/opt/QQ Agent" -type f 2>/dev/null | grep -c . | tr -d '[:space:]')
  LEFT_DIRS=$(find "/opt/QQ Agent" -type d 2>/dev/null | grep -c . | tr -d '[:space:]')
  echo "  卸载后 /opt 残留: 文件 $LEFT_FILES 个，空目录 $LEFT_DIRS 个"
  find "/opt/QQ Agent" -type f 2>/dev/null | head -10 | sed 's/^/        /'
  check "★ 安装文件已全部清除（允许空目录骨架）" \
        "$([ "$LEFT_FILES" -eq 0 ] && echo 1 || echo 0)" "$LEFT_FILES 个文件残留"
else
  check "★ 安装目录已完全移除" 1 "/opt/QQ Agent"
fi

if [ -d "$DATA_DIR" ]; then
  check "★ 卸载后数据目录仍存在" 1 "$DATA_DIR"
  AFTER_COUNT=$(find "$DATA_DIR" -type f 2>/dev/null | grep -c . || echo 0)
  echo "  卸载后文件数: $AFTER_COUNT（卸载前 $BEFORE_COUNT）"
  check "★ 数据文件未被清空" "$([ "$AFTER_COUNT" -gt 0 ] && echo 1 || echo 0)" "$AFTER_COUNT 个文件"
  OWNER=$(stat -c '%U' "$DATA_DIR")
  check "数据目录属主未被改动" "$([ "$OWNER" = "$TESTUSER" ] && echo 1 || echo 0)" "$OWNER"
  echo "  --- 残留的用户数据 ---"
  find "$DATA_DIR" -maxdepth 2 2>/dev/null | head -15 | sed 's/^/      /'
else
  check "★ 卸载后数据目录仍存在" 0 "数据目录被卸载流程删掉了 —— 用户记忆/配置丢失"
fi

kill $XVFB_PID 2>/dev/null || true
pkill -f 'Xvfb :99' 2>/dev/null || true

echo
echo "########## 结果 ##########"
for r in ${RESULTS[@]+"${RESULTS[@]}"}; do echo "$r"; done
echo
echo "  通过 $PASS 项，失败 $FAIL 项"
echo "########## 结束 $(date '+%F %T') ##########"
[ $FAIL -eq 0 ]
