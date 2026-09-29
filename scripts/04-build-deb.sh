#!/usr/bin/env bash
# ============================================================================
#  04-build-deb.sh — 打 Debian 系安装包
#
#  用法：
#    bash scripts/04-build-deb.sh                 # x86_64 → amd64
#    bash scripts/04-build-deb.sh --arch arm64    # arm64
#
#  前置：先跑 bash scripts/03-stage.sh --arch <arch>
#  产出：out/qq-agent_<版本>_<deb架构>.deb
#
#  ⚠️ deb 系架构名用 arm64（不是 aarch64）。写错装不上。
# ============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

ql_parse_args "$@"
[ "${#QL_REST[@]}" -eq 0 ] || die "未知选项：${QL_REST[*]}"

STAGE_ROOT="$STAGE_ARCH_DIR"
[ -d "$STAGE_ROOT$PREFIX" ] || die "stage 树不存在：$STAGE_ROOT$PREFIX（先跑 03-stage.sh --arch $ARCH）"

DEB_NAME="${PKG_NAME}_${APP_VERSION}_${DEB_ARCH}.deb"
OUT="$OUT_DIR/$DEB_NAME"

echo "===== 打 .deb ====="
arch_summary
echo "  来源: $STAGE_ROOT"
echo "  产出: $OUT"
echo

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BUILD="$TMP/deb"

# ── 1. 搬文件（stage 的目录结构已经是文件系统布局）──
mkdir -p "$BUILD/DEBIAN"
cp -a "$STAGE_ROOT/opt" "$BUILD/"
[ -d "$STAGE_ROOT/usr" ] && cp -a "$STAGE_ROOT/usr" "$BUILD/"
ok "文件树已搬入构建目录"

# ── 2. 依赖字段（arm64 与 amd64 同名，共用一张表）──
DEPENDS=""
for d in "${ELECTRON_DEPS_DEB[@]}"; do
  if [ -z "$DEPENDS" ]; then DEPENDS="$d"; else DEPENDS="$DEPENDS, $d"; fi
done

INSTALLED_KB="$(du -sk "$STAGE_ROOT/opt" | cut -f1)"

# ── 3. control ──
cat > "$BUILD/DEBIAN/control" <<EOF
Package: $PKG_NAME
Version: $APP_VERSION-$PKG_RELEASE
Section: net
Priority: optional
Architecture: $DEB_ARCH
Maintainer: $MAINTAINER
Homepage: $HOMEPAGE
Installed-Size: $INSTALLED_KB
Depends: $DEPENDS
Recommends: fonts-noto-cjk | fonts-wqy-zenhei, libnotify-bin
Suggests: ffmpeg
Description: $DESC_SHORT
 $DESC_LONG
 .
 注意：SnowLuma 协议端需要系统里存在真实的 Linux QQ 客户端并完成扫码登录，
 本包不包含 QQ 客户端本身，装完不能"开箱即用"。
EOF
ok "control 已生成（Architecture: $DEB_ARCH）"

# ── 4. 维护者脚本 ──
#   chrome-sandbox 的 setuid 位是 Chromium 沙箱的硬要求，打包/解包过程中常丢，
#   所以装完必须再补一次。用 if 而不是 `[ ] && cmd`——后者在 set -e 下会
#   因为测试为假而让整个脚本以非 0 退出（经典坑）。
cat > "$BUILD/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ -f /opt/qq-agent/chrome-sandbox ]; then
  chown root:root /opt/qq-agent/chrome-sandbox 2>/dev/null || true
  chmod 4755 /opt/qq-agent/chrome-sandbox 2>/dev/null || true
fi
if [ -f /opt/qq-agent/resources/app/snowluma/node ]; then
  chmod 755 /opt/qq-agent/resources/app/snowluma/node 2>/dev/null || true
fi
# ptrace_scope：SnowLuma 需要向 QQ 进程注入，ptrace_scope=3 会直接拒绝
if [ -r /proc/sys/kernel/yama/ptrace_scope ]; then
  scope="$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo 0)"
  if [ "$scope" = "3" ]; then
    echo "提示：kernel.yama.ptrace_scope=3 会阻止 SnowLuma 注入 QQ 进程。" >&2
    echo "      如遇连接失败，可执行：sudo sysctl -w kernel.yama.ptrace_scope=1" >&2
  fi
fi
exit 0
EOF

cat > "$BUILD/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
exit 0
EOF

# 卸载**不动**用户数据：数据在 ~/.local/share/qq-agent，不在安装目录里，
# 这是本方案「程序与数据分离」设计的直接好处。
cat > "$BUILD/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  echo "QQ Agent 已移除。用户数据仍保留在 ~/.local/share/qq-agent/（含 SnowLuma 登录态与配置）。"
  echo "如需彻底清除： rm -rf ~/.local/share/qq-agent ~/.config/qq-agent"
fi
exit 0
EOF

chmod 755 "$BUILD/DEBIAN/postinst" "$BUILD/DEBIAN/prerm" "$BUILD/DEBIAN/postrm"
ok "维护者脚本就位（postinst / prerm / postrm）"

# ── 5. 文档与许可说明 ──
# 由 03-stage.sh 统一生成并随 stage 树带进来（deb 与 rpm **共用同一份**）。
# 原先这里自己生成 README.Debian，导致 rpm 的 %files 指向一个不存在的目录
# （rpm 是从 stage 树打的，看不到这里的临时文件）—— 实测踩到过，已改为单一来源。
DOC="$BUILD/usr/share/doc/$PKG_NAME"
if [ -f "$DOC/README" ] && [ -f "$DOC/copyright" ]; then
  ok "文档与许可说明已随 stage 树带入（usr/share/doc/$PKG_NAME/）"
else
  warn "stage 树里缺 usr/share/doc/$PKG_NAME/{README,copyright} —— 请重跑 03-stage.sh"
fi

# ── 6. 组装 ──
mkdir -p "$OUT_DIR"
log "dpkg-deb --build ..."
if dpkg-deb --help 2>&1 | grep -q -- '--root-owner-group'; then
  dpkg-deb --root-owner-group --build "$BUILD" "$OUT"
elif command -v fakeroot >/dev/null 2>&1; then
  fakeroot dpkg-deb --build "$BUILD" "$OUT"
else
  warn "既没有 --root-owner-group 也没有 fakeroot，文件属主会是当前用户"
  dpkg-deb --build "$BUILD" "$OUT"
fi

need_file "$OUT"
sha256_of "$OUT" > "$OUT.sha256"

echo
echo "===== 产物校验 ====="
dpkg-deb -I "$OUT" | sed -n '1,20p'
echo
arch_line="$(dpkg-deb -I "$OUT" | awk -F': *' '/Architecture/{print $2; exit}')"
if [ "$arch_line" != "$DEB_ARCH" ]; then
  die "包内 Architecture=$arch_line，期望 $DEB_ARCH"
fi
ok "Architecture 正确：$arch_line"
echo "  $(basename "$OUT")  $(du -h "$OUT" | cut -f1)"
echo "  SHA256: $(cat "$OUT.sha256")"
echo
ok "deb 打包完成"
echo "  下一步：bash test/10-deb-smoke.sh --arch $ARCH   （真实安装 + 冒烟）"
