# -*- coding: utf-8 -*-
"""build-fedora-vmx.py —— 生成 Fedora VM 的 vmx：以可用 VM 为**参考**，但一次性写干净。

## 上一版的问题

上一版是"读模板 → 删一些键 → 再追加一批键"，结果：
  · 生成了畸形的 uuid.bios（我手工拼的十六进制串不合法）
  · 留下了重复键（模板里的键没删干净，我又追加了一遍）
  · VMware 直接报 "Cannot read the virtual machine configuration file"

重写比打补丁可靠。本版：**照抄模板里那批结构性配置的键值，然后一次性写全新文件**。

## 为什么必须照抄结构

手写的精简 vmx（103 行）启动时 vmware-vmx 会**访问违例崩溃**：
    VMware Workstation unrecoverable error: (vmx)
    Exception 0xc0000005 (access violation) has occurred.

对比可用的 Ubuntu vmx 发现我漏了这些结构性配置：
    virtualHW.version = "22"
    pciBridge0 / pciBridge4..7  present + virtualDev="pcieRootPort" + functions="8"
    sata0.present = "TRUE"
    nvram / extendedConfigFile / vm.createDate / vm.hotadd
**PCI 桥那一组是关键** —— 没有根端口，设备没地方挂，Workstation 26 直接崩而不是报错。
"""

import re
import uuid
from pathlib import Path

SRC_VMX = Path(r"F:\Ubuntu_vm\Ubuntu.vmx")
VM_DIR = Path(r"F:\rpm-vm")
VM_NAME = "Fedora-rpm-test"
DST_VMX = VM_DIR / f"{VM_NAME}.vmx"

FEDORA_ISO = VM_DIR / "Fedora-Server-netinst-x86_64-44-1.7.iso"
KS_ISO = VM_DIR / "ks.iso"

MEM_MB = 2560
VCPUS = 2


def read_template() -> dict[str, str]:
    """把模板 vmx 读成键值字典（保留原始写法）。"""
    out: dict[str, str] = {}
    for line in SRC_VMX.read_text(encoding="utf-8", errors="surrogateescape").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        m = re.match(r'^([A-Za-z0-9_.:]+)\s*=\s*(.*)$', s)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def main() -> int:
    print("=" * 74)
    print(f"生成 {VM_NAME}.vmx（照抄可用模板的结构性配置）")
    print("=" * 74)

    tpl = read_template()
    print(f"\n  模板 {SRC_VMX.name}: 解析出 {len(tpl)} 个键")

    # ── 结构性配置：直接照抄（这些正是手写时漏掉、导致崩溃的部分）────────
    STRUCTURAL = [
        ".encoding", "config.version", "virtualHW.version",
        "virtualHW.productCompatibility",
        "pciBridge0.present", "pciBridge0.pciSlotNumber",
        "pciBridge4.present", "pciBridge4.virtualDev", "pciBridge4.functions",
        "pciBridge4.pciSlotNumber",
        "pciBridge5.present", "pciBridge5.virtualDev", "pciBridge5.functions",
        "pciBridge5.pciSlotNumber",
        "pciBridge6.present", "pciBridge6.virtualDev", "pciBridge6.functions",
        "pciBridge6.pciSlotNumber",
        "pciBridge7.present", "pciBridge7.virtualDev", "pciBridge7.functions",
        "pciBridge7.pciSlotNumber",
        "vmci0.present", "hpet0.present",
        "powerType.powerOff", "powerType.powerOn", "powerType.suspend",
        "powerType.reset",
        "tools.syncTime", "toolScripts.afterPowerOn", "toolScripts.afterResume",
        "toolScripts.beforePowerOff", "toolScripts.beforeSuspend",
        "svga.autodetect", "svga.graphicsMemoryKB", "svga.vramSize",
        "mks.enable3d",
        "scsi0.present", "scsi0.virtualDev",
        "sata0.present",
        "usb.present", "ehci.present", "usb_xhci.present",
        "floppy0.present",
        "vcpu.hotadd", "mem.hotadd",
        "bios.bootDelay", "bios.forceSetupOnce",
    ]

    lines = [
        "#!/usr/bin/env vmware",
        f"# {VM_NAME} —— 用于验证 QQ Agent 的 .rpm 包",
        "#",
        "# 结构性配置照抄自一个可正常启动的模板 VM（见 build-fedora-vmx.py 说明）。",
        "# 手写精简 vmx 会因缺少 PCI 桥等根端口配置导致 vmware-vmx 访问违例崩溃。",
        "",
    ]

    copied, missing = 0, []
    for key in STRUCTURAL:
        if key in tpl:
            lines.append(f"{key} = {tpl[key]}")
            copied += 1
        else:
            missing.append(key)

    # ⚠️ 不要在这里再补 floppy0.present —— 它已在 STRUCTURAL 里照抄过。
    #    上一版就是因为"照抄一遍、又手工追加一遍"造成重复键，
    #    VMware 直接报 "Cannot read the virtual machine configuration file"。
    #    下面的校验会拦截这类问题。

    print(f"  照抄结构性配置: {copied} 个")
    if missing:
        print(f"  模板里没有（跳过）: {', '.join(missing)}")

    # ── 本 VM 专属配置 ────────────────────────────────────────────────────
    bios_uuid = str(uuid.uuid4())
    # VMX 的 uuid 格式：8-4-4-4-12，空格分隔的字节对
    u = bios_uuid.replace("-", "")
    uuid_fmt = f"{u[0:2]} {u[2:4]} {u[4:6]} {u[6:8]} {u[8:10]} {u[10:12]} {u[12:14]} {u[14:16]}-{u[16:18]} {u[18:20]} {u[20:22]} {u[22:24]} {u[24:26]} {u[26:28]} {u[28:30]} {u[30:32]}"

    lines += [
        "",
        "# ===== 本 VM 专属 =====",
        f'displayName = "{VM_NAME}"',
        'guestOS = "fedora-64"',
        f'annotation = "QQ Agent .rpm 验证用（Fedora Server 44 netinst）。kickstart 在 sata0:1。"',
        f'nvram = "{VM_NAME}.nvram"',
        f'extendedConfigFile = "{VM_NAME}.vmxf"',
        f'vmxstats.filename = "{VM_NAME}.scoreboard"',
        f'uuid.bios = "{uuid_fmt}"',
        f'uuid.location = "{uuid_fmt}"',
        "",
        "# ── 资源 ──",
        f'memsize = "{MEM_MB}"',
        f'numvcpus = "{VCPUS}"',
        f'cpuid.coresPerSocket = "{VCPUS}"',
        "",
        "# ── 磁盘（与 vmware-vdiskmanager -a lsilogic 创建的一致）──",
        f'scsi0:0.fileName = "{VM_NAME}.vmdk"',
        'scsi0:0.present = "TRUE"',
        'scsi0:0.deviceType = "scsi-hardDisk"',
        'scsi0:0.mode = "persistent"',
        "",
        "# ── 光驱 0：Fedora netinst ──",
        'sata0:0.present = "TRUE"',
        'sata0:0.deviceType = "cdrom-image"',
        f'sata0:0.fileName = "{FEDORA_ISO}"',
        'sata0:0.startConnected = "TRUE"',
        "",
        "# ── 光驱 1：kickstart（Anaconda 自动扫描 /ks.cfg）──",
        'sata0:1.present = "TRUE"',
        'sata0:1.deviceType = "cdrom-image"',
        f'sata0:1.fileName = "{KS_ISO}"',
        'sata0:1.startConnected = "TRUE"',
        "",
        "# ── 网络：用 e1000e（vmxnet3 在这台机器上分配不到 PCIe 槽位）──",
        'ethernet0.present = "TRUE"',
        'ethernet0.connectionType = "custom"',
        'ethernet0.vnet = "VMnet8"',
        'ethernet0.virtualDev = "e1000e"',
        'ethernet0.addressType = "generated"',
        'ethernet0.startConnected = "TRUE"',
        "",
        "# ── 启动顺序：先光驱 ──",
        'bios.bootOrder = "cdrom,hdd"',
        'bios.hddOrder = "scsi0:0"',
        "",
        "# ── 串口日志（便于无界面排查）──",
        'serial0.present = "TRUE"',
        'serial0.fileType = "file"',
        'serial0.fileName = "serial.log"',
        'serial0.tryNoRxLoss = "FALSE"',
        "",
        "# ── VNC：可远程看安装界面 ──",
        "# 为什么要开：无人值守安装若中途失败，只看日志和内存曲线很难判断卡在哪。",
        "# 实测踩过 —— 安装器因安装源配置错误反复重启，而日志里没有任何线索，",
        "# 只能靠内存曲线（93MB→4145MB→44MB 循环）推测。有 VNC 就能直接看到屏幕。",
        "# 本机是 Windows，用 VNC 客户端连 127.0.0.1:5901 即可。",
        'RemoteDisplay.vnc.enabled = "TRUE"',
        'RemoteDisplay.vnc.port = "5901"',
        'RemoteDisplay.vnc.password = "rpmtest"',
        "",
    ]

    content = "\n".join(lines)
    DST_VMX.write_text(content, encoding="utf-8", newline="\n")
    print(f"\n  已写出: {DST_VMX}（{len(lines)} 行）")

    # ── 严格校验：重复键会直接导致 VMware 读不了配置 ──────────────────────
    print("\n== 校验 ==")
    keys = []
    for line in lines:
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        m = re.match(r'^([A-Za-z0-9_.:]+)\s*=', s)
        if m:
            keys.append(m.group(1))
    dupes = {k for k in keys if keys.count(k) > 1}
    if dupes:
        print(f"  ❌ 存在重复键（会导致配置读不了）: {', '.join(sorted(dupes))}")
        return 1
    print(f"  ✅ 无重复键（共 {len(keys)} 个键）")

    # 每个值都必须有引号（VMX 要求）
    bad = [l.strip() for l in lines
           if re.match(r'^[A-Za-z0-9_.:]+\s*=', l.strip())
           and not re.match(r'^[A-Za-z0-9_.:]+\s*=\s*".*"$', l.strip())]
    if bad:
        print("  ❌ 有未加引号的值：")
        for b in bad[:5]:
            print(f"       {b}")
        return 1
    print("  ✅ 所有值都已加引号")

    required = ["pciBridge0.present", "pciBridge4.present", "pciBridge7.present",
                "virtualHW.version", "scsi0.virtualDev", "sata0.present",
                "vmci0.present", "uuid.bios", "guestOS", "displayName"]
    ok = True
    for k in required:
        if k not in keys:
            print(f"  ❌ 缺少 {k}")
            ok = False
    if ok:
        print("  ✅ 结构性键齐全")

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
