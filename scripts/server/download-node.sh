#!/usr/bin/env bash
set -Eeuo pipefail
destination=${1:-/opt/qq-agent-server/runtime}
[[ $EUID -eq 0 ]] || { echo '请以 root 运行 Node 安装器' >&2; exit 2; }
case "$(uname -m)" in
  x86_64) arch=x64; expected=ff04bc7c3ed7699ceb708dbaaf3580d899ff8bf67f17114f979e83aa74fc5a49;;
  aarch64) arch=arm64; expected=a5bb879af2fe70e7b5dc5e0bbadecba88e87f45bd8e62c0c57b5c815a4cbbaa6;;
  *) echo '仅支持 Linux x64/arm64 官方运行时' >&2; exit 2;;
esac
destination=$(readlink -m -- "$destination")
[[ "$destination" =~ ^/[a-zA-Z0-9_./-]+$ && "$destination" != / ]] || { echo '无效的运行时路径' >&2; exit 2; }
install -d -o root -g root -m 0755 "$destination"
runtime="$destination/node-v22.17.1-linux-$arch"
if [[ -x "$runtime/bin/node" ]]; then
  [[ "$("$runtime/bin/node" --version)" == v22.17.1 ]] || { echo '已存在的运行时版本不符' >&2; exit 1; }
  echo "$runtime/bin/node"; exit 0
fi
download=$(mktemp "$destination/.node-download.XXXXXX")
trap 'rm -f -- "$download"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 --max-time 300 --output "$download" "https://nodejs.org/dist/v22.17.1/node-v22.17.1-linux-$arch.tar.xz"
printf '%s  %s\n' "$expected" "$download" | sha256sum --check --status || { echo 'Node 运行时 SHA256 校验失败' >&2; exit 1; }
[[ ! -e "$runtime" ]] || { echo '目标运行时目录已存在但不可执行，拒绝覆盖' >&2; exit 1; }
tar -xJf "$download" -C "$destination" --no-same-owner
"$runtime/bin/node" --version
echo "$runtime/bin/node"
