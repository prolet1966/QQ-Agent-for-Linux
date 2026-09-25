#!/usr/bin/env bash
# build-ks-iso.sh —— 把 kickstart 打成小 ISO，供 Anaconda 自动读取。
#
# ## 为什么要这一步
#
# 无人值守安装需要把 kickstart 内容交给 Anaconda。可选做法与取舍：
#
#   ① VMX 里传内核参数 —— **做不到**。VMX 没有"追加内核启动参数"的字段。
#      我一开始在 prepare-rpm-vm.py 里写了个 guestInfo.installArgs，
#      那是无效的自定义字段，Anaconda 根本不读。已在该文件里标注更正。
#
#   ② 宿主起 HTTP 服务，Anaconda 用 inst.ks=http://... 拉 —— 可行，
#      但仍需在安装启动时手敲参数（Anaconda 启动菜单按 Tab 编辑），
#      对无人值守不友好。
#
#   ③ **做成 ISO 挂为第二光驱** —— 本脚本采用。Anaconda 启动时会自动
#      扫描所有光驱找 /ks.cfg，找到就自动进入无人值守安装，无需任何手动操作。
#
# ## 依赖
#   genisoimage（Ubuntu: sudo apt install genisoimage）
#   体积很小（几百 KB），只含一个 ks.cfg

set -euo pipefail

KS_SRC="${1:-/mnt/f/rpm-vm/ks.cfg}"
KS_ISO="${2:-/mnt/f/rpm-vm/ks.iso}"
BUILD_DIR="/tmp/ks-iso-build"

echo "== 生成 kickstart ISO =="
echo "  源  : $KS_SRC"
echo "  输出: $KS_ISO"

[ -f "$KS_SRC" ] || { echo "❌ kickstart 不存在: $KS_SRC"; exit 1; }

if ! command -v genisoimage >/dev/null 2>&1; then
  echo "❌ 缺 genisoimage。安装：sudo apt install genisoimage"
  exit 1
fi

# Anaconda 会在光驱根目录找 ks.cfg，文件名必须是这个
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cp "$KS_SRC" "$BUILD_DIR/ks.cfg"

# 校验 kickstart 内容的基本合法性（避免装到一半才发现语法错）
echo
echo "== kickstart 基本校验 =="
for kw in "cdrom" "autopart" "%packages" "%end" "rootpw"; do
  if grep -qi "^${kw}\|${kw}" "$BUILD_DIR/ks.cfg"; then
    printf "  ✅ 含 %s\n" "$kw"
  else
    printf "  ⚠️  缺少 %s\n" "$kw"
  fi
done
if grep -q "__SSH_PUBKEY__" "$BUILD_DIR/ks.cfg"; then
  echo "  ⚠️  公钥占位符未被替换 —— prepare-rpm-vm.py 可能没跑过，免密登录会失效"
else
  echo "  ✅ 公钥已注入"
fi

echo
echo "== 打包 =="
genisoimage -quiet -volid "KICKSTART" -J -R -V OEMDRV -o "$KS_ISO" "$BUILD_DIR"

if [ -f "$KS_ISO" ]; then
  echo "  ✅ 生成成功: $(du -h "$KS_ISO" | cut -f1)"
  echo "  内容:"
  genisoimage -quiet -print-size "$BUILD_DIR" >/dev/null 2>&1 || true
  echo "    /ks.cfg  ($(stat -c%s "$BUILD_DIR/ks.cfg") 字节)"
else
  echo "  ❌ 生成失败"
  exit 1
fi

rm -rf "$BUILD_DIR"
