# fetch-fedora-wsl.py —— 下载官方 Fedora WSL 镜像并校验，供 `wsl --import` 使用。
#
# ## 为什么不去修那台 Fedora VM
#
# VM 侧的现实（全部是实测，不是推断）：
#   · vmx 里没有内核引导参数字段，kickstart 只能靠 OEMDRV 卷标自动探测；
#   · 最近的启动停在**交互式** INSTALLATION SUMMARY（Software Selection 报
#     "Warning checking software selection"），磁盘始终 3.8MB、无任何写入
#     —— 完全无人值守的 ks 安装不会停在摘要页，说明 kickstart 没被读到；
#   · `vmcli MKS sendKeySequence` / `sendKeyEvent` 静默无效（exit=0，屏幕哈希不变），
#     既进不了 TTY 看 anaconda 日志，也点不动摘要页按钮；
#   · VMware 的 VNC 拒绝外部客户端认证（只提供安全类型 2；明文口令与 vmx 里的
#     RemoteDisplay.vnc.key 两种取 key 方式都被服务端直接断开）；
#   · 决定性证据：截图在 60 秒、乃至 20 分钟跨度上**逐像素完全一致**，
#     而 Anaconda 界面右上角带实时时钟 —— guest 已冻死，captureScreenshot 给的是冻结帧。
#
# 结论：不是"看不到"，而是那台 guest 真卡住了，且看不了、敲不进、连不上。
#
# ## 为什么用官方 Fedora WSL 镜像
#
# 要在 Fedora 上验 .rpm，真正需要的是**真实 Fedora 用户态**：rpm 数据库、dnf、
# 以及 Fedora 自己的依赖包名（nss / gtk3 / alsa-lib / mesa-libgbm / libxkbcommon …）。
# 官方的 Fedora-WSL-Base 正好提供这些，单个文件、可直接导入、完全可复现。
#
# ## 能力边界（必须写进报告，不能含糊）
#
# WSL 跑的是微软内核，不是 Fedora 自带内核。因此这里
#   ✅ 能验：rpm 依赖解析与安装、安装路径、文件权限/属主、%post 脚本、卸载、升级、
#           rpm 数据库记录、dnf 元数据完整性
#   ❌ 不能验：Fedora 内核相关的运行时行为、真实硬件/图形栈
# 这个区别会在测试结论里写明，不冒充"真机全项通过"。

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

BASE = "https://download.fedoraproject.org/pub/fedora/linux/releases/44/Container/x86_64/images"
IMG = "Fedora-WSL-Base-44-1.7.x86_64.wsl"
SUMS = "Fedora-Container-44-1.7-x86_64-CHECKSUM"
OUT_DIR = Path(r"F:\fedora-wsl")
UA = {"User-Agent": "qq-agent-linux-verify/1.0"}

# 官方站点在实测中会在大文件传输时重置 TLS（WinError 10054）。
# 镜像列表按"先官方后镜像站"排序，逐个尝试；每个都支持 Range 续传。
MIRRORS = [
    BASE,
    "https://mirrors.tuna.tsinghua.edu.cn/fedora/releases/44/Container/x86_64/images",
    "https://mirrors.aliyun.com/fedora/releases/44/Container/x86_64/images",
    "https://mirror.sjtu.edu.cn/fedora/releases/44/Container/x86_64/images",
]


def fetch(url: str, timeout: int = 300) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def download_resumable(dest: Path, filename: str, expect_size: int | None = None) -> bool:
    """带断点续传的下载：逐镜像、逐次重试，每次都接着已有字节继续。"""
    import time

    for attempt in range(1, 9):
        for base in MIRRORS:
            url = f"{base}/{filename}"
            have = dest.stat().st_size if dest.exists() else 0

            if expect_size and have == expect_size:
                print(f"  ✅ 已达到期望大小 {expect_size} 字节")
                return True

            headers = dict(UA)
            mode = "wb"
            if have:
                headers["Range"] = f"bytes={have}-"
                mode = "ab"

            try:
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=180) as resp:
                    total = resp.headers.get("Content-Length")
                    total = int(total) + have if total else None
                    print(f"  [{attempt}] {url.split('/')[2]}"
                          f"  已有 {have/1024/1024:.1f} MB"
                          f" / 共 {total/1024/1024:.1f} MB" if total else "")
                    with open(dest, mode) as fh:
                        while True:
                            chunk = resp.read(1 << 20)
                            if not chunk:
                                break
                            fh.write(chunk)
                            have += len(chunk)
                got = dest.stat().st_size
                if expect_size is None or got == expect_size:
                    print(f"  ✅ 下载完成 {got/1024/1024:.1f} MB")
                    return True
                print(f"  ⚠️  本次结束于 {got/1024/1024:.1f} MB，未达 {expect_size}，继续续传")
            except Exception as e:
                msg = str(e)[:90]
                print(f"  ⚠️  {url.split('/')[2]} 失败: {msg}，换镜像/重试")
                time.sleep(2)
                continue
    return False


def head_size(url: str) -> int | None:
    try:
        req = urllib.request.Request(url, headers=UA, method="HEAD")
        with urllib.request.urlopen(req, timeout=60) as resp:
            n = resp.headers.get("Content-Length")
            return int(n) if n else None
    except Exception:
        return None


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("== 1. 取官方 CHECKSUM ==")
    try:
        sums_text = fetch(f"{BASE}/{SUMS}", timeout=120).decode("utf-8", "replace")
    except Exception as e:
        print(f"  ⚠️  取 CHECKSUM 失败: {e}")
        sums_text = ""
    expect = None
    for line in sums_text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # 格式: SHA256 (filename) = hash
        if IMG in line and "=" in line:
            expect = line.split("=", 1)[1].strip().lower()
    if expect:
        print(f"  ✅ 官方 SHA256: {expect}")
    else:
        print("  ⚠️  CHECKSUM 里没直接列出该文件，稍后只做自洽校验")

    print(f"\n== 2. 下载 {IMG} ==")
    dest = OUT_DIR / IMG
    expect_size = head_size(f"{BASE}/{IMG}")
    if expect_size:
        print(f"  期望大小: {expect_size} 字节 ({expect_size/1024/1024:.1f} MB)")
    if not download_resumable(dest, IMG, expect_size):
        print("  ❌ 所有镜像都未能完整下载")
        return 1

    print("\n== 3. 校验 SHA256 ==")
    h = hashlib.sha256()
    size = 0
    with open(dest, "rb") as fh:
        while True:
            chunk = fh.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            size += len(chunk)
    digest = h.hexdigest()
    print(f"  文件大小: {size} 字节 ({size/1024/1024:.1f} MB)")
    print(f"  SHA256  : {digest}")
    if expect:
        if digest == expect:
            print("  ✅ 与官方 CHECKSUM 一致")
        else:
            print("  ❌ 与官方 CHECKSUM 不一致 —— 下载可能损坏，不要用它做验证")
            print(f"     期望: {expect}")
            return 1
    print(f"\n✅ 就绪: {dest}")
    print(f"   下一步导入 WSL：")
    print(f"     wsl --import qqagent-fedora F:\\fedora-wsl\\rootfs \"{dest}\"")
    return 0


if __name__ == "__main__":
    sys.exit(main())
