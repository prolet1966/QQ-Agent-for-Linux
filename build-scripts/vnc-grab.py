# -*- coding: utf-8 -*-
"""vnc-grab.py —— 用最小 VNC 客户端抓取虚拟机画面。

## 为什么需要它

Fedora 安装器反复重启（内存 1.59GB 稳定几分钟 → 掉到 54MB → 再起来），
磁盘始终 3.8MB 没有任何写入。只靠日志与内存曲线无法判断卡在哪一步，
而 `vmrun captureScreen` 要求先登录 guest（"Anonymous guest operations are not allowed"），
本机也没有装 VNC 客户端。

于是自己实现一个最小 RFB 客户端 —— 只要能抓到一帧 PNG，
就能直接看到安装器屏幕上的报错文字，比推测可靠得多。

## 实现范围

只做抓一帧所需的流程：
  1. 读版本号，回 RFB 003.008
  2. 处理安全类型（优先 None，否则做 VNC Authentication：DES 挑战-响应）
  3. ClientInit（共享标志）
  4. SetPixelFormat（32bpp true color，BGRX）
  5. SetEncodings（Raw 优先）
  6. FramebufferUpdateRequest → 读一帧 → 存 PNG

DES 用纯 Python 实现（VNC 的挑战-响应算法），避免依赖 pycryptodome。
"""

from __future__ import annotations

import socket
import struct
import sys
import zlib
from pathlib import Path

HOST = "127.0.0.1"
PORT = 5901
PASSWORD = "rpmtest"


# ─────────────────────────────────────────── 最小 DES（仅用于 VNC 认证）
# VNC 认证：把 16 字节密码补零成 8 字节 key（每字节取低 7 位），
# 对服务端给的 16 字节挑战做两次 DES-ECB 加密，返回 16 字节响应。
_PC1 = [56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17,
        9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35,
        62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21,
        13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3]
_PC2 = [13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9,
        22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1,
        40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47,
        43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31]
_IP = [57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
       61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
       56, 48, 40, 32, 24, 16, 8, 0, 58, 50, 42, 34, 26, 18, 10, 2,
       60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6]
_E = [31, 0, 1, 2, 3, 4, 3, 4, 5, 6, 7, 8, 7, 8, 9, 10, 11, 12,
      11, 12, 13, 14, 15, 16, 15, 16, 17, 18, 19, 20, 19, 20, 21,
      22, 23, 24, 23, 24, 25, 26, 27, 28, 27, 28, 29, 30, 31, 0]
_P = [15, 6, 19, 20, 28, 11, 27, 16, 0, 14, 22, 25, 4, 17,
      30, 9, 1, 7, 23, 13, 31, 26, 2, 8, 18, 12, 29, 5,
      21, 10, 3, 24]
_SBOX = [
    [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
     0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
     4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
     15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
    [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
     3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
     0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
     13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
    [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
     13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
     13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
     1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
    [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
     13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
     10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
     3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
    [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
     14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
     4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
     11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
    [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
     10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
     9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
     4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
    [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
     13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
     1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
     6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
    [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
     1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
     7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
     2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
]


def _permute(bits, table):
    return [bits[i] for i in table]


def _bits_from_bytes(data: bytes) -> list[int]:
    out = []
    for b in data:
        for i in range(7, -1, -1):
            out.append((b >> i) & 1)
    return out


def _bytes_from_bits(bits: list[int]) -> bytes:
    out = bytearray()
    for i in range(0, len(bits), 8):
        v = 0
        for b in bits[i:i + 8]:
            v = (v << 1) | b
        out.append(v)
    return bytes(out)


def _des_encrypt_block(key: bytes, block: bytes) -> bytes:
    kb = _permute(_bits_from_bytes(key), _PC1)
    c, d = kb[:28], kb[28:]
    subkeys = []
    for shift in [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]:
        c = c[shift:] + c[:shift]
        d = d[shift:] + d[:shift]
        subkeys.append(_permute(c + d, _PC2))

    bits = _permute(_bits_from_bytes(block), _IP)
    l, r = bits[:32], bits[32:]
    for k in subkeys:
        expanded = _permute(r, _E)
        x = [a ^ b for a, b in zip(expanded, k)]
        out = []
        for i in range(8):
            chunk = x[i * 6:(i + 1) * 6]
            row = (chunk[0] << 1) | chunk[5]
            col = (chunk[1] << 3) | (chunk[2] << 2) | (chunk[3] << 1) | chunk[4]
            val = _SBOX[i][row * 16 + col]
            out += [(val >> 3) & 1, (val >> 2) & 1, (val >> 1) & 1, val & 1]
        f = _permute(out, _P)
        l, r = r, [a ^ b for a, b in zip(l, f)]
    return _bytes_from_bits(_permute(r + l, _IP))


def vnc_response(password: str, challenge: bytes) -> bytes:
    """VNC 认证响应：key 取密码每字节低 7 位，补零到 8 字节，对挑战做两次 DES。"""
    key = bytes((ord(c) & 0x7F) for c in password[:8]).ljust(8, b"\x00")
    return _des_encrypt_block(key, challenge[:8]) + _des_encrypt_block(key, challenge[8:16])


def raw_key_response(key8: bytes, challenge: bytes) -> bytes:
    """直接用 8 字节作为 DES key（VMware 的 RemoteDisplay.vnc.key 走这条路）。

    标准 VNC 认证是「明文口令 → 每字节取低 7 位 → 8 字节 key」。
    但 vmx 里 `RemoteDisplay.vnc.key` 存的显然不是明文口令，
    说明 VMware 内部按**已派生的 key**处理，客户端也得直接用 key 做 DES。
    """
    k = key8[:8].ljust(8, b"\x00")
    return _des_encrypt_block(k, challenge[:8]) + _des_encrypt_block(k, challenge[8:16])


# ─────────────────────────────────────────── 最小 VNC 客户端
def recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("连接被对方关闭")
        buf += chunk
    return buf


def grab(host: str, port: int, password: str | None, out_path: Path,
         key8: bytes | None = None) -> int:
    print(f"== 连接 {host}:{port} ==")
    sock = socket.create_connection((host, port), timeout=15)

    # 1. 版本协商
    ver = recv_exact(sock, 12)
    print(f"  服务端版本: {ver.decode(errors='replace').strip()}")
    sock.sendall(b"RFB 003.008\n")

    # 2. 安全类型
    n = recv_exact(sock, 1)[0]
    types = list(recv_exact(sock, n)) if n else []
    print(f"  安全类型: {types}")
    if n == 0:
        reason_len = struct.unpack("!I", recv_exact(sock, 4))[0]
        reason = recv_exact(sock, reason_len).decode(errors="replace")
        print(f"  ❌ 服务端拒绝: {reason}")
        return 1

    if 2 in types and (password or key8):
        chosen = 2
    elif 1 in types:
        chosen = 1
    elif 2 in types:
        chosen = 2          # 需要密码但没提供，仍选它，后面会失败
    else:
        chosen = types[0]
    print(f"  选用安全类型: {chosen}" + ("（VNC 认证）" if chosen == 2 else "（无认证）"))
    sock.sendall(bytes([chosen]))

    if chosen == 2:
        if not password and not key8:
            print("  ❌ 需要密码但未提供")
            return 1
        challenge = recv_exact(sock, 16)
        if key8:
            print(f"  使用 vmx 的 RemoteDisplay.vnc.key 前 8 字节作 DES key: {key8[:8].hex()}")
            sock.sendall(raw_key_response(key8, challenge))
        else:
            sock.sendall(vnc_response(password, challenge))
    elif chosen == 1:
        pass
    else:
        # 其它类型（如 18/19 的 Tunnel/RA2）本最小实现不支持
        print(f"  ❌ 不支持的安全类型 {chosen}")
        return 1

    # 3. 安全结果
    result = struct.unpack("!I", recv_exact(sock, 4))[0]
    if result != 0:
        print(f"  ❌ 认证失败（result={result}）—— 密码可能不对")
        return 1
    print("  ✅ 认证通过")

    # 4. ClientInit（shared=1）
    sock.sendall(b"\x01")

    # 5. ServerInit
    w, h = struct.unpack("!HH", recv_exact(sock, 4))
    pf = recv_exact(sock, 16)
    name_len = struct.unpack("!I", recv_exact(sock, 4))[0]
    name = recv_exact(sock, name_len).decode(errors="replace")
    print(f"  分辨率: {w}x{h}   名称: {name!r}")

    # 6. SetPixelFormat：32bpp, depth 24, little endian, true color, BGRX
    #    这是 VNC 里最通用的一种，XnView/各种客户端都用它。
    sock.sendall(bytes([0, 0, 0, 0]))                       # padding
    sock.sendall(struct.pack("!BBBB", 32, 24, 0, 1))        # bpp, depth, big-endian-flag=0, true-colour
    sock.sendall(struct.pack("!HHH", 255, 255, 255))        # max R,G,B
    sock.sendall(struct.pack("!BBB", 16, 8, 0))             # red shift, green shift, blue shift
    sock.sendall(b"\x00\x00\x00")                           # padding

    # 7. SetEncodings：只要 Raw（0）
    sock.sendall(struct.pack("!BBH", 2, 0, 1) + struct.pack("!i", 0))

    # 8. 请求整屏一帧
    sock.sendall(struct.pack("!BBHHHH", 3, 0, 0, 0, w, h))
    print("  已请求帧缓冲...")

    # 9. 读一帧
    while True:
        msg = recv_exact(sock, 1)[0]
        if msg == 0:      # FramebufferUpdate
            break
        if msg in (1, 2, 3):        # SetColourMapEntries / Bell / ServerCutText
            # 这些消息长度不定，简单跳过会导致错位；对抓一帧而言通常遇不到。
            print(f"  ⚠️  收到消息类型 {msg}，尝试继续")
            continue
        print(f"  ⚠️  未知消息类型 {msg}")

    recv_exact(sock, 1)     # padding
    nrects = struct.unpack("!H", recv_exact(sock, 2))[0]
    print(f"  收到 {nrects} 个矩形")

    img = bytearray(b"\x00" * (w * h * 4))      # RGBA 输出缓冲
    for _ in range(nrects):
        x, y, rw, rh, enc = struct.unpack("!HHHHi", recv_exact(sock, 12))
        if enc != 0:
            print(f"  ⚠️  非 Raw 编码 {enc}，不支持")
            return 1
        data = recv_exact(sock, rw * rh * 4)
        for row in range(rh):
            src = row * rw * 4
            dst = ((y + row) * w + x) * 4
            for col in range(rw):
                s = src + col * 4
                d = dst + col * 4
                # BGRX -> RGBA
                img[d] = data[s + 2]
                img[d + 1] = data[s + 1]
                img[d + 2] = data[s]
                img[d + 3] = 255

    sock.close()

    # 10. 写 PNG（标准库 zlib + struct，不依赖 Pillow）
    def png_chunk(tag: bytes, payload: bytes) -> bytes:
        return (struct.pack("!I", len(payload)) + tag + payload
                + struct.pack("!I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    raw = bytearray()
    for row in range(h):
        raw.append(0)
        raw += img[row * w * 4:(row + 1) * w * 4]

    png = (b"\x89PNG\r\n\x1a\n"
           + png_chunk(b"IHDR", struct.pack("!IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + png_chunk(b"IDAT", zlib.compress(bytes(raw), 6))
           + png_chunk(b"IEND", b""))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(png)
    print(f"\n  ✅ 已保存: {out_path}  ({len(png)/1024:.1f} KB, {w}x{h})")
    return 0


def main() -> int:
    host = sys.argv[1] if len(sys.argv) > 1 else HOST
    port = int(sys.argv[2]) if len(sys.argv) > 2 else PORT
    cred = sys.argv[3] if len(sys.argv) > 3 else PASSWORD
    out = Path(sys.argv[4]) if len(sys.argv) > 4 else Path(r"F:\rpm-vm\screen.png")

    # 凭据可能是：明文口令，或 vmx 里的 base64 派生 key。
    # 判断依据：base64 解出来是 24 字节，且字面量里不含 '@' 等口令常用字符。
    key8 = None
    pw = cred or None
    if cred:
        try:
            import base64
            if "@" not in cred:
                blob = base64.b64decode(cred, validate=True)
                if len(blob) == 24:
                    key8 = blob
                    pw = None
                    print(f"凭据识别为 vmx 派生 key（{len(blob)} 字节）")
        except Exception:
            pass
    return grab(host, port, pw, out, key8)


if __name__ == "__main__":
    sys.exit(main())
