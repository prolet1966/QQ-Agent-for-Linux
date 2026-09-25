# -*- coding: utf-8 -*-
"""vm-prepare.py —— 测试前调整 VMware 虚拟机配置（可还原）。

做的事：
  1. 备份原始 .vmx（只在首次执行时备份，避免覆盖掉真正的原始配置）
  2. 把 memsize 从 7128 降到 4096 —— 宿主只有 9.9GB 可用，7GB 会给 Windows 太大压力
  3. 记录改动，便于测试后还原

为什么改 memsize 而不是别的：虚拟机内存是宿主内存的硬性扣减，
启动后那 7GB 就一直被占着。4GB 对「装包 + 跑冒烟测试」完全够用。

安全性：.vmx 是纯文本配置，改动只影响下一次开机；
关机状态下的修改不会损坏磁盘镜像。已在改动前备份。
"""

import os
import re
import shutil
import sys

VMX = r"F:\Ubuntu_vm\Ubuntu.vmx"
BAK = r"F:\Ubuntu_vm\Ubuntu.vmx.bak-before-test"
TARGET_MEM = "4096"


def read_lines(path):
    with open(path, encoding="utf-8", errors="surrogateescape") as fh:
        return fh.readlines()


def find_memsize(lines):
    for i, line in enumerate(lines):
        m = re.match(r'^\s*memsize\s*=\s*"?(\d+)"?\s*$', line)
        if m:
            return i, m.group(1)
    return None, None


def main():
    if not os.path.isfile(VMX):
        print(f"❌ 找不到: {VMX}")
        return 1

    # 备份只在第一次做 —— 否则第二次执行会把「已改过的」当成原始备份
    if not os.path.isfile(BAK):
        shutil.copy2(VMX, BAK)
        print(f"✅ 已备份原始配置: {BAK}")
    else:
        print(f"ℹ️  备份已存在，保留不动: {BAK}")

    lines = read_lines(VMX)
    idx, cur = find_memsize(lines)

    if idx is None:
        print("❌ 在 .vmx 里找不到 memsize 行，放弃修改")
        return 1

    print(f"\n当前 memsize = {cur} MB")
    if cur == TARGET_MEM:
        print(f"已经是 {TARGET_MEM} MB，无需修改")
        return 0

    # 保留原行的引号风格
    quote = '"' if '"' in lines[idx] else ""
    lines[idx] = f'memsize = {quote}{TARGET_MEM}{quote}\n'

    with open(VMX, "w", encoding="utf-8", errors="surrogateescape") as fh:
        fh.writelines(lines)

    # 复核
    idx2, new = find_memsize(read_lines(VMX))
    print(f"已改为 memsize = {new} MB")
    print(f"\n还原命令：拷贝回 {os.path.basename(BAK)}，或用")
    print(f'    (Get-Content "{BAK}") | Set-Content "{VMX}"')
    return 0


if __name__ == "__main__":
    sys.exit(main())
