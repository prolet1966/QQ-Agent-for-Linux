#!/usr/bin/env bash
# test-direct-vs-proxy.sh —— 对比「直连」与「走代理」下载同一文件的结果。
#
# ## 为什么怀疑代理
#
# 实测事实：
#   · 官方 CHECKSUM 声明 Rocky-9-latest-x86_64-minimal.iso = 1,480,048,640 字节
#   · 四个镜像（官方/中科大/南大/阿里云）的 CHECKSUM 完全一致，SHA256 都是 d338032c...
#   · 但实际下载得到的是 2,755,067,904 / 2,752,642,560 字节，两次还不同
#   · 本地文件卷标是 Rocky-9-8-x86_64-dvd，而官方 DVD 其实是 15,194,259,456 字节
#     （既不是 minimal 的 1.48GB，也不是 DVD 的 15.19GB）
#   · `ss` 显示 curl 的连接是 127.0.0.1:7897 —— 即本机的 Clash 代理
#
# 尺寸对不上、且每次不同 → 典型的「传输过程被中间层改写」。
# 本脚本用同一 URL、同样只取 32MB，分别走代理与不走代理，看 Content-Length
# 与实收字节数是否一致。只取片段，不下载整包。

set -uo pipefail

URL="https://download.rockylinux.org/pub/rocky/9/isos/x86_64/Rocky-9-latest-x86_64-minimal.iso"
EXPECT=1480048640
CHUNK=33554432   # 32MB

echo "=================================================================="
echo "1. 代理环境"
echo "=================================================================="
env | grep -iE 'proxy' || echo "  （无 proxy 环境变量）"

echo
echo "=================================================================="
echo "2. 同一 URL 的 HEAD（分别直连 / 走代理）"
echo "=================================================================="
for mode in "直连" "走代理"; do
  echo "  --- $mode ---"
  if [ "$mode" = "直连" ]; then
    OPTS=(--noproxy '*')
    # 同时清掉可能存在的环境变量
    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY 2>/dev/null || true
  else
    OPTS=(-x http://127.0.0.1:7897)
  fi
  curl -sSL "${OPTS[@]}" -I --max-time 30 "$URL" 2>&1 \
    | grep -iE '^HTTP|^content-length|^content-type|^server|^location' | sed 's/^/      /' \
    || echo "      失败"
done

echo
echo "=================================================================="
echo "3. 各取 ${CHUNK} 字节，比较实收大小"
echo "=================================================================="
TMP=/tmp/dltest.bin
for mode in "直连" "走代理"; do
  echo "  --- $mode ---"
  if [ "$mode" = "直连" ]; then
    OPTS=(--noproxy '*')
  else
    OPTS=(-x http://127.0.0.1:7897)
  fi
  rm -f "$TMP"
  curl -sSL "${OPTS[@]}" -r 0-$((CHUNK-1)) --max-time 90 \
       -o "$TMP" "$URL" 2>&1 | head -2
  got=$(stat -c%s "$TMP" 2>/dev/null || echo 0)
  printf "      实收: %s 字节 (期望 %s)\n" "$got" "$CHUNK"
  if [ "$got" = "$CHUNK" ]; then
    echo "      ✅ 数量正确"
  else
    echo "      ❌ 数量不对（差 $((got - CHUNK))）"
  fi
  echo "      类型: $(file -b "$TMP" 2>/dev/null | cut -c1-50)"
done
rm -f "$TMP"

echo
echo "=================================================================="
echo "4. 探测真实 Content-Length（curl -L 跟随跳转后的最终响应）"
echo "=================================================================="
for mode in "直连" "走代理"; do
  echo "  --- $mode ---"
  if [ "$mode" = "直连" ]; then
    OPTS=(--noproxy '*')
  else
    OPTS=(-x http://127.0.0.1:7897)
  fi
  # 用 -r 0-0 拿单字节，同时用 -w 输出响应头信息
  out=$(curl -sSL "${OPTS[@]}" -r 0-0 --max-time 40 -o /dev/null \
        -w "http=%{http_code} size_download=%{size_download} content_length_download=%{size_download} url=%{url_effective}" \
        "$URL" 2>&1)
  echo "      $out"
  # 再单独取 Content-Length
  cl=$(curl -sSL "${OPTS[@]}" -r 0-0 -D - --max-time 40 -o /dev/null "$URL" 2>/dev/null \
       | grep -i '^content-range' | tail -1 | tr -d '\r')
  echo "      $cl"
  [ -n "$cl" ] && echo "      → 由此可知总大小"
done

echo
echo "=================================================================="
echo "期望的总大小: $EXPECT 字节 ($(awk -v s="$EXPECT" 'BEGIN{printf "%.2f GB", s/1073741824}'))"
echo "=================================================================="
echo
echo "判读："
echo "  · 若「直连」的 Content-Range 显示总大小 = $EXPECT，而「走代理」显示别的值"
echo "    → 代理改写了响应，应关闭代理或给镜像加 no_proxy"
echo "  · 若两者都显示 2.7GB 左右 → 服务器端内容就是那么大，官方 CHECKSUM 未同步"
echo "    （某些滚动发布确实会这样，此时应以实际下载+多重校验为准）"
