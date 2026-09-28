#!/usr/bin/env bash
# ============================================================================
#  20-rpm-smoke.sh — RPM 系安装包真实安装 + 冒烟测试
#
#  用法：
#    sudo bash test/20-rpm-smoke.sh                    # 用 out/ 里默认产物
#    sudo bash test/20-rpm-smoke.sh --arch arm64
#    sudo bash test/20-rpm-smoke.sh --rpm out/xxx.rpm --keep
#
#  ⚠️ 在 Debian/Ubuntu 上跑 rpm 时，`rpm -i` 不做依赖解析（没有 dnf/yum 的
#     依赖库）。这时会回退成 `rpm -i --nodeps`，并**如实记为警告**——
#     依赖是否满足在这种环境下**无法验证**，不要把它当成"依赖没问题"。
#     要真正验证依赖，得在 RHEL/Rocky/Alma/Fedora 上跑。
# ============================================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
# shellcheck source=test/_smoke-common.sh
source test/_smoke-common.sh

PKG_FILE=""
SMOKE_KIND="rpm"
ql_parse_args "$@"
if [ "${#QL_REST[@]}" -gt 0 ]; then set -- "${QL_REST[@]}"; else set --; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --rpm)          [ $# -ge 2 ] || die "--rpm 后面要跟文件"; PKG_FILE="$2"; shift 2 ;;
    --rpm=*)        PKG_FILE="${1#*=}"; shift ;;
    --keep)         SMOKE_KEEP=1; shift ;;
    --no-uninstall) SMOKE_SKIP_UNINSTALL=1; shift ;;
    *)              die "未知选项：$1" ;;
  esac
done

[ -n "$PKG_FILE" ] || PKG_FILE="$OUT_DIR/${PKG_NAME}-${APP_VERSION}-${PKG_RELEASE}.${RPM_ARCH}.rpm"

echo "===== QQ-Agent rpm 冒烟测试 ====="
arch_summary
echo "  包文件: $PKG_FILE"
echo

need_file "$PKG_FILE"
command -v rpm >/dev/null 2>&1 || die "没有 rpm 命令（Debian 系：sudo apt install rpm）"
smoke_resolve_run_user
trap smoke_cleanup EXIT
smoke_setup

# ── 包元数据 ──
smoke_head "包元数据"
pk_arch="$(rpm -qp --qf '%{ARCH}' "$PKG_FILE" 2>/dev/null || true)"
if [ "$pk_arch" = "$RPM_ARCH" ]; then
  smoke_pass "包内 ARCH 正确" "$pk_arch"
else
  smoke_fail "包内 ARCH 不符" "期望 $RPM_ARCH，实际 ${pk_arch:-空}"
fi

# ── 安装 ──
smoke_head "安装"
if rpm -i "$PKG_FILE" > "$SMOKE_TMP/install.log" 2>&1; then
  smoke_pass "rpm -i 成功" "依赖满足"
else
  smoke_warn "rpm -i 非零退出" "本机可能没有 rpm 依赖库，回退 --nodeps"
  if rpm -i --nodeps "$PKG_FILE" >> "$SMOKE_TMP/install.log" 2>&1 && rpm -q "$PKG_NAME" >/dev/null 2>&1; then
    smoke_pass "（回退）rpm -i --nodeps 安装成功" "依赖**未在本机解析**，见下方说明"
    smoke_warn "本机解析不了 rpm 依赖" "已回退 --nodeps；依赖是否合理由 test/50-rpm-deps-resolve.sh 对照 Fedora/RHEL 真实元数据验证"
  else
    smoke_fail "安装失败" "$(tail -6 "$SMOKE_TMP/install.log" | tr '\n' '|')"
    smoke_finish; exit 1
  fi
fi
if rpm -q "$PKG_NAME" >/dev/null 2>&1; then
  smoke_pass "rpm 已登记该包" "$(rpm -q --qf '%{VERSION}-%{RELEASE}' "$PKG_NAME" 2>/dev/null)"
else
  smoke_fail "rpm 里查不到该包" "$PKG_NAME"
  smoke_finish; exit 1
fi

smoke_static_checks
smoke_app_checks
smoke_uninstall_check

if smoke_finish; then exit 0; else exit 1; fi
