#!/usr/bin/env bash
# load-test-addons.sh —— 真实加载测试：接上并入的插件与技能后，程序能否正常启动。
#
# 为什么必须做：静态扫描只能证明「没有调用未提供的 api」，不能证明
#   · 模块求值时不抛异常（顶层代码有副作用 / import 不存在的依赖）
#   · setup() 注册工具时不与已有技能冲突
#   · 清单字段格式被 normalizeManifest 接受
# 这些只有真的加载一遍才知道。而且加载出问题时往往是**静默**的
# （V0.4.4 对工具 id 冲突只 warning 后覆盖），所以必须逐条核对日志。
#
# 判据：
#   1. 进程能启动并存活
#   2. 数据目录正常创建
#   3. 【关键】日志里没有针对新插件的 error / 未捕获异常
#   4. 新插件应有的日志行出现（例如 affinity、kb-growth 会打印就绪信息）

set -uo pipefail

APP="$HOME/qq-agent-linux/app"
EXE="$APP/dist/linux-unpacked/qq-agent"
DATA="$HOME/.local/share/qq-agent-addontest"
LOG="$HOME/qq-agent-linux/addon-load.log"

# 优先用构建产物（linux-unpacked）跑，它才是要发布的东西
if [ ! -x "$EXE" ]; then
  echo "⚠️  linux-unpacked 不存在，先跑 pipeline.sh；回退到源码直跑"
  EXE=""
fi

echo "############ 插件/技能加载测试 $(date '+%F %T') ############"
echo "  插件数: $(find "$APP/plugins" -maxdepth 1 -mindepth 1 -type d | wc -l)"
echo "  技能数: $(find "$APP/skills" -maxdepth 1 -mindepth 1 -type d | wc -l)"

rm -rf "$DATA"
export QQ_AGENT_DATA_DIR="$DATA"

echo
echo "== 启动 =="
if [ -n "$EXE" ]; then
  echo "  方式: 构建产物 $EXE"
  CMD=("$EXE" --no-sandbox)
else
  echo "  方式: 源码直跑"
  CMD=(npx electron . --no-sandbox)
fi

cd "$APP"
timeout 30 "${CMD[@]}" > "$LOG" 2>&1
RC=$?
echo "  退出码: $RC（124=超时被杀，即一直存活）"

echo
echo "== 1. 存活与数据目录 =="
echo "  数据目录: $([ -d "$DATA" ] && echo '✅ 已创建' || echo '❌ 未创建')"
[ -d "$DATA" ] && ls -1 "$DATA" | head -8 | sed 's/^/    /'

echo
echo "== 2. skill/plugin 相关日志（全部） =="
grep -E "\[skill|\[plugin|skill:|plugin:" "$LOG" 2>/dev/null | sed 's/^/  /' || echo "  (无)"

echo
echo "== 3. 是否有报错 =="
ERR=$(grep -iE "error|exception|cannot find|is not a function|undefined is not|failed to load|加载失败|未捕获" "$LOG" 2>/dev/null \
      | grep -viE "gpu|zygote|network_service|crashpad|renderer|渲染进程|cpufreq|libfuse" || true)
if [ -n "$ERR" ]; then
  echo "$ERR" | head -25 | sed 's/^/  ⚠️  /'
else
  echo "  ✅ 无插件/技能相关报错"
fi

echo
echo "== 4. 新并入的插件是否出现（抽查若干） =="
for k in affinity body-state kb-growth meme-engine mood-tune threads wake-policy 复读拦截 本体情绪 远程价格表; do
  n=$(grep -c "$k" "$LOG" 2>/dev/null || echo 0)
  printf "  %-16s 日志出现 %s 次\n" "$k" "$n"
done

echo
echo "== 5. 工具 id 冲突检查（V0.4.4 冲突时只 warning） =="
if grep -q "工具 id 冲突" "$LOG" 2>/dev/null; then
  echo "  ⚠️  存在工具 id 冲突："
  grep "工具 id 冲突" "$LOG" | sed 's/^/    /'
else
  echo "  ✅ 无工具 id 冲突"
fi

echo
echo "== 6. 日志规模与前 30 行 =="
echo "  总行数: $(wc -l < "$LOG")"
head -30 "$LOG" | sed 's/^/  /'

echo
echo "############ 结束 $(date '+%F %T') ############"
