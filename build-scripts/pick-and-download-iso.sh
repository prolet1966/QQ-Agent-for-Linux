#!/usr/bin/env bash
# pick-and-download-iso.sh —— 探测多个 https 镜像，选可用的下载并校验。
#
# ## 前面失败的原因汇总（都记下来，避免重犯）
#
#   1. 脚本只判断"文件存在"就跳过，不校验 → 差点拿坏文件装 VM
#   2. 用了 `curl -C -` 续传 → Range 处理有问题
#   3. 下载中途 kill 掉作业，看到文件"超过官方大小"就误判为"响应被改写"
#      **实际只是没下完**
#   4. 诊断脚本探测时漏了 `-L` → 拿到 215 字节的 302 HTML 而不是文件
#   5. 本脚本要解决的：**阿里云 302 跳到 HTTP(80)，而本机 80 端口不通**
#
# ## 本脚本的策略
#   逐个探测候选镜像（全部 https 且尽量直连文件，不依赖跟随跳转），
#   只挑「能拿到正确 Content-Length 且响应像二进制」的那个来下。

set -uo pipefail

DEST_DIR="/mnt/f/rpm-vm"
ISO_NAME="Rocky-9-latest-x86_64-minimal.iso"
DEST="$DEST_DIR/$ISO_NAME"
CHECKSUM_FILE="$DEST_DIR/CHECKSUM.official"

mkdir -p "$DEST_DIR"

echo "=================================================================="
echo "Rocky ISO：探测可用镜像"
echo "=================================================================="

# ── 0. 官方校验值（从阿里云取，它只用于取文本，不涉及大文件）─────────────
echo
echo "== 0. 取官方校验清单 =="
EXPECT_SIZE=""; EXPECT_SHA=""
for ck in \
  "https://mirrors.aliyun.com/rockylinux/9/isos/x86_64/CHECKSUM" \
  "https://download.rockylinux.org/pub/rocky/9/isos/x86_64/CHECKSUM" \
  ; do
  if curl -sSL --max-time 30 -o "$CHECKSUM_FILE" "$ck" 2>/dev/null && [ -s "$CHECKSUM_FILE" ]; then
    EXPECT_SIZE=$(grep -F "$ISO_NAME:" "$CHECKSUM_FILE" | grep -oE '[0-9]{6,}' | head -1)
    EXPECT_SHA=$(grep -F "$ISO_NAME" "$CHECKSUM_FILE" | grep -i SHA256 | sed 's/.*= *//' | tr -d ' \r' | head -1)
    [ -n "$EXPECT_SHA" ] && { echo "  来源: $ck"; break; }
  fi
done

if [ -z "$EXPECT_SHA" ]; then
  echo "  ❌ 取不到官方 SHA256，停止（无校验的 ISO 不能用）"
  exit 1
fi
echo "  官方大小  : $EXPECT_SIZE 字节 ($(awk -v s="$EXPECT_SIZE" 'BEGIN{printf "%.2f GB", s/1073741824}'))"
echo "  官方 SHA256: ${EXPECT_SHA:0:40}..."

# ── 1. 候选镜像 ──────────────────────────────────────────────────────────
# 只用能 https 直连文件的；对 302 到 http 的源不给机会（本机 80 不通）
CANDIDATES=(
  "官方主站|https://download.rockylinux.org/pub/rocky/9/isos/x86_64/$ISO_NAME"
  "官方镜像|https://mirrors.rockylinux.org/mirrorlist?arch=x86_64&repo=9"
  "清华|https://mirrors.tuna.tsinghua.edu.cn/rocky/9/isos/x86_64/$ISO_NAME"
  "中科大|https://mirrors.ustc.edu.cn/rocky/9/isos/x86_64/$ISO_NAME"
  "南大|https://mirror.nju.edu.cn/rocky/9/isos/x86_64/$ISO_NAME"
  "阿里云|https://mirrors.aliyun.com/rockylinux/9/isos/x86_64/$ISO_NAME"
)

echo
echo "== 1. 逐个探测（跟随跳转，检查 Content-Length 与内容类型）=="
# 只用真正的 ISO 直链；mirrorlist 那条会被跳过（它是列表页）
BEST=""
for item in "${CANDIDATES[@]}"; do
  name="${item%%|*}"
  url="${item#*|}"
  case "$url" in
    *mirrorlist*) continue ;;
  esac

  printf "  %-10s " "$name"

  # -L 跟随跳转；取前 1KB 看响应
  probe=$(curl -sSL -o /tmp/probe.bin --max-time 25 \
          -w "%{http_code}|%{size_download}|%{content_type}|%{url_effective}" \
          -r 0-1023 "$url" 2>&1)

  code=$(echo "$probe" | cut -d'|' -f1)
  size=$(echo "$probe" | cut -d'|' -f2)
  ctype=$(echo "$probe" | cut -d'|' -f3)
  final=$(echo "$probe" | cut -d'|' -f4)

  if [ "$code" = "200" ] || [ "$code" = "206" ]; then
    ft=$(file -b /tmp/probe.bin 2>/dev/null | cut -c1-40)
    echo "HTTP=$code  ${size}B  $ctype"
    echo "             跳转到: $final"
    echo "             类型: $ft"
    if [ -z "$BEST" ]; then
      BEST="$url"
      echo "             ✅ 选为下载源"
    fi
  else
    echo "失败 HTTP=$code"
  fi
done
rm -f /tmp/probe.bin

if [ -z "$BEST" ]; then
  echo
  echo "❌ 没有可用镜像（全部探测失败）"
  echo "  可尝试：检查网络 / 关闭代理 / 换用其他发行版（如 Fedora）的镜像"
  exit 1
fi

# ── 2. 下载 ──────────────────────────────────────────────────────────────
echo
echo "== 2. 下载 =="
echo "  源  : $BEST"
echo "  目标: $DEST"
echo "  大小: $EXPECT_SIZE 字节"
echo "  开始: $(date '+%H:%M:%S')"
rm -f "$DEST"
echo

curl -L --retry 3 --retry-delay 3 --connect-timeout 20 --max-time 2400 \
     -o "$DEST" "$BEST" \
     -w "  HTTP=%{http_code}  实收=%{size_download} 字节  用时=%{time_total}s  均速=%{speed_download} B/s\n" \
     -sS 2>&1 | tail -3
RC=$?
echo "  curl 退出码: $RC"
echo "  结束: $(date '+%H:%M:%S')"

[ $RC -eq 0 ] || { echo "  ❌ curl 未正常结束"; exit 1; }

# ── 3. 校验 ──────────────────────────────────────────────────────────────
echo
echo "== 3. 校验 =="
SIZE=$(stat -c%s "$DEST" 2>/dev/null || echo 0)
FT=$(file -b "$DEST" 2>/dev/null | cut -c1-60)
echo "  实际大小: $SIZE 字节 ($(awk -v s="$SIZE" 'BEGIN{printf "%.2f GB", s/1073741824}'))"
echo "  文件类型: $FT"

if echo "$FT" | grep -qi html; then
  echo "  ❌ 是 HTML（错误页/重定向页），不是 ISO"
  exit 1
fi
if [ "$SIZE" != "$EXPECT_SIZE" ]; then
  echo "  ❌ 大小与官方不符（官方 $EXPECT_SIZE），差 $((SIZE - EXPECT_SIZE)) 字节"
  exit 1
fi
echo "  ✅ 大小一致"

echo "  计算 SHA256（约 30-60 秒）..."
GOT=$(sha256sum "$DEST" | awk '{print $1}')
if [ "$GOT" = "$EXPECT_SHA" ]; then
  echo "  ✅ SHA256 与官方完全一致 —— ISO 完整可信"
else
  echo "  ❌ SHA256 不一致"
  echo "     本地: ${GOT:0:40}..."
  echo "     官方: ${EXPECT_SHA:0:40}..."
  exit 1
fi

echo
echo "=================================================================="
echo "✅ 完成"
du -h "$DEST"
