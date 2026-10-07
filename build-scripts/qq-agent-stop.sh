#!/usr/bin/env bash
# qq-agent-stop —— 彻底停止 QQ Agent（含它拉起的 SnowLuma 协议端子进程）。
#
# 为什么需要它：
#   1) QQ Agent 默认「关闭窗口 = 缩到托盘」，进程继续跑 —— 点了 ✕ 并没有退出。
#      真退出入口在托盘图标右键菜单里，托盘图标被折叠时很难找到。
#   2) 正常退出走 before-quit → core.stop() 清理链；万一某个 await 不返回，
#      进程就卡在"点了退出却还在跑"的状态。
#   本脚本按 PID 精确结束，不按进程名乱杀，绝不会碰你机器上其它 node / Electron 程序。
#
# 用法：
#   qq-agent-stop            # 只停 QQ Agent 与它的 SnowLuma
#   qq-agent-stop --with-qq  # 连 QQ 客户端一起停（会结束 QQ 登录态，慎用）
#   qq-agent-stop --dry-run  # 只报告将要结束哪些进程，不做任何动作
set -uo pipefail

LOCK="$HOME/.local/share/qq-agent/instance.lock"
APP_MAIN_RE='^/opt/QQ Agent/qq-agent( |$)'
# ⚠️ 必须同时要求 index.mjs：早先只写 'snowluma/node'，pgrep -f 是整条命令行子串匹配，
#    任何命令行里出现这段字串的进程（例如正开着该路径的编辑器、或跑测试的 shell）都会被算成
#    SnowLuma 并被结束。实测就误杀过自己的测试进程。真实启动命令行形如：
#      /opt/QQ Agent/resources/app/snowluma/node /opt/.../snowluma/index.mjs
SNOW_RE='snowluma/node.*index\.mjs'
# Chromium 的崩溃处理器会自我守护（--monitor-self），主进程没了它也不一定退，
# 实测会留下 ppid=1 的孤儿。只匹配 QQ Agent 自己的那一个，绝不碰 Chrome 的。
CRASH_RE='^/opt/QQ Agent/chrome_crashpad_handler( |$)'
QQ_RE='^/opt/QQ/qq( |$)'
WAIT_SECS=8
WITH_QQ=0
DRY_RUN=0
for _a in "$@"; do
  case "$_a" in
    --with-qq) WITH_QQ=1 ;;
    --dry-run) DRY_RUN=1 ;;
  esac
done

say() { printf '  %s\n' "$*"; }

alive() { kill -0 "$1" 2>/dev/null; }

# 等一组 PID 退出，返回仍未退出的 PID
wait_gone() {
  local deadline=$(( $(date +%s) + WAIT_SECS )) still=()
  while [ "$(date +%s)" -lt "$deadline" ]; do
    still=()
    for p in "$@"; do alive "$p" && still+=("$p"); done
    [ ${#still[@]} -eq 0 ] && return 0
    sleep 0.3
  done
  printf '%s\n' "${still[@]}"
  return 1
}

mapfile -t APP_PIDS < <(pgrep -f "$APP_MAIN_RE" 2>/dev/null)
mapfile -t SNOW_PIDS < <(pgrep -f "$SNOW_RE" 2>/dev/null)
mapfile -t CRASH_PIDS < <(pgrep -f "$CRASH_RE" 2>/dev/null)

MAIN_PID=""
if [ -f "$LOCK" ]; then
  MAIN_PID=$(grep -o '"pid"[[:space:]]*:[[:space:]]*[0-9]*' "$LOCK" 2>/dev/null | grep -o '[0-9]*' | head -1)
  [ -n "$MAIN_PID" ] && ! alive "$MAIN_PID" && MAIN_PID=""
fi

if [ ${#APP_PIDS[@]} -eq 0 ] && [ ${#SNOW_PIDS[@]} -eq 0 ] && [ ${#CRASH_PIDS[@]} -eq 0 ]; then
  say "QQ Agent 未在运行。"
  exit 0
fi

say "检测到 QQ Agent 进程 ${#APP_PIDS[@]} 个，SnowLuma 进程 ${#SNOW_PIDS[@]} 个，崩溃处理器 ${#CRASH_PIDS[@]} 个"
[ -n "$MAIN_PID" ] && say "锁文件里的主进程 PID = $MAIN_PID"

if [ "$DRY_RUN" = "1" ]; then
  say "（--dry-run：只报告将要结束的进程，不做任何动作）"
  say "  QQ Agent 进程 : ${APP_PIDS[*]:-无}"
  say "  SnowLuma 进程 : ${SNOW_PIDS[*]:-无}"
  say "  崩溃处理器    : ${CRASH_PIDS[*]:-无}"
  [ "$WITH_QQ" = "1" ] && say "  QQ 客户端进程 : $(pgrep -f "$QQ_RE" 2>/dev/null | tr '\n' ' ')"
  exit 0
fi

# ── 1. 主进程：SIGTERM（触发它自己的清理链），超时再 SIGKILL ──
TARGETS=("${APP_PIDS[@]}")
[ -n "$MAIN_PID" ] && TARGETS=("$MAIN_PID" "${APP_PIDS[@]}")

TARGETS=($(printf '%s\n' "${TARGETS[@]}" | sort -u))   # 去重
say "向 ${TARGETS[*]} 发送 SIGTERM（给 ${WAIT_SECS}s 走清理链）"
for p in "${TARGETS[@]}"; do kill -TERM "$p" 2>/dev/null; done

if ! LEFT=$(wait_gone "${TARGETS[@]}"); then
  say "仍有未退出：${LEFT//$'\n'/ } → SIGKILL"
  for p in $LEFT; do kill -KILL "$p" 2>/dev/null; done
  sleep 0.5
fi

# ── 2. SnowLuma：子进程可能因为父进程被强杀而变孤儿，单独清理 ──
if [ ${#SNOW_PIDS[@]} -gt 0 ]; then
  LEFT_SNOW=()
  for p in "${SNOW_PIDS[@]}"; do alive "$p" && LEFT_SNOW+=("$p"); done
  if [ ${#LEFT_SNOW[@]} -gt 0 ]; then
    say "清理残留 SnowLuma：${LEFT_SNOW[*]}"
    for p in "${LEFT_SNOW[@]}"; do kill -TERM "$p" 2>/dev/null; done
    if ! LEFT2=$(wait_gone "${LEFT_SNOW[@]}"); then
      for p in $LEFT2; do kill -KILL "$p" 2>/dev/null; done
      sleep 0.5
    fi
  fi
fi

# ── 3. 崩溃处理器：--monitor-self 的 crashpad 在父进程死后会自我守护成孤儿 ──
if [ ${#CRASH_PIDS[@]} -gt 0 ]; then
  LEFT_CRASH=()
  for p in "${CRASH_PIDS[@]}"; do alive "$p" && LEFT_CRASH+=("$p"); done
  if [ ${#LEFT_CRASH[@]} -gt 0 ]; then
    say "清理残留崩溃处理器：${LEFT_CRASH[*]}"
    for p in "${LEFT_CRASH[@]}"; do kill -TERM "$p" 2>/dev/null; done
    if ! LEFT3=$(wait_gone "${LEFT_CRASH[@]}"); then
      for p in $LEFT3; do kill -KILL "$p" 2>/dev/null; done
      sleep 0.5
    fi
  fi
fi

# ── 4. 可选：连 QQ 客户端一起停（否则 QQ 会留着一个已被注入的 hook）──
if [ "$WITH_QQ" = "1" ]; then
  mapfile -t QQ_PIDS < <(pgrep -f "$QQ_RE" 2>/dev/null)
  if [ ${#QQ_PIDS[@]} -gt 0 ]; then
    say "停 QQ 客户端 ${#QQ_PIDS[@]} 个进程（--with-qq）"
    for p in "${QQ_PIDS[@]}"; do kill -TERM "$p" 2>/dev/null; done
    if ! LEFTQ=$(wait_gone "${QQ_PIDS[@]}"); then
      for p in $LEFTQ; do kill -KILL "$p" 2>/dev/null; done
    fi
  fi
fi

# ── 5. 结果确认 ──
sleep 0.5
REM_APP=$(pgrep -f "$APP_MAIN_RE" 2>/dev/null | wc -l)
REM_SNOW=$(pgrep -f "$SNOW_RE" 2>/dev/null | wc -l)
REM_CRASH=$(pgrep -f "$CRASH_RE" 2>/dev/null | wc -l)
say "剩余 QQ Agent: $REM_APP   SnowLuma: $REM_SNOW   崩溃处理器: $REM_CRASH"
if [ "$REM_APP" -eq 0 ] && [ "$REM_SNOW" -eq 0 ] && [ "$REM_CRASH" -eq 0 ]; then
  say "✅ 已彻底停止。"
  exit 0
else
  say "⚠️  仍有残留，请手动检查（可能需要 sudo 或该进程属其他用户）。"
  exit 1
fi
