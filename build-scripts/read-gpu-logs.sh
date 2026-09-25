#!/usr/bin/env bash
# read-gpu-logs.sh —— 直接读对照实验产生的日志，人工核对 GPU 报错到底有没有。
#
# 为什么重做：gpu-ab-test.sh 里的计数用了
#   local fatals=$(grep -c "..." "$log" 2>/dev/null || echo 0)
# 但 `grep -c` 在**无匹配时也会输出 "0" 并返回退出码 1**，
# 于是 `|| echo 0` 又追加了一个 0，得到 "0\n0" 这种两行结果，
# 汇总时把表格撑坏。计数类命令不能这样兜底。

set -uo pipefail

echo "############ GPU 日志核对 $(date '+%F %T') ############"
echo "环境: DISPLAY=${DISPLAY:-未设置} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-未设置}"
echo

for label in baseline nodisablegpu swiftshader inprocessgpu; do
  log="$HOME/qq-agent-linux/gpu-$label.log"
  echo "── 用例 $label"
  if [ ! -f "$log" ]; then
    echo "    (日志不存在)"
    continue
  fi
  echo "    日志大小: $(stat -c%s "$log") 字节"

  # 逐条计数，注意 grep -c 的退出码语义
  n_fatal=$(grep -c "GPU process isn't usable" "$log" 2>/dev/null) || n_fatal=0
  n_launch=$(grep -c "GPU process launch failed" "$log" 2>/dev/null) || n_launch=0
  n_zygote=$(grep -c "zygote_communication" "$log" 2>/dev/null) || n_zygote=0
  n_crash=$(grep -c "渲染进程崩溃\|render-process-gone" "$log" 2>/dev/null) || n_crash=0

  printf "    'GPU isn't usable'       : %s\n" "$n_fatal"
  printf "    'GPU process launch failed': %s\n" "$n_launch"
  printf "    'zygote communication'    : %s\n" "$n_zygote"
  printf "    '渲染进程崩溃'             : %s\n" "$n_crash"

  echo "    所有含 GPU 的行（最多 6 条）:"
  grep -i "gpu" "$log" 2>/dev/null | head -6 | sed 's/^/      /' || echo "      （无）"
  echo
done

echo "############ 关键业务日志行（确认功能正常）############"
for label in baseline; do
  log="$HOME/qq-agent-linux/gpu-$label.log"
  echo "── $label 的启动日志前 15 行"
  head -15 "$log" 2>/dev/null | sed 's/^/    /'
done

echo
echo "############ 数据目录核对 ############"
for label in baseline nodisablegpu swiftshader inprocessgpu; do
  d="$HOME/.local/share/qq-agent-gputest-$label"
  printf "  %-14s %s  (%s 个条目)\n" "$label" \
    "$([ -d "$d" ] && echo 已创建 || echo 未创建)" \
    "$([ -d "$d" ] && ls -1 "$d" | wc -l || echo 0)"
done
