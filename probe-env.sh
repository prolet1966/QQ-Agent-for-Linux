#!/usr/bin/env bash
echo '=== 发行版 ==='
grep -E 'PRETTY|VERSION_ID' /etc/os-release
echo
echo '=== 打包工具 ==='
for c in dpkg-deb fakeroot rpmbuild rpm fpm alien mksquashfs appimagetool xvfb-run zsync dch patchelf file ar cpio; do
  p=$(command -v "$c" 2>/dev/null)
  if [ -n "$p" ]; then echo "OK   $c -> $p"; else echo "NO   $c"; fi
done
echo
echo '=== node ==='
node -v 2>&1
npm -v 2>&1
echo
echo '=== 网络 ==='
timeout 10 curl -sSI https://registry.npmjs.org/ 2>&1 | head -1
timeout 10 curl -sSI https://github.com 2>&1 | head -1
timeout 10 curl -sSI https://github.com/electron/electron/releases 2>&1 | head -1
echo
echo '=== sudo ==='
if sudo -n true 2>/dev/null; then echo 'sudo NOPASSWD OK'; else echo 'sudo 需要密码或不可用'; fi
echo
echo '=== 架构 ==='
uname -m
echo
echo '=== 显示/库 ==='
echo "DISPLAY=${DISPLAY:-<empty>}"
for l in libgtk-3-0 libnss3 libasound2; do :; done
ldconfig -p 2>/dev/null | grep -cE 'libgtk-3|libnss3|libasound' || true
