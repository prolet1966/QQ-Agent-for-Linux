#!/usr/bin/env bash
# diagnose-iso-download.sh —— 排查"下载体积远超官方大小"的原因。
#
# 现象：官方 ISO 是 1,480,048,640 字节，但经 curl 下载得到 1.84GB / 2.31GB，
# 而且还在持续增长 —— 说明响应的**字节流被改写或夹带了额外内容**。
#
# 要排查的可能：
#   1. 代理：WSL 里设了 http_proxy/https_proxy 指向宿主的 Clash（127.0.0.1:7897），
#      代理若对镜像做了缓存或注入，会改变响应体
#   2. 镜像本身的问题（可用 HEAD 请求对比 Content-Length）
#   3. HTTP 重定向到别处（比如被劫持到广告页或错误页）
#
# 本脚本只做诊断，不下载整包。

set -uo pipefail

URL="https://mirrors.aliyun.com/rockylinux/9/isos/x86_64/Rocky-9-latest-x86_64-minimal.iso"
EXPECT=1480048640

echo "==================================================================" 
echo "1. 代理环境变量"
echo "=================================================================="
for v in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY; do
  val="${!v:-（未设置）}"
  printf "  %-14s %s\n" "$v" "$val"
done

echo
echo "=================================================================="
echo "2. curl 默认是否走代理"
echo "=================================================================="
# curl 会读环境变量；这里用一个 HEAD 请求看它实际连到哪
echo "  --- 走默认设置 ---"
curl -sS -o /dev/null -D - --max-time 20 -I "$URL" 2>&1 \
  | grep -iE "^HTTP|^location|^content-length|^server|^via|^x-cache" | sed 's/^/    /' || echo "    失败"

echo
echo "  --- 强制不走代理（--noproxy '*'）---"
curl -sS -o /dev/null -D - --max-time 20 --noproxy '*' -I "$URL" 2>&1 \
  | grep -iE "^HTTP|^location|^content-length|^server|^via|^x-cache" | sed 's/^/    /' || echo "    失败"

echo
echo "=================================================================="
echo "3. 实际下载前 1MB，看内容是否像 ISO"
echo "=================================================================="
TMP=/tmp/iso-probe.bin
for mode in "默认" "不走代理"; do
  echo "  --- $mode ---"
  if [ "$mode" = "不走代理" ]; then
    NP=(--noproxy '*')
  else
    NP=()
  fi
  curl -sS "${NP[@]}" -r 0-1048575 --max-time 30 -o "$TMP" "$URL" 2>&1 | head -2
  got=$(stat -c%s "$TMP" 2>/dev/null || echo 0)
  echo "    取到: $got 字节"
  echo "    文件类型: $(file -b "$TMP" 2>/dev/null | cut -c1-70)"
  echo "    前 8 字节 (hex): $(xxd -l 8 -p "$TMP" 2>/dev/null || od -A n -t x1 -N 8 "$TMP" | tr -d ' ')"
  echo "    是否含 '<html' 或 'ERROR': $(grep -aciE '<html|error|forbidden' "$TMP" 2>/dev/null || echo 0)"
done
rm -f "$TMP"

echo
echo "=================================================================="
echo "4. 用 Range 请求核对 Content-Range 是否与实际返回一致"
echo "=================================================================="
echo "  请求 bytes=0-99（应返回 100 字节）"
resp=$(curl -sS --noproxy '*' -r 0-99 --max-time 20 -D - -o /tmp/r.bin "$URL" 2>&1)
echo "$resp" | grep -iE "^HTTP|^content-range|^content-length" | sed 's/^/    /'
echo "    实收字节: $(stat -c%s /tmp/r.bin 2>/dev/null || echo 0)"
rm -f /tmp/r.bin

echo
echo "=================================================================="
echo "5. 换一个镜像做对比"
echo "=================================================================="
for u in \
  "https://download.rockylinux.org/pub/rocky/9/isos/x86_64/Rocky-9-latest-x86_64-minimal.iso" \
  "https://mirrors.tuna.tsinghua.edu.cn/rocky/9/isos/x86_64/Rocky-9-latest-x86_64-minimal.iso" \
  ; do
  echo "  $u"
  curl -sS --noproxy '*' -o /dev/null --max-time 20 -I "$u" 2>&1 \
    | grep -iE "^HTTP|^content-length" | sed 's/^/      /' || echo "      失败"
done

echo
echo "=================================================================="
echo "结论提示"
echo "=================================================================="
echo "  · 若「走代理」与「不走代理」的 content-length 不同 → 代理改写了响应"
echo "  · 若前 1MB 不像 ISO 或含 html → 被劫持/返回错误页"
echo "  · 若 Content-Range 与实际字节数不符 → 服务端或中间层有 bug"
echo "  · 官方期望大小: $EXPECT 字节"
