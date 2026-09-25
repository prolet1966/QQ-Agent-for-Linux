#!/usr/bin/env bash
# verify-gpu-flags.sh —— 核实 app 是否真的传了 disable-gpu，还是日志里的
# "GPU process isn't usable" 另有来源。
#
# 为什么要查：冒烟测试时日志出现
#   FATAL:gpu_data_manager_impl_private.cc(423)] GPU process isn't usable. Goodbye.
# 但 main.js 第 57-60 行明明会在 QQ_AGENT_ENABLE_GPU != 1 时加上 --disable-gpu。
# 两种可能：
#   a) 开关没生效（那是个真 bug，无 GPU 的服务器上会崩）
#   b) 开关生效了，但那条 FATAL 来自别的进程（例如 crashpad 独立初始化 GPU）
# 必须分清，否则要么误报要么漏掉真问题。

set -uo pipefail

EXE=$(command -v qq-agent 2>/dev/null || echo "")
[ -n "$EXE" ] || { echo "qq-agent 未安装，先跑 smoke-test.sh"; exit 1; }

LOG="$HOME/qq-agent-linux/gpu-check.log"
DATA="$HOME/.local/share/qq-agent-gputest"

echo "== 环境 =="
echo "  可执行: $EXE"
echo "  QQ_AGENT_ENABLE_GPU = '${QQ_AGENT_ENABLE_GPU:-（未设置）}'"
echo "  DISPLAY = '${DISPLAY:-（未设置）}'"

echo
echo "== 启动并抓取真实命令行 =="
rm -rf "$DATA"
export QQ_AGENT_DATA_DIR="$DATA"

timeout 20 "$EXE" --no-sandbox > "$LOG" 2>&1 &
APP_PID=$!
sleep 8

echo "  主进程 PID: $APP_PID"
echo "  该进程的实际命令行："
tr '\0' ' ' < "/proc/$APP_PID/cmdline" 2>/dev/null | sed 's/^/    /' || echo "    (读不到)"
echo
echo "  是否含 --disable-gpu ?"
if tr '\0' '\n' < "/proc/$APP_PID/cmdline" 2>/dev/null | grep -qx -- '--disable-gpu'; then
  echo "    ✅ 含（开关生效）"
else
  echo "    ❓ 不含（主进程命令行里没看到）"
fi

echo
echo "== 子进程树命令行 =="
for pid in $(pgrep -P "$APP_PID" 2>/dev/null); do
  echo "  子进程 $pid:"
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-150 | sed 's/^/    /'
done

echo
echo "== 所有相关进程（含 type 标记）=="
pgrep -af "qq-agent|app\.asar" 2>/dev/null | cut -c1-140 | sed 's/^/  /' | head -10

sleep 1
kill "$APP_PID" 2>/dev/null || true
wait "$APP_PID" 2>/dev/null || true
pkill -f "app.asar" 2>/dev/null || true

echo
echo "== 日志里的 GPU 相关行 =="
grep -iE "gpu|swiftshader|rasteriz|FATAL|Goodbye" "$LOG" 2>/dev/null | sed 's/^/  /' || echo "  (无 GPU 相关日志)"

echo
echo "== 触发 FATAL 的那个进程号 =="
grep -oE "^\[[0-9]+:" "$LOG" 2>/dev/null | sort -u | sed 's/^/  /' || true

echo
echo "== 日志前 20 行（看启动参数）=="
head -20 "$LOG" 2>/dev/null | sed 's/^/  /'

echo
echo "== 数据目录是否创建 =="
echo "  $DATA: $([ -d "$DATA" ] && echo 已创建 || echo 未创建)"

echo
echo "== 结论判断 =="
if grep -q "GPU process isn't usable" "$LOG" 2>/dev/null; then
  if tr '\0' '\n' < "/proc/1/cmdline" >/dev/null 2>&1; then :; fi
  echo "  出现 FATAL。但请注意：本次是**不带** --disable-gpu 的对照…"
fi
