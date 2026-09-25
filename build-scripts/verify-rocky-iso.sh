#!/usr/bin/env bash
# verify-rocky-iso.sh —— 校验 Rocky ISO 是否完整（大小 + 官方 SHA256）。
#
# 背景：fetch-rocky-iso.sh 有个 bug —— 它只看"文件是否存在"就跳过，
# 不校验完整性。续传中断后留下 1.75GB 的不完整文件，脚本却直接说"已存在，跳过"。
# 本脚本专门做校验，避免拿一个残缺的 ISO 去装 VM（那会浪费大量时间排查安装失败）。

set -uo pipefail

DIR="/mnt/f/rpm-vm"
ISO_NAME="Rocky-9-latest-x86_64-minimal.iso"
ISO="$DIR/$ISO_NAME"

echo "== 1. 本地文件 =="
if [ ! -f "$ISO" ]; then
  echo "  ❌ 不存在: $ISO"
  exit 1
fi
SIZE=$(stat -c%s "$ISO")
echo "  大小: $SIZE 字节 ($(du -h "$ISO" | cut -f1))"

echo
echo "== 2. 官方清单（大小 + SHA256）=="
MIRRORS=(
  "https://mirrors.aliyun.com/rockylinux/9/isos/x86_64/"
  "https://download.rockylinux.org/pub/rocky/9/isos/x86_64/"
)
CHECKSUM_FILE="$DIR/CHECKSUM.official"
GOT_LIST=0
for m in "${MIRRORS[@]}"; do
  echo "  尝试: ${m}CHECKSUM"
  if curl -sS --max-time 30 -o "$CHECKSUM_FILE" "${m}CHECKSUM" 2>/dev/null; then
    if [ -s "$CHECKSUM_FILE" ]; then
      GOT_LIST=1
      echo "    ✅ 取到清单 ($(stat -c%s "$CHECKSUM_FILE") 字节)"
      break
    fi
  fi
  echo "    ❌ 失败"
done

if [ $GOT_LIST -eq 0 ]; then
  echo "  ⚠️  取不到官方清单，只能按经验判断大小"
  # Rocky 9 minimal 通常约 2.0-2.5 GB
  if [ "$SIZE" -lt 2000000000 ]; then
    echo "  ❌ 小于 2GB —— 极可能不完整"
    exit 1
  fi
  echo "  ✅ 大于 2GB，大小合理（但未经哈希校验）"
  exit 0
fi

echo
echo "  清单里与目标相关的行："
grep -i "$ISO_NAME" "$CHECKSUM_FILE" | sed 's/^/      /' || echo "      （未匹配到）"

WANT_SHA=$(grep -i "SHA256" "$CHECKSUM_FILE" | grep -i "$ISO_NAME" | awk '{print $NF}' | head -1)
# 有些清单格式是 "<sha256>  <file>"，取第一列
if [ -z "$WANT_SHA" ]; then
  WANT_SHA=$(awk -v f="$ISO_NAME" '$2==f || $NF==f {print $1}' "$CHECKSUM_FILE" | head -1)
fi

echo
echo "== 3. 校验 =="
if [ -n "$WANT_SHA" ]; then
  echo "  官方 SHA256: ${WANT_SHA:0:40}..."
  echo "  正在计算本地 SHA256（1.8GB 需几十秒）..."
  LOCAL_SHA=$(sha256sum "$ISO" | awk '{print $1}')
  echo "  本地 SHA256: ${LOCAL_SHA:0:40}..."
  if [ "$LOCAL_SHA" = "$WANT_SHA" ]; then
    echo "  ✅ 完全一致 —— ISO 完整可信"
    exit 0
  else
    echo "  ❌ 不一致 —— ISO 不完整或已损坏"
    echo "     应删除后重新下载: rm -f $ISO"
    exit 1
  fi
else
  echo "  ⚠️  清单里没找到该文件的 SHA256"
  echo "     清单前 5 行："
  head -5 "$CHECKSUM_FILE" | sed 's/^/      /'
  exit 1
fi
