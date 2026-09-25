#!/usr/bin/env bash
# probe-proxy.sh —— 找出能从 WSL 访问 Windows 宿主 Clash 的地址。
#
# 背景：WSL 里下载 GitHub release 资源（会 302 到 objects.githubusercontent.com）
# 实测 90 秒零字节并 SSL 断流，是典型被墙。需要走宿主的 Clash 代理。
#
# WSL2 有两种网络模式，判断地址的方式不同：
#   NAT 模式     ：localhost 指 WSL 自己，要用宿主在 vEthernet(WSL) 上的 IP
#   mirrored 模式：localhost 直接就是 Windows，WSL 自己就是宿主
# 所以这里把所有候选地址都试一遍，谁通用谁。

set -uo pipefail

PORT="${CLASH_PORT:-7897}"
GATEWAYS=$(ip route | grep '^default' | awk '{print $3}')

echo "== 候选宿主地址 =="
echo "  默认网关: $(echo "$GATEWAYS" | tr '\n' ' ')"
echo "  resolv nameserver: $(grep nameserver /etc/resolv.conf | awk '{print $2}' | head -1)"
echo "  WSL 自身 IP: $(hostname -I 2>/dev/null)"

CANDS=()
CANDS+=("127.0.0.1")
CANDS+=("localhost")
while IFS= read -r gw; do [ -n "$gw" ] && CANDS+=("$gw"); done <<< "$GATEWAYS"
NS=$(grep nameserver /etc/resolv.conf | awk '{print $2}' | head -1)
[ -n "$NS" ] && CANDS+=("$NS")

# 去重
mapfile -t CANDS < <(printf '%s\n' "${CANDS[@]}" | awk '!seen[$0]++')

echo
echo "== 逐个测试 $PORT 端口连通性 =="
WORKING=""
for addr in "${CANDS[@]}"; do
  # bash 的 /dev/tcp 做纯 TCP 探测，不涉及 TLS，最干净
  if timeout 3 bash -c "exec 3<>/dev/tcp/$addr/$PORT" 2>/dev/null; then
    echo "  ✅ $addr:$PORT  TCP 可连"
    [ -z "$WORKING" ] && WORKING="$addr"
  else
    echo "  ❌ $addr:$PORT  连不上"
  fi
done

if [ -z "$WORKING" ]; then
  echo
  echo "== 结论：没有可用的宿主代理地址 =="
  echo "  可能原因："
  echo "    1. Clash 的「允许局域网连接 / Allow LAN」未开启 —— 必须开，否则只监听 127.0.0.1"
  echo "    2. Clash 的 mixed-port 不是 $PORT"
  echo "    3. Windows 防火墙拦了 vEthernet(WSL) 的入站"
  exit 2
fi

echo
echo "== 用 $WORKING:$PORT 实测 HTTPS 能否通到 GitHub 资源域 =="
# 关键：release 下载会 302 到 objects.githubusercontent.com，
# 只测 github.com 不够，必须测这个真正会断流的域名。
for u in "https://github.com" "https://objects.githubusercontent.com"; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
         -x "http://$WORKING:$PORT" "$u" 2>/dev/null || echo "ERR")
  printf "  %-45s HTTP=%s\n" "$u" "$code"
done

echo
echo "== 可用代理（写进环境变量即可）=="
echo "  export https_proxy=http://$WORKING:$PORT"
echo "  export http_proxy=http://$WORKING:$PORT"
echo "PROXY_ADDR=$WORKING" > /tmp/proxy-addr.env
echo "  已写入 /tmp/proxy-addr.env"
