#!/usr/bin/env bash
# ============================================================================
#  lib.sh — QQ-Agent Linux 打包共享库
#  定义版本、架构、路径、公共函数，被 scripts/0X-*.sh 与 test/*.sh 复用
#
#  ── 架构支持（新增，2026-09-27）────────────────────────────────────────────
#  默认 ARCH=x86_64，行为与改造前**完全一致**（cache 文件名逐字不变）。
#  传 --arch arm64 切到 arm64：
#      deb 架构 = arm64     rpm 架构 = aarch64
#      Electron = arm64     SnowLuma = arm64     AppImage = aarch64
#
#  ⚠️ deb 用 arm64、rpm 用 aarch64，写错装不上。见 assert_arch_triplet()。
# ============================================================================
set -euo pipefail

# ⚠️ 注意：上面这行 `set -e` 会**作用于所有 source 本文件的脚本**。
#    踩过的坑（2026-09-28）：`test/50-rpm-deps-resolve.sh` 里 `dnf --assumeno`
#    在**成功解析之后必然返回 1**（主动放弃事务）→ `set -e` 让脚本**静默退出**：
#    exit=1、零报错，看起来像"莫名其妙死了"。
#    所以：**凡预期会返回非 0 的命令，必须显式处理**（`|| true`、`if !`、
#    或临时 `set +e` / `set -e` 包起来）。不要假设脚本里没有 -e。

# ── 版本与标识 ──
APP_NAME="QQ Agent"
PKG_NAME="qq-agent"
# APP_VERSION 是【分发版本】：决定 deb/rpm/AppImage 的文件名与包元数据。
# 它与 package.json 的 version（【应用版本】，即上游 Windows 版 V0.4.4）是两回事：
# 本移植版只重新打包、不改应用代码，故 package.json 保持 0.4.4 不动。
# 0.4.5 = 仅修复 deb/rpm 启动器的 Chromium 沙箱判据（见 scripts/03-stage.sh）。
APP_VERSION="0.4.5"
PKG_RELEASE="1"
ELECTRON_VERSION="33.4.11"
SNOWLUMA_VERSION="1.14.19"

# ── 架构（默认 x86_64；由 ql_parse_args 覆盖）──
ARCH="x86_64"
DEB_ARCH="amd64"
RPM_ARCH="x86_64"
ELECTRON_ARCH="x64"
SNOWLUMA_ARCH="x64"
APPIMAGE_ARCH="x86_64"

MAINTAINER="Kondius <noreply@kondius.cn>"
HOMEPAGE="https://github.com/Kondius/qq-agent"
DESC_SHORT="QQ 群 AI 机器人（桌面版）"
DESC_LONG="QQ Agent 是一个事件驱动的无状态 QQ 群 AI 机器人，接入 OpenAI 兼容 API，带会话式控制台，内置 SnowLuma 协议端。"

# ── 上游下载地址（按架构拼接）──
ELECTRON_URL_BASE="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}"
SNOWLUMA_URL_BASE="https://github.com/SnowLuma/SnowLuma/releases/download/v${SNOWLUMA_VERSION}"

# ── 官方 SHA256 ──
# x64 值来自官方 release，已核对（01-当前进展.md §4.2）。
SNOWLUMA_SHA256_x64="f0cbd19809327c3959c64083a008c136d9b7538f34a6763c21415fcf9d75f7a5"
# arm64 值取自 GitHub Releases API 的 asset digest 字段（2026-09-28 取得）：
#   https://api.github.com/repos/SnowLuma/SnowLuma/releases/tags/v1.14.19
#   → assets[].digest
#
# ★ 可信度交叉验证（这是敢直接 pin 的依据）：
#   同一次 API 响应里给出 x64 的 digest 为 f0cbd198…f7a5，与上面已经 pin 的
#   SNOWLUMA_SHA256_x64 **逐字一致** —— 说明该接口返回的就是官方值，不是第三方推测。
#   另外 arm64 的字节数 45,817,799 与 01-当前进展.md §3.1 早先的探测记录一致。
SNOWLUMA_SHA256_arm64="6e3c8e31d6c6b9863aa55ba92b148983d2f133e10b766422640dbb77f2ad33e3"

# ── Electron 官方 SHA256（取自官方 SHASUMS256.txt）──
# 来源：https://github.com/electron/electron/releases/download/v33.4.11/SHASUMS256.txt
#
# ★ 可信度交叉验证：该文件里 linux-x64 的值 212d431c…e8a9 与本工程**早先从官方
#   下载并在 cache 里存着的** electron-v33.4.11-linux-x64.zip 实测 SHA256 逐字一致
#   —— 说明这个 SHASUMS256.txt 出自官方；因此同一文件里 arm64 的值同样可信。
#   arm64 的字节数 111,291,327 也与 GitHub API 报告的 asset size 一致。
#
# 为什么值得加：原先 ensure_electron() **完全不做完整性校验**（只有 SnowLuma 校验），
# 这是个明显的缺口 —— 供应链上任何一环被替换都发现不了。
ELECTRON_SHA256_x64="212d431c7c916292311c797cd91f84467c5abd6e6983cf24b162efff64cee8a9"
ELECTRON_SHA256_arm64="e865132767e0930f5fef8ee146b9dd83c7f8fb95ed533c4de99e7057d5de5b61"

# ── 目录 ──
QL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$QL_ROOT/cache"
STAGE_DIR="$QL_ROOT/stage"
OUT_DIR="$QL_ROOT/out"
TEST_DIR="$QL_ROOT/test"
# 由 apply_arch() 填成 stage/<arch>，保证两个架构的组装产物互不覆盖
STAGE_ARCH_DIR=""
# 已安装的 Windows V0.4.4（app 树来源；**只在本地存在，CI 里没有**）
WIN_APP_DIR="/mnt/e/Program Files/QQ Agent/QQ Agent v0.4 setup"
WIN_APP_SUB="$WIN_APP_DIR/resources/app"

# ── 安装布局（遵循 FHS）──
PREFIX="/opt/qq-agent"
BIN_LINK="/usr/bin/qq-agent"
DESKTOP_FILE="/usr/share/applications/qq-agent.desktop"
ICON_DIR="/usr/share/icons/hicolor"
METAINFO_DIR="/usr/share/metainfo"
PIXMAP_DIR="/usr/share/pixmaps"

# ── ★ 从 Windows app 树复制时必须排除的路径（安全红线）──
#
# 已安装的 app 树里**混着运行期数据**，照原样复制会把用户的隐私打进安装包。
# 实测确认存在（2026-09-24）：
#   snowluma/config/             ← runtime.json、onebot_*.json、WebUI 令牌
#   snowluma/config.auto-*/      ← 自动备份的配置
#   snowluma/data/<QQ号>/        ← ★★ media.db / messages.db / reactions.db
#                                    / snowluma_identity.db = QQ 登录态 + 私聊消息库
#   snowluma/logs/               ← 运行日志（含 QQ 号、群号、消息片段）
#   data/                        ← 控制台数据：config.json（API Key！）、sessions、
#                                    memory-v2、messages
#
# 另外 community.key 是厂商云端名单的**写权限密钥**，源码注释明写
# 「绝不能打进分发给别人的安装包」，必须排除。
#
# 复制策略：用 rsync 的 exclude 列表，或 tar 的 --exclude，一律带上这些。
EXCLUDE_PATTERNS=(
  "data"
  "data-*"
  "community.key"
  "community.key.example"
  "snowluma/config"
  "snowluma/config.auto-*"
  "snowluma/data"
  "snowluma/logs"
  "test"
  "doc"
  "scripts"
  "*.log"
  "*.md.bak"
  "__pycache__"
  ".git"
)

# ── 隐私红线：内容复检断言（99-selfcheck --input / 03-stage.sh 共用）──
#
#  ★ 分两级，理由：原清单把 `snowluma/config`、`snowluma/logs`、`data` 一律当违规，
#    但**官方 SnowLuma 包自带一个空的 config/ 目录是合法的**，一刀切会误报、
#    让构建红得莫名其妙。所以按「只可能来自运行期数据」的标准精确化：
#
#    MUST_ABSENT      存在即**失败** —— 这些路径只可能是运行期数据
#    SENSITIVE_GLOBS  命中即**失败** —— 按文件名匹配的强敏感文件
#    WARN_IF_PRESENT  存在只**警告** —— 可能是官方默认模板，需人工确认
REDLINE_MUST_ABSENT=(
  "snowluma/data"            # ★ QQ 登录态 + 私聊消息库 + media/reactions
  "data/config.json"         # ★ API Key 明文
  "community.key"            # ★ 厂商云端名单写权限密钥
)
REDLINE_SENSITIVE_GLOBS=(
  "*.db"
  "*.dmp"
)
REDLINE_WARN_IF_PRESENT=(
  "snowluma/config"
  "snowluma/logs"
  "data"
  "runtime.json"
)

# 对一个「即将入包」的目录做隐私内容复检。
# 调用：assert_no_redline <root> || die
# 命中硬红线返回 1（不直接 exit，方便调用方聚合报错）。
assert_no_redline() {
  local root="$1"
  local fails=0 warns=0
  [ -d "$root" ] || die "assert_no_redline：目录不存在：$root"

  local rel
  for rel in "${REDLINE_MUST_ABSENT[@]}"; do
    if [ -e "$root/$rel" ]; then
      printf '\033[31m  ✗ 红线命中\033[0m %s\n' "$rel" >&2
      fails=$((fails + 1))
    fi
  done

  local g hits h
  for g in "${REDLINE_SENSITIVE_GLOBS[@]}"; do
    hits="$(find "$root" -type f -name "$g" 2>/dev/null | head -10)"
    if [ -n "$hits" ]; then
      while IFS= read -r h; do
        printf '\033[31m  ✗ 敏感文件\033[0m %s\n' "${h#"$root"/}" >&2
        fails=$((fails + 1))
      done <<< "$hits"
    fi
  done

  for rel in "${REDLINE_WARN_IF_PRESENT[@]}"; do
    if [ -e "$root/$rel" ]; then
      printf '\033[33m  ! 需人工确认\033[0m %s 存在\n' "$rel" >&2
      warns=$((warns + 1))
    fi
  done

  if [ "$fails" -gt 0 ]; then
    printf '\033[31m红线复检不通过：%d 项硬命中（%d 项警告）\033[0m\n' "$fails" "$warns" >&2
    return 1
  fi
  ok "红线复检通过（0 项硬命中，${warns} 项警告）"
  return 0
}

# ── 运行时依赖 ──
# Electron 33 在 Linux 上的共享库依赖（名字按 Debian 系）。
# **arm64 与 amd64 同名**，两个架构共用这一张表，不需要分叉。
# rpm 系由 05-build-rpm.sh 做同义映射。
ELECTRON_DEPS_DEB=(
  libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils
  libatspi2.0-0 libuuid1 libsecret-1-0 "libasound2 | libasound2t64"
)

# ── 日志 ──
# ⚠️ 全部写 stderr，**不要改成 stdout**。
#    原因（2026-09-27 真跑组装时踩到的真 bug）：
#    ensure_electron() / ensure_snowluma() 的 stdout 是**返回值**——
#    调用方写的是 EDIR="$(ensure_electron)"。从前 log() 写 stdout，
#    于是捕获到的"路径"里混进了日志文本，cp 当场报
#    `cannot stat '...[36m[12:52:02][0m 解包 Electron ...'`。
#    这类 bug 只有真跑一遍才会暴露，静态检查看不出来。
#    纪律：任何「用 stdout 返回值的函数」内部都不许往 stdout 写诊断信息。
log()  { printf '\033[36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
warn() { printf '\033[33m[警告]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m  OK \033[0m %s\n' "$*" >&2; }

need_file() { [ -e "$1" ] || die "缺少文件：$1"; }

# ============================================================================
#  架构
# ============================================================================

usage_arch() {
  cat <<'EOF'
用法：<脚本> [--arch x86_64|arm64] [其他选项]

  --arch x86_64   默认。deb=amd64  rpm=x86_64   Electron/SnowLuma=x64
  --arch arm64    deb=arm64   rpm=aarch64  Electron/SnowLuma=arm64
EOF
}

# 把 ARCH 展开成五个具体架构变量
apply_arch() {
  case "$ARCH" in
    x86_64|amd64|x64)
      ARCH="x86_64"; DEB_ARCH="amd64"; RPM_ARCH="x86_64"
      ELECTRON_ARCH="x64"; SNOWLUMA_ARCH="x64"; APPIMAGE_ARCH="x86_64" ;;
    arm64|aarch64)
      ARCH="arm64"; DEB_ARCH="arm64"; RPM_ARCH="aarch64"
      ELECTRON_ARCH="arm64"; SNOWLUMA_ARCH="arm64"; APPIMAGE_ARCH="aarch64" ;;
    *) die "不支持的架构：$ARCH（只支持 x86_64 / arm64）" ;;
  esac
  # stage 产物按架构隔离：否则先打 x86_64 再打 arm64 会把前一份覆盖掉
  STAGE_ARCH_DIR="$STAGE_DIR/$ARCH"
}

# 断言三段架构组合合法（防止手改出 arm64 + amd64 这种混搭）
assert_arch_triplet() {
  case "$ARCH" in
    x86_64) [ "$DEB_ARCH" = amd64 ] && [ "$RPM_ARCH" = x86_64 ] \
              || die "架构组合不一致：ARCH=$ARCH DEB_ARCH=$DEB_ARCH RPM_ARCH=$RPM_ARCH" ;;
    arm64)  [ "$DEB_ARCH" = arm64 ] && [ "$RPM_ARCH" = aarch64 ] \
              || die "架构组合不一致：ARCH=$ARCH DEB_ARCH=$DEB_ARCH RPM_ARCH=$RPM_ARCH（deb 用 arm64、rpm 用 aarch64）" ;;
    *) die "未知 ARCH：$ARCH" ;;
  esac
}

# 统一的参数解析入口。脚本开头调用：ql_parse_args "$@"
# 只认识的选项由 ql_parse_args 消费，其余原样留在 QL_REST 中供脚本自己处理。
QL_REST=()
ql_parse_args() {
  QL_REST=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --arch)      [ $# -ge 2 ] || die "--arch 后面要跟 x86_64 或 arm64"; ARCH="$2"; shift 2 ;;
      --arch=*)    ARCH="${1#*=}"; shift ;;
      -h|--help)   usage_arch; exit 0 ;;
      *)           QL_REST+=("$1"); shift ;;
    esac
  done
  apply_arch
  assert_arch_triplet
}

arch_summary() {
  printf 'ARCH=%s  deb=%s  rpm=%s  electron=%s  snowluma=%s  appimage=%s\n' \
    "$ARCH" "$DEB_ARCH" "$RPM_ARCH" "$ELECTRON_ARCH" "$SNOWLUMA_ARCH" "$APPIMAGE_ARCH"
}

# ============================================================================
#  运行时文件名（按架构；x86_64 的名称与改造前逐字一致）
# ============================================================================

electron_zip_name()  { echo "electron-v${ELECTRON_VERSION}-linux-${ELECTRON_ARCH}.zip"; }
electron_dir_name()  { echo "electron-v${ELECTRON_VERSION}-linux-${ELECTRON_ARCH}"; }
electron_url()       { echo "${ELECTRON_URL_BASE}/$(electron_zip_name)"; }
snowluma_tgz_name()  { echo "SnowLuma-v${SNOWLUMA_VERSION}-linux-${SNOWLUMA_ARCH}.tar.gz"; }
snowluma_dir_name()  { echo "snowluma-linux-${SNOWLUMA_ARCH}"; }
snowluma_url()       { echo "${SNOWLUMA_URL_BASE}/$(snowluma_tgz_name)"; }

snowluma_sha256() {
  # 允许用环境变量覆盖（CI 里通过 secret 提供），但**仍然拒绝占位值**——
  # 覆盖通道是给「已经人工核对过官方值」的场景用的，不是绕过校验的后门。
  case "$ARCH" in
    x86_64) echo "${QL_SNOWLUMA_SHA256_X64:-$SNOWLUMA_SHA256_x64}" ;;
    arm64)  echo "${QL_SNOWLUMA_SHA256_ARM64:-$SNOWLUMA_SHA256_arm64}" ;;
    *)      die "未知架构：$ARCH" ;;
  esac
}

# arm64 的 SHA256 尚未核对时，**主动硬失败**，绝不放行未校验的包。
require_snowluma_sha256() {
  local v; v="$(snowluma_sha256)"
  if [ -z "$v" ] || [ "${v#__}" != "$v" ]; then
    cat >&2 <<EOF
[错误] SnowLuma $ARCH 的官方 SHA256 尚未核对，拒绝继续（防供应链风险）。

  请在能联网的机器上执行：
    curl -fLO $(snowluma_url)
    sha256sum $(snowluma_tgz_name)
  与官方 release 页面公布的值比对后，把结果填进
    scripts/lib.sh  的 SNOWLUMA_SHA256_${ARCH}
EOF
    exit 1
  fi
  echo "$v"
}

# ============================================================================
#  通用工具
# ============================================================================

prepare_dirs() { mkdir -p "$CACHE_DIR" "$STAGE_DIR" "$OUT_DIR"; }

download() {
  local url="$1" dest="$2"
  [ -f "$dest" ] && { log "已存在，跳过下载：$(basename "$dest")"; return 0; }
  log "下载 $(basename "$dest") ..."
  mkdir -p "$(dirname "$dest")"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 -o "$dest.part" "$url" \
      || die "下载失败：$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$dest.part" "$url" || die "下载失败：$url"
  else
    die "既没有 curl 也没有 wget，无法下载"
  fi
  mv "$dest.part" "$dest"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else die "没有 sha256sum / shasum 可用"; fi
}

verify_sha256() {
  local file="$1" want="$2" label="${3:-$1}"
  local got; got="$(sha256_of "$file")"
  if [ "$got" != "$want" ]; then
    die "$label SHA256 不匹配！
  期望: $want
  实际: $got"
  fi
  ok "$label SHA256 一致"
}

# ============================================================================
#  ELF / PE 架构探测（不依赖 file 命令，直接读魔数与 e_machine）
#  为 test/05-arch-audit.sh 与 01-extract.sh 共用
# ============================================================================

_hex4() { head -c4 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n'; }

is_elf() { [ "$(_hex4 "$1")" = "7f454c46" ]; }
is_pe()  { [ "$(head -c2 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n')" = "4d5a" ]; }

# 读 ELF64 的 e_machine（偏移 0x12，小端 2 字节）
#   3e00 → x86-64       b700 → AArch64
elf_machine() {
  is_elf "$1" || { echo ""; return 0; }
  local m; m="$(od -An -tx1 -j18 -N2 "$1" 2>/dev/null | tr -d ' \n')"
  case "$m" in
    3e00) echo "x86-64" ;;
    b700) echo "AArch64" ;;
    *)    echo "unknown(machine=$m)" ;;
  esac
}

# 本架构期望的 ELF machine 名（readelf / 魔数探测的写法）
expected_elf_machine() {
  case "$ARCH" in
    x86_64) echo "x86-64" ;;
    arm64)  echo "AArch64" ;;
    *)      die "未知 ARCH：$ARCH" ;;
  esac
}

# ⚠️ 给 grep 用的架构正则 —— **不要**拿 expected_elf_machine() 的写法去 grep `file` 的输出：
#    `file` 对同一架构的拼写不同：
#        arm64  → "ELF 64-bit LSB pie executable, ARM aarch64, ..."    （小写 aarch64）
#        x86_64 → "ELF 64-bit LSB pie executable, x86-64, ..."
#    实测踩到过：用 "AArch64" 去 `grep -v` file 的输出，arm64 树上**所有** ELF
#    都被误判成"架构不符"（x86_64 恰好两边都写 x86-64，所以一直没暴露）。
expected_elf_grep_pattern() {
  case "$ARCH" in
    x86_64) echo 'x86[-_]64' ;;
    arm64)  echo '(AArch64|aarch64)' ;;
    *)      die "未知 ARCH：$ARCH" ;;
  esac
}

# 大小写不敏感地找目录（E 盘上目录名拼写不完全一致过）
find_win_app() {
  if [ -d "$WIN_APP_SUB" ]; then return 0; fi
  local hit
  hit="$(find /mnt/e -maxdepth 4 -type d -name app -path '*QQ Agent*' 2>/dev/null | head -1)"
  if [ -n "$hit" ] && [ -f "$hit/package.json" ]; then
    WIN_APP_SUB="$hit"
    WIN_APP_DIR="$(dirname "$(dirname "$hit")")"
    warn "已回退定位到：$WIN_APP_SUB"
    return 0
  fi
  die "找不到已安装的 QQ-Agent V0.4.4 应用树（期望 $WIN_APP_SUB）"
}

# ============================================================================
#  运行时准备（按架构）
# ============================================================================

electron_sha256() {
  case "$ARCH" in
    x86_64) echo "${QL_ELECTRON_SHA256_X64:-$ELECTRON_SHA256_x64}" ;;
    arm64)  echo "${QL_ELECTRON_SHA256_ARM64:-$ELECTRON_SHA256_arm64}" ;;
    *)      die "未知架构：$ARCH" ;;
  esac
}

# 未核对时硬失败（与 SnowLuma 同策略：绝不放行未校验的运行时）
require_electron_sha256() {
  local v; v="$(electron_sha256)"
  if [ -z "$v" ] || [ "${v#__}" != "$v" ]; then
    cat >&2 <<EOF
[错误] Electron $ARCH 的官方 SHA256 尚未核对，拒绝继续。
  官方校验文件：
  https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/SHASUMS256.txt
EOF
    exit 1
  fi
  echo "$v"
}

ensure_electron() {
  local zip dir
  zip="$CACHE_DIR/$(electron_zip_name)"
  dir="$CACHE_DIR/$(electron_dir_name)"
  # 缓存命中判据用 -f 而不是 -x：-x 在丢过权限位的环境（如 Cygwin noacl）恒为假，
  # 会导致每次重复解包。这里顺手把执行位补回来，自愈。
  if [ -f "$dir/electron" ]; then
    chmod +x "$dir/electron" 2>/dev/null || true
    echo "$dir"; return 0
  fi
  [ -f "$zip" ] || download "$(electron_url)" "$zip"
  need_file "$zip"
  # ★ 完整性校验：这一步原先**是缺的**（只有 SnowLuma 做了校验），
  #   供应链上任何一环被替换都发现不了。2026-09-28 补上。
  verify_sha256 "$zip" "$(require_electron_sha256)" "Electron linux-${ELECTRON_ARCH}"
  log "解包 Electron ${ELECTRON_VERSION} linux-${ELECTRON_ARCH} ..."
  rm -rf "$dir"; mkdir -p "$dir"
  unzip -q "$zip" -d "$dir"
  chmod +x "$dir/electron" 2>/dev/null || true
  echo "$dir"
}

ensure_snowluma() {
  local tgz dir inner tmp
  tgz="$CACHE_DIR/$(snowluma_tgz_name)"
  dir="$CACHE_DIR/$(snowluma_dir_name)"
  if [ -f "$dir/index.mjs" ]; then
    [ -f "$dir/node" ] && chmod 755 "$dir/node" 2>/dev/null || true
    echo "$dir"; return 0
  fi

  [ -f "$tgz" ] || download "$(snowluma_url)" "$tgz"
  need_file "$tgz"
  verify_sha256 "$tgz" "$(require_snowluma_sha256)" "SnowLuma linux-${SNOWLUMA_ARCH}"

  log "解包 SnowLuma ${SNOWLUMA_VERSION} linux-${SNOWLUMA_ARCH} ..."
  rm -rf "$dir"; mkdir -p "$dir"
  tar -xzf "$tgz" -C "$dir"
  # 有些发行版多包一层目录
  if [ ! -f "$dir/index.mjs" ]; then
    inner="$(find "$dir" -maxdepth 2 -name index.mjs -type f | head -1)"
    if [ -n "$inner" ]; then
      tmp="$dir.__tmp"
      mv "$(dirname "$inner")" "$tmp"
      rm -rf "$dir"; mv "$tmp" "$dir"
    fi
  fi
  [ -f "$dir/index.mjs" ] || die "SnowLuma 解包后仍找不到 index.mjs"
  # 给自带 node 补执行位
  [ -f "$dir/node" ] && chmod 755 "$dir/node" || true
  echo "$dir"
}

# SnowLuma native/ 报告 —— ★ 专门用来回答「坑 A：ffmpeg addon 在不在」
# arm64 构建前必须看这段输出，确认 native/ 下是 linux 的 .node/.so，
# 尤其 ffmpeg addon 有没有对应架构版本。
snowluma_native_report() {
  local dir="$1"
  echo "--- native/ 原生模块（确认是 linux 件，不是 win32）---"
  if [ ! -d "$dir/native" ]; then
    warn "没有 native/ 目录：$dir/native"
    return 0
  fi
  find "$dir/native" -maxdepth 3 -type f -printf '  %-52p %10s\n' 2>/dev/null \
    || find "$dir/native" -maxdepth 3 -type f -exec ls -la {} \; 2>/dev/null

  local ff
  ff="$(find "$dir/native" -maxdepth 3 -iname '*ffmpeg*' -type f 2>/dev/null | head -5)"
  if [ -n "$ff" ]; then
    ok "找到 ffmpeg addon："; printf '    %s\n' $ff
    case "$ff" in
      *win32*|*win64*|*.dll) warn "★ ffmpeg addon 看起来是 Windows 件！arm64 版会废掉语音功能" ;;
    esac
  else
    warn "★ native/ 下没找到 ffmpeg addon —— 请人工确认语音功能在 $ARCH 上是否可用"
  fi

  local pe
  pe="$(find "$dir/native" \( -iname '*win32*' -o -iname '*win64*' -o -iname '*.dll' \) 2>/dev/null | head -5)"
  [ -n "$pe" ] && { warn "发现疑似 Windows 原生件："; printf '    %s\n' $pe; }
  return 0
}

# ============================================================================
#  AppImage 工具链（06-build-appimage.sh 用）
#
#  digest 来源：GitHub Releases API 的 assets[].digest（2026-09-28 取得）
#    AppImage/appimagetool   tag=continuous
#    AppImage/type2-runtime  tag=continuous
#
#  与 SnowLuma / Electron 同策略：下载走镜像（github.com 被 SNI 阻断），
#  但**逐字节比对官方 digest 通过才落地** —— 校验通过即等价于拿到官方原件。
# ============================================================================
APPIMAGETOOL_TAG="continuous"
TYPE2RUNTIME_TAG="continuous"
APPIMAGETOOL_URL_BASE="https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_TAG}"
TYPE2RUNTIME_URL_BASE="https://github.com/AppImage/type2-runtime/releases/download/${TYPE2RUNTIME_TAG}"
# 国内直连 github.com 不通时用的镜像前缀（可用 QL_GH_MIRROR 覆盖；留空表示直连）
QL_GH_MIRROR="${QL_GH_MIRROR-https://gh-proxy.com/}"

APPIMAGETOOL_SHA256_x86_64="a6d71e2b6cd66f8e8d16c37ad164658985e0cf5fcaa950c90a482890cb9d13e0"
APPIMAGETOOL_SHA256_aarch64="1b00524ba8c6b678dc15ef88a5c25ec24def36cdfc7e3abb32ddcd068e8007fe"
TYPE2RUNTIME_SHA256_x86_64="1cc49bcf1e2ccd593c379adb17c9f85a36d619088296504de95b1d06215aebbf"
TYPE2RUNTIME_SHA256_aarch64="7d5d772b7c32f0c84caf0a452a3072a5709027d7eac5856feb89a7a7a8881372"

appimagetool_name() { echo "appimagetool-${APPIMAGE_ARCH}.AppImage"; }
runtime_name()      { echo "runtime-${APPIMAGE_ARCH}"; }

appimagetool_sha256() {
  case "$APPIMAGE_ARCH" in
    x86_64)  echo "${QL_APPIMAGETOOL_SHA256_X86_64:-$APPIMAGETOOL_SHA256_x86_64}" ;;
    aarch64) echo "${QL_APPIMAGETOOL_SHA256_AARCH64:-$APPIMAGETOOL_SHA256_aarch64}" ;;
    *)       die "未知 APPIMAGE_ARCH：$APPIMAGE_ARCH" ;;
  esac
}
runtime_sha256() {
  case "$APPIMAGE_ARCH" in
    x86_64)  echo "${QL_TYPE2RUNTIME_SHA256_X86_64:-$TYPE2RUNTIME_SHA256_x86_64}" ;;
    aarch64) echo "${QL_TYPE2RUNTIME_SHA256_AARCH64:-$TYPE2RUNTIME_SHA256_aarch64}" ;;
    *)       die "未知 APPIMAGE_ARCH：$APPIMAGE_ARCH" ;;
  esac
}

# 下载 + 官方摘要校验，落地到 tools/
ensure_appimage_tool() {
  local kind="$1"          # appimagetool | runtime
  local url name want out
  case "$kind" in
    appimagetool) url="$APPIMAGETOOL_URL_BASE/$(appimagetool_name)"; name="$(appimagetool_name)"; want="$(appimagetool_sha256)" ;;
    runtime)      url="$TYPE2RUNTIME_URL_BASE/$(runtime_name)";       name="$(runtime_name)";       want="$(runtime_sha256)" ;;
    *) die "ensure_appimage_tool: 未知类型 $kind" ;;
  esac
  out="$QL_ROOT/tools/$name"
  mkdir -p "$QL_ROOT/tools"
  if [ -f "$out" ] && [ "$(sha256_of "$out")" = "$want" ]; then echo "$out"; return 0; fi
  log "下载 AppImage 工具链：$name"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 --silent --show-error \
         -o "$out.part" "${QL_GH_MIRROR}${url}" || die "下载失败：$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$out.part" "${QL_GH_MIRROR}${url}" || die "下载失败：$url"
  else
    die "既没有 curl 也没有 wget"
  fi
  verify_sha256 "$out.part" "$want" "$name"
  mv "$out.part" "$out"
  chmod 755 "$out"
  echo "$out"
}
