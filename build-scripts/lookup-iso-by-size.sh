#!/usr/bin/env bash
# lookup-iso-by-size.sh —— 用文件大小在官方 CHECKSUM 里反查对应条目。
#
# ## 为什么要反查
#
# 已确认的事实：
#   · 服务器对 Rocky-9-latest-x86_64-minimal.iso 声明 content-length = 2,755,067,904
#   · 但 CHECKSUM 里该文件条目写的是 1,480,048,640
#   · 直连取 32MB 片段，实收精确等于请求量，内容为 ISO 9660 → 传输无损坏
#   · 代理连不上，所以与代理无关
#
# 结论：**服务器上的文件与 CHECKSUM 不同步**（滚动发布常见）。
# 那就换个方向 —— 拿实际大小去 CHECKSUM 里找对应条目，看能否确认它到底是哪个版本。
# 若找到匹配条目，仍可用官方哈希校验；找不到则说明该文件未被官方清单收录。

set -uo pipefail

SIZE="${1:-2755067904}"
CK=/tmp/ck-official.txt

echo "=================================================================="
echo "在官方 CHECKSUM 里反查大小 $SIZE 字节"
echo "=================================================================="

curl -sSL --max-time 30 -o "$CK" \
  "https://download.rockylinux.org/pub/rocky/9/isos/x86_64/CHECKSUM" 2>/dev/null \
  || { echo "❌ 取不到官方 CHECKSUM"; exit 1; }

echo "  清单大小: $(stat -c%s "$CK") 字节"
echo "  清单里的条目总数: $(grep -cE '^#.*\.iso:' "$CK")"
echo

echo "== 1. 找大小完全匹配的条目 =="
HIT=$(grep -E '^#.*\.iso:' "$CK" | while IFS= read -r line; do
  s=$(echo "$line" | grep -oE '[0-9]{6,}' | head -1)
  [ "$s" = "$SIZE" ] && echo "$line"
done)

if [ -n "$HIT" ]; then
  echo "  ✅ 找到匹配条目："
  echo "$HIT" | sed 's/^/      /'
  NAME=$(echo "$HIT" | head -1 | sed 's/^# *//; s/:.*//')
  WANT=$(grep -F "$NAME" "$CK" | grep -i SHA256 | sed 's/.*= *//' | tr -d ' \r' | head -1)
  echo "      对应文件: $NAME"
  echo "      官方 SHA256: ${WANT:0:48}..."
  echo
  echo "  → 可以用这个哈希校验本地文件。保存到 /tmp/expected-sha.txt"
  echo "$WANT" > /tmp/expected-sha.txt
  echo "$NAME" > /tmp/expected-name.txt
else
  echo "  ❌ 清单里没有任何条目的大小等于 $SIZE"
  echo
  echo "== 2. 清单里最小与最大的几个条目（供对比）=="
  grep -E '^#.*\.iso:' "$CK" | while IFS= read -r line; do
    n=$(echo "$line" | sed 's/^# *//; s/:.*//')
    s=$(echo "$line" | grep -oE '[0-9]{6,}' | head -1)
    echo "$s|$n"
  done | sort -n | awk -F'|' '
    NR<=6 { printf "      %-46s %14s\n", $2, $1 }
    { all[NR]=$0 }
    END {
      print "      ..."
      start = NR-5; if (start < 1) start = 1
      for (i=start; i<=NR; i++) { split(all[i], a, "|"); printf "      %-46s %14s\n", a[2], a[1] }
    }'
fi

echo
echo "=================================================================="
echo "当地文件实际是什么"
echo "=================================================================="
ISO=$(ls /mnt/f/rpm-vm/*.iso 2>/dev/null | head -1)
if [ -n "$ISO" ]; then
  echo "  文件: $(basename "$ISO")"
  echo "  大小: $(stat -c%s "$ISO") 字节"
  echo "  卷标: $(isoinfo -d -i "$ISO" 2>/dev/null | grep -i 'Volume id' | sed 's/.*: *//' | tr -d '\r' || echo '取不到')"
  echo "  类型: $(file -b "$ISO" | cut -c1-60)"
else
  echo "  （目录里没有 ISO）"
fi
