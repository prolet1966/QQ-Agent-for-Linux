#!/usr/bin/env bash
# gpu-ab-test.sh —— 对照实验：明确传 --disable-gpu 与不传，行为是否不同。
#
# 目的：定性「日志里的 GPU FATAL 到底是不是问题」。
#   · 若显式传 --disable-gpu 后仍出现同样的 FATAL → 该报错与我们的开关无关，
#     是环境层面的（WSLg 的 GPU 支持不完整），在真桌面/Linux 服务器上表现不同，
#     属于已知且可接受的噪声，不是移植缺陷。
#   · 若显式传之后 FATAL 消失 → 说明 main.js 里的开关应用得太晚，是真 bug，需要修。
#
# 注意：FATAL 打印 ≠ 进程立即死亡。要紧的是「数据目录是否建出来、
# 进程是否还活着」。所以每组都同时看这三项。

set -uo pipefail

EXE="/opt/QQ Agent/qq-agent"
[ -f "$EXE" ] || { echo "❌ 未安装，先跑 reinstall-and-verify-gpu.sh"; exit 1; }

run_case() {
  local label="$1"; shift
  local data="$HOME/.local/share/qq-agent-gputest-$label"
  local log="$HOME/qq-agent-linux/gpu-$label.log"

  rm -rf "$data"
  echo "── 用例：$label"
  echo "   额外参数: $*"
  echo "   数据目录: $data"

  QQ_AGENT_DATA_DIR="$data" timeout 18 "$EXE" --no-sandbox "$@" > "$log" 2>&1 &
  local pid=$!
  sleep 7

  local alive=0; kill -0 "$pid" 2>/dev/null && alive=1
  local dcdir=0; [ -d "$data" ] && dcdir=1

  # GPU 子进程
  local gpuprocs=0
  for cp in $(pgrep -P "$pid" 2>/dev/null || true); do
    if tr '\0' ' ' < "/proc/$cp/cmdline" 2>/dev/null | grep -q -- '--type=gpu'; then
      gpuprocs=$((gpuprocs+1))
    fi
  done

  # 日志特征
  local fatals=$(grep -c "GPU process isn't usable" "$log" 2>/dev/null || echo 0)
  local launchfail=$(grep -c "GPU process launch failed" "$log" 2>/dev/null || echo 0)

  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  pkill -f "app.asar" 2>/dev/null || true
  sleep 1

  printf "     进程存活(7s时) : %s\n" "$alive"
  printf "     数据目录已建   : %s\n" "$dcdir"
  printf "     GPU 子进程数   : %s\n" "$gpuprocs"
  printf "     'GPU launch failed' 次数: %s\n" "$launchfail"
  printf "     '不是 usable/Goodbye' 次数: %s\n" "$fatals"
  echo
  echo "$label|$alive|$dcdir|$gpuprocs|$launchfail|$fatals" >> /tmp/gpu-ab-result.txt
}

echo "############ GPU 对照实验 $(date '+%F %T') ############"
echo "环境: DISPLAY=${DISPLAY:-未设置} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-未设置}"
echo
rm -f /tmp/gpu-ab-result.txt

run_case "baseline"          # 什么都不加，完全按 app 自身逻辑
run_case "nodisablegpu" --disable-gpu --disable-software-rasterizer
run_case "swiftshader"   --use-gl=swiftshader
run_case "inprocessgpu"  --in-process-gpu

echo "############ 汇总 ############"
printf "%-14s %-8s %-10s %-10s %-12s %-10s\n" 用例 存活 数据目录 GPU子进程 launch失败 FATAL
while IFS='|' read -r label alive dcdir gpuprocs launchfail fatals; do
  printf "%-14s %-8s %-10s %-10s %-12s %-10s\n" "$label" "$alive" "$dcdir" "$gpuprocs" "$launchfail" "$fatals"
done < /tmp/gpu-ab-result.txt

echo
echo "############ 结论提示 ############"
echo "  若各用例的 FATAL 次数都相同 → 与本项目的开关无关，是环境噪声"
echo "  若 baseline 有 FATAL、nodisablegpu 无 → main.js 的开关应用时机有问题，需修"
echo "  关键指标是「数据目录已建」：只要它是 1，程序的核心功能就是正常的"
