#!/usr/bin/env bash
# ============================================================================
# QQ Agent 双实例启动样例（Linux）
#
# 说明：
#   - 实例 #1：默认（QQ_AGENT_PROFILE 空），数据目录 ~/.local/share/qq-agent
#   - 实例 #2：QQ_AGENT_PROFILE=2，数据目录 ~/.local/share/qq-agent-2，
#              控制台 3510 / SnowLuma OneBot ws 3201 / http 3200
#   - 每个实例要连**各自的 SnowLuma**（第二份工作副本，见 docs/multi-instance.md）
#
# ⚠️ 本机（2026-09-29 核对）：主实例 server.port 是**手改的 3410**
#   （= 公式里 profile #2 的默认端口）。所以实例 #2 必须显式
#   QQ_AGENT_PORT=3510，否则端口撞车 —— 脚本默认值已按此写死。
#
# 用法：
#   QQ_AGENT_BIN="/opt/QQ Agent/qq-agent" ./multi-instance-launch.sh
#
# 可覆盖项：
#   QQ_AGENT_BIN        —— 主程序路径（默认 qq-agent）
#   SNOWLUMA_DIR_2      —— 实例 #2 的独立 SnowLuma 目录（默认 ~/snowluma-2，
#                           已在实例 #2 的 config.json 的 snowluma.dir 指好）
#   QQ_AGENT_PORT_2     —— 实例 #2 控制台端口（默认 3510）
# ============================================================================
set -u

BIN="${QQ_AGENT_BIN:-qq-agent}"
PORT_1="${QQ_AGENT_PORT_1:-3210}"
PORT_2="${QQ_AGENT_PORT_2:-3510}"
LOG_DIR="${LOG_DIR:-/tmp}"

echo "[多开] 实例 #1：默认配置（控制台 $PORT_1，数据 ~/.local/share/qq-agent）"
QQ_AGENT_PROFILE= "$BIN" >"$LOG_DIR/qq-agent-1.log" 2>&1 &
echo "        pid=$!  日志 $LOG_DIR/qq-agent-1.log"

echo "[多开] 实例 #2：QQ_AGENT_PROFILE=2（控制台 $PORT_2，数据 ~/.local/share/qq-agent-2）"
QQ_AGENT_PROFILE=2 \
QQ_AGENT_PORT="$PORT_2" \
"$BIN" >"$LOG_DIR/qq-agent-2.log" 2>&1 &
echo "        pid=$!  日志 $LOG_DIR/qq-agent-2.log"

echo
echo "[多开] 两个实例已启动。注意："
echo "        1) 实例 #2 的 SnowLuma 目录已在它自己的 config.json 里指到独立副本"
echo "           （默认 ~/snowluma-2）。登录前先在它的 WebUI（http://127.0.0.1:5199）"
echo "           里扫码登录 Asaba，并把 OneBot WS/HTTP 配成 3201 / 3200。"
echo "        2) 实例 #2 默认自动启动 SnowLuma 是关的，登录成功后再到实例 #2 设置里"
echo "           打开（或直接改 config.json 的 snowluma.autoLaunch=true）。"
echo "        3) headless 方式把 BIN 换成：node src/server.js（仓库内）"