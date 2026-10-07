#!/usr/bin/env bash
# ============================================================================
#  03-stage.sh — 组装 Linux 应用树
#
#  用法：
#    bash scripts/03-stage.sh                          # x86_64，源取本机 E:\ 已安装的 V0.4.4
#    bash scripts/03-stage.sh --arch arm64
#    bash scripts/03-stage.sh --app-src /path/to/app    # 指定应用代码源（目录）
#    bash scripts/03-stage.sh --app-src ./app-code.tar.gz   # 或 tar 包（CI 用）
#    bash scripts/03-stage.sh --app-tarball out/app-code.tar.gz   # 只产出清洗过的应用代码 tar
#
#  产出：
#    stage/<arch>/opt/qq-agent/               ← 完整可运行树
#    stage/<arch>/usr/bin/qq-agent            ← 启动器
#    stage/<arch>/usr/share/applications/…    ← 桌面项
#
#  ★ 两条铁律（见 05-arm64方案.md 坑 A / §5.4）：
#    1. snowluma/ **整棵**来自官方包，绝不从 Windows 树继承（那边全是 win32 原生件）
#    2. 复制应用代码前后都要做隐私红线复检，命中即中止
# ============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

APP_SRC=""
APP_TARBALL=""
DO_PATCH=1
MODE="stage"

ql_parse_args "$@"
if [ "${#QL_REST[@]}" -gt 0 ]; then set -- "${QL_REST[@]}"; else set --; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --app-src)       [ $# -ge 2 ] || die "--app-src 后面要跟路径"; APP_SRC="$2"; shift 2 ;;
    --app-src=*)     APP_SRC="${1#*=}"; shift ;;
    --app-tarball)   MODE="app-tarball"; APP_TARBALL="${2:-}"; [ $# -ge 2 ] && shift 2 || shift ;;
    --app-tarball=*) MODE="app-tarball"; APP_TARBALL="${1#*=}"; shift ;;
    --no-patch)      DO_PATCH=0; shift ;;
    *)               die "未知选项：$1（用 --help 看用法）" ;;
  esac
done

prepare_dirs

# ── stage 阶段额外的排除项 ──
# 「snowluma」必须整棵排除：Windows 树里的 snowluma/native/*.win32-x64.node 等
# 是不可用且危险的（会静默混进包里）。arm64/x64 的 snowluma 一律从官方包复制。
# 同时给出多种写法，因为不同 tar 实现对 --exclude 的匹配语义不完全一致；
# 真正兜底的是复制完之后的 assert_no_redline + 架构审计，而不是靠 glob 写对。
STAGE_EXCLUDE_PATTERNS=(
  "${EXCLUDE_PATTERNS[@]}"
  "snowluma" "./snowluma" "*/snowluma"
)

TMP_DIRS=()
new_tmp() { local d; d="$(mktemp -d)"; TMP_DIRS+=("$d"); echo "$d"; }
cleanup() {
  local d
  for d in "${TMP_DIRS[@]:-}"; do
    [ -n "$d" ] && [ -d "$d" ] && rm -rf "$d"
  done
  return 0
}
trap cleanup EXIT

# ── 解析应用代码源 ──
APP_SRC_DIR=""
resolve_app_src() {
  local s="$APP_SRC"
  if [ -z "$s" ]; then
    if [ -d "$WIN_APP_SUB" ]; then
      s="$WIN_APP_SUB"
    else
      log "未指定 --app-src，尝试在 /mnt/e 上定位已安装的 V0.4.4 ..."
      find_win_app
      s="$WIN_APP_SUB"
    fi
  fi
  case "$s" in
    *.tar.gz|*.tgz)
      need_file "$s"
      local exdir
      exdir="$(new_tmp)"
      log "解包应用代码源：$s"
      tar -xzf "$s" -C "$exdir"
      APP_SRC_DIR="$exdir"
      ;;
    *)
      [ -d "$s" ] || die "应用代码源目录不存在：$s（目录或 .tar.gz 都行）"
      APP_SRC_DIR="$s"
      ;;
  esac
  [ -f "$APP_SRC_DIR/package.json" ] || die "应用代码源里没有 package.json，看着不像 app 树：$APP_SRC_DIR"
  log "应用代码源：$APP_SRC_DIR"
}

# ── 复制应用代码（套用排除清单）──
copy_app_code() {
  local src="$1" dst="$2"
  local ex=() p
  for p in "${STAGE_EXCLUDE_PATTERNS[@]}"; do ex+=("--exclude=$p"); done
  mkdir -p "$dst"
  ( cd "$src" && tar -cf - "${ex[@]}" . ) | ( cd "$dst" && tar -xf - )
}

# ════════════════════════════════════════════════════════════
#  模式 A：只产出「清洗过、未打补丁」的应用代码 tar（平台无关，供 CI 取用）
# ════════════════════════════════════════════════════════════
if [ "$MODE" = "app-tarball" ]; then
  [ -n "$APP_TARBALL" ] || die "--app-tarball 后面要跟输出文件名"
  echo "===== 产出应用代码 tar（平台无关）====="
  arch_summary
  echo
  resolve_app_src

  APPWORK="$(new_tmp)"
  local_stage="$APPWORK/app"
  log "复制并套用排除清单 ..."
  copy_app_code "$APP_SRC_DIR" "$local_stage"

  echo
  echo "--- 隐私红线复检（必须在打 tar 之前通过）---"
  assert_no_redline "$local_stage" || die "红线复检不通过，拒绝产出 tar"

  echo
  echo "--- 正向完整性断言（★ 2026-10-06 data-url.js 事故的正面闸门）---"
  # 只断言"不该有的没有"是不够的：排除规则过宽会把必需文件静默吃掉。
  # 这两步分别是"白名单文件必须在位"与"跟着 require 图一个都不能缺"。
  assert_required_present "$local_stage" || die "必需文件缺失，拒绝产出 tar"
  assert_requires_complete "$local_stage" || die "依赖图残缺，拒绝产出 tar"

  echo
  echo "--- snowluma 必须已被整棵排除 ---"
  if [ -e "$local_stage/snowluma" ]; then
    die "snowluma/ 未被排除！(Windows 原生件会混入包) 请检查 tar 的 --exclude 语义"
  fi
  ok "snowluma/ 已排除（将由官方 Linux 包补上）"

  mkdir -p "$(dirname "$APP_TARBALL")"
  # 先解析成绝对路径：后面要在子 shell 里 cd 到别处，相对路径会失效
  APP_TARBALL_ABS="$(cd "$(dirname "$APP_TARBALL")" && pwd)/$(basename "$APP_TARBALL")"
  log "打包 → $APP_TARBALL_ABS"
  ( cd "$local_stage" && tar -czf "$APP_TARBALL_ABS" . )
  need_file "$APP_TARBALL_ABS"
  sha256_of "$APP_TARBALL_ABS" > "$APP_TARBALL_ABS.sha256"
  echo "  $(basename "$APP_TARBALL_ABS")  $(du -h "$APP_TARBALL_ABS" | cut -f1)"
  echo "  SHA256: $(cat "$APP_TARBALL_ABS.sha256")"
  echo
  echo "完成。CI 里用法：bash scripts/03-stage.sh --arch arm64 --app-src $APP_TARBALL"
  exit 0
fi

# ════════════════════════════════════════════════════════════
#  模式 B：完整组装
# ════════════════════════════════════════════════════════════
echo "===== 0. 目标架构 ====="
arch_summary
echo "  stage 根目录: $STAGE_ARCH_DIR"
echo

resolve_app_src

EDIR="$(ensure_electron)"
SDIR="$(ensure_snowluma)"
log "Electron: $EDIR"
log "SnowLuma: $SDIR"
echo

OPT="$STAGE_ARCH_DIR$PREFIX"        # stage/<arch>/opt/qq-agent
APPDIR="$OPT/resources/app"

echo "===== 1. 铺 Electron 运行时 ====="
rm -rf "$STAGE_ARCH_DIR"
mkdir -p "$OPT"
cp -a "$EDIR"/. "$OPT"/
if [ -f "$OPT/electron" ]; then
  mv "$OPT/electron" "$OPT/qq-agent"
  chmod 755 "$OPT/qq-agent"
  ok "主程序 electron → qq-agent"
else
  die "Electron 解包结果里没有 electron 主程序"
fi
# chrome-sandbox 需要 setuid root；打包工具常丢这个位，安装脚本里会补，
# 这里先按 4755 摆好，并在断言里检查源码树侧的存在性。
if [ -f "$OPT/chrome-sandbox" ]; then
  chmod 4755 "$OPT/chrome-sandbox" 2>/dev/null || chmod 755 "$OPT/chrome-sandbox"
  ok "chrome-sandbox 就位（setuid 位由安装脚本最终保证）"
else
  warn "Electron 包里没有 chrome-sandbox（Chromium 沙箱将不可用）"
fi

echo
echo "===== 2. 复制应用代码（套用排除清单）====="
mkdir -p "$APPDIR"
copy_app_code "$APP_SRC_DIR" "$APPDIR"
ok "应用代码已复制"

echo
echo "--- 隐私红线复检（复制完立刻做）---"
assert_no_redline "$APPDIR" || die "红线复检不通过，中止组装"

echo
echo "--- 正向完整性断言（复制阶段也要做，别等到打完包才发现少了模块）---"
assert_required_present "$APPDIR" || die "必需文件缺失，中止组装"
assert_requires_complete "$APPDIR" || die "依赖图残缺，中止组装"

if [ -e "$APPDIR/snowluma" ]; then
  warn "snowluma/ 居然还在（排除没生效？）—— 马上会被整棵替换，但请检查 --exclude 语义"
fi

echo
echo "===== 3. ★ snowluma 整棵替换为官方 linux-${SNOWLUMA_ARCH} 包 ====="
rm -rf "$APPDIR/snowluma"
cp -a "$SDIR" "$APPDIR/snowluma"
[ -f "$APPDIR/snowluma/index.mjs" ] || die "替换后找不到 index.mjs"
chmod 755 "$APPDIR/snowluma/node" 2>/dev/null || true
ok "snowluma 已整棵替换（不再有任何 Windows 原生件）"

echo
echo "--- snowluma 原生件清单（应当全是 linux-${SNOWLUMA_ARCH}）---"
snowluma_native_report "$APPDIR/snowluma"

echo
echo "===== 4. 打 Linux 适配补丁 ====="
if [ "$DO_PATCH" = 1 ]; then
  node patches/patch-linux.mjs "$APPDIR"
  ok "补丁完成"
else
  warn "跳过了补丁（--no-patch）——产物在 Linux 上跑不起来，仅供调试"
fi

echo
echo "--- 补丁后依赖图复检（补丁若新增 require，必须在这里就被抓住）---"
assert_requires_complete "$APPDIR" || die "补丁后依赖图残缺，中止组装"

echo
echo "===== 5. 启动器 / 桌面项 ====="
mkdir -p "$STAGE_ARCH_DIR/usr/bin" \
         "$STAGE_ARCH_DIR/usr/share/applications" \
         "$STAGE_ARCH_DIR/usr/share/icons/hicolor/512x512/apps"

cat > "$STAGE_ARCH_DIR/usr/bin/qq-agent" <<'LAUNCHER_EOF'
#!/bin/sh
# /usr/bin/qq-agent — QQ Agent 启动器
#
# 职责（与 electron/main.js 的 data-dir-xdg 补丁双保险）：
#   1. 按 XDG 规范导出数据目录（补丁自己也会算，这里导出是为了可见、可覆盖）
#   2. 判定 chrome-sandbox 沙箱是否真能生效（三重校验），不能则显式降级 --no-sandbox
#   3. Wayland / X11 自适应
#   4. locale 兜底，避免中文乱码
APP_DIR="@PREFIX@"
BIN="$APP_DIR/qq-agent"

: "${XDG_DATA_HOME:=$HOME/.local/share}"
export XDG_DATA_HOME
: "${QQ_AGENT_DATA_DIR:=$XDG_DATA_HOME/qq-agent/data}"
export QQ_AGENT_DATA_DIR
mkdir -p "$QQ_AGENT_DATA_DIR" 2>/dev/null || true

# SnowLuma 的运行目录镜像也建在这里（补丁会自己创建，这里提前建好避免首次启动竞态）
mkdir -p "$XDG_DATA_HOME/qq-agent/snowluma" 2>/dev/null || true

# ── Chromium 沙箱可用性判定 ───────────────────────────────────────────
# ⚠️ 判据**不能只看 setuid 位**。三条必须同时成立，少一条沙箱就是废的：
#      1) 文件带 setuid 位
#      2) 属主是 root
#      3) 所在挂载点不是 nosuid
#
#    只判第 1 条会在 nosuid 挂载上**误判为「沙箱可用」**：
#    典型场景是 Parallels / VMware 等虚拟机把系统卷按 nosuid 挂载 ——
#    位在、属主是 root，但内核照样丢弃它，Chromium 随后直接 FATAL 退出。
#    这正是「同一台机器上 AppImage 能跑、.deb 跑不起来」的成因
#    （AppRun 侧早就有这套三重校验，见 06-build-appimage.sh 的 sandbox_effective()；
#      这里与之对齐，让两种形态行为一致）。
#
# 沙箱确实不可用时**显式降级 --no-sandbox 并提示一次**（写标记文件，不重复刷屏）。
# 注意这是「判定真的用不了才降级」，**不是**无条件关沙箱。
sandbox_reason() {
  _f="$1"
  [ -e "$_f" ] || { echo "missing"; return 0; }
  [ -u "$_f" ] || { echo "no-setuid"; return 0; }
  [ "$(stat -c %u "$_f" 2>/dev/null)" = "0" ] || { echo "not-root-owned"; return 0; }
  _d="$(dirname "$_f")"
  _opts="$(awk -v d="$_d" '
    { mp=$2; gsub(/\\040/, " ", mp)
      # 根挂载点不能拼成 "//"，否则前缀匹配不上（实测踩到过：home/x 取到空串）
      pfx = (mp == "/") ? "/" : mp "/"
      if (d == mp || index(d, pfx) == 1) { if (length(mp) > best) { best = length(mp); o = $4 } } }
    END { print o }' /proc/mounts 2>/dev/null)"
  case ",$_opts," in *,nosuid,*) echo "nosuid-mount"; return 0 ;; esac
  echo "ok"
}

SB_REASON="$(sandbox_reason "$APP_DIR/chrome-sandbox")"
NO_SANDBOX=""
if [ "$SB_REASON" != "ok" ]; then
  NO_SANDBOX="--no-sandbox"
  STAMP="$QQ_AGENT_DATA_DIR/.sandbox-notice"
  if [ ! -f "$STAMP" ]; then
    echo "[qq-agent] 提示：Chromium 沙箱不可用（原因：$SB_REASON）" >&2
    case "$SB_REASON" in
      missing)
        echo "[qq-agent]       装出来的包里没有 chrome-sandbox，属打包问题，建议重装本包。" >&2 ;;
      no-setuid|not-root-owned)
        echo "[qq-agent]       修复：sudo chown root:root '$APP_DIR/chrome-sandbox'" >&2
        echo "[qq-agent]             && sudo chmod 4755 '$APP_DIR/chrome-sandbox'" >&2 ;;
      nosuid-mount)
        echo "[qq-agent]       所在挂载点是 nosuid，setuid 会被内核丢弃，chmod 无效。" >&2
        echo "[qq-agent]       这是 Parallels / VMware 等虚拟机的常见限制；" >&2
        echo "[qq-agent]       要沙箱请把该卷按 suid 重新挂载，或改用原生（非虚拟机）环境。" >&2 ;;
    esac
    echo "[qq-agent]       因此本次以 --no-sandbox 启动（Chromium 沙箱已关闭）。" >&2
    : > "$STAMP" 2>/dev/null || true
  fi
fi

# Wayland 优先，X11 自动回退
: "${ELECTRON_OZONE_PLATFORM_HINT:=auto}"
export ELECTRON_OZONE_PLATFORM_HINT

case "${LANG:-}" in
  ""|C|POSIX) LANG=C.UTF-8; export LANG ;;
esac

# shellcheck disable=SC2086
exec "$BIN" $NO_SANDBOX "$@"
LAUNCHER_EOF

# 把占位符换成真实安装前缀
sed -i "s|@PREFIX@|$PREFIX|g" "$STAGE_ARCH_DIR/usr/bin/qq-agent"
chmod 755 "$STAGE_ARCH_DIR/usr/bin/qq-agent"
ok "启动器 → usr/bin/qq-agent（APP_DIR=$PREFIX）"

cat > "$STAGE_ARCH_DIR/usr/share/applications/qq-agent.desktop" <<'DESKTOP_EOF'
[Desktop Entry]
Type=Application
Version=1.0
Name=QQ Agent
Name[zh_CN]=QQ Agent
GenericName=QQ 群 AI 机器人
GenericName[zh_CN]=QQ 群 AI 机器人
Comment=QQ 群 AI 机器人（桌面版）
Comment[zh_CN]=QQ 群 AI 机器人（桌面版）
Exec=qq-agent %U
Icon=qq-agent
Terminal=false
Categories=Utility;Network;
Keywords=QQ;AI;Bot;OneBot;
StartupNotify=true
StartupWMClass=qq-agent
DESKTOP_EOF
chmod 644 "$STAGE_ARCH_DIR/usr/share/applications/qq-agent.desktop"
ok "桌面项 → usr/share/applications/qq-agent.desktop"

# 图标：从应用树里找一个 PNG，找不到就如实警告（桌面项里 Icon= 指向不存在也不算致命）
ICON_SRC=""
for c in "$APP_SRC_DIR/ui/icon.png" "$APP_SRC_DIR/build/icon.png" \
         "$APP_SRC_DIR/assets/icon.png" "$APP_SRC_DIR/icon.png"; do
  [ -f "$c" ] && { ICON_SRC="$c"; break; }
done
if [ -z "$ICON_SRC" ]; then
  ICON_SRC="$(find "$APP_SRC_DIR" -maxdepth 3 -type f -name '*.png' 2>/dev/null | head -1)"
fi
if [ -n "$ICON_SRC" ] && [ -f "$ICON_SRC" ]; then
  cp -f "$ICON_SRC" "$STAGE_ARCH_DIR/usr/share/icons/hicolor/512x512/apps/qq-agent.png"
  ok "图标 ← $(basename "$ICON_SRC")（注意：尺寸未必正好 512x512）"
else
  warn "应用树里没找到 PNG 图标 —— 桌面项会缺图标（不影响运行）"
fi

echo
echo "===== 5a. 文档与许可说明 ====="
# 放在 stage 阶段而不是打包脚本里：deb 与 rpm **共用同一份**，
# 否则 rpm 的 %files 会指向一个根本不存在的目录（实测踩到过）。
mkdir -p "$STAGE_ARCH_DIR/usr/share/doc/$PKG_NAME"
cat > "$STAGE_ARCH_DIR/usr/share/doc/$PKG_NAME/README" <<EOF
$APP_NAME $APP_VERSION（$ARCH）
========================================

安装后如何使用
--------------
1. 启动：命令行执行 \`qq-agent\`，或从应用菜单点 "QQ Agent"。
2. 首次运行会在**用户主目录**创建数据目录：
     ~/.local/share/qq-agent/data/
   SnowLuma 的运行目录（配置 + 登录态 + 消息库）在：
     ~/.local/share/qq-agent/snowluma/
   （安装目录 $PREFIX 属 root 只读，运行期数据一律不写在那里。）

前置条件（重要：装完不能「开箱即用」）
--------------------------------------
SnowLuma 是 QQ NT 协议的协议端实现，它需要：
  * 系统里存在**真实的 Linux QQ 客户端进程**，SnowLuma 向其注入 hook；
  * 首次使用需要**扫码登录** QQ 账号。
本安装包**不含 QQ 客户端**。请先自行安装 Linux 版 QQ 并登录。

已知环境依赖
------------
  * kernel.yama.ptrace_scope 若为 3，注入会被内核拒绝；
    可临时放开： sudo sysctl -w kernel.yama.ptrace_scope=1
  * 无桌面环境（纯 ssh）时 Electron 起不来，可用 xvfb-run 做无头调试。

数据与卸载
----------
  * 程序： $PREFIX                 （由包管理器管理）
  * 数据： ~/.local/share/qq-agent/（包管理器**不管**，卸载后保留）
  * 彻底清除： rm -rf ~/.local/share/qq-agent ~/.config/qq-agent
EOF

cat > "$STAGE_ARCH_DIR/usr/share/doc/$PKG_NAME/copyright" <<EOF
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: QQ Agent
Source: $HOMEPAGE

Files: *
Copyright: Kondius
License: MIT

Files: opt/qq-agent/resources/app/snowluma/*
Copyright: SnowLuma
License: 源码可见的非商业许可（个人自用免费；商业使用需书面授权）
 原生模块（.so / .node）为专有组件，禁止逆向。
 分发本安装包前请确认用途合规。
EOF
chmod 644 "$STAGE_ARCH_DIR/usr/share/doc/$PKG_NAME/README" \
          "$STAGE_ARCH_DIR/usr/share/doc/$PKG_NAME/copyright"
ok "文档与许可说明 → usr/share/doc/$PKG_NAME/（deb 与 rpm 共用）"

echo
echo "===== 5b. 权限归一化 ====="
# 为什么必须做（2026-09-28 在 WSL 上实测发现）：
#   应用代码是从 Windows 的 /mnt/e（drvfs）复制过来的，那边**所有文件的权限都显示为 777**
#   （drvfs 不支持 POSIX 权限）。照原样打包会得到「root 拥有但全局可写」的文件装进
#   /opt —— 任何本地用户都能篡改程序代码。这是实打实的安全问题，不是洁癖。
#   实测：不归一化时整棵树 74+ 个文件全是 777。
#
# 白名单来源：在 **ext4 上**从官方压缩包干净解包得到的权威模式（Windows 侧解包不可信）：
#   Electron : 8 个 755（electron / chrome-sandbox / chrome_crashpad_handler /
#              libEGL.so / libGLESv2.so / libffmpeg.so / libvk_swiftshader.so / libvulkan.so.1）
#   SnowLuma : 2 个 755（node / launcher.sh）；native/*.node|.so 是 644（dlopen 无需执行位）
normalize_modes() {
  local root="$1"
  find "$root" -type d -exec chmod 755 {} + 2>/dev/null || true
  find "$root" -type f -exec chmod 644 {} + 2>/dev/null || true

  # 可执行白名单
  chmod 755 "$OPT/qq-agent" 2>/dev/null || true
  local f
  for f in chrome_crashpad_handler libEGL.so libGLESv2.so libffmpeg.so \
           libvk_swiftshader.so libvulkan.so.1; do
    [ -f "$OPT/$f" ] && chmod 755 "$OPT/$f"
  done
  [ -f "$APPDIR/snowluma/node" ]        && chmod 755 "$APPDIR/snowluma/node"
  [ -f "$APPDIR/snowluma/launcher.sh" ] && chmod 755 "$APPDIR/snowluma/launcher.sh"
  [ -f "$root/usr/bin/qq-agent" ]       && chmod 755 "$root/usr/bin/qq-agent"
  [ -f "$root/usr/share/applications/qq-agent.desktop" ] \
    && chmod 644 "$root/usr/share/applications/qq-agent.desktop"

  # chrome-sandbox 需要 setuid（Chromium 沙箱硬要求）；postinst 里还会再补一次
  [ -f "$OPT/chrome-sandbox" ] && chmod 4755 "$OPT/chrome-sandbox"

  ok "权限已归一化（目录 755 / 文件 644 / 白名单 755 / chrome-sandbox 4755）"
}
normalize_modes "$STAGE_ARCH_DIR"

echo
echo "===== 6. 架构审计 ====="
# --no-patch（直接用自带 Linux 适配的仓库代码）时，补丁标记断言不适用
[ "$DO_PATCH" = "0" ] && export QL_NO_PATCH=1
if [ -x test/05-arch-audit.sh ]; then
  bash test/05-arch-audit.sh --arch "$ARCH" --root "$OPT" || die "架构审计未通过，产物不可用"
else
  warn "test/05-arch-audit.sh 不存在，跳过架构审计（强烈建议先写它）"
fi

echo
echo "===== 7. 组装结果 ====="
echo "  安装树: $OPT"
echo "  磁盘占用: $(du -sh "$OPT" | cut -f1)"
echo "  顶层内容:"; ls -1 "$OPT" | head -20
echo
echo "  应用目录:"; ls -1 "$APPDIR" | head -20
echo
ok "组装完成（$ARCH）"
echo "  下一步：bash scripts/04-build-deb.sh --arch $ARCH"
