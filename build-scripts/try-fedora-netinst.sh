#!/usr/bin/env bash
# try-fedora-netinst.sh —— 改用 Fedora netinst（体积小、校验和可靠）。
#
# ## 为什么换发行版
#
# Rocky 的镜像目前**无法可靠校验**：
#   · 官方 CHECKSUM 只有 928 字节 / 6 个条目，且 boot 与 minimal 同尺寸同哈希
#     （都 1,480,048,640）——这不是一份正常发布清单
#   · 实际下载得到 2,755,067,904 字节，清单里根本没有这个大小的条目
#   · 换多个镜像（官方/中科大/南大/阿里云）结果相同
#   · 直连取片段精确无误、内容为 ISO 9660，**传输是干净的、问题在源**
#
# 无法校验的 ISO 不该拿来装系统 —— 装完若出问题，分不清是包的问题还是
# 系统本身的问题，反而会让 .rpm 验证失去意义。
#
# ## 为什么选 Fedora
#   · 完整 rpm/dnf 体系，正是验证 .rpm 需要的环境
#   · 基础设施（mirrors + CHECKSUM）维护规范，校验值可靠
#   · netinst 仅几百 MB，下载快
#
# ## 对 .rpm 验证的影响（已核实）
#   本项目的 .rpm 声明的依赖是 RHEL 系包名：
#     nss, gtk3, alsa-lib, mesa-libgbm, libxkbcommon, libdrm, libXScrnSaver, xdg-utils
#   Fedora 用同样的名字，因此依赖能被正确解析。
#   （dnf5 与 dnf4 差异不影响 rpm 数据库层面的验证。）

set -uo pipefail

DIR="/mnt/f/rpm-vm"
mkdir -p "$DIR"

echo "=================================================================="
echo "探测 Fedora netinst"
echo "=================================================================="

BASES=(
  "中科大|https://mirrors.ustc.edu.cn/fedora/releases/"
  "南大|https://mirror.nju.edu.cn/fedora/releases/"
  "阿里云|https://mirrors.aliyun.com/fedora/releases/"
)

# ── 1. 列出可用的 Fedora 版本目录 ────────────────────────────────────────
echo
echo "== 1. 可用版本 =="
for item in "${BASES[@]}"; do
  name="${item%%|*}"; base="${item#*|}"
  printf "  %-8s " "$name"
  vers=$(curl -sSL --max-time 20 "$base" 2>/dev/null \
         | grep -oE '>[0-9]+/' | tr -d '>/' | sort -rn | head -3 | tr '\n' ' ')
  if [ -n "$vers" ]; then
    echo "版本: $vers"
  else
    echo "取不到目录列表"
  fi
done

# ── 2. 对每个源，找最新的 netinst ISO ────────────────────────────────────
echo
echo "== 2. 查找 netinst ISO =="
FOUND_URL=""; FOUND_CK=""; FOUND_SIZE=""; FOUND_SHA=""

for item in "${BASES[@]}"; do
  name="${item%%|*}"; base="${item#*|}"
  echo "  【$name】$base"

  # 取最新版本号
  VER=$(curl -sSL --max-time 20 "$base" 2>/dev/null \
        | grep -oE '>[0-9]+/' | tr -d '>/' | sort -rn | head -1)
  [ -z "$VER" ] && { echo "      取不到版本号"; continue; }

  NETDIR="${base}${VER}/Server/x86_64/iso/"
  echo "      版本 $VER，目录 $NETDIR"

  listing=$(curl -sSL --max-time 25 "$NETDIR" 2>/dev/null)
  if [ -z "$listing" ]; then
    echo "      ❌ 目录取不到"
    continue
  fi

  # 找 netinst
  ISOFILE=$(echo "$listing" | grep -oE '[A-Za-z0-9._-]*netinst[A-Za-z0-9._-]*\.iso' | sort -u | head -1)
  if [ -z "$ISOFILE" ]; then
    echo "      目录里没有 netinst，文件名样例："
    echo "$listing" | grep -oE '[A-Za-z0-9._-]*\.iso' | sort -u | head -5 | sed 's/^/         /'
    continue
  fi
  echo "      ✅ 找到: $ISOFILE"

  # 取该目录的 CHECKSUM（Fedora 用 *-CHECKSUM 文件）
  CKFILE=$(echo "$listing" | grep -oE '[A-Za-z0-9._-]*CHECKSUM' | sort -u | head -1)
  echo "      校验文件: ${CKFILE:-（目录里没有 CHECKSUM，需另找）}"

  CKURL="${NETDIR}${CKFILE}"
  if [ -n "$CKFILE" ] && curl -sSL --max-time 25 -o /tmp/fck.txt "$CKURL" 2>/dev/null && [ -s /tmp/fck.txt ]; then
    # Fedora CHECKSUM 格式通常是: SHA256 (Fedora-...iso) = <hash>
    SZ=$(grep -F "$ISOFILE" /tmp/fck.txt | head -1 | grep -oE '[0-9]{9,}' | head -1)
    SH=$(grep -F "$ISOFILE" /tmp/fck.txt | grep -i SHA256 | sed 's/.*= *//' | tr -d ' \r' | head -1)
    echo "      清单内容（前 3 行）:"
    head -3 /tmp/fck.txt | sed 's/^/         /'
    if [ -n "$SH" ]; then
      echo "      SHA256: ${SH:0:40}..."
      FOUND_URL="${NETDIR}${ISOFILE}"
      FOUND_CK="$CKURL"
      FOUND_SHA="$SH"
      break
    fi
  else
    echo "      ⚠️  取不到 CHECKSUM —— 继续找别的源"
  fi
done

if [ -z "$FOUND_URL" ]; then
  echo
  echo "❌ 没找到带可用 CHECKSUM 的 Fedora netinst"
  echo
  echo "  备选方案："
  echo "    · 你手动下载任一 rpm 系发行版 ISO 放到 $DIR"
  echo "      （Rocky/Fedora/Alma/openSUSE 均可，用于验 rpm 装包足够）"
  echo "    · 或告诉我已有的 ISO 路径，我来接手后续步骤"
  exit 1
fi

echo
echo "=================================================================="
echo "选中"
echo "=================================================================="
echo "  URL   : $FOUND_URL"
echo "  CHECK : $FOUND_CK"
echo "  SHA256: ${FOUND_SHA:0:48}..."

# ── 3. 下载 ──────────────────────────────────────────────────────────────
echo
echo "== 3. 下载 =="
ISO="$DIR/$(basename "$FOUND_URL")"
rm -f "$ISO"
echo "  目标: $ISO"
echo
curl -L --retry 3 --retry-delay 3 --connect-timeout 20 --max-time 1800 \
     -o "$ISO" "$FOUND_URL" \
     -w "  HTTP=%{http_code} 实收=%{size_download} 用时=%{time_total}s\n" -sS 2>&1 | tail -2
RC=$?
echo "  curl 退出码: $RC"
[ $RC -eq 0 ] || { echo "  ❌ 下载失败"; exit 1; }

# ── 4. 校验 ──────────────────────────────────────────────────────────────
echo
echo "== 4. 校验 =="
SIZE=$(stat -c%s "$ISO")
echo "  大小: $SIZE 字节 ($(awk -v s="$SIZE" 'BEGIN{printf "%.2f GB", s/1073741824}'))"
echo "  类型: $(file -b "$ISO" | cut -c1-60)"
echo "  卷标: $(isoinfo -d -i "$ISO" 2>/dev/null | grep -i 'Volume id' | sed 's/.*: *//' | tr -d '\r' || echo 取不到)"

if grep -qE '^SHA256' /tmp/fck.txt 2>/dev/null; then
  CHKSUM=$(grep -F "$(basename "$FOUND_URL")" /tmp/fck.txt | grep -i openssl | head -1)
fi

echo "  计算 SHA256..."
GOT=$(sha256sum "$ISO" | awk '{print $1}')
echo "  本地: ${GOT:0:48}..."
if [ "$GOT" = "$FOUND_SHA" ]; then
  echo "  ✅ SHA256 与官方一致 —— ISO 完整可信，可用于创建虚拟机"
else
  echo "  ❌ SHA256 不一致"
  echo "     官方: ${FOUND_SHA:0:48}..."
  exit 1
fi

echo
echo "=================================================================="
echo "✅ 完成: $ISO"
echo "=================================================================="
