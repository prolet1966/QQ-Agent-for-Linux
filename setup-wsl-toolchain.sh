#!/usr/bin/env bash
# 安装 WSL 构建工具链：rpm(含 rpmbuild)、cpio、nodejs/npm
set -u
export DEBIAN_FRONTEND=noninteractive

echo "===== apt-get update ====="
sudo apt-get update -qq 2>&1 | tail -3

echo
echo "===== 安装 rpm cpio nodejs npm ====="
sudo apt-get install -y -qq rpm cpio nodejs npm 2>&1 | tail -8
echo "apt exit=$?"

echo
echo "===== 工具就位情况 ====="
for c in rpmbuild rpm cpio node npm dpkg-deb fakeroot mksquashfs xvfb-run; do
  p=$(command -v "$c" 2>/dev/null)
  if [ -n "$p" ]; then
    printf 'OK   %-12s %s\n' "$c" "$p"
  else
    printf 'NO   %-12s\n' "$c"
  fi
done

echo
echo "===== 版本 ====="
rpmbuild --version 2>&1 | head -1
node -v 2>&1
npm -v 2>&1
