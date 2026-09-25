#!/usr/bin/env bash
# vm-03-appimage.sh —— 在真实 Ubuntu 虚拟机里测试 AppImage。
#
# AppImage 与 deb/rpm 的关键差异：
#   · 不需要安装，但依赖系统提供的库（不打包依赖，与 .deb 的 Depends 声明不同）
#   · 需要 FUSE 才能直接挂载运行；Ubuntu 24.04+ 默认只有 libfuse3，缺 libfuse2
#   · 缺 libfuse2 时可用 --appimage-extract-and-run 绕过
#
# 因此本脚本要验的是两个独立问题：
#   1. 包本身是否完好（能否解包、内部资源是否齐全）
#   2. 运行路径是否可用（FUSE 直接挂载 / extract-and-run 兜底）
#
# 用法：bash vm-03-appimage.sh /path/to/洛版-for-Linux.AppImage

set -uo pipefail

AI="${1:-}"
PASS=0; FAIL=0
declare -a RESULTS
check() {
  if [ "$2" = "1" ]; then PASS=$((PASS+1)); RESULTS+=("  ✅ $1${3:+  ($3)}")
  else FAIL=$((FAIL+1)); RESULTS+=("  ❌ $1${3:+  ($3)}"); fi
}

[ -n "$AI" ] && [ -f "$AI" ] || { echo "用法: bash $0 <AppImage路径>"; exit 2; }

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/qq-agent-aitest"
LOG=/tmp/qa-ai.log

echo "############ AppImage 冒烟测试（真实虚拟机）$(date '+%F %T') ############"
echo "  文件: $(basename "$AI")  ($(du -h "$AI" | cut -f1))"

# scp 传输不会保留执行位（传过来是 644）。AppImage 必须先可执行才能运行，
# 这也是为什么安装文档里要求用户 chmod +x —— 这里如实复现那一步。
if [ ! -x "$AI" ]; then
  echo "  （传输后无可执行位，执行 chmod +x —— 与用户安装步骤一致）"
  chmod +x "$AI"
fi

echo
echo "== 1. 文件属性 =="
check "有可执行位" "$([ -x "$AI" ] && echo 1 || echo 0)"
check "为 x86-64 ELF" "$(file -b "$AI" | grep -q 'x86-64' && echo 1 || echo 0)"
AIVER=$("$AI" --appimage-version 2>&1 | head -1)
check "AppImage runtime 可响应" "$(echo "$AIVER" | grep -q Version && echo 1 || echo 0)" "$AIVER"

echo
echo "== 2. FUSE 环境（决定用哪条运行路径）=="
FUSE_DEV=0; [ -e /dev/fuse ] && FUSE_DEV=1
FUSE_LIB=""
for p in /lib/x86_64-linux-gnu/libfuse.so.2 /usr/lib/x86_64-linux-gnu/libfuse.so.2; do
  [ -e "$p" ] && FUSE_LIB="$p" && break
done
echo "  /dev/fuse    : $([ $FUSE_DEV -eq 1 ] && echo 存在 || echo 不存在)"
echo "  libfuse.so.2 : ${FUSE_LIB:-未找到}"
FUSE_OK=0
[ $FUSE_DEV -eq 1 ] && [ -n "$FUSE_LIB" ] && FUSE_OK=1
if [ $FUSE_OK -eq 1 ]; then
  echo "  → FUSE 完整，可尝试直接挂载运行"
else
  echo "  → FUSE 不完整，将用 --appimage-extract-and-run（这是 AppImage 的既定兜底方式）"
  [ $FUSE_DEV -eq 1 ] && [ -z "$FUSE_LIB" ] && \
    echo "     这是 Ubuntu 24.04+ 的常见情况；装 libfuse2t64 即可直接挂载"
fi

echo
echo "== 3. ★ 实际启动 =="
rm -rf "$DATA_DIR"
export QQ_AGENT_DATA_DIR="$DATA_DIR"
CMD=("$AI" --appimage-extract-and-run --no-sandbox)
MODE="--appimage-extract-and-run"
if [ $FUSE_OK -eq 1 ] && [ "${AI_USE_FUSE:-0}" = "1" ]; then
  CMD=("$AI" --no-sandbox); MODE="FUSE 直接挂载"
fi
echo "  方式: $MODE"

if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  timeout 40 "${CMD[@]}" > "$LOG" 2>&1
elif command -v xvfb-run >/dev/null 2>&1; then
  timeout 40 xvfb-run -a "${CMD[@]}" > "$LOG" 2>&1
else
  echo "  ❌ 无图形环境且无 xvfb，无法启动验证"
  exit 1
fi
RC=$?
echo "  退出码: $RC（124=被 timeout 杀掉 = 进程持续存活）"
check "AppImage 能启动并存活" "$([ "$RC" = "124" ] || [ "$RC" = "0" ] && echo 1 || echo 0)" "退出码 $RC"

echo
echo "== 4. ★ 数据目录 XDG 落点 =="
check "已按 XDG 创建" "$([ -d "$DATA_DIR" ] && echo 1 || echo 0)" "$DATA_DIR"
check "不在解包临时目录内" "$([ -d "$DATA_DIR" ] && ! echo "$DATA_DIR" | grep -q '/tmp/appimage' && echo 1 || echo 0)"
if [ -d "$DATA_DIR" ]; then
  OWNER=$(stat -c '%U' "$DATA_DIR")
  check "属主是当前用户" "$([ "$OWNER" = "$(id -un)" ] && echo 1 || echo 0)" "$OWNER"
  echo "  --- 内容 ---"
  ls -1 "$DATA_DIR" | head -8 | sed 's/^/      /'
fi

echo
echo "== 5. 内部资源完整性（解包核对）=="
# ⚠️ 路径注意：AppImage 的布局与 .deb/.rpm 不同 ——
#   .deb/.rpm ：/opt/QQ Agent/resources/...
#   AppImage  ：resources/...            （在 squashfs 根目录下，没有 /opt 前缀）
# 最初这里照抄了 deb 的路径，导致 4 项断言全部误报失败。
# 已用 vm-04-appimage-structure.sh 打印真实结构核对过，不是猜的。
TMPX=/tmp/qa-ai-extract
rm -rf "$TMPX"; mkdir -p "$TMPX"
(cd "$TMPX" && "$AI" --appimage-extract >/dev/null 2>&1)
ROOT="$TMPX/squashfs-root"
if [ -d "$ROOT" ]; then
  check "解包成功" "1"
  check "主程序存在且可执行" "$([ -x "$ROOT/qq-agent" ] && echo 1 || echo 0)"
  check "Electron resources/app.asar 存在" "$([ -f "$ROOT/resources/app.asar" ] && echo 1 || echo 0)"
  SNOW="$ROOT/resources/app.asar.unpacked/snowluma"
  check "内置 SnowLuma 已解包到 asar 之外" "$([ -d "$SNOW" ] && echo 1 || echo 0)"
  check "  index.mjs 存在" "$([ -f "$SNOW/index.mjs" ] && echo 1 || echo 0)"
  check "  自带 node 可执行" "$([ -x "$SNOW/node" ] && echo 1 || echo 0)"
  NODEV=$("$SNOW/node" --version 2>/dev/null || echo FAIL)
  check "  自带 node 可运行" "$(echo "$NODEV" | grep -q '^v' && echo 1 || echo 0)" "$NODEV"
  check "  native/snowluma-linux-x64.node" "$([ -f "$SNOW/native/snowluma-linux-x64.node" ] && echo 1 || echo 0)"
  check "  无 Windows 残留" "$(find "$SNOW" \( -name '*win32*' -o -name '*.bat' -o -name 'node.exe' \) 2>/dev/null | grep -q . && echo 0 || echo 1)"
  check ".desktop 在根目录" "$([ -f "$ROOT/qq-agent.desktop" ] && echo 1 || echo 0)"
  grep -E '^(Name|Exec|Icon|Categories)=' "$ROOT/qq-agent.desktop" 2>/dev/null | sed 's/^/      /'
  check "图标已打包" "$(find "$ROOT/usr/share/icons" -name 'qq-agent.*' 2>/dev/null | grep -q . && echo 1 || echo 0)"
else
  check "解包成功" "0" "无 squashfs-root"
fi
rm -rf "$TMPX"

echo
echo "== 6. 技能加载（确认运行时真的起来了）=="
grep -E "\[skill|\[plugin" "$LOG" 2>/dev/null | head -8 | sed 's/^/      /' || echo "      （日志无技能行 —— 可能进程起得太早被杀）"

echo
echo "== 7. 清理 =="
rm -rf /tmp/appimage_extracted_* 2>/dev/null || true
rm -rf "$DATA_DIR" 2>/dev/null || true
echo "  完成"

echo
echo "############ 结果 ############"
for r in "${RESULTS[@]}"; do echo "$r"; done
echo
echo "  通过 $PASS 项，失败 $FAIL 项"
echo "############ 结束 $(date '+%F %T') ############"
[ $FAIL -eq 0 ]
