#!/usr/bin/env bash
# check-deps.sh —— 检查 electron-builder 产出 deb / rpm / AppImage 所需的工具
#
# 为什么单独查：electron-builder 缺依赖时不一定在早期报错，
# 常见表现是构建跑到一半才在某个 target 上失败，浪费十几分钟。
# 提前查清比事后排查便宜。
#
# 各 target 的实际依赖（依据 electron-builder 文档与实测）：
#   deb      : fakeroot（生成 deb 的假 root 环境）、dpkg
#   rpm      : rpm / rpmbuild
#   AppImage : 需要下载 appimage 工具链（自动），以及 zsync 相关工具

set -uo pipefail

echo "===== 系统 ====="
echo "  发行版 : $(. /etc/os-release && echo "$PRETTY_NAME")"
echo "  架构   : $(uname -m) / dpkg=$(dpkg --print-architecture)"

echo
echo "===== 打包工具 ====="
MISSING=()
for c in fakeroot dpkg dpkg-deb dpkg-query rpm rpmbuild rpm2cpio ar tar bsdtar xz zstd file; do
  if command -v "$c" >/dev/null 2>&1; then
    printf "  %-12s ✅ %s\n" "$c" "$(command -v "$c")"
  else
    printf "  %-12s ❌ 缺失\n" "$c"
    MISSING+=("$c")
  fi
done

echo
echo "===== 缺失项处理建议 ====="
if [ ${#MISSING[@]} -eq 0 ]; then
  echo "  无缺失，可以构建三种包"
else
  echo "  缺失: ${MISSING[*]}"
  # 按包名给出 apt 安装建议（命令名与包名不一定一致）
  declare -A PKGMAP=(
    [fakeroot]=fakeroot
    [rpmbuild]=rpm
    [rpm]=rpm
    [rpm2cpio]=rpm2cpio
    [bsdtar]=libarchive-tools
    [zstd]=zstd
    [xz]=xz-utils
    [file]=file
  )
  APT=()
  for m in "${MISSING[@]}"; do
    p="${PKGMAP[$m]:-}"
    [ -n "$p" ] && APT+=("$p")
  done
  if [ ${#APT[@]} -gt 0 ]; then
    # 去重
    mapfile -t APT < <(printf '%s\n' "${APT[@]}" | awk '!seen[$0]++')
    echo
    echo "  建议执行："
    echo "    sudo apt-get install -y ${APT[*]}"
  fi
fi

echo
echo "===== 磁盘与内存 ====="
df -h /home | tail -1 | awk '{printf "  可用磁盘: %s\n", $4}'
free -m | awk 'NR==2{printf "  内存: 总 %sMB / 可用 %sMB\n", $2, $7}'

echo
echo "===== Electron 镜像可达性（构建要下二进制）====="
for u in \
  "https://npmmirror.com/mirrors/electron/" \
  "https://npmmirror.com/mirrors/electron-builder-binaries/" ; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$u" 2>/dev/null || echo ERR)
  printf "  %-58s HTTP=%s\n" "$u" "$code"
done
