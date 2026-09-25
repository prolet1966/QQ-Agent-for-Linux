# -*- coding: utf-8 -*-
"""push-with-msgfile.py —— 读提交信息文件后调用 push-via-api.py。

为什么需要这层薄封装：
  多行提交信息从 PowerShell 传到 Python 时会被逐行当成不同参数，
  导致 argv 错位（实测把提交信息的第二行当成了 staging 路径，
  报「staging 不存在」）。Windows 上这类展开问题反复出现，
  统一改为「信息写文件、脚本读文件」，彻底绕开。
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PUSHER = os.path.join(HERE, "push-via-api.py")


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python push-with-msgfile.py <提交信息文件> [staging目录]")
        return 2

    msg_file = sys.argv[1]
    stage = sys.argv[2] if len(sys.argv) > 2 else None

    if not os.path.isfile(msg_file):
        print(f"❌ 提交信息文件不存在: {msg_file}")
        return 1
    with open(msg_file, encoding="utf-8") as fh:
        message = fh.read().rstrip("\n")

    if not message.strip():
        print("❌ 提交信息为空")
        return 1

    print(f"== 提交信息（{len(message.splitlines())} 行）==")
    for line in message.splitlines()[:4]:
        print(f"  {line}")
    if len(message.splitlines()) > 4:
        print("  …")
    print()

    args = [sys.executable, PUSHER, message]
    if stage:
        args.append(stage)
    return subprocess.run(args).returncode


if __name__ == "__main__":
    sys.exit(main())
