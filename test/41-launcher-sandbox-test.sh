#!/usr/bin/env bash
# ============================================================================
#  41-launcher-sandbox-test.sh — .deb / .rpm 启动器的沙箱降级单元测试
#
#  ⚠️ 为什么必须有这个文件（别删，见 06-构建与验证实录.md §4.7）：
#
#    AppRun 侧早在 06-build-appimage.sh 就有 `sandbox_effective()` 三重校验，
#    也有 test/40-apprun-sandbox-test.sh 覆盖它。
#    **但 .deb / .rpm 启动器曾经只判 `-u`（setuid 位）**，于是在 Parallels /
#    VMware 这类把系统卷按 nosuid 挂载的虚拟机里：
#        启动器认为「沙箱可用」→ 不加任何参数
#        → 内核照样丢弃 setuid → Chromium 直接 FATAL 退出
#    现象就是同一台机器上 **AppImage 能跑、.deb 跑不起来**。
#
#    修法：启动器改用 `sandbox_reason()`（位 + 属主 + 挂载点三项全查），
#    确认不可用时**显式降级 --no-sandbox 并提示一次**。
#
#  本文件测两件事，缺一不可：
#    A. `sandbox_reason()` 判据本身对不对（五个用例，坑同 40）
#    B. **降级有没有真的接上** —— 光有函数不算修好：
#       若 exec 行没带上 $NO_SANDBOX，降级就是个摆设，行为与修之前完全一致。
#       这一层此前**没有任何测试覆盖**，正是它漏掉了这个 bug。
#
#  用法：
#    bash test/41-launcher-sandbox-test.sh                    # x86_64
#    bash test/41-launcher-sandbox-test.sh --arch arm64
#    bash test/41-launcher-sandbox-test.sh --launcher /usr/bin/qq-agent
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

LAUNCHER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --launcher)   [ $# -ge 2 ] || die "--launcher 后面要跟文件"; LAUNCHER="$2"; shift 2 ;;
    --launcher=*) LAUNCHER="${1#*=}"; shift ;;
    *)            die "未知选项：$1" ;;
  esac
done

echo "===== .deb/.rpm 启动器沙箱降级单元测试 ====="
echo "  架构: $ARCH"

# ── 1. 定位启动器 ──
#  优先用**已组装产出的**启动器（测发货代码，不是源码副本）；没跑过 03 就退回源码 heredoc
if [ -z "$LAUNCHER" ]; then
  CAND="$STAGE_ARCH_DIR/usr/bin/qq-agent"
  if [ -f "$CAND" ]; then
    LAUNCHER="$CAND"
    echo "  启动器取自组装产物: $LAUNCHER"
  else
    echo "  组装产物里没有启动器，退回 scripts/03-stage.sh 的 heredoc"
    [ -f scripts/03-stage.sh ] || die "找不到 scripts/03-stage.sh"
    TMP_H="$(mktemp -d)"
    sed -n '/^cat > .*LAUNCHER_EOF.$/,/^LAUNCHER_EOF$/p' scripts/03-stage.sh \
      | sed '1d;$d' > "$TMP_H/qq-agent"
    [ -s "$TMP_H/qq-agent" ] || die "抠不出启动器 heredoc —— 03-stage.sh 结构变了？"
    LAUNCHER="$TMP_H/qq-agent"
    echo "  heredoc 抽出: $(wc -l <"$LAUNCHER") 行"
  fi
fi
[ -f "$LAUNCHER" ] || die "找不到启动器：$LAUNCHER"

# ── 2. 接线检查：降级必须真的落到 exec 上（B 层，最关键）──
echo
echo "--- 接线检查（防「只写了函数忘了用」）---"
wire_fail=0
if grep -q 'NO_SANDBOX="--no-sandbox"' "$LAUNCHER"; then
  printf '\033[32m  ✓\033[0m %-46s\n' "有降级赋值 NO_SANDBOX"
else
  printf '\033[31m  ✗\033[0m %-46s 缺降级赋值\n' "有降级赋值 NO_SANDBOX"; wire_fail=$((wire_fail+1))
fi
if grep -q 'exec "\$BIN" \$NO_SANDBOX "\$@"' "$LAUNCHER"; then
  printf '\033[32m  ✓\033[0m %-46s\n' "exec 行已带上 \$NO_SANDBOX"
else
  printf '\033[31m  ✗\033[0m %-46s 降级是摆设！\n' "exec 行已带上 \$NO_SANDBOX"; wire_fail=$((wire_fail+1))
fi
if grep -q 'exec "\$BIN" "\$@"' "$LAUNCHER"; then
  printf '\033[31m  ✗\033[0m %-46s 仍存在裸 exec\n' "仍存在裸 exec（旧的失败路径）"; wire_fail=$((wire_fail+1))
else
  printf '\033[32m  ✓\033[0m %-46s\n' "裸 exec 已消失"
fi
if [ "$wire_fail" -gt 0 ]; then
  echo "  ❌ 降级没接上线，行为与修复前一致" >&2
  exit 1
fi

# ── 3. 把 sandbox_reason() 抽出来做成可调用的探针 ──
FUNC="$(sed -n '/^sandbox_reason() {/,/^}/p' "$LAUNCHER")"
if [ -z "$FUNC" ]; then
  echo "!! 启动器里找不到 sandbox_reason()" >&2
  exit 1
fi
TMP="$(mktemp -d)"
MNT="$TMP/nosuid"
NORM_DIR=""
cleanup() {
  mountpoint -q "$MNT" 2>/dev/null && sudo umount "$MNT" 2>/dev/null
  rm -rf "$TMP" ${NORM_DIR:+"$NORM_DIR"}
}
trap cleanup EXIT

PROBE="$TMP/probe.sh"
{
  echo '#!/bin/sh'
  printf '%s\n' "$FUNC"
  echo 'sandbox_reason "$1"'
} > "$PROBE"
chmod 755 "$PROBE"

# ── 4. 夹具与用例 ──
pass=0; fail=0; skip=0
chk() {  # chk <描述> <期望原因> <文件>
  local desc="$1" want="$2" f="$3" got
  got="$(sh "$PROBE" "$f" 2>/dev/null || echo CRASHED)"
  if [ "$got" = "$want" ]; then
    printf '\033[32m  ✓\033[0m %-46s %s\n' "$desc" "$got"; pass=$((pass+1))
  else
    printf '\033[31m  ✗\033[0m %-46s 得到 %s，期望 %s\n' "$desc" "$got" "$want"; fail=$((fail+1))
  fi
}
skipto() { printf '\033[33m  !\033[0m %-46s 跳过：%s\n' "$1" "$2"; skip=$((skip+1)); }

echo
echo "--- 判据用例 ---"
# ⚠️ 三个坑（与 40 相同，都是实测踩到的）：
#  1) 以 root 跑时 touch 出来的文件属主就是 root，而"属主非 root"这条用例的前提
#     恰恰要被破坏 → 必须**显式 chown 给非 root 用户**，否则用例假失败。
#  2) **/tmp 在不少系统上本身就是 nosuid**（本机实测：`/tmp rw,nosuid,nodev,size=...`）。
#     所以"普通文件系统"的夹具**不能放 /tmp** —— 否则会用错误的前提把函数误判成 bug。
#  3) 判据读的是 /proc/mounts，所以**挂载点缺失时应判 ok 之外的失败或 ok 都算行为确定**，
#     但路径不存在必须先判 missing，不能让后面的 stat/awk 去炸。
NONROOT_USER="${SUDO_USER:-nobody}"
[ "$NONROOT_USER" = "root" ] && NONROOT_USER=nobody
NORM_DIR="$(mktemp -d "${HOME:-/root}/.ql-sbtest41.XXXXXX")" || die "造不出普通 fs 夹具目录"

mk_nonroot_4755() { touch "$1"; chown "$NONROOT_USER" "$1" 2>/dev/null || sudo chown "$NONROOT_USER" "$1" 2>/dev/null || true; chmod 4755 "$1" 2>/dev/null || sudo chmod 4755 "$1"; }
mk_root_4755()    { touch "$1"; chown root:root "$1" 2>/dev/null || sudo chown root:root "$1" 2>/dev/null || true;     chmod 4755 "$1" 2>/dev/null || sudo chmod 4755 "$1"; }
fs_of() { findmnt -no TARGET,OPTIONS --target "$1" 2>/dev/null | tr -s ' '; }

# 1) 路径不存在 → missing（判据不能在异常输入下崩）
chk "路径不存在" missing "$NORM_DIR/does-not-exist"

# 2) 无 setuid 位 → no-setuid（对应打包丢位）
touch "$NORM_DIR/a"; chmod 644 "$NORM_DIR/a"
chk "无 setuid 位" no-setuid "$NORM_DIR/a"

# 3) 有 setuid 但属主非 root → not-root-owned
mk_nonroot_4755 "$NORM_DIR/b"
chk "有 setuid 位但属主非 root（属主=$NONROOT_USER）" not-root-owned "$NORM_DIR/b"

if [ "$(id -u)" = "0" ] || sudo -n true 2>/dev/null; then
  # 4) setuid + root + 非 nosuid → ok（不该无谓地关沙箱）
  mk_root_4755 "$NORM_DIR/c"
  echo "  参考：$NORM_DIR/c 所在挂载点 → $(fs_of "$NORM_DIR/c")"
  chk "setuid + 属主 root + 非 nosuid（应有沙箱）" ok "$NORM_DIR/c"

  # 5) ★ setuid + root + nosuid 挂载 → nosuid-mount
  #    这一支就是 Parallels/VMware 的真实场景，也是本 bug 的正主
  mkdir -p "$MNT"
  if sudo mount -t tmpfs -o nosuid,size=1M tmpfs "$MNT" 2>/dev/null; then
    mk_root_4755 "$MNT/d"
    echo "  参考：$MNT/d 所在挂载点 → $(fs_of "$MNT/d")"

    # 先证明老逻辑（只判 -u）在这个场景确实会误判 —— 坐实成因，别让后人以为是玄学
    if [ -u "$MNT/d" ]; then
      printf '\033[33m  ~\033[0m %-46s 确认\n' "对照：老逻辑只判 -u 会误判为「可用」"
    else
      printf '\033[31m  ✗\033[0m %-46s 对照异常\n' "对照：老逻辑只判 -u 会误判为「可用」"; fail=$((fail+1))
    fi

    chk "★ setuid + 属主 root + nosuid（虚拟机场景）" nosuid-mount "$MNT/d"

    # 6) 额外数据点：/tmp 常常本身就是 nosuid（记录下来，免得以后又拿它当"普通 fs"）
    mk_root_4755 "$TMP/e"
    if fs_of "$TMP/e" | grep -q nosuid; then
      chk "setuid + 属主 root + /tmp（本就是 nosuid）" nosuid-mount "$TMP/e"
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
  echo "  ❌ 启动器沙箱判定有问题 —— 虚拟机环境下 .deb/.rpm 会启动失败" >&2
  exit 1
fi
if [ "$skip" -gt 0 ]; then
  echo "  ⚠️  有用例被跳过（不算通过）。要完整验证请在 root 下重跑。"
fi
echo "  ✅ 已执行的用例全部符合预期。"
