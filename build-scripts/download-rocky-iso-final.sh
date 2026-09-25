#!/usr/bin/env bash
# download-rocky-iso-final.sh —— 下载 Rocky ISO 并**等它完整结束**再校验。
#
# ## 前几次失败的真实原因（值得记下来）
#
# 1. 第一次：脚本只判断"文件是否存在"就跳过，**不校验** —— 脚本 bug。
# 2. 第二次：我用了 `curl -C -` 续传，得到的文件比官方大，判定为"被代理改写"。
#    **这个判断是错的** —— 真实原因是续传的 Range 请求没处理好，见下。
# 3. 第三次：下载到 1.9GB 时我**在中途 kill 了作业**，然后看到文件"超过官方大小"
#    就以为响应被改写。**实际是文件还在增长，根本没下完。**
#    我把"未完成的下载"误判成了"损坏的下载"。
# 4. 诊断脚本本身也有错：探测时用了 `-I` 和 Range 却**漏了 `-L`**，
#    结果拿到的是 215 字节的 302 重定向页，而不是文件内容。
#    阿里云镜像确实返回 302 跳转到 iso-osm.mirrors.aliyuncs.com。
#
# ## 结论
#   必须：跟随重定向（-L）→ 等 curl **自然退出** → 再比对官方 SHA256。
#   不能在下载过程中根据文件大小的中间值下判断。

set -uo pipefail

DEST_DIR="/mnt/f/rpm-vm"
ISO_NAME="Rocky-9-latest-x86_64-minimal.iso"
DEST="$DEST_DIR/$ISO_NAME"
CHECKSUM_FILE="$DEST_DIR/CHECKSUM.official"

URL_ALIYUN="https://mirrors.aliyun.com/rockylinux/9/isos/x86_64/$ISO_NAME"

echo "=================================================================="
echo "Rocky Linux ISO 下载（含完整校验）"
echo "=================================================================="

mkdir -p "$DEST_DIR"

# ── 0. 官方校验值 ────────────────────────────────────────────────────────
echo
echo "== 0. 取官方校验清单 =="
if curl -sSL --max-time 30 -o "$CHECKSUM_FILE" \
     "https://mirrors.aliyun.com/rockylinux/9/isos/x86_64/CHECKSUM" 2>/dev/null \
   && [ -s "$CHECKSUM_FILE" ]; then
  EXPECT_SIZE=$(grep -F "$ISO_NAME:" "$CHECKSUM_FILE" | grep -oE '[0-9]{6,}' | head -1)
  EXPECT_SHA=$(grep -F "$ISO_NAME" "$CHECKSUM_FILE" | grep -i SHA256 | sed 's/.*= *//' | tr -d ' \r' | head -1)
  echo "  官方大小  : $EXPECT_SIZE 字节 ($(awk -v s="$EXPECT_SIZE" 'BEGIN{printf "%.2f GB", s/1073741824}'))"
  echo "  官方 SHA256: ${EXPECT_SHA:0:40}..."
else
  echo "  ❌ 取不到官方清单，无法校验。停止。"
  exit 1
fi

# ── 1. 解析真实下载地址（跟随 302）──────────────────────────────────────
echo
echo "== 1. 解析真实地址（阿里云会 302 跳转）=="
echo "  原始: $URL_ALIYUN"
# ⚠️ 必须带 -L：不带 -L 的 -I 只会拿到 302 响应本身（215 字节的 HTML）
FINAL=$(curl -sSL -o /dev/null --max-time 30 -w '%{url_effective}' -I "$URL_ALIYUN" 2>/dev/null || echo "")
if [ -n "$FINAL" ] && [ "$FINAL" != "$URL_ALIYUN" ]; then
  echo "  跳转到: $FINAL"
else
  FINAL="$URL_ALIYUN"
  echo "  （无跳转）"
fi

# 用真实地址探测长度（这次带 -L）
echo
echo "  用真实地址探测 Content-Length（带 -L）："
LEN=$(curl -sSL -o /dev/null --max-time 30 -w '%{size_download} %{content_type}' -r 0-1023 "$FINAL" 2>/dev/null || echo "?")
echo "    取 1KB 测试: $LEN"
CT=$(curl -sSLI --max-time 30 "$FINAL" 2>/dev/null | grep -i '^content-length' | tail -1 | tr -d '\r')
echo "    $CT"

# ── 2. 下载（等它自然结束）──────────────────────────────────────────────
echo
echo "== 2. 下载（-L 跟随重定向，等 curl 自然退出）=="
rm -f "$DEST"
echo "  目标大小: $EXPECT_SIZE 字节"
echo "  开始: $(date '+%H:%M:%S')"
echo

curl -L --retry 3 --retry-delay 3 --connect-timeout 20 \
     --max-time 1800 \
     -o "$DEST" "$URL_ALIYUN" \
     -w "  完成: HTTP=%{http_code} 实收=%{size_download} 字节 用时=%{time_total}s 平均=%{speed_download} B/s\n" \
     -sS 2>&1 | tail -3

RC=$?
echo "  curl 退出码: $RC  （0=正常结束）"
echo "  结束: $(date '+%H:%M:%S')"

if [ $RC -ne 0 ]; then
  echo "  ❌ curl 未正常结束，放弃校验"
  exit 1
fi

# ── 3. 校验（此时文件是完整的）──────────────────────────────────────────
echo
echo "== 3. 校验 =="
SIZE=$(stat -c%s "$DEST" 2>/dev/null || echo 0)
echo "  实际大小: $SIZE 字节 ($(awk -v s="$SIZE" 'BEGIN{printf "%.2f GB", s/1073741824}'))"
echo "  官方大小: $EXPECT_SIZE 字节"

if [ "$SIZE" != "$EXPECT_SIZE" ]; then
  echo "  ❌ 大小不符，差 $((SIZE - EXPECT_SIZE)) 字节"
  exit 1
fi
echo "  ✅ 大小一致"

# 确认是 ISO 而不是 HTML 错误页
FT=$(file -b "$DEST" 2>/dev/null | cut -c1-60)
echo "  文件类型: $FT"
if echo "$FT" | grep -qi html; then
  echo "  ❌ 是 HTML，说明拿到的是错误页而非 ISO"
  exit 1
fi

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
echo "✅ 完成，可用于创建虚拟机"
du -h "$DEST"
