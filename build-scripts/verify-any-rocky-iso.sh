#!/usr/bin/env bash
# verify-any-rocky-iso.sh —— 校验本地已有的 Rocky ISO（不纠结它叫什么名字）。
#
# ## 思路纠正
#
# 前面我一直在纠结"下载到的到底是 minimal 还是 DVD"，反复换源重下，
# 浪费了不少时间。其实真正要紧的只有一个问题：
#   **我手上的这个 ISO 是不是可信的？**
# 而这可以用校验和直接回答 —— 跟文件名叫什么无关。
#
# ## 做法
#   1. 读本地 ISO 的卷标，判断它实际是哪个变体（dvd / minimal / boot）
#   2. 从镜像取**该变体对应版本**的 CHECKSUM（有各变体的条目）
#   3. 按大小匹配到正确条目，再核 SHA256
#
# ## 为什么卷标能告诉我们变体
#   实测：
#     Rocky-9-latest-x86_64-minimal.iso  → 卷标 Rocky-9-8-x86_64-dvd
#     Rocky-9.8-x86_64-minimal.iso       → 卷标 Rocky-9-8-x86_64-dvd
#   也就是说这些镜像的 minimal 链接实际给的是 DVD。
#   既然 DVD 也是**完整、可用**的 Rocky 9 安装介质（只是体积大些），
#   那么只要校验通过就可以用 —— 没必要为名字较劲。

set -uo pipefail

DIR="/mnt/f/rpm-vm"
CK="$DIR/CHECKSUM-rocky98.txt"

echo "=================================================================="
echo "校验本地 Rocky ISO"
echo "=================================================================="

# 找本地的 iso
ISO=""
for f in "$DIR"/*.iso; do
  [ -f "$f" ] && ISO="$f" && break
done

if [ -z "$ISO" ]; then
  echo "❌ 目录里没有 ISO: $DIR"
  exit 1
fi

SIZE=$(stat -c%s "$ISO")
echo "  文件: $(basename "$ISO")"
echo "  大小: $SIZE 字节 ($(awk -v s="$SIZE" 'BEGIN{printf "%.2f GB", s/1073741824}'))"

VOLID=$(isoinfo -d -i "$ISO" 2>/dev/null | grep -i 'Volume id' | sed 's/.*: *//' | tr -d '\r')
echo "  卷标: ${VOLID:-（取不到）}"
FT=$(file -b "$ISO" | cut -c1-60)
echo "  类型: $FT"

if echo "$FT" | grep -qi html; then
  echo
  echo "❌ 这是 HTML（错误页），不是 ISO。删除后重下。"
  exit 1
fi

echo
echo "=================================================================="
echo "取 CHECKSUM（含各变体条目）"
echo "=================================================================="
GOT_CK=0
for base in \
  "https://mirrors.ustc.edu.cn/rocky/9/isos/x86_64/" \
  "https://mirror.nju.edu.cn/rocky/9/isos/x86_64/" \
  "https://download.rockylinux.org/pub/rocky/9/isos/x86_64/" \
  ; do
  echo "  $base"
  if curl -sSL --max-time 25 -o "$CK" "${base}CHECKSUM" 2>/dev/null && [ -s "$CK" ]; then
    echo "    ✅ 取到（$(stat -c%s "$CK") 字节）"
    GOT_CK=1
    break
  fi
  echo "    ❌ 失败"
done

[ $GOT_CK -eq 1 ] || { echo "❌ 取不到 CHECKSUM"; exit 1; }

echo
echo "  清单里所有 .iso 条目（名 / 大小）："
# 清单格式：# <name>: <size> bytes   /   SHA256 (<name>) = <hash>
while IFS= read -r line; do
  n=$(echo "$line" | sed 's/^# *//; s/:.*//')
  s=$(echo "$line" | grep -oE '[0-9]{6,}' | head -1)
  if [ -n "$s" ]; then
    mark=""
    [ "$s" = "$SIZE" ] && mark="  ← 与本机大小相同"
    printf "    %-44s %14s 字节%s\n" "$n" "$s" "$mark"
  fi
done < <(grep -E '^#.*\.iso:' "$CK")

echo
echo "=================================================================="
echo "按大小匹配并校验"
echo "=================================================================="
# 找出清单里大小与本地一致的那条
MATCH_NAME=$(grep -E '^#.*\.iso:' "$CK" | while IFS= read -r line; do
  s=$(echo "$line" | grep -oE '[0-9]{6,}' | head -1)
  if [ "$s" = "$SIZE" ]; then
    echo "$line" | sed 's/^# *//; s/:.*//'
    break
  fi
done)

if [ -z "$MATCH_NAME" ]; then
  echo "  ⚠️  清单里没有与本机大小匹配的条目。"
  echo "     说明本地文件的版本/变体与清单不同步，无法用哈希校验。"
  echo
  echo "  可选做法："
  echo "    · 换一个镜像重新下载"
  echo "    · 或直接使用 —— file 已确认它是 ISO 9660 且卷标为 Rocky，"
  echo "      但**未经哈希校验**，建议至少确认安装界面能正常启动"
  exit 2
fi

echo "  匹配到条目: $MATCH_NAME"
WANT_SHA=$(grep -F "$MATCH_NAME" "$CK" | grep -i SHA256 | sed 's/.*= *//' | tr -d ' \r' | head -1)
echo "  该条目 SHA256: ${WANT_SHA:0:48}..."

if [ -z "$WANT_SHA" ]; then
  echo "  ⚠️  清单里没有该条目的 SHA256，无法校验"
  exit 2
fi

echo
echo "  计算本地 SHA256（2.5GB 约需 40-90 秒）..."
GOT_SHA=$(sha256sum "$ISO" | awk '{print $1}')
echo "  本地: ${GOT_SHA:0:48}..."

echo
if [ "$GOT_SHA" = "$WANT_SHA" ]; then
  echo "✅ SHA256 完全一致 —— ISO 完整可信，可用于安装"
  echo
  echo "  注意：它实际是 **$VOLID** 变体（不是 minimal）。"
  echo "  DVD 版同样是完整的 Rocky 9 安装介质，用于本次 rpm 验证完全够用，"
  echo "  只是体积更大、安装时可少选些软件组来提速。"
  exit 0
else
  echo "❌ SHA256 不一致 —— 文件损坏或被改写，不可用于安装"
  exit 1
fi
