#!/usr/bin/env bash
# verify-iso-official.sh —— 用**官方源**的 CHECKSUM 核对已下载的 ISO。
#
# ## 为什么怀疑之前的 CHECKSUM 是错的
#
# 之前从阿里云取的 CHECKSUM 说：
#   Rocky-9-latest-x86_64-minimal.iso = 1,480,048,640 字节
#    SHA256 = d338032cd1cdd41c67139f2f71b4c832c8e4a21943106519db9c7137df7a63d4
#
# 但从**官方源**下载得到的文件是 2,755,067,904 字节，且 `file` 明确识别为
#   "ISO 9660 CD-ROM filesystem data (DOS/MBR boot sector) 'Rocky..."
# —— 是货真价实的 ISO，不是错误页。
#
# 文件名里的 "latest" 说明这是**滚动版本**：内容会随 Rocky 的更新而变化，
# 各镜像站的 CHECKSUM 文件未必同步。所以拿阿里云的 CHECKSUM 去核官方源的文件，
# 本身就可能不成立。
#
# 本脚本从多个源取 CHECKSUM，找出**与本地文件大小一致**的那份，再用它核对 SHA256。

set -uo pipefail

DIR="/mnt/f/rpm-vm"
ISO_NAME="Rocky-9-latest-x86_64-minimal.iso"
ISO="$DIR/$ISO_NAME"

[ -f "$ISO" ] || { echo "❌ 本地 ISO 不存在: $ISO"; exit 1; }

LOCAL_SIZE=$(stat -c%s "$ISO")
echo "=================================================================="
echo "本地文件"
echo "=================================================================="
echo "  路径: $ISO"
echo "  大小: $LOCAL_SIZE 字节 ($(awk -v s="$LOCAL_SIZE" 'BEGIN{printf "%.2f GB", s/1073741824}'))"
echo "  类型: $(file -b "$ISO" | cut -c1-70)"

# 先看 ISO 卷标，确认版本
echo "  卷标: $(isoinfo -d -i "$ISO" 2>/dev/null | grep -i 'Volume id' | head -1 || echo '（isoinfo 不可用）')"

echo
echo "=================================================================="
echo "各镜像源的 CHECKSUM"
echo "=================================================================="
FOUND=0
declare -a MATCHED_SHA
for src in \
  "官方|https://download.rockylinux.org/pub/rocky/9/isos/x86_64/CHECKSUM" \
  "中科大|https://mirrors.ustc.edu.cn/rocky/9/isos/x86_64/CHECKSUM" \
  "南大|https://mirror.nju.edu.cn/rocky/9/isos/x86_64/CHECKSUM" \
  "阿里云|https://mirrors.aliyun.com/rockylinux/9/isos/x86_64/CHECKSUM" \
  ; do
  name="${src%%|*}"; url="${src#*|}"
  printf "  %-8s " "$name"

  if ! curl -sSL --max-time 25 -o /tmp/ck.txt "$url" 2>/dev/null || [ ! -s /tmp/ck.txt ]; then
    echo "取不到"
    continue
  fi

  sz=$(grep -F "$ISO_NAME:" /tmp/ck.txt | grep -oE '[0-9]{6,}' | head -1)
  sh=$(grep -F "$ISO_NAME" /tmp/ck.txt | grep -i SHA256 | sed 's/.*= *//' | tr -d ' \r' | head -1)
  echo "大小=$sz   SHA256=${sh:0:24}..."

  if [ "$sz" = "$LOCAL_SIZE" ]; then
    echo "           ✅ 大小与本地一致 —— 用这份核对"
    MATCHED_SHA+=("$name|$sh")
    FOUND=1
  fi
done

echo
echo "=================================================================="
echo "校验"
echo "=================================================================="

if [ $FOUND -eq 0 ]; then
  echo "  ⚠️  没有任何镜像的 CHECKSUM 与本地大小一致。"
  echo "     这不一定是本地文件的问题 —— 可能是各处 CHECKSUM 都未同步，"
  echo "     或下载到的版本与 CHECKSUM 记录的版本不同。"
  echo
  echo "  已知："
  echo "    · 本地文件被 file 识别为 ISO 9660（是真实 ISO，不是错误页）"
  echo "    · 卷标见上（可用于判断实际版本）"
  echo
  echo "  建议：改用**固定版本**的 ISO（不带 'latest'），这样 CHECKSUM 可对应。"
  echo "  例如 Rocky-9.8-x86_64-minimal.iso。"
  exit 2
fi

echo "  计算本地 SHA256（约 40-90 秒，2.57GB）..."
GOT=$(sha256sum "$ISO" | awk '{print $1}')
echo "  本地: ${GOT:0:48}..."
echo

OK=0
for m in "${MATCHED_SHA[@]}"; do
  name="${m%%|*}"; want="${m#*|}"
  printf "  %-8s 官方: %s...  " "$name" "${want:0:48}"
  if [ "$GOT" = "$want" ]; then
    echo "✅ 一致"
    OK=1
  else
    echo "❌ 不一致"
  fi
done

echo
if [ $OK -eq 1 ]; then
  echo "✅ SHA256 校验通过 —— ISO 完整可信"
  exit 0
else
  echo "❌ SHA256 不一致 —— 文件可能损坏"
  exit 1
fi
