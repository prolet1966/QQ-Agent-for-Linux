#!/usr/bin/env bash
# ============================================================================
# QQ Agent 双实例启动样例（Linux）
#
# 说明：
#   - 实例 #1：默认（QQ_AGENT_PROFILE 空），数据目录 ~/.local/share/qq-agent
#   - 实例 #2：QQ_AGENT_PROFILE=2，数据目录 ~/.local/share/qq-agent-2，
#              控制台 3410 / SnowLuma OneBot ws 3201 / http 3200
#   - 每个实例要连**各自的 SnowLuma**（第二份工作副本，见 docs/multi-instance.md）
#
# 用法：
#   QQ_AGENT_BIN=/opt/QQ\ Agent/qq-agent ./multi-instance-launch.sh
#
# 可覆盖项：
#   QQ_AGENT_BIN        —— 主程序路径（默认 qq-agent）
#   SNOWLUMA_DIR_2      —— 实例 #2 的独立 SnowLuma 目录（仅演示；实际请在实例 #2
#                           的设置页填写，或写到它的 config.json 的 snowluma.dir）
#   QQ_AGENT_PORT_2     —— 实例 #2 控制台端口（默认 3410，撞车时显式改）
# ============================================================================
set -u

BIN="${QQ_AGENT_BIN:-qq-agent}"
PORT_2="${QQ_AGENT_PORT_2:-3410}"
LOG_DIR="${LOG_DIR:-/tmp}"

echo "[多开] 实例 #1：默认配置（控制台 3210，数据 ~/.local/share/qq-agent）"
QQ_AGENT_PROFILE= "$BIN" >"$LOG_DIR/qq-agent-1.log" 2>&1 &
echo "        pid=$!  日志 $LOG_DIR/qq-agent-1.log"

echo "[多开] 实例 #2：QQ_AGENT_PROFILE=2（控制台 $PORT_2，数据 ~/.local/share/qq-agent-2）"
QQ_AGENT_PROFILE=2 \
QQ_AGENT_PORT="$PORT_2" \
"$BIN" >"$LOG_DIR/qq-agent-2.log" 2>&1 &
echo "        pid=$!  日志 $LOG_DIR/qq-agent-2.log"

echo
echo "[多开] 两个实例已启动。注意："
echo "        1) 实例 #2 登录第一个 QQ 号前，先到它的设置页把 SnowLuma 目录指到独立副本"
echo "        2) SnowLuma #2 的 WebUI 端口不要用 5099（与 #1 冲突），并在其 WebUI 里"
echo "           把 OneBot WS/HTTP 配成 3201 / 3200"
echo "        3) headless 方式把 BIN 换成：node src/server.js（仓库内）"