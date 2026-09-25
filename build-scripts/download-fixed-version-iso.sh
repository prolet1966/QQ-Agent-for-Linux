#!/usr/bin/env bash
# download-fixed-version-iso.sh —— 下载**固定版本**的 Rocky minimal ISO 并校验。
#
# ## 为什么放弃 -latest-
#
# 事实链（每一步都有实测依据）：
#   1. 从 mirrors.aliyun.com/.../Rocky-9-latest-x86_64-minimal.iso 下载
#   2. 得到 2,755,067,904 字节，`file` 识别为 ISO 9660（是真实 ISO）
#   3. 但卷标是 **Rocky-9-8-x86_64-dvd** —— 竟是 DVD 版，不是 minimal
#   4. 四个镜像（官方/中科大/南大/阿里云）的 CHECKSUM 都一致声明
#      minimal 应为 1,480,048,640 字节，SHA256 d338032c...
#
# 也就是说 `-latest-` 这个滚动名称在不同镜像站指向了不同的实际文件。
# 继续用它会一直对不上，所以改用**固定版本**：文件名与内容一一对应，可被校验。
#
# minimal 版约 1.4GB（vs DVD 的 2.57GB），对"装包测 rpm"这个目的完全够用。

set -uo pipefail

DIR="/mnt/f/rpm-vm"
VERSION="9.8"
ISO_NAME="Rocky-${VERSION}-x86_64-minimal.iso"
DEST="$DIR/$ISO_NAME"
CK="$DIR/CHECKSUM-fixed.txt"

MIRRORS=(
  "中科大|https://mirrors.ustc.edu.cn/rocky/9/isos/x86_64/"
  "南大|https://mirror.nju.edu.cn/rocky/9/isos/x86_64/"
  "官方|https://download.rockylinux.org/pub/rocky/9/isos/x86_64/"
  "阿里云|https://mirrors.aliyun.com/rockylinux/9/isos/x86_64/"
)

echo "=================================================================="
echo "下载固定版本 ISO: $ISO_NAME"
echo "=================================================================="

mkdir -p "$DIR"

# ── 0. 取该版本的 CHECKSUM（逐个源试，找到含该文件的那份）────────────────
echo
echo "== 0. 取 CHECKSUM（需包含 $ISO_NAME）=="
EXPECT_SIZE=""; EXPECT_SHA=""; CK_SRC=""
for item in "${MIRRORS[@]}"; do
  name="${item%%|*}"; base="${item#*|}"
  printf "  %-8s " "$name"
  if curl -sSL --max-time 25 -o /tmp/ck.txt "${base}CHECKSUM" 2>/dev/null && [ -s /tmp/ck.txt ]; then
    if grep -qF "$ISO_NAME" /tmp/ck.txt; then
      sz=$(grep -F "$ISO_NAME:" /tmp/ck.txt | grep -oE '[0-9]{6,}' | head -1)
      sh=$(grep -F "$ISO_NAME" /tmp/ck.txt | grep -i SHA256 | sed 's/.*= *//' | tr -d ' \r' | head -1)
      echo "✅ 有该文件  大小=$sz  SHA256=${sh:0:24}..."
      EXPECT_SIZE="$sz"; EXPECT_SHA="$sh"; CK_SRC="$name"
      cp /tmp/ck.txt "$CK"
      break
    fi
    echo "清单里没有该文件"
  else
    echo "取不到"
  fi
done

if [ -z "$EXPECT_SHA" ]; then
  echo
  echo "❌ 没有源提供 $ISO_NAME 的 CHECKSUM"
  echo "   可先列出目录看有哪些版本："
  for item in "${MIRRORS[@]}"; do
    name="${item%%|*}"; base="${item#*|}"
    echo "   【$name】"
    curl -sSL --max-time 20 "$base" 2>/dev/null | grep -oE 'Rocky-9[^"]*minimal\.iso' | sort -u | head -5 | sed 's/^/       /'
  done
  exit 1
fi

echo
echo "  校验值来源: $CK_SRC"
echo "  官方大小  : $EXPECT_SIZE 字节 ($(awk -v s="$EXPECT_SIZE" 'BEGIN{printf "%.2f GB", s/1073741824}'))"
echo "  官方 SHA256: ${EXPECT_SHA:0:40}..."

# ── 1. 下载 ──────────────────────────────────────────────────────────────
echo
echo "== 1. 下载 =="
rm -f "$DEST"
for item in "${MIRRORS[@]}"; do
  name="${item%%|*}"; base="${item#*|}"
  url="${base}${ISO_NAME}"
  echo
  echo "  尝试【$name】$url"
  t0=$(date +%s)
  curl -L --retry 2 --retry-delay 2 --connect-timeout 15 --max-time 1800 \
       -o "$DEST" "$url" \
       -w "    HTTP=%{http_code} 实收=%{size_download} 用时=%{time_total}s\n" \
       -sS 2>&1 | tail -2
  rc=$?
  t1=$(date +%s)

  if [ $rc -ne 0 ]; then
    echo "    ❌ curl 退出码 $rc"
    rm -f "$DEST"
    continue
  fi

  size=$(stat -c%s "$DEST" 2>/dev/null || echo 0)
  ft=$(file -b "$DEST" 2>/dev/null | cut -c1-50)
  echo "    大小: $size  类型: $ft"
  if echo "$ft" | grep -qi html; then
    echo "    ❌ 是 HTML 错误页"
    rm -f "$DEST"
    continue
  fi
  if [ "$size" != "$EXPECT_SIZE" ]; then
    echo "    ❌ 大小不符（期望 $EXPECT_SIZE），换下一个源"
    rm -f "$DEST"
    continue
  fi
  echo "    ✅ 大小一致，用时 $((t1-t0))s"
  break
done

[ -f "$DEST" ] || { echo; echo "❌ 所有源都下载失败"; exit 1; }

# ── 2. 校验 ──────────────────────────────────────────────────────────────
echo
echo "== 2. SHA256 校验 =="
echo "  计算中（约 30-60 秒）..."
GOT=$(sha256sum "$DEST" | awk '{print $1}')
echo "  本地: ${GOT:0:48}..."
echo "  官方: ${EXPECT_SHA:0:48}..."
if [ "$GOT" = "$EXPECT_SHA" ]; then
  echo "  ✅ 完全一致 —— ISO 完整可信"
else
  echo "  ❌ 不一致 —— 文件损坏，不可用于安装"
  exit 1
fi

echo
echo "== 3. 确认版本 =="
echo "  卷标: $(isoinfo -d -i "$DEST" 2>/dev/null | grep -i 'Volume id' | head -1 || echo '（isoinfo 不可用）')"
echo "  大小: $(du -h "$DEST" | cut -f1)"

echo
echo "=================================================================="
echo "✅ 完成: $DEST"
echo "=================================================================="
