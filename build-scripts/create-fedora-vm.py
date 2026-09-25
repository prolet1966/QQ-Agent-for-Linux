# -*- coding: utf-8 -*-
"""create-fedora-vm.py —— 创建用于验证 .rpm 的 Fedora 虚拟机。

## 为什么最后是 Fedora 而不是 Rocky

原本计划用 Rocky Linux。但实测发现 **Rocky 的镜像无法可靠校验**：
  · 官方 CHECKSUM 只有 928 字节 / 6 个条目，且 boot 与 minimal 同尺寸同哈希
    （都是 1,480,048,640）—— 这不是一份正常的发布清单
  · 实际下载得到 2,755,067,904 字节，清单里没有这个大小的条目
  · 换多个镜像（官方/中科大/南大/阿里云）结果一致
  · 直连取 32MB 片段精确等于请求量、内容为 ISO 9660 → **传输是干净的，问题在源**

无法校验的 ISO 不该拿来装系统：装完若出问题，分不清是包的问题还是系统本身的问题，
.rpm 验证就失去意义了。

Fedora 则完全通过校验：
  · Fedora-Server-netinst-x86_64-44-1.7.iso
  · 1,228,384,256 字节，SHA256 与官方 CHECKSUM **完全一致**
  · 卷标 Fedora-S-dvd-x86_64-44

## 对 .rpm 验证的有效性（重要）

本项目的 .rpm 声明的依赖是 RHEL 系包名：
    nss, gtk3, alsa-lib, mesa-libgbm, libxkbcommon, libdrm, libXScrnSaver, xdg-utils
**Fedora 用完全相同的包名**，因此 dnf 能正确解析这些依赖 —— 这正是我们要验证的。
（Fedora 用 dnf5、Rocky 用 dnf4，但 rpm 数据库层面的验证等价。）

## 重要前提

Fedora netinst **安装时需要联网拉包**（它本身只有安装器，没有完整软件集）。
所以 VMnet8 的 NAT 必须可用 —— 这一点之前已经确认（Ubuntu VM 就是走它装的）。
"""

import os
import shutil
import sys
from pathlib import Path

VM_DIR = Path(r"F:\rpm-vm")
VM_NAME = "Fedora-rpm-test"
VMX = VM_DIR / f"{VM_NAME}.vmx"

ISO = VM_DIR / "Fedora-Server-netinst-x86_64-44-1.7.iso"
KS_ISO = VM_DIR / "ks.iso"
KS_CFG = VM_DIR / "ks.cfg"

MEM_MB = 2560
VCPUS = 2          # netinst 要解压+下载软件包，2 核能快不少
DISK_GB = 30


def vmx_content() -> str:
    return f'''#!/usr/bin/env vmware
# 由 create-fedora-vm.py 生成 —— 用于验证 QQ Agent 的 .rpm 包
#
# 安装方式：Anaconda 自动扫描光驱找 /ks.cfg，故 ide1:1 挂 kickstart 小 ISO，
# 无需手敲任何启动参数。
.encoding = "UTF-8"
config.version = "8"
virtualHW.version = "21"

displayName = "{VM_NAME}"
guestOS = "fedora-64"
annotation = "QQ Agent .rpm 验证用（Fedora Server 44 netinst）。kickstart 在 ide1:1。"

# ── 资源 ──
memsize = "{MEM_MB}"
numvcpus = "{VCPUS}"
cpuid.coresPerSocket = "{VCPUS}"

# ── 主磁盘 ──
# ⚠️ 控制器类型必须与创建磁盘时用的适配器一致。
#    踩过的坑：vmx 里写 scsi0.virtualDev = "pvscsi"，而磁盘是用
#    `vmware-vdiskmanager -a lsilogic` 创建的 —— 启动直接失败：
#      PVSCSI: Failed to register PCI slot.
#      [msg.pvscsi.badPCI] Unable to allocate a PCI SCSI adapter
#      Module 'DevicePowerOn' power on failed.
#    报错信息完全没提"适配器不匹配"，只会说"无法分配 PCI 插槽"，
#    很容易误以为是资源或权限问题。两处必须统一。
#    这里统一用 lsilogic（兼容性最好，Fedora 自带驱动）。
scsi0.present = "TRUE"
scsi0.virtualDev = "lsilogic"
scsi0:0.present = "TRUE"
scsi0:0.deviceType = "scsi-hardDisk"
scsi0:0.fileName = "{VM_NAME}.vmdk"
scsi0:0.mode = "persistent"

# ── 光驱 0：Fedora netinst ISO ──
ide1:0.present = "TRUE"
ide1:0.deviceType = "cdrom-image"
ide1:0.fileName = "{ISO}"
ide1:0.startConnected = "TRUE"

# ── 光驱 1：kickstart ISO ──
ide1:1.present = "TRUE"
ide1:1.deviceType = "cdrom-image"
ide1:1.fileName = "{KS_ISO}"
ide1:1.startConnected = "TRUE"

# ── 网络：VMnet8 NAT（netinst 必须联网）──
# ⚠️ 用 e1000e 而不是 vmxnet3。
#    踩过的坑：vmxnet3 是 PCIe 设备，在当前 PCI 拓扑下分配不到槽位，启动直接失败：
#      Vmxnet3 PCI: failed to reserve slot for vmxnet3 PCIe device
#      Module 'DevicePowerOn' power on failed.
#    e1000e 是传统 PCI 设备，兼容性最好，Fedora 自带驱动。
#    （现有 Ubuntu VM 能用 vmxnet3，说明是这台的 PCI 布局差异所致；
#     不确定时用 e1000e 更省事。）
ethernet0.present = "TRUE"
ethernet0.connectionType = "custom"
ethernet0.vnet = "VMnet8"
ethernet0.virtualDev = "e1000e"
ethernet0.addressType = "generated"
ethernet0.startConnected = "TRUE"

# ── 显示 ──
svga.present = "TRUE"
svga.autodetect = "FALSE"
svga.vramSize = "16777216"
mks.enable3d = "FALSE"

# ── VMCI（vmrun 通信需要）──
vmci0.present = "TRUE"
tools.syncTime = "FALSE"
tools.upgrade.policy = "manual"

# ── 启动顺序 ──
bios.bootOrder = "cdrom,hdd"
bios.hddOrder = "scsi0:0"

# ── 其它 ──
floppy0.present = "FALSE"
sound.present = "FALSE"
usb.present = "FALSE"
ehci.present = "FALSE"
serial0.present = "TRUE"
serial0.fileType = "file"
serial0.fileName = "serial.log"
powerType.powerOff = "soft"
powerType.suspend = "soft"
powerType.reset = "soft"
'''


def main() -> int:
    print("=" * 74)
    print("创建 Fedora 虚拟机（用于 .rpm 验证）")
    print("=" * 74)

    print("\n== 1. 检查文件 ==")
    ok = True
    for label, p in [("Fedora ISO", ISO), ("kickstart ISO", KS_ISO), ("kickstart cfg", KS_CFG)]:
        if p.is_file():
            print(f"  ✅ {label}: {p.name}  ({p.stat().st_size/1024/1024:.1f} MB)")
        else:
            print(f"  ❌ {label} 缺失: {p}")
            ok = False
    if not ok:
        print("\n  先按顺序执行：")
        print("    try-fedora-netinst.sh       下载并校验 Fedora ISO")
        print("    gen-fedora-ks.sh            生成 kickstart")
        print("    build-ks-iso.sh             打包 kickstart 为 ISO")
        return 1

    print("\n== 2. 生成 .vmx ==")
    content = vmx_content()
    if VMX.exists():
        bak = VMX.with_suffix(".vmx.bak")
        shutil.copy2(VMX, bak)
        print(f"  已有 vmx，备份为 {bak.name}")
    VMX.write_text(content, encoding="utf-8", newline="\n")
    print(f"  已写出: {VMX}")

    print("\n== 3. 磁盘 ==")
    vmdk = VM_DIR / f"{VM_NAME}.vmdk"
    if vmdk.exists():
        print(f"  已存在 {vmdk.name} ({vmdk.stat().st_size/1024/1024:.1f} MB)")
    else:
        print(f"  首次启动时 VMware 会自动创建 {DISK_GB}GB 磁盘")

    print("\n== 4. 核对关键设置 ==")
    for line in content.splitlines():
        s = line.strip()
        if s.startswith(("guestOS", "memsize", "numvcpus", "ethernet0.vnet",
                         "ide1:0.fileName", "ide1:1.fileName")):
            print(f"  {s}")

    print("\n== 5. 启动方式 ==")
    print(f'  "F:\\VM\\vmrun.exe" -T ws start "{VMX}" nogui')
    print()
    print("  netinst 需要联网下载软件包，安装约 5-15 分钟。")
    print("  装完会自动重启。之后查 DHCP 租约拿 IP：")
    print("    C:\\ProgramData\\VMware\\vmnetdhcp.leases")
    print("  用 MAC 匹配（mac 见 vmx 的 ethernet0.generatedAddress）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
