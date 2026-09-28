#!/usr/bin/env bash
# ============================================================================
#  05-build-rpm.sh — 打 RPM 系安装包
#
#  用法：
#    bash scripts/05-build-rpm.sh                 # x86_64
#    bash scripts/05-build-rpm.sh --arch arm64    # aarch64
#
#  前置：先跑 bash scripts/03-stage.sh --arch <arch>
#  产出：out/qq-agent-<版本>-<release>.<rpm架构>.rpm
#
#  ⚠️ rpm 系架构名用 aarch64（不是 arm64）。deb 是 arm64。写错装不上。
#
#  ⚠️ 交叉架构构建的坑：在 x86_64 上打 aarch64 包时，rpm 默认的
#     __os_install_post（brp-strip / brp-compress 等）会用宿主的 strip
#     去处理 aarch64 二进制，可能直接让构建失败。这里用
#     --define '__os_install_post %{nil}' 关掉整个后处理链
#     （安装包不需要 debuginfo，也不需要 strip）。
# ============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

ql_parse_args "$@"
[ "${#QL_REST[@]}" -eq 0 ] || die "未知选项：${QL_REST[*]}"

STAGE_ROOT="$STAGE_ARCH_DIR"
[ -d "$STAGE_ROOT$PREFIX" ] || die "stage 树不存在：$STAGE_ROOT$PREFIX（先跑 03-stage.sh --arch $ARCH）"
command -v rpmbuild >/dev/null 2>&1 || die "没有 rpmbuild（Debian 系装 rpm 包：sudo apt install rpm）"

RPM_NAME="${PKG_NAME}-${APP_VERSION}-${PKG_RELEASE}.${RPM_ARCH}.rpm"
OUT="$OUT_DIR/$RPM_NAME"
SOURCE_TAR="$PKG_NAME-${APP_VERSION}.tar.gz"

echo "===== 打 .rpm ====="
arch_summary
echo "  来源: $STAGE_ROOT"
echo "  产出: $OUT"
echo

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TOP="$TMP/rpmbuild"
mkdir -p "$TOP/BUILD" "$TOP/RPMS" "$TOP/SOURCES" "$TOP/SPECS" "$TOP/SRPMS"

# ── 1. 把 stage 树打成 SOURCE0 ──
log "打包 stage 树 → SOURCES/$SOURCE_TAR"
( cd "$STAGE_ROOT" && tar -czf "$TOP/SOURCES/$SOURCE_TAR" . )
ok "SOURCE0 就绪（$(du -h "$TOP/SOURCES/$SOURCE_TAR" | cut -f1)）"

# ── 2. 依赖映射（RPM 系命名习惯与 Debian 不同）──
#     arm64 与 x86_64 共用这张表。
RPM_REQUIRES=(
  gtk3 libnotify nss libXScrnSaver libXtst xdg-utils
  at-spi2-atk libuuid libsecret alsa-lib
)
REQ=""
for r in "${RPM_REQUIRES[@]}"; do
  if [ -z "$REQ" ]; then REQ="$r"; else REQ="$REQ, $r"; fi
done

# 图标可能不存在（03-stage.sh 找不到就跳过），条件包含，避免 %files 报错
ICON_LINE=""
if [ -f "$STAGE_ROOT/usr/share/icons/hicolor/512x512/apps/qq-agent.png" ]; then
  ICON_LINE="/usr/share/icons/hicolor/512x512/apps/qq-agent.png"
else
  warn "没有图标文件，%files 里跳过图标"
fi

# ── 3. spec ──
SPEC="$TOP/SPECS/$PKG_NAME.spec"
cat > "$SPEC" <<EOF
Name:           $PKG_NAME
Version:        $APP_VERSION
Release:        $PKG_RELEASE
Summary:        $DESC_SHORT
License:        MIT
URL:            $HOMEPAGE
BuildArch:      $RPM_ARCH
Requires:       $REQ
Recommends:     alsa-lib
Source0:        $SOURCE_TAR

%description
$DESC_LONG

注意：SnowLuma 协议端需要系统里存在真实的 Linux QQ 客户端并完成扫码登录，
本包不包含 QQ 客户端本身，装完不能"开箱即用"。

%prep
# 无需解包到 BUILD 目录：%install 里直接从 SOURCE0 解到 buildroot

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}
tar -xzf %{SOURCE0} -C %{buildroot}
# 安装到系统后属主由 rpm 决定；这里只保证权限位正确
chmod 755 %{buildroot}$PREFIX/qq-agent
if [ -f %{buildroot}$PREFIX/chrome-sandbox ]; then
  chmod 4755 %{buildroot}$PREFIX/chrome-sandbox
fi
if [ -f %{buildroot}$PREFIX/resources/app/snowluma/node ]; then
  chmod 755 %{buildroot}$PREFIX/resources/app/snowluma/node
fi

%files
$PREFIX
/usr/bin/qq-agent
/usr/share/applications/qq-agent.desktop
$ICON_LINE
/usr/share/doc/$PKG_NAME

%post
# chrome-sandbox 必须是 root:root 且 setuid，Chromium 沙箱的硬要求
if [ -f $PREFIX/chrome-sandbox ]; then
  chown root:root $PREFIX/chrome-sandbox 2>/dev/null || true
  chmod 4755 $PREFIX/chrome-sandbox 2>/dev/null || true
fi
if [ -f $PREFIX/resources/app/snowluma/node ]; then
  chmod 755 $PREFIX/resources/app/snowluma/node 2>/dev/null || true
fi
if [ -r /proc/sys/kernel/yama/ptrace_scope ]; then
  scope="\$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo 0)"
  if [ "\$scope" = "3" ]; then
    echo "提示：kernel.yama.ptrace_scope=3 会阻止 SnowLuma 注入 QQ 进程。" >&2
    echo "      如遇连接失败：sudo sysctl -w kernel.yama.ptrace_scope=1" >&2
  fi
fi

%postun
# 卸载**不动**用户数据：数据在 ~/.local/share/qq-agent，不在安装目录里
if [ "\$1" = "0" ]; then
  echo "QQ Agent 已移除。用户数据仍保留在 ~/.local/share/qq-agent/"
fi

%changelog
* $(LC_ALL=C date '+%a %b %d %Y') $MAINTAINER - $APP_VERSION-$PKG_RELEASE
- 首个 Linux $ARCH 版本
EOF
ok "spec 已生成（BuildArch: $RPM_ARCH）"

# ── 4. 构建 ──
mkdir -p "$OUT_DIR"

# 用私有 rpmdb：以非 root 身份跑 rpmbuild 时，默认的 /var/lib/rpm 打不开，
# 会刷一堆 "Unable to open sqlite database" 报错（虽然多数情况不致命，
# 但在 CI 里既吵又可能变成真失败）。--initdb 一次即可。
mkdir -p "$TOP/rpmdb"
rpm --dbpath "$TOP/rpmdb" --initdb >/dev/null 2>&1 || true

RPM_LOG="$TOP/rpmbuild.log"
HOST_ARCH="$(uname -m 2>/dev/null || echo 未知)"
if [ "$RPM_ARCH" != "$HOST_ARCH" ]; then
  warn "目标架构 $RPM_ARCH 与宿主架构 $HOST_ARCH 不同 —— rpmbuild 大概率会拒绝跨架构构建（见下方说明）"
fi

log "rpmbuild -bb --target $RPM_ARCH ..."
if ! rpmbuild -bb \
      --target "$RPM_ARCH" \
      --define "_topdir $TOP" \
      --define "_dbpath $TOP/rpmdb" \
      --define '__os_install_post %{nil}' \
      --define "_build_id_links none" \
      "$SPEC" > "$RPM_LOG" 2>&1; then
  cat "$RPM_LOG"
  if grep -q 'No compatible architectures found for build' "$RPM_LOG"; then
    cat >&2 <<EOF

[错误] rpmbuild **不支持跨架构构建**：目标 $RPM_ARCH，宿主 $HOST_ARCH。

  原因：rpmbuild 内置硬性架构保护（checkBuildArch），在 x86_64 上打不出 aarch64 的包。
  实测确认（2026-09-28）：同一个 spec 只把 BuildArch 换成宿主架构就能成功，
  换回目标架构必然失败。以下绕过办法**全部试过且全部无效**：
    --target / _host_cpu / _build_cpu / _target_cpu / _host / _target_platform /
    私有 rpmdb / __os_install_post
  它们都被同一条检查拦下，不是配置写法问题。

  正确做法：**在 aarch64 宿主上打 arm64 的 rpm**。
  本工程的 CI（.github/workflows/build-linux-arm64.yml）用的正是原生
  ubuntu-24.04-arm runner，那里属原生构建，没有这个问题。

  对比：deb **没有**这个限制 —— dpkg-deb 可以在 x86_64 上产出 arm64 的 .deb
  （本工程已实测产出 qq-agent_0.4.4_arm64.deb）。
EOF
    exit 1
  fi
  die "rpmbuild 失败，看上面的输出定位"
fi

BUILT="$(find "$TOP/RPMS" -name '*.rpm' -type f | head -1)"
[ -n "$BUILT" ] || die "rpmbuild 报成功但没找到 rpm 产物"
cp -f "$BUILT" "$OUT"
need_file "$OUT"
sha256_of "$OUT" > "$OUT.sha256"

echo
echo "===== 产物校验 ====="
if command -v rpm >/dev/null 2>&1; then
  rpm -qip "$OUT" 2>/dev/null | sed -n '1,15p'
  echo
  arch_line="$(rpm -qp --qf '%{ARCH}' "$OUT" 2>/dev/null || true)"
  if [ "$arch_line" != "$RPM_ARCH" ]; then
    die "包内 ARCH=$arch_line，期望 $RPM_ARCH"
  fi
  ok "ARCH 正确：$arch_line"
else
  warn "没有 rpm 命令，跳过包元数据校验（不校验就发布有风险）"
fi
echo "  $(basename "$OUT")  $(du -h "$OUT" | cut -f1)"
echo "  SHA256: $(cat "$OUT.sha256")"
echo
ok "rpm 打包完成"
echo "  下一步：bash test/20-rpm-smoke.sh --arch $ARCH   （真实安装 + 冒烟）"
