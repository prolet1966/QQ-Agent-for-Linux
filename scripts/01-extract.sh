#!/usr/bin/env bash
# ============================================================================
#  01-extract.sh — 下载 / 解包 arm64|x86_64 运行时，并核对完整性
#
#  用法：
#    bash scripts/01-extract.sh                 # x86_64（默认，行为同改造前）
#    bash scripts/01-extract.sh --arch arm64
#
#  产出（cache/，两个架构可共存）：
#    electron-v33.4.11-linux-<arch>/     ← 解包后的 Electron 运行时
#    snowluma-linux-<arch>/              ← 解包后的 SnowLuma
#
#  ⚠️ arm64 的 SnowLuma SHA256 若尚未核对，本脚本会**主动失败**（见 lib.sh）。
# ============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

ql_parse_args "$@"
prepare_dirs

echo "===== 0. 目标架构 ====="
arch_summary
echo "  期望 ELF machine: $(expected_elf_machine)"
echo

echo "===== 1. Electron ${ELECTRON_VERSION} linux-${ELECTRON_ARCH} ====="
EDIR="$(ensure_electron)"
echo "  目录: $EDIR"
ls -la "$EDIR/electron"
echo "  顶层条目数: $(ls "$EDIR" | wc -l)"
if [ -f "$EDIR/chrome-sandbox" ]; then
  ls -la "$EDIR/chrome-sandbox"
  echo "  （注意：setuid 位会在打包时丢失，安装脚本里要 chmod 4755 补回）"
else
  echo "  （无 chrome-sandbox）"
fi

# ★ 架构自检：主程序必须真的是本架构的 ELF
em="$(elf_machine "$EDIR/electron")"
printf '  架构探测: %s\n' "${em:-（不是 ELF？）}"
if [ "$em" != "$(expected_elf_machine)" ]; then
  die "Electron 主程序架构不符：期望 $(expected_elf_machine)，实际 ${em:-未知}"
fi
ok "Electron 架构正确"

echo
echo "===== 2. SnowLuma ${SNOWLUMA_VERSION} linux-${SNOWLUMA_ARCH} ====="
SDIR="$(ensure_snowluma)"
echo "  目录: $SDIR"
echo "  顶层内容:"
ls -la "$SDIR" | head -30

echo
snowluma_native_report "$SDIR"

echo
echo "===== 3. SnowLuma 关键启动契约 ====="
echo "--- launcher.sh（如果有）---"
if [ -f "$SDIR/launcher.sh" ]; then cat "$SDIR/launcher.sh"; else echo "  （无 launcher.sh）"; fi
echo
echo "--- 自带 node？ ---"
if [ -x "$SDIR/node" ]; then
  ls -la "$SDIR/node"
  "$SDIR/node" -v 2>&1 || true
  nm="$(elf_machine "$SDIR/node")"
  printf '  node 架构探测: %s\n' "${nm:-（不是 ELF？）}"
  if [ "$nm" != "$(expected_elf_machine)" ]; then
    die "SnowLuma 自带 node 架构不符：期望 $(expected_elf_machine)，实际 ${nm:-未知}"
  fi
  ok "自带 node 架构正确"
elif [ -f "$SDIR/node" ]; then
  ls -la "$SDIR/node"
  warn "自带 node 没有执行位（03-stage.sh 会补 755）"
else
  warn "（无自带 node，将依赖系统 node ^22.13 || >=23.4）"
fi
echo
echo "--- package.json ---"
cat "$SDIR/package.json" 2>/dev/null || echo "  （无）"

echo
echo "===== 完成 ====="
echo "  运行时已就绪：$ARCH"
echo "  下一步：bash scripts/03-stage.sh --arch $ARCH"
