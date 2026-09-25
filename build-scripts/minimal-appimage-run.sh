#!/usr/bin/env bash
# minimal-appimage-run.sh —— 最小复现：单独跑 AppImage，抓清楚它到底怎么退出的。
#
# 前两次 appimage-smoke-test.sh 都在「启动测试」处静默中断（脚本返回 1，无输出），
# 所以先把启动这一件事单独隔离出来，不加任何后续逻辑，看真实退出码与输出。

set -o pipefail   # 注意：故意不用 -u / -e，要看清每一步的真实结果

AI="$HOME/qq-agent-linux/app/dist/qq-agent-v0.4.4-x86_64.AppImage"
DATA="$HOME/.local/share/qq-agent-aimin"
LOG="$HOME/qq-agent-linux/ai-min.log"

echo "== 0. 前置检查 =="
echo "  AppImage: $AI"
echo "  存在: $([ -f "$AI" ] && echo 是 || echo 否)"
echo "  可执行: $([ -x "$AI" ] && echo 是 || echo 否)"
ls -la "$AI" 2>&1 | sed 's/^/  /'

echo
echo "== 1. 最简调用：--appimage-version =="
"$AI" --appimage-version 2>&1 | head -3 | sed 's/^/  /'
echo "  退出码: $?"

echo
echo "== 2. 最简调用：--appimage-help（看支持哪些参数）=="
"$AI" --appimage-help 2>&1 | head -12 | sed 's/^/  /'
echo "  退出码: $?"

echo
echo "== 3. 用 --appimage-extract-and-run 启动（避开 FUSE 挂载）=="
rm -rf "$DATA"
echo "  QQ_AGENT_DATA_DIR=$DATA"
echo "  执行: timeout 25 $AI --appimage-extract-and-run --no-sandbox"
echo "  --- 输出开始 ---"
QQ_AGENT_DATA_DIR="$DATA" timeout 25 "$AI" --appimage-extract-and-run --no-sandbox > "$LOG" 2>&1
RC=$?
echo "  --- 输出结束 ---"
echo "  timeout/AppImage 退出码: $RC"
echo "  124=超时被杀（说明进程一直活着，正常）"
echo "  0=自己退出了  其他=异常"

echo
echo "== 4. 数据目录 =="
if [ -d "$DATA" ]; then
  echo "  ✅ 已创建: $DATA"
  ls -1 "$DATA" | sed 's/^/    /'
else
  echo "  ❌ 未创建"
fi

echo
echo "== 5. 完整日志（共 $(wc -l < "$LOG" 2>/dev/null || echo 0) 行）=="
if [ -f "$LOG" ]; then
  head -40 "$LOG" | sed 's/^/  /'
else
  echo "  (无日志文件)"
fi
