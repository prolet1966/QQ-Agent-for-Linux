#!/usr/bin/env bash
# inspect-packages.sh —— 检查三个安装包的元数据与内容是否符合目标要求。
#
# 目标里明确要求的项，逐条核对：
#   · x86_64 架构
#   · 包含官方 SnowLuma Linux 协议端
#   · 包含 Linux 版 Electron 运行时
#   · 数据目录遵循 XDG（这一点在代码里，靠 installer 脚本行为体现）
#   · deb 依赖声明正确
#
# 有些问题只有拆开包才看得到，比如「snowluma 是否真的被打进去了」、
# 「原生 .node 是不是 x86-64」——这些不检查，装完才发现就晚了。

set -uo pipefail

DIST="$HOME/qq-agent-linux/app/dist"

echo "===== 产物清单 ====="
ls -la "$DIST"/*.deb "$DIST"/*.rpm "$DIST"/*.AppImage 2>/dev/null | awk '{printf "  %-42s %10s  %s %s\n", $9, $5, $6, $7}'
echo
for f in "$DIST"/*.deb "$DIST"/*.rpm "$DIST"/*.AppImage; do
  [ -f "$f" ] || continue
  printf "  %-42s %s\n" "$(basename "$f")" "$(file -b "$f" | cut -c1-70)"
done

echo
echo "===== .deb 元数据 ====="
DEB="$DIST/qq-agent-v0.4.4-amd64.deb"
if [ -f "$DEB" ]; then
  echo "--- control ---"
  dpkg-deb -I "$DEB" 2>/dev/null | sed 's/^/  /'
  echo "--- 包内文件数 ---"
  echo "  共 $(dpkg-deb -c "$DEB" 2>/dev/null | wc -l) 个条目"
  echo "--- 关键路径（应为 /opt 下）---"
  dpkg-deb -c "$DEB" 2>/dev/null | awk '{print $NF}' | grep -E "\.desktop$|/opt/.*(qq-agent|QQ Agent)$|/opt/.*resources/app\.asar$" | sed 's/^/  /' | head -10
  echo "--- SnowLuma 是否打进包（关键：asarUnpack 生效与否）---"
  dpkg-deb -c "$DEB" 2>/dev/null | awk '{print $NF}' | grep -i "snowluma" | head -8 | sed 's/^/  /'
  echo "  含 snowluma 条目数: $(dpkg-deb -c "$DEB" 2>/dev/null | awk '{print $NF}' | grep -ic snowluma)"
else
  echo "  .deb 不存在"
fi

echo
echo "===== .rpm 元数据 ====="
RPM="$DIST/qq-agent-v0.4.4-x86_64.rpm"
if [ -f "$RPM" ]; then
  rpm -qip "$RPM" 2>/dev/null | sed 's/^/  /'
  echo "--- 依赖 ---"
  rpm -qpR "$RPM" 2>/dev/null | head -20 | sed 's/^/  /'
  echo "--- 包内条目数 ---"
  echo "  共 $(rpm -qpl "$RPM" 2>/dev/null | wc -l) 个"
  echo "--- SnowLuma ---"
  echo "  含 snowluma 条目数: $(rpm -qpl "$RPM" 2>/dev/null | grep -ic snowluma)"
else
  echo "  .rpm 不存在"
fi

echo
echo "===== AppImage ====="
AI="$DIST/qq-agent-v0.4.4-x86_64.AppImage"
if [ -f "$AI" ]; then
  echo "  大小   : $(du -h "$AI" | cut -f1)"
  echo "  可执行 : $(test -x "$AI" && echo 是 || echo 否)"
  echo "  版本   : $("$AI" --appimage-version 2>&1 | head -1)"
  echo "  架构   : $(file -b "$AI" | grep -o 'x86-64' | head -1)"
else
  echo "  AppImage 不存在"
fi

echo
echo "===== 打包内容抽查（linux-unpacked）====="
LU="$DIST/linux-unpacked"
if [ -d "$LU" ]; then
  echo "  顶层:"
  ls -1 "$LU" 2>/dev/null | head -12 | sed 's/^/    /'
  echo "  resources/:"
  ls -1 "$LU/resources" 2>/dev/null | head -10 | sed 's/^/    /'
  echo
  echo "  ⭐ 关键：snowluma 是否解包到 app.asar.unpacked（能被 spawn 执行）"
  if [ -d "$LU/resources/app.asar.unpacked/snowluma" ]; then
    echo "    ✅ 存在: resources/app.asar.unpacked/snowluma"
    ls -1 "$LU/resources/app.asar.unpacked/snowluma" 2>/dev/null | head -8 | sed 's/^/      /'
    echo "    native/:"
    ls -1 "$LU/resources/app.asar.unpacked/snowluma/native" 2>/dev/null | sed 's/^/      /'
    NODE_BIN="$LU/resources/app.asar.unpacked/snowluma/node"
    if [ -f "$NODE_BIN" ]; then
      echo "    自带 node 架构: $(file -b "$NODE_BIN" | cut -c1-60)"
      echo "    可执行位: $(test -x "$NODE_BIN" && echo 是 || echo '否 ❌')"
    fi
  else
    echo "    ❌ 不存在！SnowLuma 被打进 asar 里就无法执行"
  fi
else
  echo "  linux-unpacked 不存在"
fi
