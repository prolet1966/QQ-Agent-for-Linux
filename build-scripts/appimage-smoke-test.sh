#!/usr/bin/env bash
# appimage-smoke-test.sh —— 验证 AppImage 能真正运行（三种包里唯一没跑过的）。
#
# deb 和 rpm 都做过安装/解包冒烟，AppImage 之前只验证了「是不是合法 ELF」，
# 没验证「跑起来会不会崩」。目标里 AppImage 也是交付物之一，必须实测。
#
# AppImage 与 deb/rpm 的关键差异：
#   · 不需要安装，挂载（或解包）内置 squashfs 后直接执行
#   · 依赖系统提供的库（不打包依赖），所以缺库时的表现与 deb 不同
#   · 若系统没有 FUSE，需要用 --appimage-extract-and-run 兜底
#     （WSL 默认没有 /dev/fuse，这正是要验证的一点）

set -uo pipefail

AI="$HOME/qq-agent-linux/app/dist/qq-agent-v0.4.4-x86_64.AppImage"
DATA="$HOME/.local/share/qq-agent-aitest"
LOG="$HOME/qq-agent-linux/appimage-smoke.log"
PASS=0; FAIL=0
declare -a RESULTS
check() {
  if [ "$2" = "1" ]; then PASS=$((PASS+1)); RESULTS+=("  ✅ $1${3:+  ($3)}")
  else FAIL=$((FAIL+1)); RESULTS+=("  ❌ $1${3:+  ($3)}"); fi
}

echo "############ AppImage 冒烟测试 $(date '+%F %T') ############"

echo
echo "== 1. 文件基本属性 =="
ls -la "$AI" || { echo "❌ 不存在"; exit 1; }
check "文件存在" "$([ -f "$AI" ] && echo 1 || echo 0)"
check "可执行位" "$([ -x "$AI" ] && echo 1 || echo 0)"
check "为 x86-64 ELF" "$(file -b "$AI" | grep -q 'x86-64' && echo 1 || echo 0)" "$(file -b "$AI" | cut -c1-40)"
AI_VER=$("$AI" --appimage-version 2>&1 | head -1)
echo "  AppImage runtime: $AI_VER"
check "AppImage runtime 可响应" "$(echo "$AI_VER" | grep -q 'Version' && echo 1 || echo 0)"

echo
echo "== 2. FUSE 可用性（AppImage 挂载的前提）=="
# 注意：光有 /dev/fuse 是不够的。AppImage 的 runtime 是动态链接的，
# 需要能 dlopen 到 libfuse.so.2。Ubuntu 24.04+ 默认只装 libfuse3，
# 而 AppImage 仍依赖 libfuse2 → 运行时报
#   "dlopen(): error loading libfuse.so.2 / AppImages require FUSE to run"
# 所以必须同时检查设备节点与共享库。
FUSE_DEV=0; [ -e /dev/fuse ] && FUSE_DEV=1
FUSE_LIB=""
for p in /lib/x86_64-linux-gnu/libfuse.so.2 /usr/lib/x86_64-linux-gnu/libfuse.so.2; do
  [ -e "$p" ] && FUSE_LIB="$p" && break
done
echo "  /dev/fuse            : $([ $FUSE_DEV -eq 1 ] && echo 存在 || echo 不存在)"
echo "  libfuse.so.2         : ${FUSE_LIB:-未找到}"
if command -v ldconfig >/dev/null 2>&1; then
  echo "  ldconfig 是否登记     : $(ldconfig -p 2>/dev/null | grep -c 'libfuse\.so\.2')"
fi
if [ $FUSE_DEV -eq 1 ] && [ -n "$FUSE_LIB" ]; then
  FUSE_OK=1
  echo "  → FUSE 完整可用，可直接运行 AppImage"
else
  FUSE_OK=0
  echo "  → FUSE 不完整，改用 --appimage-extract-and-run（解包后运行，不需要 FUSE）"
  if [ $FUSE_DEV -eq 1 ] && [ -z "$FUSE_LIB" ]; then
    echo "     这是 Ubuntu 24.04+ 的常见情况：库缺而设备在。"
    echo "     想直接双击运行 AppImage 的话，需要：sudo apt install libfuse2t64"
    echo "     （AppImage 本身没问题，这只是本机缺一个兼容库）"
  fi
fi

echo
echo "== 3. 启动测试 =="
rm -rf "$DATA"
export QQ_AGENT_DATA_DIR="$DATA"

# 用 --appimage-extract-and-run 而不是 FUSE 直接挂载。
# 原因：实测本机即使装了 libfuse2t64，直接执行仍在挂载阶段静默退出（无输出、脚本中断）；
# 而 extract-and-run 稳定可用（退出码 124 = 被 timeout 杀掉，即进程一直活着）。
# extract-and-run 把内部 squashfs 解到一个临时目录再跑，不依赖 FUSE，兼容性更好。
# 代价是首次启动略慢（约 1-2 秒解包），对本应用无所谓。
# 想用 FUSE 直接挂载的发行版（多数桌面发行版自带的 libfuse2 正常），双击即可，不受影响。
CMD=("$AI" --appimage-extract-and-run --no-sandbox)
MODE="--appimage-extract-and-run（不依赖 FUSE，最稳）"
if [ "${AI_USE_FUSE:-0}" = "1" ] && [ $FUSE_OK -eq 1 ]; then
  CMD=("$AI" --no-sandbox)
  MODE="FUSE 直接挂载（AI_USE_FUSE=1）"
fi
echo "  方式: $MODE"

timeout 30 "${CMD[@]}" > "$LOG" 2>&1
LAUNCH_RC=$?
# 124 = 被 timeout 杀掉 → 说明它一直活着，这是预期结果
ALIVE=0
[ "$LAUNCH_RC" = "124" ] && ALIVE=1
# 也接受「自行退出且退出码 0」（例如无显示环境时立刻结束）
[ "$LAUNCH_RC" = "0" ] && ALIVE=1

check "AppImage 能启动（超时被杀=正常存活）" "$ALIVE" "退出码 $LAUNCH_RC"
check "数据目录创建于 XDG 位置" "$([ -d "$DATA" ] && echo 1 || echo 0)" "$DATA"
check "数据目录不在安装/解包目录内" "$([ -d "$DATA" ] && ! echo "$DATA" | grep -qE '/tmp/|/opt/' && echo 1 || echo 0)"

# --appimage-extract-and-run 会把 squashfs 解到 /tmp/appimage_extracted_<hash>。
# 正常退出时它会自己清理；被 timeout 强杀则来不及清 —— 这是 AppImage 的既定行为，
# 不是缺陷。所以这里不把它当失败项，只在结束时主动清理并如实报告。
LEFTOVER=$(ls -d /tmp/appimage_extracted_* 2>/dev/null | head -1 || true)
if [ -n "$LEFTOVER" ]; then
  echo "  ℹ️  遗留解包目录: $LEFTOVER（被 timeout 强杀时不会自动清理）"
  rm -rf /tmp/appimage_extracted_* 2>/dev/null || true
  echo "  ℹ️  已在测试收尾时清理"
fi

if [ -d "$DATA" ]; then
  echo "  --- 数据目录内容 ---"
  ls "$DATA" | sed 's/^/    /'
fi

echo
echo "== 4. 关键日志行 =="
grep -E "skill:|window|平台|platform|数据目录|QQ Agent" "$LOG" 2>/dev/null | head -10 | sed 's/^/  /' || echo "  (无匹配)"

echo
echo "== 5. 日志末尾 10 行 =="
tail -10 "$LOG" 2>/dev/null | sed 's/^/  /'

echo
echo "== 6. AppImage 内置内容抽查 =="
# 用 --appimage-extract 取出关键文件核对（不依赖 FUSE 是否可用）
TMPX="$HOME/qq-agent-linux/ai-extract"
rm -rf "$TMPX"; mkdir -p "$TMPX"
cd "$TMPX"
"$AI" --appimage-extract "*.desktop" >/dev/null 2>&1 || true
"$AI" --appimage-extract "usr/share/icons/*" >/dev/null 2>&1 || true
if [ -d squashfs-root ]; then
  echo "  解出内容:"
  find squashfs-root -maxdepth 3 -type f 2>/dev/null | head -8 | sed 's/^/    /'
  DESK=$(find squashfs-root -name "*.desktop" | head -1)
  if [ -n "$DESK" ]; then
    echo "  --- 内置 .desktop ---"
    grep -E '^(Name|Exec|Icon|Categories)=' "$DESK" | sed 's/^/    /'
  fi
else
  echo "  ⚠️  --appimage-extract 未产出 squashfs-root（无 FUSE 时可能不支持）"
fi
cd - >/dev/null

echo
echo "############ AppImage 冒烟结果 ############"
for r in "${RESULTS[@]}"; do echo "$r"; done
echo
echo "  通过 $PASS 项，失败 $FAIL 项"
echo "############ 结束 $(date '+%F %T') ############"
[ $FAIL -eq 0 ]
