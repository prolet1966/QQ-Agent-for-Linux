#!/usr/bin/env bash
# ============================================================================
#  05-arch-audit.sh — 打包前的架构审计（★ 本工程最有价值的一道防线）
#
#  用法：
#    bash test/05-arch-audit.sh                       # 审 stage/<arch>/opt/qq-agent
#    bash test/05-arch-audit.sh --arch arm64
#    bash test/05-arch-audit.sh --root /some/tree
#
#  为什么需要它（见 05-arm64方案.md 坑 A）：
#    安装好的 Windows app 树里有一批 win32 原生件：
#      snowluma/native/snowluma-win32-x64.dll / .node
#      snowluma/native/websocket-win32-x64.node
#      snowluma/native/ffmpeg/ffmpegAddon.win32.x64.node
#    一旦照原样复制进 arm64 包，dpkg-deb / rpmbuild **不会报任何错**，
#    装完启动才发现 —— 极难排查。人工「记得小心」会失效，脚本断言不会。
#
#  四类断言：
#    A. 树里所有 ELF 必须是目标架构
#    B. 不允许出现任何 Windows PE 文件
#    C. snowluma 的四个原生件必须存在（防空包 / 防漏文件）
#    D. 主程序与关键 JS 入口必须就位
# ============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

ROOT_OVERRIDE=""
ql_parse_args "$@"
if [ "${#QL_REST[@]}" -gt 0 ]; then set -- "${QL_REST[@]}"; else set --; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --root)   [ $# -ge 2 ] || die "--root 后面要跟目录"; ROOT_OVERRIDE="$2"; shift 2 ;;
    --root=*) ROOT_OVERRIDE="${1#*=}"; shift ;;
    *)        die "未知选项：$1" ;;
  esac
done

EXPECT_ELF="$(expected_elf_machine)"
ROOT="${ROOT_OVERRIDE:-$STAGE_ARCH_DIR$PREFIX}"

echo "===== 架构审计 ====="
echo "  目标架构: $ARCH （期望 ELF machine = $EXPECT_ELF）"
echo "  审计目录: $ROOT"
[ -d "$ROOT" ] || die "审计目标不存在：$ROOT（先跑 03-stage.sh）"
echo

fails=0
fail() { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; fails=$((fails + 1)); }

# ── A + B：全树 ELF / PE 扫描 ──
echo "--- A/B. 全树 ELF 架构 与 Windows PE 检查 ---"
FILELIST="$(mktemp)"
trap 'rm -f "$FILELIST"' EXIT

if command -v file >/dev/null 2>&1; then
  # 用 file 批量扫（一次进程，快）。依赖 file 命令；没有就走下面的慢路径。
  find "$ROOT" -type f -print0 | xargs -0 -r file > "$FILELIST" 2>/dev/null || true

  # ⚠️ 只认**真正的 PE 可执行体**。不要把 `MS Windows` 一概而论：
  #    file 会把 .ico 报成 "MS Windows icon resource"，那是无害的跨平台图标资源，
  #    一律当违规会造成假失败（真跑组装时踩到过：resources/app/assets/icon.ico）。
  #    PE32 / PE32+ 是 PE 文件的标志；.dll/.exe/.node(win) 都会带上它。
  pe_hits="$(grep -E ': .*(PE32|MS-DOS executable)' "$FILELIST" || true)"
  if [ -n "$pe_hits" ]; then
    fail "发现 Windows PE 可执行文件（绝不能入包）："
    printf '%s\n' "$pe_hits" | sed "s|$ROOT/|      |" | head -20 >&2
  else
    ok "没有 Windows PE 可执行文件"
  fi

  # Windows 资源文件（图标等）无害，但要可见 —— 只提示不阻断
  winres_hits="$(grep -E ': .*MS Windows (icon|bitmap|cursor|font) resource' "$FILELIST" || true)"
  if [ -n "$winres_hits" ]; then
    warn "发现无害的 Windows 资源文件（不阻断构建，仅提示）："
    printf '%s\n' "$winres_hits" | sed "s|$ROOT/|      |" | cut -c1-110 | head -10 >&2
  else
    ok "无 Windows 资源文件残留"
  fi

  # ⚠️ 必须用 expected_elf_grep_pattern()，不能用 expected_elf_machine()：
  #    file 对 arm64 写的是小写 "ARM aarch64"，而 readelf/魔数探测写 "AArch64"。
  #    拿 "AArch64" 去 grep file 的输出会把 arm64 树上**所有** ELF 判成架构不符。
  bad_elf="$(grep ': .*ELF' "$FILELIST" | grep -vE -- "$(expected_elf_grep_pattern)" || true)"
  if [ -n "$bad_elf" ]; then
    fail "发现非 $EXPECT_ELF 架构的 ELF："
    printf '%s\n' "$bad_elf" | sed "s|$ROOT/|      |" | head -20 >&2
  else
    ok "全树 ELF 均为 $EXPECT_ELF（共 $(grep -c ': .*ELF' "$FILELIST" || echo 0) 个）"
  fi
else
  warn "没有 file 命令，走逐文件魔数慢路径"
  n_elf=0
  while IFS= read -r -d '' f; do
    if is_pe "$f"; then
      fail "Windows PE 文件：${f#"$ROOT"/}"
      continue
    fi
    if is_elf "$f"; then
      n_elf=$((n_elf + 1))
      m="$(elf_machine "$f")"
      [ "$m" = "$EXPECT_ELF" ] || fail "架构不符（$m）：${f#"$ROOT"/}"
    fi
  done < <(find "$ROOT" -type f -print0)
  ok "扫到 $n_elf 个 ELF"
fi

echo
echo "--- C. snowluma 原生件（四个都必须在，且名字要带 linux-${ELECTRON_ARCH}）---"
NATIVE="$ROOT/resources/app/snowluma/native"
want_native=(
  "snowluma-linux-${ELECTRON_ARCH}.node"
  "snowluma-linux-${ELECTRON_ARCH}.so"
  "websocket-linux-${ELECTRON_ARCH}.node"
  "ffmpeg/ffmpegAddon.linux.${ELECTRON_ARCH}.node"
)
if [ ! -d "$NATIVE" ]; then
  fail "snowluma/native 目录不存在：$NATIVE"
else
  for w in "${want_native[@]}"; do
    if [ -f "$NATIVE/$w" ]; then
      ok "native/$w"
    else
      fail "缺少原生件 native/$w"
    fi
  done
  # 反向检查：有没有 win32 残留
  leftover="$(find "$NATIVE" \( -iname '*win32*' -o -iname '*win64*' -o -iname '*.dll' \) 2>/dev/null | head -10)"
  if [ -n "$leftover" ]; then
    fail "native/ 下有 Windows 残留："
    printf '%s\n' "$leftover" | sed "s|$ROOT/|      |" >&2
  fi
fi

echo
echo "--- D. 主程序与关键入口 ---"
BIN="$ROOT/qq-agent"
if [ -f "$BIN" ]; then
  m="$(elf_machine "$BIN")"
  [ "$m" = "$EXPECT_ELF" ] && ok "主程序 qq-agent 架构 = $m" \
    || fail "主程序架构不符：期望 $EXPECT_ELF，实际 ${m:-不是 ELF}"
  [ -x "$BIN" ] || fail "主程序没有执行位"
else
  fail "主程序不存在：$BIN"
fi
for rel in resources/app/package.json \
           resources/app/electron/main.js \
           resources/app/src/app.js \
           resources/app/src/routes.js \
           resources/app/snowluma/index.mjs; do
  [ -f "$ROOT/$rel" ] && ok "$rel" || fail "缺少 $rel"
done

# 补丁是否真的打上了（漏打补丁的包在 Linux 上必坏）
#
# ⚠️ 2026-09-29：这条判据**只对「Windows 源 + 补丁」那条产物线成立**。
#    本仓库已经自带 Linux 适配（数据目录走 XDG、SnowLuma 不可写时启用可写镜像），
#    它不经过 patch-linux.mjs，自然也没有 QQA_LINUX_PATCH 标记。
#    用 --no-patch 直接从本仓库组装时（QL_NO_PATCH=1），跳过这两条断言 ——
#    对应功能改由冒烟测试实测（数据目录落点 / SnowLuma 镜像与 native 软链）。
if [ "${QL_NO_PATCH:-0}" = "1" ]; then
  echo "  · 跳过补丁标记断言（QL_NO_PATCH=1：直接使用自带 Linux 适配的仓库代码）"
  echo "    功能由冒烟测试实测：数据目录落 XDG / SnowLuma 不可写时建可写镜像"
elif [ -f "$ROOT/resources/app/src/app.js" ]; then
  if grep -q 'QQA_LINUX_PATCH:snowluma-runtime-mirror' "$ROOT/resources/app/src/app.js"; then
    ok "snowluma-runtime-mirror 补丁已应用"
  else
    fail "snowluma-runtime-mirror 补丁未应用（Linux 上 SnowLuma 写配置必失败）"
  fi
  if grep -q 'QQA_LINUX_PATCH:data-dir-xdg' "$ROOT/resources/app/electron/main.js"; then
    ok "data-dir-xdg 补丁已应用"
  else
    fail "data-dir-xdg 补丁未应用（数据会写到只读的 /opt）"
  fi
fi

echo
echo "--- E. 权限位（防 world-writable 入包）---"
# 为什么查这个：打包基线的应用代码是从 Windows 的 drvfs 复制来的，那边文件权限
# 一律显示 777。不归一化就会把「root 拥有但全局可写」的文件装进 /opt，
# 任何本地用户都能改程序代码。实测踩到过（74+ 个文件全是 777）。
# 只用 stat/find，不依赖任何外部工具。
if command -v stat >/dev/null 2>&1; then
  ww="$(find "$ROOT" \( -type f -o -type d \) -perm -0002 2>/dev/null | head -20)"
  if [ -n "$ww" ]; then
    fail "存在全局可写（o+w）的文件/目录 —— 装到 /opt 后任何本地用户都能改程序："
    printf '%s\n' "$ww" | sed "s|$ROOT/|      |" >&2
  else
    ok "无全局可写项"
  fi

  if [ -f "$BIN" ]; then
    bm="$(stat -c '%a' "$BIN" 2>/dev/null)"
    case "$bm" in
      *755) ok "主程序模式 $bm" ;;
      *)    fail "主程序模式 $bm（期望 755）" ;;
    esac
  fi
  if [ -f "$ROOT/chrome-sandbox" ]; then
    cm="$(stat -c '%a' "$ROOT/chrome-sandbox" 2>/dev/null)"
    case "$cm" in
      4755) ok "chrome-sandbox 模式 $cm（setuid 正确）" ;;
      *)    warn "chrome-sandbox 模式 $cm（期望 4755；安装脚本会再补一次）" ;;
    esac
  fi
  # 原生件不需要执行位，倒是 world-writable 才是问题，上面已覆盖
else
  warn "没有 stat 命令，跳过权限位检查"
fi

echo
echo "===== 审计结论 ====="
echo "  目标: $ARCH   目录: $ROOT"
if [ "$fails" -eq 0 ]; then
  ok "架构审计全部通过，产物可以打包。"
  exit 0
fi
printf '\033[31m  审计未通过：%d 项问题，拒绝打包。\033[0m\n' "$fails" >&2
exit 1
