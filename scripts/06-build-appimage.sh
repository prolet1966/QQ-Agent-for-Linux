#!/usr/bin/env bash
# ============================================================================
#  06-build-appimage.sh — 打通用版 AppImage
#
#  用法：
#    bash scripts/06-build-appimage.sh                 # x86_64
#    bash scripts/06-build-appimage.sh --arch arm64     # aarch64
#
#  前置：先跑 bash scripts/03-stage.sh --arch <arch>
#  产出：out/QQ-Agent-<版本>-<appimage架构>.AppImage
#
#  ⚠️ 位置约定：按用户红线，**AppImage 最后做** —— 等 deb/rpm 都通过之后。
#
#  设计要点（见 02-构建方案.md §3.3/§3.4）：
#    1. AppDir 是**只读挂载点**，运行期数据一律落到用户主目录（XDG）
#    2. ★ AppImage 的固有限制：SquashFS 经 FUSE 挂载后 **setuid 位无效**，
#       而 Chromium 沙箱要求 chrome-sandbox 是 setuid root。
#       → AppRun 检测到不可用时**显式降级 --no-sandbox 并提示一次**（不静默）
#    3. 工具链（appimagetool / type2-runtime）走官方摘要校验，与 SnowLuma/Electron 同纪律
# ============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

ql_parse_args "$@"
[ "${#QL_REST[@]}" -eq 0 ] || die "未知选项：${QL_REST[*]}"
prepare_dirs

STAGE_ROOT="$STAGE_ARCH_DIR"
[ -d "$STAGE_ROOT$PREFIX" ] || die "stage 树不存在：$STAGE_ROOT$PREFIX（先跑 03-stage.sh --arch $ARCH）"

APPIMAGE_NAME="QQ-Agent-${APP_VERSION}-${APPIMAGE_ARCH}.AppImage"
OUT="$OUT_DIR/$APPIMAGE_NAME"

echo "===== 打 AppImage ====="
arch_summary
echo "  AppImage 架构名: $APPIMAGE_ARCH"
echo "  来源: $STAGE_ROOT"
echo "  产出: $OUT"
echo

command -v mksquashfs >/dev/null 2>&1 || die "没有 mksquashfs（sudo apt install squashfs-tools）"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── 1. 取工具链（下载 + 官方摘要校验）──
echo "--- 工具链 ---"
# ★ 用**宿主架构**的 appimagetool + **目标架构**的 runtime：
#   appimagetool 只做「拼装 + 调 mksquashfs」，**不需要执行目标架构的代码**，
#   所以跨架构打 AppImage **完全不依赖 qemu**（这点比 rpmbuild 友好得多 ——
#   rpmbuild 有硬性架构保护，只能靠 aarch64 环境）。
#   实测踩到过：在 x86_64 上直接跑 aarch64 的 appimagetool 会
#   `cannot execute binary file: Exec format error`（且 WSL 重启后 binfmt 注册还会丢）。
HOST_AI_ARCH="$(uname -m 2>/dev/null || echo unknown)"
case "$HOST_AI_ARCH" in
  x86_64|aarch64) ;;
  amd64) HOST_AI_ARCH=x86_64 ;;
  arm64) HOST_AI_ARCH=aarch64 ;;
  *)     HOST_AI_ARCH="$APPIMAGE_ARCH" ;;   # 认不出来就退回目标架构
esac

SAVED_APPIMAGE_ARCH="$APPIMAGE_ARCH"
APPIMAGE_ARCH="$HOST_AI_ARCH"
AITOOL="$(ensure_appimage_tool appimagetool)"
APPIMAGE_ARCH="$SAVED_APPIMAGE_ARCH"
RUNTIME="$(ensure_appimage_tool runtime)"

echo "  appimagetool: $AITOOL  （宿主架构 $HOST_AI_ARCH）"
echo "  runtime     : $RUNTIME  （目标架构 $APPIMAGE_ARCH）"
# runtime 的架构必须与目标一致，否则打出来的 AppImage 起不来
rm="$(elf_machine "$RUNTIME")"
[ "$rm" = "$(expected_elf_machine)" ] || die "runtime 架构不符：期望 $(expected_elf_machine)，实际 $rm"

# ── 2. 组 AppDir ──
APPDIR="$TMP/AppDir"
mkdir -p "$APPDIR"
echo
echo "--- 组 AppDir ---"
cp -a "$STAGE_ROOT/opt" "$APPDIR/"
[ -d "$STAGE_ROOT/usr" ] && cp -a "$STAGE_ROOT/usr" "$APPDIR/"
# appimagetool 要求 AppDir 根下有同名 .desktop 与图标
cp -f "$STAGE_ROOT/usr/share/applications/qq-agent.desktop" "$APPDIR/qq-agent.desktop" \
  || die "缺少 desktop 文件"
ICON="$STAGE_ROOT/usr/share/icons/hicolor/512x512/apps/qq-agent.png"
if [ -f "$ICON" ]; then
  cp -f "$ICON" "$APPDIR/qq-agent.png"
else
  warn "没有图标；appimagetool 可能报缺图标（AppDir 根下的 qq-agent.png）"
fi

cat > "$APPDIR/AppRun" <<'APPRUN_EOF'
#!/bin/sh
# AppRun — AppImage 入口
# AppDir 是只读挂载点：程序在这里读，**运行期数据一律写用户主目录**。
HERE="$(dirname "$(readlink -f "$0")")"
APP_DIR="$HERE/opt/qq-agent"
BIN="$APP_DIR/qq-agent"

: "${XDG_DATA_HOME:=$HOME/.local/share}"
export XDG_DATA_HOME
: "${QQ_AGENT_DATA_DIR:=$XDG_DATA_HOME/qq-agent/data}"
export QQ_AGENT_DATA_DIR
mkdir -p "$QQ_AGENT_DATA_DIR" 2>/dev/null || true
mkdir -p "$XDG_DATA_HOME/qq-agent/snowluma" 2>/dev/null || true

# ★ AppImage 形态的固有限制：Chromium 沙箱要求 chrome-sandbox 是 setuid root。
#   ⚠️ 判据**不能只看文件的 setuid 位**：
#      真实使用时 AppImage 经 FUSE 挂载，而 FUSE 挂载默认带 nosuid ——
#      位还在，内核却忽略它，沙箱照样失效。
#      只判 `-u` 会在真实场景下漏掉降级，导致 Chromium 直接启动失败；
#      而 extract-and-run（解到普通文件系统）却会"恰好通过"，本地测不出来。
#   必须同时满足：位在 + 属主是 root + 所在挂载点不是 nosuid。
sandbox_effective() {
  _f="$1"
  [ -u "$_f" ] || return 1
  [ "$(stat -c %u "$_f" 2>/dev/null)" = "0" ] || return 1
  _d="$(dirname "$_f")"
  _opts="$(awk -v d="$_d" '
    { mp=$2; gsub(/\\040/, " ", mp)
      # 根挂载点不能拼成 "//"，否则永远匹配不上（实测踩到：/home/x 取到空串）
      pfx = (mp == "/") ? "/" : mp "/"
      if (d == mp || index(d, pfx) == 1) { if (length(mp) > best) { best = length(mp); o = $4 } } }
    END { print o }' /proc/mounts 2>/dev/null)"
  case ",$_opts," in *,nosuid,*) return 1 ;; esac
  return 0
}

NO_SANDBOX=""
if [ -f "$APP_DIR/chrome-sandbox" ] && ! sandbox_effective "$APP_DIR/chrome-sandbox"; then
  NO_SANDBOX="--no-sandbox"
  STAMP="$QQ_AGENT_DATA_DIR/.appimage-sandbox-notice"
  if [ ! -f "$STAMP" ]; then
    echo "[qq-agent] 提示：AppImage 内的 chrome-sandbox 无法生效" >&2
    echo "[qq-agent]       （FUSE 挂载带 nosuid，或属主不是 root），" >&2
    echo "[qq-agent]       因此本次以 --no-sandbox 启动（Chromium 沙箱关闭）。" >&2
    echo "[qq-agent]       这是 AppImage 形态的固有限制；需要沙箱请改用 .deb / .rpm 版本。" >&2
    : > "$STAMP" 2>/dev/null || true
  fi
fi

: "${ELECTRON_OZONE_PLATFORM_HINT:=auto}"
export ELECTRON_OZONE_PLATFORM_HINT

case "${LANG:-}" in ""|C|POSIX) LANG=C.UTF-8; export LANG ;; esac

# shellcheck disable=SC2086
exec "$BIN" $NO_SANDBOX "$@"
APPRUN_EOF
chmod 755 "$APPDIR/AppRun"
ok "AppDir 就绪（$(du -sh "$APPDIR" | cut -f1)）"

# ── 3. 跑 appimagetool ──
echo
echo "--- appimagetool ---"
AILOG="$TMP/appimagetool.log"
run_aitool() {
  if APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$APPIMAGE_ARCH" "$AITOOL" \
       --no-appstream --runtime-file "$RUNTIME" "$APPDIR" "$OUT" > "$AILOG" 2>&1; then
    return 0
  fi
  # 回退：无 FUSE 时把 appimagetool 自己解包再跑它的 AppRun
  warn "直接运行 appimagetool 失败，回退到解包运行（无 FUSE 环境常见）"
  ( cd "$TMP" && "$AITOOL" --appimage-extract >/dev/null 2>&1 \
    && APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$APPIMAGE_ARCH" "$TMP/squashfs-root/AppRun" \
         --no-appstream --runtime-file "$RUNTIME" "$APPDIR" "$OUT" > "$AILOG" 2>&1 )
}
if ! run_aitool; then
  echo "--- appimagetool 输出 ---" >&2
  tail -25 "$AILOG" >&2 || true
  die "appimagetool 失败"
fi
tail -6 "$AILOG" | sed 's/^/  /' || true

need_file "$OUT"
sha256_of "$OUT" > "$OUT.sha256"

# ── 4. 产物自检（不只看 appimagetool 说成功）──
echo
echo "--- 产物自检 ---"
m="$(elf_machine "$OUT")"
[ "$m" = "$(expected_elf_machine)" ] || die "AppImage 头部架构不符：期望 $(expected_elf_machine)，实际 ${m:-非ELF}"
ok "AppImage 是可执行 ELF，架构 $m"

# 解出来看载荷。
#   首选 AppImage 自带的 --appimage-extract（需要 runtime 能执行）；
#   ★ 跨架构时 runtime 执行不了（`cannot execute binary file: Exec format error`），
#     但 AppImage 的 squashfs 偏移**恰好等于 runtime 文件大小**
#     （已实测：x86_64 产物 `--appimage-offset` 报 944632 == runtime-x86_64 的字节数），
#     所以可以直接用 `unsquashfs -o <runtime大小>` 读载荷 —— **不需要执行目标架构的代码**。
EX="$TMP/extract"
mkdir -p "$EX"
SR=""
if ( cd "$EX" && "$OUT" --appimage-extract >/dev/null 2>&1 ) && [ -d "$EX/squashfs-root" ]; then
  SR="$EX/squashfs-root"
  ok "载荷自检方式：--appimage-extract（runtime 可执行）"
else
  OFF="$(wc -c <"$RUNTIME" | tr -d ' ')"
  if command -v unsquashfs >/dev/null 2>&1 \
     && unsquashfs -o "$OFF" -d "$EX/squashfs-root" "$OUT" >/dev/null 2>&1; then
    SR="$EX/squashfs-root"
    ok "载荷自检方式：unsquashfs -o $OFF（跨架构，无需执行）"
  fi
fi

if [ -z "$SR" ]; then
  die "无法自检载荷（--appimage-extract 与 unsquashfs 都失败）—— 拒绝交付未验证的产物"
fi

for f in AppRun qq-agent.desktop opt/qq-agent/qq-agent \
         opt/qq-agent/resources/app/src/app.js \
         opt/qq-agent/resources/app/snowluma/index.mjs \
         "opt/qq-agent/resources/app/snowluma/native/snowluma-linux-${ELECTRON_ARCH}.node" \
         "opt/qq-agent/resources/app/snowluma/native/ffmpeg/ffmpegAddon.linux.${ELECTRON_ARCH}.node"; do
  [ -e "$SR/$f" ] && ok "载荷含 $f" || die "载荷缺 $f"
done
pm="$(elf_machine "$SR/opt/qq-agent/qq-agent")"
[ "$pm" = "$(expected_elf_machine)" ] || die "载荷主程序架构不符：$pm"
ok "载荷主程序架构 $pm"
n_win=$(find "$SR" \( -iname '*win32*' -o -iname '*win64*' -o -iname '*.dll' \) 2>/dev/null | wc -l)
[ "$n_win" = 0 ] && ok "载荷无 Windows 残留" || die "载荷有 Windows 残留 $n_win 项"
for bad in opt/qq-agent/resources/app/snowluma/data opt/qq-agent/resources/app/snowluma/config \
           opt/qq-agent/resources/app/snowluma/logs; do
  [ -e "$SR/$bad" ] && die "载荷混入运行期数据：$bad" || true
done
ok "载荷无运行期数据"

echo
ok "AppImage 打包完成"
echo "  $(basename "$OUT")  $(du -h "$OUT" | cut -f1)"
echo "  SHA256: $(cat "$OUT.sha256")"
echo
echo "  冒烟测试：bash test/30-appimage-smoke.sh --arch $ARCH"
