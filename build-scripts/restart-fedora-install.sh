#!/usr/bin/env bash
# restart-fedora-install.sh —— 修正 kickstart 后重启 Fedora 安装。
#
# ## 上一轮为什么失败
#
# 现象：VM 内存 93MB → 4145MB（安装器启动）→ 掉回 44MB → 再涨起来，循环往复；
#       磁盘始终只有 3.8MB，说明**没往盘上写任何东西**。
#
# 原因：kickstart 里写的是 `cdrom` 作为安装源，但 **netinst ISO 只有安装器、
#       没有软件包**，必须从网络仓库拉取。这个组合是矛盾的，所以装不下去。
#
# 本轮修正：
#   1. 安装源改为网络 mirrorlist（见 gen-fedora-ks.sh）
#   2. 重新生成 ks.cfg 与 ks.iso
#   3. 重建 vmx（顺带加 VNC，便于直接看安装界面）
#   4. 重启安装
#
# ## 为什么加 VNC
#
# 上一轮只能靠内存曲线推测卡在哪 —— 日志里没有任何有用线索。
# 有 VNC 就能直接看到安装器的报错文字，排查效率完全不同。

set -uo pipefail

BS="/mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/build-scripts"
DIR="/mnt/f/rpm-vm"
VMRUN="/mnt/f/VM/vmrun.exe"

echo "############ 重启 Fedora 安装 $(date '+%F %T') ############"

echo
echo "== 1. 停掉旧 VM =="
"$VMRUN" -T ws stop "$DIR/Fedora-rpm-test.vmx" hard 2>&1 | sed 's/^/  /' || true
sleep 3
"$VMRUN" -T ws list 2>&1 | sed 's/^/  /'

echo
echo "== 2. 重新生成 kickstart =="
bash "$BS/gen-fedora-ks.sh" "$DIR/ks.cfg" 2>&1 | sed 's/^/  /'

echo
echo "== 3. 重新打包 kickstart ISO =="
bash "$BS/build-ks-iso.sh" "$DIR/ks.cfg" "$DIR/ks.iso" 2>&1 | tail -8 | sed 's/^/  /'

echo
echo "== 4. 重建 vmx（含 VNC）=="
# 用 python 重建；它在 Windows 侧路径上工作，这里通过 /mnt/c 调用 Windows python 不方便，
# 所以由外层 PowerShell 负责这一步。这里只做校验。
echo "  （由外层脚本调用 build-fedora-vmx.py 完成）"

echo
echo "== 5. 校验新 kickstart 的安装源 =="
if grep -qE '^(url|repo) ' "$DIR/ks.cfg"; then
  echo "  ✅ 已使用网络仓库作为安装源"
  grep -E '^(url|repo) ' "$DIR/ks.cfg" | sed 's/^/      /'
else
  echo "  ❌ 没有找到 url/repo 行"
fi
if grep -qE '^cdrom' "$DIR/ks.cfg"; then
  echo "  ❌ 仍存在 cdrom 行（会与 netinst 冲突）"
fi

echo
echo "############ 准备完成，可由外层启动 VM ############"
