#!/usr/bin/env bash
# vm-01-probe.sh —— 在真实 Ubuntu 虚拟机里做环境探测（**只读，不改系统**）。
#
# 为什么先探测而不直接装：
#   前面在 WSL 里测过 .deb，但 WSL 不是真机环境：没有 systemd 用户会话、
#   图形栈不完整、内核参数行为不同。真实 VM 能验出 WSL 测不出的问题。
#   探测一下现状，才能判断后面的失败是"我们的包有问题"还是"环境本来就不满足前置条件"。
#
# 本脚本**不做任何修改**：不装包、不改配置、不碰内核参数。

set -uo pipefail

echo "########## QQ Agent Linux 包 · 虚拟机环境探测 ##########"
echo "时间：$(date '+%F %T')"
echo

echo "===== 1. 系统 ====="
if [ -r /etc/os-release ]; then
  . /etc/os-release
  echo "  发行版    : ${PRETTY_NAME:-未知}"
  echo "  ID/版本   : ${ID:-?} ${VERSION_ID:-?}"
fi
echo "  内核      : $(uname -r)"
echo "  架构      : $(uname -m)"
echo "  glibc     : $(ldd --version 2>/dev/null | head -1 | awk '{print $NF}')"
if [ "$(uname -m)" != "x86_64" ]; then
  echo "  ❌ 架构不是 x86_64 —— 安装包只提供 x64"
fi

echo
echo "===== 2. 资源 ====="
free -m | awk 'NR==2{printf "  内存: 总 %s MB / 可用 %s MB\n", $2, $7}'
df -h / | tail -1 | awk '{printf "  根分区可用: %s\n", $4}'
echo "  CPU: $(nproc) 核"

echo
echo "===== 3. 是否已有 QQ Agent（避免重复安装）====="
if command -v qq-agent >/dev/null 2>&1; then
  echo "  ⚠️  已安装: $(command -v qq-agent)"
  dpkg-query -W -f='      dpkg: ${Status} ${Version}\n' qq-agent 2>/dev/null || true
else
  echo "  ✅ 未安装（干净状态）"
fi
for d in "$HOME/.local/share/qq-agent" "$HOME/.config/qq-agent"; do
  [ -e "$d" ] && echo "  ⚠️  已存在数据目录: $d"
done

echo
echo "===== 4. XDG 环境（数据目录落点的前提）====="
echo "  XDG_DATA_HOME  : ${XDG_DATA_HOME:-（未设置，按规范应回落 ~/.local/share）}"
echo "  HOME           : $HOME"
echo "  预期数据目录    : ${XDG_DATA_HOME:-$HOME/.local/share}/qq-agent"

echo
echo "===== 5. 图形环境（扫码登录需要）====="
echo "  DISPLAY         : ${DISPLAY:-（未设置）}"
echo "  WAYLAND_DISPLAY : ${WAYLAND_DISPLAY:-（未设置）}"
echo "  XDG_SESSION_TYPE: ${XDG_SESSION_TYPE:-（未设置）}"
if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  echo "  ✅ 有图形环境 —— 可以走完整流程（扫码登录 QQ）"
else
  echo "  ⚠️  无图形环境 —— 只适合验安装与平台层，扫码登录做不了"
fi

echo
echo "===== 6. 系统 QQ（协议端注入的必要条件）====="
FOUND_QQ=""
for p in /opt/QQ/qq /usr/bin/qq /usr/local/bin/qq /usr/lib/qq/qq /opt/tencent-qq/qq; do
  if [ -x "$p" ]; then
    echo "  ✅ 找到: $p  ($(du -h "$p" 2>/dev/null | cut -f1))"
    FOUND_QQ="$p"
  fi
done
[ -z "$FOUND_QQ" ] && echo "  ❌ 未安装 Linux 版 QQ —— 协议端无法工作（安装指南第三节）"

echo
echo "===== 7. 内核注入限制（协议端能否工作的关键）====="
PS=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo "N/A")
echo "  kernel.yama.ptrace_scope = $PS"
case "$PS" in
  0) echo "  ✅ 已放开 —— 协议端可以注入 QQ" ;;
  1) echo "  ⚠️  为 1（Ubuntu 默认）—— 协议端会报 COMPONENT_LOAD_FAILED" ;;
  2) echo "  ⚠️  为 2（仅管理员）—— 协议端无法注入" ;;
  N/A) echo "  ℹ️  读不到该参数（可能未启用 yama 模块）" ;;
esac

echo
echo "===== 8. .deb 依赖是否满足 ====="
# 这些是包声明依赖的系统库
LIBS="libnss3 libgtk-3-0 libasound2 libasound2t64 libgbm1 libxkbcommon0 libdrm2 libxss1"
MISSING=""
for l in $LIBS; do
  if dpkg-query -W -f='${Status}' "$l" 2>/dev/null | grep -q "install ok installed"; then
    printf "  ✅ %s\n" "$l"
  else
    printf "  ➖ %s（未安装或包名不同）\n" "$l"
    MISSING="$MISSING $l"
  fi
done
if command -v xdg-open >/dev/null 2>&1; then
  echo "  ✅ xdg-utils（xdg-open 存在）"
else
  echo "  ➖ xdg-utils 未安装（「打开数据目录」会失效）"
fi

echo
echo "===== 9. 打包工具（若要在 VM 里重打包）====="
for c in fakeroot dpkg dpkg-deb rpm rpmbuild; do
  if command -v "$c" >/dev/null 2>&1; then printf "  ✅ %s\n" "$c"; else printf "  ➖ %s 缺失\n" "$c"; fi
done

echo
echo "===== 10. 网络（apt 装依赖需要）====="
if timeout 8 curl -sS -o /dev/null -w "%{http_code}" http://archive.ubuntu.com/ 2>/dev/null | grep -qE "200|301|302"; then
  echo "  ✅ 可访问 archive.ubuntu.com"
else
  echo "  ⚠️  访问 archive.ubuntu.com 失败（apt 装依赖会失败）"
fi

echo
echo "===== 11. 已装的相关环境（判断这台 VM 的用途）====="
for c in java hadoop mongod mysql docker; do
  if command -v "$c" >/dev/null 2>&1; then
    printf "  %s: %s\n" "$c" "$(command -v $c)"
  fi
done
if command -v java >/dev/null 2>&1; then
  java -version 2>&1 | head -1 | sed 's/^/    /'
fi

echo
echo "########## 探测结束（未对系统做任何修改）##########"
