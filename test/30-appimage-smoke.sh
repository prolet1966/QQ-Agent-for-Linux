#!/usr/bin/env bash
# ============================================================================
#  30-appimage-smoke.sh — AppImage 真实运行冒烟
#
#  用法：
#    bash test/30-appimage-smoke.sh                    # 用 out/ 里默认产物
#    bash test/30-appimage-smoke.sh --arch arm64
#    bash test/30-appimage-smoke.sh --appimage out/xxx.AppImage
#
#  ★ 与 deb/rpm 冒烟的关键差异：
#    1. **不需要 root**（AppImage 本来就不安装）—— 直接以当前用户跑
#    2. 无 FUSE 环境（WSL / 容器）下用 APPIMAGE_EXTRACT_AND_RUN=1
#    3. 专门验证 AppImage 的固有限制：SquashFS 挂载后 setuid 无效，
#       启动器必须**显式降级 --no-sandbox**而不是静默失败
# ============================================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
# shellcheck source=test/_smoke-common.sh
source test/_smoke-common.sh

SMOKE_KIND="appimage"
SMOKE_NEEDS_ROOT=0          # AppImage 不需要安装，也就不需要 root
SMOKE_EXTRACT_AND_RUN=1     # WSL/容器里通常没有 FUSE

PKG_FILE=""
ql_parse_args "$@"
if [ "${#QL_REST[@]}" -gt 0 ]; then set -- "${QL_REST[@]}"; else set --; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --appimage)      [ $# -ge 2 ] || die "--appimage 后面要跟文件"; PKG_FILE="$2"; shift 2 ;;
    --appimage=*)    PKG_FILE="${1#*=}"; shift ;;
    --keep)          SMOKE_KEEP=1; shift ;;
    --with-fuse)     SMOKE_EXTRACT_AND_RUN=0; shift ;;
    *)               die "未知选项：$1" ;;
  esac
done

[ -n "$PKG_FILE" ] || PKG_FILE="$OUT_DIR/QQ-Agent-${APP_VERSION}-${APPIMAGE_ARCH}.AppImage"
PKG_FILE="$(cd "$(dirname "$PKG_FILE")" && pwd)/$(basename "$PKG_FILE")"
SMOKE_BIN="$PKG_FILE"

echo "===== QQ-Agent AppImage 冒烟测试 ====="
arch_summary
echo "  产物: $PKG_FILE"
echo "  模式: $([ "$SMOKE_EXTRACT_AND_RUN" = 1 ] && echo 'extract-and-run（无 FUSE 环境）' || echo '正常 FUSE 挂载')"
echo

need_file "$PKG_FILE"
[ -x "$PKG_FILE" ] || die "AppImage 没有执行位：$PKG_FILE"
smoke_resolve_run_user
trap smoke_cleanup EXIT
smoke_setup

# ── 静态检查（AppImage 专属）──
smoke_head "静态检查"
m="$(elf_machine "$PKG_FILE")"
if [ "$m" = "$(expected_elf_machine)" ]; then
  smoke_pass "AppImage 是可执行 ELF 且架构正确" "$m"
else
  smoke_fail "AppImage 架构不符" "期望 $(expected_elf_machine)，实际 ${m:-非ELF}"
fi
smoke_info "体积" "$(du -h "$PKG_FILE" | cut -f1)（单文件，自带全部运行时）"

# 解出来看载荷，并**确认 setuid 位在 AppImage 里确实失效**（这正是降级的理由）
SR=""
EX="$SMOKE_TMP/aimg"
mkdir -p "$EX"
if ( cd "$EX" && "$PKG_FILE" --appimage-extract >/dev/null 2>&1 ) && [ -d "$EX/squashfs-root" ]; then
  SR="$EX/squashfs-root"
  smoke_pass "可用 --appimage-extract 解开（无需 FUSE）" "$(du -sh "$SR" | cut -f1)"
  for f in AppRun qq-agent.desktop opt/qq-agent/qq-agent \
           opt/qq-agent/resources/app/src/app.js \
           opt/qq-agent/resources/app/snowluma/index.mjs \
           "opt/qq-agent/resources/app/snowluma/native/snowluma-linux-${ELECTRON_ARCH}.node" \
           "opt/qq-agent/resources/app/snowluma/native/ffmpeg/ffmpegAddon.linux.${ELECTRON_ARCH}.node"; do
    [ -e "$SR/$f" ] && smoke_pass "载荷含 $f" "" || smoke_fail "载荷缺 $f" ""
  done
  pm="$(elf_machine "$SR/opt/qq-agent/qq-agent")"
  [ "$pm" = "$(expected_elf_machine)" ] && smoke_pass "载荷主程序架构正确" "$pm" \
    || smoke_fail "载荷主程序架构不符" "$pm"
  n_win=$(find "$SR" \( -iname '*win32*' -o -iname '*win64*' -o -iname '*.dll' \) 2>/dev/null | wc -l)
  [ "$n_win" = 0 ] && smoke_pass "载荷无 Windows 残留" "" || smoke_fail "载荷有 Windows 残留" "$n_win 项"
  bad=""
  for b in opt/qq-agent/resources/app/snowluma/data opt/qq-agent/resources/app/snowluma/config \
           opt/qq-agent/resources/app/snowluma/logs opt/qq-agent/data; do
    [ -e "$SR/$b" ] && bad="$bad $b"
  done
  [ -z "$bad" ] && smoke_pass "载荷无运行期数据" "" || smoke_fail "载荷混入运行期数据" "$bad"

  # ★ AppImage 的固有限制：确认 chrome-sandbox 的 setuid 位确实没了
  if [ -f "$SR/opt/qq-agent/chrome-sandbox" ]; then
    if [ -u "$SR/opt/qq-agent/chrome-sandbox" ]; then
      smoke_info "AppImage 内 chrome-sandbox 仍带 setuid 位" "本环境解包保留了 setuid（少见）"
    else
      smoke_info "AppImage 内 chrome-sandbox 无 setuid 位" "★ 这正是 AppRun 必须降级 --no-sandbox 的理由"
    fi
  fi
else
  smoke_warn "无法用 --appimage-extract 自检载荷" "跳过（意味着载荷没被验证过）"
fi

# ── 真实运行（复用共享的应用级检查）──
SMOKE_RUN_START="$(date +%s)"   # 供下面「产物同级不应新出现文件」的判据用
smoke_app_checks

# ── AppImage 专属追加检查 ──
smoke_head "AppImage 专属检查"
LOG="$SMOKE_TMP/app.log"
# 按**沙箱的实际状态**决定该不该期待降级提示，而不是固定匹配某个字符串
# （上一版就吃了亏：AppRun 里改了文案，这里还在找旧文案，于是明明降级了却报"没看到提示"）。
SB_EFFECTIVE=1
if [ -n "$SR" ] && [ -f "$SR/opt/qq-agent/chrome-sandbox" ]; then
  if [ "$(stat -c %u "$SR/opt/qq-agent/chrome-sandbox" 2>/dev/null)" != "0" ]; then
    SB_EFFECTIVE=0
  fi
fi
if [ "$SB_EFFECTIVE" = "0" ]; then
  if grep -q 'chrome-sandbox 无法生效' "$LOG" 2>/dev/null; then
    smoke_pass "沙箱不可用时如实提示并降级 --no-sandbox" "未静默关闭沙箱"
  else
    smoke_fail "沙箱不可用，却没看到降级提示" "AppRun 的判据可能失效 —— 真实 FUSE 场景下会起不来"
  fi
else
  smoke_info "本环境 chrome-sandbox 属主是 root" "不预期出现降级提示"
fi
# 数据绝不能写进 AppDir —— 那是只读挂载点
if [ -n "$SR" ]; then
  if [ -e "$SR/opt/qq-agent/data" ] || [ -e "$SR/data" ]; then
    smoke_fail "★ 运行后 AppDir 里出现了 data 目录" "AppDir 必须保持只读"
  else
    smoke_pass "运行后 AppDir 内无数据写入" "只读约定成立"
  fi
fi
# 单文件自包含：本次运行期间不应在产物同级写出任何文件。
# ⚠️ 判据必须用「运行开始的时间戳」而不是 `find -newer "$PKG_FILE"` ——
#    后者会把**比本产物更新的其它产物**（比如刚重建过的另一个架构的 AppImage）
#    误报成"新文件"（实测踩到过）。
if [ -n "${SMOKE_RUN_START:-}" ]; then
  neigh="$(find "$(dirname "$PKG_FILE")" -maxdepth 1 -type f -newermt "@$SMOKE_RUN_START" 2>/dev/null | head -5)"
  [ -z "$neigh" ] && smoke_pass "运行期间未在产物同级写出文件" "单文件自包含" \
    || smoke_warn "运行期间产物同级出现新文件" "$(printf '%s' "$neigh" | tr '\n' ' ')"
else
  smoke_info "跳过「产物同级新文件」检查" "未记录运行起始时间戳"
fi

if smoke_finish; then exit 0; else exit 1; fi
