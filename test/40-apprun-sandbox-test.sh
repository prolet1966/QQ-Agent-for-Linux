#!/usr/bin/env bash
# ============================================================================
#  40-apprun-sandbox-test.sh — AppRun「沙箱是否可用」判据的单元测试
#
#  ⚠️ 为什么需要单独的测试文件：
#    这个判据的关键分支在**端到端冒烟里覆盖不到**：
#      - extract-and-run 把载荷解到普通文件系统 → 只会走到「属主不是 root」那一支
#      - **真实 FUSE 挂载带 nosuid** → 才是真会出事的那一支（本地跑不出来）
#    而 06-构建与验证实录.md §4.7 记录的正是这个 bug：只判 `-u` 会漏掉降级，
#    真实用户装上就起不来。
#
#  做法：从**已构建的 AppImage 里**把 AppRun 抠出来（测的是真正发货的代码，
#        不是源码的副本），再把它里面的 sandbox_effective() 抽出来，
#        用夹具把 5 种情况逐个测一遍。
#
#  用法：
#    bash test/40-apprun-sandbox-test.sh                    # 用 out/ 里默认产物
#    bash test/40-apprun-sandbox-test.sh --appimage out/xxx.AppImage
#
#  需要 root 才能造 nosuid 挂载点与 root 属主夹具；非 root 时这两个用例会跳过
#  并**明确标注跳过**（不允许静默当成通过）。
# ============================================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

ql_parse_args "$@"
if [ "${#QL_REST[@]}" -gt 0 ]; then set -- "${QL_REST[@]}"; else set --; fi

APPIMAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --appimage)   [ $# -ge 2 ] || die "--appimage 后面要跟文件"; APPIMAGE="$2"; shift 2 ;;
    --appimage=*) APPIMAGE="${1#*=}"; shift ;;
    *)            die "未知选项：$1" ;;
  esac
done
[ -n "$APPIMAGE" ] || APPIMAGE="$OUT_DIR/QQ-Agent-${APP_VERSION}-${APPIMAGE_ARCH}.AppImage"

echo "===== AppRun 沙箱判据单元测试 ====="
echo "  产物: $APPIMAGE"
[ -f "$APPIMAGE" ] || die "找不到 AppImage（先跑 06-build-appimage.sh --arch $ARCH）"

TMP="$(mktemp -d)"
MNT="$TMP/nosuid"
cleanup() {
  mountpoint -q "$MNT" 2>/dev/null && sudo umount "$MNT" 2>/dev/null
  rm -rf "$TMP" "${NORM_DIR:-}"
}
trap cleanup EXIT

# ── 1. 从产物里抠出 AppRun（测发货代码，不是源码副本）──
SR=""
mkdir -p "$TMP/ex"
if ( cd "$TMP/ex" && "$APPIMAGE" --appimage-extract >/dev/null 2>&1 ) && [ -d "$TMP/ex/squashfs-root" ]; then
  SR="$TMP/ex/squashfs-root"
else
  OFF="$(wc -c <"$(dirname "$APPIMAGE")/../tools/runtime-${APPIMAGE_ARCH}" 2>/dev/null | tr -d ' ' || echo 0)"
  if [ "$OFF" != "0" ] && command -v unsquashfs >/dev/null 2>&1 \
     && unsquashfs -o "$OFF" -d "$TMP/ex/squashfs-root" "$APPIMAGE" >/dev/null 2>&1; then
    SR="$TMP/ex/squashfs-root"
  fi
fi
[ -n "$SR" ] && [ -f "$SR/AppRun" ] || die "抠不出 AppRun —— 无法测试（拒绝跳过）"
APPRUN="$SR/AppRun"
echo "  AppRun 取自产物: $(wc -l <"$APPRUN") 行"

# ── 2. 把 sandbox_effective() 抽出来做成可调用的探针 ──
FUNC="$(sed -n '/^sandbox_effective() {/,/^}/p' "$APPRUN")"
if [ -z "$FUNC" ]; then
  echo "!! AppRun 里找不到 sandbox_effective()" >&2
  exit 1
fi
PROBE="$TMP/probe.sh"
{
  echo '#!/bin/sh'
  printf '%s\n' "$FUNC"
  echo 'if sandbox_effective "$1"; then echo EFFECTIVE; else echo INEFFECTIVE; fi'
} > "$PROBE"
chmod 755 "$PROBE"

# ── 3. 夹具 ──
pass=0; fail=0; skip=0
chk() {  # chk <描述> <期望 EFFECTIVE|INEFFECTIVE> <文件>
  local desc="$1" want="$2" f="$3" got
  got="$(sh "$PROBE" "$f" 2>/dev/null || echo INEFFECTIVE)"
  if [ "$got" = "$want" ]; then
    printf '\033[32m  ✓\033[0m %-46s %s\n' "$desc" "$got"; pass=$((pass+1))
  else
    printf '\033[31m  ✗\033[0m %-46s 得到 %s，期望 %s\n' "$desc" "$got" "$want"; fail=$((fail+1))
  fi
}
skipto() { printf '\033[33m  !\033[0m %-46s 跳过：%s\n' "$1" "$2"; skip=$((skip+1)); }

echo
echo "--- 用例 ---"
# ⚠️ 两个坑（都是实测踩到的）：
#  1) 以 root 跑时 `touch` 出来的文件属主就是 root，而"属主非 root"这条用例的前提
#     恰恰要被破坏 → 必须**显式 chown 给非 root 用户**，否则用例假失败。
#  2) **/tmp 在不少系统上本身就是 nosuid**（本 WSL 实测：`/tmp rw,nosuid,nodev,size=...`）。
#     所以"普通文件系统"的夹具**不能放 /tmp** —— 否则会用错误的前提把函数误判成 bug
#     （第一版就是这么错的）。这里放到 $HOME（实测落在 / 上，非 nosuid）。
NONROOT_USER="${SUDO_USER:-nobody}"
[ "$NONROOT_USER" = "root" ] && NONROOT_USER=nobody
NORM_DIR="$(mktemp -d "${HOME:-/root}/.ql-sbtest.XXXXXX")" || die "造不出普通 fs 夹具目录"

mk_nonroot_4755() { touch "$1"; chown "$NONROOT_USER" "$1" 2>/dev/null || sudo chown "$NONROOT_USER" "$1" 2>/dev/null || true; chmod 4755 "$1" 2>/dev/null || sudo chmod 4755 "$1"; }
mk_root_4755()    { touch "$1"; chown root:root "$1" 2>/dev/null || sudo chown root:root "$1" 2>/dev/null || true;     chmod 4755 "$1" 2>/dev/null || sudo chmod 4755 "$1"; }
fs_of() { findmnt -no TARGET,OPTIONS --target "$1" 2>/dev/null | tr -s ' '; }

# 1) 没有 setuid 位 → 不可用
touch "$NORM_DIR/a"; chmod 644 "$NORM_DIR/a"
chk "无 setuid 位" INEFFECTIVE "$NORM_DIR/a"

# 2) 有 setuid 位但属主不是 root → 不可用
mk_nonroot_4755 "$NORM_DIR/b"
chk "有 setuid 位但属主非 root（属主=$NONROOT_USER）" INEFFECTIVE "$NORM_DIR/b"

# 3) 路径不存在 → 不可用（判据不能在异常输入下崩）
chk "文件不存在" INEFFECTIVE "$NORM_DIR/does-not-exist"

# 4) setuid + 属主 root + **非 nosuid** 文件系统 → 可用（不该无谓地关沙箱）
if [ "$(id -u)" = "0" ] || sudo -n true 2>/dev/null; then
  mk_root_4755 "$NORM_DIR/c"
  echo "  参考：$NORM_DIR/c 所在挂载点 → $(fs_of "$NORM_DIR/c")"
  chk "setuid + 属主 root + 非 nosuid（应有沙箱）" EFFECTIVE "$NORM_DIR/c"

  # 5) ★ setuid + 属主 root + **nosuid 挂载** → 不可用
  #    这一支就是真实 FUSE 场景；端到端冒烟到不了这里（见 06-构建与验证实录.md §4.7）
  mkdir -p "$MNT"
  if sudo mount -t tmpfs -o nosuid,size=1M tmpfs "$MNT" 2>/dev/null; then
    mk_root_4755 "$MNT/d"
    echo "  参考：$MNT/d 所在挂载点 → $(fs_of "$MNT/d")"
    chk "★ setuid + 属主 root + nosuid（真实 FUSE 场景）" INEFFECTIVE "$MNT/d"

    # 6) 额外数据点：/tmp 常常本身就是 nosuid（记录下来，免得以后又拿它当"普通 fs"）
    mk_root_4755 "$TMP/e"
    if fs_of "$TMP/e" | grep -q nosuid; then
      chk "setuid + 属主 root + /tmp（本就是 nosuid）" INEFFECTIVE "$TMP/e"
    else
      skipto "/tmp 用例" "本机 /tmp 不是 nosuid（少见）"
    fi
  else
    skipto "nosuid 挂载用例（2 个）" "无法挂载 tmpfs（需要 root/权限）"
  fi
else
  skipto "root 属主用例（3 个）" "没有 root/sudo"
fi

echo
printf '\033[36m=== 结论 ===\033[0m\n'
printf '  通过 %s · 失败 %s · 跳过 %s\n' "$pass" "$fail" "$skip"
if [ "$fail" -gt 0 ]; then
  echo "  ❌ 判据有问题 —— 真实 FUSE 场景下 AppImage 可能起不来" >&2
  exit 1
fi
if [ "$skip" -gt 0 ]; then
  echo "  ⚠️  有用例被跳过（不算通过）。要完整验证请在 root 下重跑。"
fi
echo "  ✅ 已执行的用例全部符合预期。"
