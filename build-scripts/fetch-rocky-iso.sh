#!/usr/bin/env bash
# fetch-rocky-iso.sh —— 下载并**校验** Rocky Linux minimal ISO。
#
# ## 为什么强调"校验"
#
# 这个脚本的第一版有严重 bug：只判断「文件是否存在」就跳过下载，**完全不校验**。
# 实测后果：续传中断后留下一个 1.84GB 的坏文件（官方只有 1.48GB），
# 脚本却报「已存在，跳过」。若照此装配 VM，会拿一个损坏的 ISO 去安装，
# 然后花大量时间排查"为什么装不上系统"——而问题根本不在安装过程。
#
# 现在：一切以**官方 CHECKSUM 文件**为准。存在也要校验，不通过就删掉重下。
#
# ## 不用断点续传
#
# 第一版用了 `curl -C -`。它产出的 1.84GB 坏文件比官方还大，
# 怀疑是本机走了 Clash 代理（127.0.0.1:7897），代理对「重定向 + Range 请求」
# 的处理不可靠，拼接出了错误字节流。
# 有了 SHA256 校验，本来也不该依赖续传来"省事" —— 下载必须能被验证。

set -uo pipefail

DEST_DIR="/mnt/f/rpm-vm"
ISO_NAME="Rocky-9-latest-x86_64-minimal.iso"
DEST="$DEST_DIR/$ISO_NAME"
CHECKSUM_FILE="$DEST_DIR/CHECKSUM.official"

# 镜像目录（结尾带 /，后面拼文件名与 CHECKSUM）
MIRROR_DIRS=(
  "https://mirrors.aliyun.com/rockylinux/9/isos/x86_64/"
  "https://download.rockylinux.org/pub/rocky/9/isos/x86_64/"
)

mkdir -p "$DEST_DIR"

# ── 0. 取官方校验清单 ────────────────────────────────────────────────────
# CHECKSUM 文件里的格式实测为：
#   # Rocky-9-latest-x86_64-minimal.iso: 1480048640 bytes
#   SHA256 (Rocky-9-latest-x86_64-minimal.iso) = d338032c...
echo "=== 0. 取官方校验清单 ==="
EXPECT_SIZE=""
EXPECT_SHA=""
for d in "${MIRROR_DIRS[@]}"; do
  echo "  尝试: ${d}CHECKSUM"
  if curl -sS --max-time 30 -o "$CHECKSUM_FILE" "${d}CHECKSUM" 2>/dev/null && [ -s "$CHECKSUM_FILE" ]; then
    # 大小：形如 "<name>: 1480048640 bytes"
    EXPECT_SIZE=$(grep -F "$ISO_NAME:" "$CHECKSUM_FILE" | grep -oE '[0-9]{6,}' | head -1)
    # SHA256：形如 "SHA256 (<name>) = <hash>"
    EXPECT_SHA=$(grep -F "$ISO_NAME" "$CHECKSUM_FILE" | grep -i 'SHA256' | sed 's/.*= *//' | tr -d ' \r' | head -1)
    echo "    ✅ 清单已取到 ($(stat -c%s "$CHECKSUM_FILE") 字节)"
    break
  fi
  echo "    ❌ 失败"
done

if [ -z "$EXPECT_SHA" ]; then
  echo "  ⚠️  没能取到官方 SHA256 —— 本次无法做完整性校验"
  echo "     不继续下载（无校验的 ISO 风险太高）。请检查网络或镜像可用性。"
  exit 1
fi

echo
echo "  官方大小  : ${EXPECT_SIZE:-未知} 字节"
if [ -n "$EXPECT_SIZE" ]; then
  echo "              $(awk -v s="$EXPECT_SIZE" 'BEGIN{printf "%.2f GB", s/1073741824}')"
fi
echo "  官方 SHA256: ${EXPECT_SHA:0:40}..."

# ── 1. 已存在则校验，通过才跳过 ──────────────────────────────────────────
if [ -f "$DEST" ]; then
  CUR=$(stat -c%s "$DEST")
  echo
  echo "=== 1. 本地已有文件，校验完整性 ==="
  echo "  本地大小: $CUR 字节 ($(awk -v s="$CUR" 'BEGIN{printf "%.2f GB", s/1073741824}'))"

  if [ -n "$EXPECT_SIZE" ] && [ "$CUR" != "$EXPECT_SIZE" ]; then
    echo "  ❌ 大小不符（官方 $EXPECT_SIZE）"
    echo "     → 文件不可用，删除后重下"
    rm -f "$DEST"
  else
    echo "  大小一致，继续核对 SHA256（约 30-60 秒）..."
    GOT=$(sha256sum "$DEST" | awk '{print $1}')
    if [ "$GOT" = "$EXPECT_SHA" ]; then
      echo "  ✅ SHA256 一致 —— ISO 完整，无需重新下载"
      du -h "$DEST"
      exit 0
    fi
    echo "  ❌ SHA256 不一致"
    echo "     本地: ${GOT:0:40}..."
    echo "     → 文件已损坏，删除后重下"
    rm -f "$DEST"
  fi
fi

# ── 2. 测速选源 ──────────────────────────────────────────────────────────
echo
echo "=== 2. 测速选源（各取 16MB，用 Range 请求）==="
BEST_URL=""; BEST_SPD=0
for d in "${MIRROR_DIRS[@]}"; do
  u="${d}${ISO_NAME}"
  printf "  %-42s " "$(echo "$d" | awk -F/ '{print $3}')"
  out=$(curl -sS -o /dev/null -r 0-16777215 \
        -w "%{http_code} %{speed_download} %{time_total}" \
        --max-time 45 "$u" 2>&1)
  rc=$?
  if [ $rc -eq 0 ]; then
    code=$(echo "$out" | awk '{print $1}')
    spd=$(echo "$out" | awk '{print $2}')
    tt=$(echo "$out" | awk '{print $3}')
    printf "HTTP=%s  %s MB/s  (%ss)\n" "$code" \
           "$(awk -v s="$spd" 'BEGIN{printf "%.2f", s/1048576}')" "$tt"
    if awk -v s="$spd" -v b="$BEST_SPD" 'BEGIN{exit !(s>b)}'; then
      BEST_SPD="$spd"; BEST_URL="$u"
    fi
  else
    echo "失败 (rc=$rc)"
  fi
done

if [ -z "$BEST_URL" ]; then
  echo
  echo "❌ 所有镜像测速失败"
  exit 1
fi

echo
echo "  选中: $BEST_URL"
echo "  速度: $(awk -v s="$BEST_SPD" 'BEGIN{printf "%.2f MB/s", s/1048576}')"

# ── 3. 下载（整包，不用续传）─────────────────────────────────────────────
echo
echo "=== 3. 下载（整包重下，不用断点续传）==="
if [ -n "$EXPECT_SIZE" ]; then
  ETA=$(awk -v s="$BEST_SPD" -v t="$EXPECT_SIZE" 'BEGIN{if(s>0) printf "%.0f", t/s; else print "?"}')
  echo "  预计约 $(awk -v t="$EXPECT_SIZE" 'BEGIN{printf "%.2f GB", t/1073741824}')，按当前速度约需 ${ETA} 秒"
fi
echo

curl -L --retry 3 --retry-delay 3 --connect-timeout 20 \
     -o "$DEST" "$BEST_URL" \
     --progress-bar 2>&1 | tail -1

RC=$?
if [ $RC -ne 0 ]; then
  echo "❌ 下载失败 (rc=$RC)"
  exit 1
fi

# ── 4. 下载后校验 ────────────────────────────────────────────────────────
echo
echo "=== 4. 下载后校验 ==="
SIZE=$(stat -c%s "$DEST" 2>/dev/null || echo 0)
echo "  文件大小: $SIZE 字节 ($(awk -v s="$SIZE" 'BEGIN{printf "%.2f GB", s/1073741824}'))"

if [ -n "$EXPECT_SIZE" ] && [ "$SIZE" != "$EXPECT_SIZE" ]; then
  echo "  ❌ 与官方大小不符（官方 $EXPECT_SIZE）"
  echo "     常见原因：经过代理（如 Clash）时响应体被改写"
  echo "     建议：临时关闭代理后重试，或用别的镜像"
  exit 1
fi
echo "  ✅ 大小与官方一致"

echo "  计算 SHA256..."
GOT=$(sha256sum "$DEST" | awk '{print $1}')
if [ "$GOT" = "$EXPECT_SHA" ]; then
  echo "  ✅ SHA256 与官方完全一致 —— ISO 完整可信"
else
  echo "  ❌ SHA256 不一致！"
  echo "     本地: ${GOT:0:40}..."
  echo "     官方: ${EXPECT_SHA:0:40}..."
  exit 1
fi

echo
echo "=== 完成 ==="
du -h "$DEST"
