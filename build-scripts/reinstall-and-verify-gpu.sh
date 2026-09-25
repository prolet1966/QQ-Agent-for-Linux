#!/usr/bin/env bash
# reinstall-and-verify-gpu.sh —— 重装 .deb，然后核实 disable-gpu 是否真的生效。
#
# 为什么合并成一个脚本：从 PowerShell 调 `wsl -- bash -c '...'` 时，
# 单引号里的 $VAR 会被 PowerShell 先展开。这个坑今天已经踩了 6 次以上
# （$c / $A / $HOME / $D 都被吃掉），导致命令以空参数执行、
# 或者变量为空的诡异失败。凡是带变量的逻辑，一律写进脚本文件。

set -uo pipefail

DEB="$HOME/qq-agent-linux/app/dist/qq-agent-v0.4.4-amd64.deb"
EXE="/opt/QQ Agent/qq-agent"
LOG="$HOME/qq-agent-linux/gpu-check.log"
DATA="$HOME/.local/share/qq-agent-gputest"

echo "== 1. 确认 deb 存在 =="
ls -la "$DEB" || { echo "  ❌ 包不存在"; exit 1; }

echo
echo "== 2. 安装（若已装则先移除，保证干净）=="
sudo dpkg -r qq-agent >/dev/null 2>&1 || true
sudo apt-get install -y "$DEB" 2>&1 | grep -E "Setting up|Unpacking|update-alternatives|error|E:" | sed 's/^/  /'

echo
echo "== 3. 安装结果 =="
ST=$(dpkg-query -W -f='${Status}' qq-agent 2>/dev/null || echo missing)
echo "  dpkg 状态: ${ST:-（空）}"
echo "  主程序    : $([ -f "$EXE" ] && echo 存在 || echo 缺失)"
echo "  /usr/bin/qq-agent: $(ls -la /usr/bin/qq-agent 2>/dev/null | awk '{print $NF, $(NF-1), $(NF-2)}' || echo '无')"

if [ ! -f "$EXE" ]; then
  echo "  ❌ 主程序不存在，无法继续"
  exit 1
fi

echo
echo "== 4. GPG/GPU 开关核实 =="
echo "  QQ_AGENT_ENABLE_GPU = '${QQ_AGENT_ENABLE_GPU:-（未设置）}'"
echo "  DISPLAY             = '${DISPLAY:-（未设置）}'"

echo
echo "== 5. 启动并读取真实命令行 =="
rm -rf "$DATA"
export QQ_AGENT_DATA_DIR="$DATA"

timeout 20 "$EXE" --no-sandbox > "$LOG" 2>&1 &
APP_PID=$!
sleep 8

echo "  主进程 PID: $APP_PID"
if [ -r "/proc/$APP_PID/cmdline" ]; then
  echo "  命令行（空格分隔）："
  tr '\0' ' ' < "/proc/$APP_PID/cmdline" | fold -w 120 | sed 's/^/    /'
  echo
  if tr '\0' '\n' < "/proc/$APP_PID/cmdline" | grep -qx -- '--disable-gpu'; then
    echo "  ✅ 命令行含 --disable-gpu —— 开关生效"
    GPU_OK=1
  else
    echo "  ⚠️  命令行未见 --disable-gpu"
    GPU_OK=0
  fi
  if tr '\0' '\n' < "/proc/$APP_PID/cmdline" | grep -qx -- '--disable-software-rasterizer'; then
    echo "  ✅ 命令行含 --disable-software-rasterizer"
  else
    echo "  ⚠️  未见 --disable-software-rasterizer"
  fi
  if tr '\0' '\n' < "/proc/$APP_PID/cmdline" | grep -qx -- '--no-sandbox'; then
    echo "  ✅ 命令行含 --no-sandbox"
  fi
else
  echo "  ⚠️  进程已退出或无权限读 /proc"
  GPU_OK=0
fi

echo
echo "== 6. 子进程（看 GPU 进程是否被创建）=="
CHILDREN=$(pgrep -P "$APP_PID" 2>/dev/null || true)
if [ -n "$CHILDREN" ]; then
  for pid in $CHILDREN; do
    TYPE=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -oE '\-\-type=[a-z-]+' | head -1)
    printf "  pid=%-7s %s\n" "$pid" "${TYPE:-（无 --type）}"
  done
  # 是否出现了 GPU 类型子进程
  if for pid in $CHILDREN; do tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null; echo; done | grep -q -- '--type=gpu'; then
    echo "  ⚠️  存在 --type=gpu 子进程"
  else
    echo "  ✅ 无 --type=gpu 子进程（disable-gpu 生效的直接证据）"
  fi
else
  echo "  （无子进程，或进程已退出）"
fi

sleep 1
kill "$APP_PID" 2>/dev/null || true
wait "$APP_PID" 2>/dev/null || true
pkill -f "app.asar" 2>/dev/null || true

echo
echo "== 7. 日志里的 GPU/FATAL 行 =="
if grep -iE "gpu|swiftshader|rasteriz|FATAL|Goodbye" "$LOG" 2>/dev/null | head -12 | sed 's/^/  /'; then
  :
else
  echo "  ✅ 无任何 GPU 相关错误"
fi

echo
echo "== 8. 数据目录（XDG 验收）=="
echo "  $DATA"
echo "  $([ -d "$DATA" ] && echo '✅ 已创建' || echo '❌ 未创建')"
[ -d "$DATA" ] && ls "$DATA" | sed 's/^/    /'

echo
echo "== 9. 日志开头 12 行 =="
head -12 "$LOG" 2>/dev/null | sed 's/^/  /'
