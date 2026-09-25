# -*- coding: utf-8 -*-
"""vm-ssh.py —— 通过 SSH 在 Ubuntu 虚拟机里执行任务（封装重试与编码问题）。

为什么不用裸 ssh 命令：
  1. 每次都要带一堆 -o 参数（BatchMode / StrictHostKeyChecking / 指定私钥）
  2. 从 PowerShell 传含中文或含 $ 的脚本体极易被展开破坏
     （本项目已在 PowerShell 变量展开上栽过多次）
  3. 中文输出在 Windows 控制台会乱码，需要显式按 UTF-8 解码

因此统一走本模块：脚本内容写到临时文件 → scp 传进去 → 远端执行 → 取回输出。

用法：
    python vm-ssh.py run   <本地脚本>            把脚本传到 VM 并执行
    python vm-ssh.py put   <本地文件> [远端路径]  只传文件
    python vm-ssh.py exec  "<简单命令>"           执行单条命令（避免复杂引号）
    python vm-ssh.py info                        汇总 VM 基本信息
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

HOST = "192.168.105.128"
USER = "kmy"
KEY = str(Path.home() / ".ssh" / "id_ed25519")

SSH_OPTS = [
    "-i", KEY,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=10",
    "-o", "LogLevel=ERROR",
]


def _run(args: list[str], timeout: int = 900) -> tuple[int, str]:
    """执行命令，返回 (退出码, 合并后的输出)。输出按 UTF-8 解码，避免中文乱码。"""
    proc = subprocess.run(
        args,
        capture_output=True,
        timeout=timeout,
        env={**os.environ, "LC_ALL": "C.UTF-8"},
    )
    out = b""
    if proc.stdout:
        out += proc.stdout
    if proc.stderr:
        out += proc.stderr
    text = out.decode("utf-8", errors="replace")
    return proc.returncode, text


def ssh(cmd: str, timeout: int = 900) -> tuple[int, str]:
    return _run(["ssh", *SSH_OPTS, f"{USER}@{HOST}", cmd], timeout)


def scp(local: str, remote: str, timeout: int = 900) -> tuple[int, str]:
    return _run(["scp", *SSH_OPTS, local, f"{USER}@{HOST}:{remote}"], timeout)


def do_info():
    print(f"== 虚拟机信息 {USER}@{HOST} ==")
    rc, out = ssh(
        "echo 'hostname :' $(hostname); "
        "echo 'whoami   :' $(whoami); "
        "echo 'os       :' $(. /etc/os-release 2>/dev/null && echo $PRETTY_NAME); "
        "echo 'kernel   :' $(uname -r); "
        "echo 'arch     :' $(uname -m); "
        "echo 'glibc    :' $(ldd --version 2>/dev/null | head -1 | awk '{print $NF}'); "
        "echo 'cpu/mem  :' $(nproc) '核 /' $(free -m | awk 'NR==2{print $2}') 'MB'; "
        "echo 'disk     :' $(df -h / | tail -1 | awk '{print $4}') '可用'; "
        "echo 'sudo     :' $(sudo -n true 2>/dev/null && echo '免密可用' || echo '需要密码'); "
        "echo 'DISPLAY  :' ${DISPLAY:-（无）}; "
        "echo 'HOME     :' $HOME"
    )
    print(out.strip())
    return rc


def do_exec(cmd: str):
    rc, out = ssh(cmd)
    print(out, end="")
    return rc


def do_put(local: str, remote: str | None = None, normalize_eol: bool | None = None):
    """传输文件。

    ⚠️ 行尾规范化**只对文本文件做**。
    这里踩过一次很严重的坑：最初对所有文件无条件执行
        sed -i 's/\\r$//'
    结果把 .deb 当文本处理，**破坏了二进制**导致 SHA256 不匹配
    （实测 023ebec3... 变成 70d3dead...）。若不是传输后做了哈希核对，
    就会拿一个损坏的包去装，然后花大量时间去查"为什么装不上"。

    现在按扩展名自动判断，也可用 normalize_eol 显式指定。
    """
    if not os.path.isfile(local):
        print(f"❌ 本地文件不存在: {local}")
        return 1

    target = remote or f"/tmp/{os.path.basename(local)}"

    # 判定是否文本：显式参数优先，否则按扩展名
    if normalize_eol is None:
        text_exts = {".sh", ".py", ".mjs", ".js", ".cjs", ".json", ".md", ".txt", ".yml", ".yaml", ".conf", ".service"}
        normalize_eol = os.path.splitext(local)[1].lower() in text_exts

    size_kb = os.path.getsize(local) / 1024
    print(f"  传输: {os.path.basename(local)} ({size_kb:.1f} KB) → {target}")
    if not normalize_eol:
        print("        （二进制/非文本，不做行尾处理）")

    rc, out = scp(local, target)
    if rc != 0:
        print("  ❌ 传输失败:")
        print(out[:800])
        return rc

    if normalize_eol:
        ssh(f"sed -i 's/\\r$//' {target}")
        print("  ✅ 已传输并规范化行尾")
    else:
        print("  ✅ 已传输")

    # 传输后立即核对大小 —— 二进制被破坏时这一步就能发现
    rc2, remote_size = ssh(f"stat -c %s {target} 2>/dev/null || echo 0")
    try:
        rs = int(remote_size.strip())
    except ValueError:
        rs = -1
    ls = os.path.getsize(local)
    if rs != ls:
        print(f"  ❌ 大小不一致！本地 {ls} 字节，远端 {rs} 字节 —— 传输被破坏")
        return 1
    print(f"  ✅ 大小核对一致（{ls} 字节）")
    return 0


def do_run(local_script: str, extra_args: list[str] | None = None):
    """传脚本并执行，输出原样返回。

    extra_args 会作为参数传给远端脚本 —— 不少脚本需要参数
    （例如 vm-02-smoke.sh 要 .deb 的路径）。
    最初漏了这一步，远端脚本因缺参数直接退出。
    """
    if not os.path.isfile(local_script):
        print(f"❌ 脚本不存在: {local_script}")
        return 1

    name = os.path.basename(local_script)
    remote = f"/tmp/{name}"

    print(f"== 1. 传输 {name} ==")
    rc = do_put(local_script, remote, normalize_eol=True)
    if rc != 0:
        return rc

    arg_str = " ".join(f'"{a}"' for a in (extra_args or []))
    print(f"\n== 2. 执行 {name} {arg_str} ==")
    # 用 bash 显式执行，不依赖 shebang 与执行位
    rc, out = ssh(f"chmod +x {remote}; bash {remote} {arg_str}")
    print(out, end="")
    print(f"\n== 退出码: {rc} ==")
    return rc


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    action = sys.argv[1]

    if action == "info":
        return do_info()
    if action == "exec":
        if len(sys.argv) < 3:
            print("用法: exec \"<命令>\"")
            return 2
        return do_exec(sys.argv[2])
    if action == "put":
        if len(sys.argv) < 3:
            print("用法: put <本地文件> [远端路径]")
            return 2
        return do_put(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    if action == "run":
        if len(sys.argv) < 3:
            print("用法: run <本地脚本> [传给脚本的参数...]")
            return 2
        return do_run(sys.argv[2], sys.argv[3:])

    print(f"未知操作: {action}")
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
