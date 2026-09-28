#!/usr/bin/env bash
# ============================================================================
#  10-deb-smoke.sh — Debian 系安装包真实安装 + 冒烟测试
#
#  用法：
#    sudo bash test/10-deb-smoke.sh                     # 用 out/ 里默认产物
#    sudo bash test/10-deb-smoke.sh --arch arm64
#    sudo bash test/10-deb-smoke.sh --deb out/xxx.deb --keep
#
#  判据对齐 02-构建方案.md §5 的 12 项，另加 4 项 arm64 专属检查。
#  报告写到 out/report-smoke-<arch>.md
#
#  ⚠️ 应用以**非 root 用户**运行（取 SUDO_USER；没有就造一个一次性的），
#     否则测不出「数据目录落在用户主目录」——而那是本方案最核心的设计。
# ============================================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
# shellcheck source=test/_smoke-common.sh
source test/_smoke-common.sh

PKG_FILE=""
SMOKE_KIND="deb"
ql_parse_args "$@"
if [ "${#QL_REST[@]}" -gt 0 ]; then set -- "${QL_REST[@]}"; else set --; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --deb)          [ $# -ge 2 ] || die "--deb 后面要跟文件"; PKG_FILE="$2"; shift 2 ;;
    --deb=*)        PKG_FILE="${1#*=}"; shift ;;
    --keep)         SMOKE_KEEP=1; shift ;;
    --no-uninstall) SMOKE_SKIP_UNINSTALL=1; shift ;;
    *)              die "未知选项：$1" ;;
  esac
done

[ -n "$PKG_FILE" ] || PKG_FILE="$OUT_DIR/${PKG_NAME}_${APP_VERSION}_${DEB_ARCH}.deb"

echo "===== QQ-Agent deb 冒烟测试 ====="
arch_summary
echo "  包文件: $PKG_FILE"
echo

need_file "$PKG_FILE"
smoke_resolve_run_user
trap smoke_cleanup EXIT
smoke_setup

# ── 安装 ──
smoke_head "安装"
if dpkg -i "$PKG_FILE" > "$SMOKE_TMP/install.log" 2>&1; then
  smoke_pass "dpkg -i 成功" "退出码 0，依赖满足"
else
  smoke_warn "dpkg -i 非零退出" "尝试 apt-get -f install 补依赖"
  if apt-get -f install -y >> "$SMOKE_TMP/install.log" 2>&1 && dpkg -s "$PKG_NAME" >/dev/null 2>&1; then
    smoke_pass "补依赖后安装成功" "apt-get -f install"
  else
    smoke_fail "安装失败" "$(tail -6 "$SMOKE_TMP/install.log" | tr '\n' '|')"
    smoke_finish; exit 1
  fi
fi
if dpkg -s "$PKG_NAME" >/dev/null 2>&1; then
  smoke_pass "dpkg 已登记该包" "$(dpkg-query -W -f='${Version}' "$PKG_NAME" 2>/dev/null)"
else
  smoke_fail "dpkg 里查不到该包" "$PKG_NAME"
  smoke_finish; exit 1
fi

# ── 包内架构声明 ──
smoke_head "包元数据"
pk_arch="$(dpkg-deb -I "$PKG_FILE" 2>/dev/null | awk -F': *' '/Architecture/{print $2; exit}')"
if [ "$pk_arch" = "$DEB_ARCH" ]; then
  smoke_pass "包内 Architecture 正确" "$pk_arch"
else
  smoke_fail "包内 Architecture 不符" "期望 $DEB_ARCH，实际 ${pk_arch:-空}"
fi

smoke_static_checks
smoke_app_checks
smoke_uninstall_check

if smoke_finish; then exit 0; else exit 1; fi
