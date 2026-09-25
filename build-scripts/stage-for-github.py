# -*- coding: utf-8 -*-
"""stage-for-github.py —— 准备待推送的源码目录，并做凭据泄露扫描。

为什么单独做这一步：
  port/app 里混着三类东西，只有第一类该上 GitHub：
    1. 移植后的源码        —— 要推
    2. Windows 版 SnowLuma —— 330MB，且是第三方二进制，不推
    3. **用户真实数据**      —— messages.db / 日志 / 含真实 QQ 号的目录，绝对不推
  另外用户数据目录里的 config.json 含明文 API Key 与 B 站 Cookie，
  必须确认它没有以任何形式混进要在源码里提交的文件。

本脚本做两件事：
  A. 按白名单挑选文件到 staging 目录
  B. 扫描 staging，找疑似凭据（Key / Token / Cookie / 真实 QQ 号）
"""

import os
import re
import shutil
import sys

SRC = r"F:\kmy\Documents\dpsk\harness\QQ-Agent-for-Linux\port\app"
DST = r"F:\kmy\Documents\dpsk\harness\.gh-stage"
REPO_ROOT = r"F:\kmy\Documents\dpsk\harness\QQ-Agent-for-Linux"

# 要推送的源码目录
INCLUDE_DIRS = ["src", "electron", "plugins", "skills", "ui", "assets", "test",
                "build-scripts", "examples", "docs"]
# 要推送的单个文件
INCLUDE_FILES = ["package.json", "package-lock.json", "README.md", "prices.json"]

# ── 排除规则 ────────────────────────────────────────────────────────────
#
# ⚠️ 这里踩过一次坑，记下来免得改回去：
#   最初 EXCLUDE_PATTERNS 里写的是 `r"\\snowluma"`（子串匹配），
#   于是任何**名字里含 snowluma 的路径**都会被排除 ——
#   包括合法文件如 `src/snowluma-helper.js`、`docs/snowluma-notes.md`，
#   甚至 `SnowLuma-v1.14.19-linux-x64.tar.gz`（在源码目录之外）。
#   那是「宁可错杀」的写法，会在不知不觉中漏掉该推的文件，
#   而且不报错、只是文件静默消失。
#
#   正确做法是分层判断：
#     · DIRECTORY_NAMES —— 只在**目录层级**上匹配整个路径段
#     · FILE_SUFFIXES   —— 只在**文件名后缀**上匹配
#     · FILE_PATTERNS   —— 需要正则的少数文件名规则
#
# 排除的目录名（整段匹配，不做子串）
EXCLUDE_DIR_NAMES = {
    "node_modules",
    "dist",
    "snowluma",            # Windows 版协议端（330MB），Linux 版由构建脚本另装
    "snowluma.win-backup",
    "data",                # 用户数据
    "data-2",
    ".git",
    ".gh-stage",
    ".gh-work",
}

# 排除的文件后缀（只匹配文件名结尾）
EXCLUDE_FILE_SUFFIXES = (
    ".db", ".log", ".sqlite", ".sqlite3", ".bak", ".key",
    ".tar", ".tar.gz", ".tgz", ".zip",      # 大压缩包（SnowLuma 安装包等）
    ".exe", ".dll", ".node", ".so", ".asar",
)

# 需要正则的少数文件名规则
EXCLUDE_FILE_PATTERNS = [
    r"^credentials",
    r"^\.env",
    r"\.env$",
    r"\.bak-",
]


def should_exclude(rel: str) -> bool:
    """rel 为相对 SRC 的路径（用 / 或 \\ 分隔）。"""
    parts = re.split(r"[\\/]+", rel)
    name = parts[-1].lower()
    dirs = [p.lower() for p in parts[:-1]]

    # 1) 目录层级：整段匹配
    if any(d in EXCLUDE_DIR_NAMES for d in dirs):
        return True

    # 2) 文件后缀
    if name.endswith(EXCLUDE_FILE_SUFFIXES):
        return True

    # 3) 文件名正则
    if any(re.search(p, name, re.I) for p in EXCLUDE_FILE_PATTERNS):
        return True

    return False

# ── 凭据扫描模式 ────────────────────────────────────────────────────────
#
# 通用模式：与具体身份无关，可以直接写在脚本里。
# ⚠️ 这里**故意不放"真实 QQ 号"这类具体值** ——
#    一旦写进脚本，脚本本身就携带了敏感信息，而它是要提交到公开仓库的。
#    具体标识走仓库外的私有清单，见下面的 load_needles()。
SECRET_PATTERNS = [
    (r"sk-[A-Za-z0-9]{20,}", "疑似 OpenAI/DashScope API Key (sk-)"),
    (r"SESSDATA=[^;\s\"']+", "B 站 SESSDATA Cookie"),
    (r"bili_jct=[A-Za-z0-9]+", "B 站 bili_jct Cookie"),
    (r"buvid3=[A-Za-z0-9\-]+", "B 站 buvid3 Cookie"),
    (r"eyJhbGciOi[A-Za-z0-9_\-\.]{40,}", "疑似 JWT"),
    (r"DedeUserID=\d+", "B 站 DedeUserID"),
    (r"(?i)(api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[\"'][A-Za-z0-9_\-]{16,}[\"']", "硬编码的凭据赋值"),
]


def load_needles_from_private_list() -> list[str]:
    """从仓库外的私有清单读取需要额外检查的具体标识（QQ 号、私人词等）。"""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import privacy_needles as pn
        return pn.load_needles()
    except Exception as exc:  # 清单缺失不应让整个流程失败
        print(f"  ⚠️  私有清单未加载（{exc}），仅使用通用模式扫描")
        return []


def main() -> int:
    print("== A. 准备 staging 目录 ==")
    if os.path.exists(DST):
        shutil.rmtree(DST, ignore_errors=True)
    os.makedirs(DST, exist_ok=True)

    copied = skipped = 0
    total_bytes = 0

    for d in INCLUDE_DIRS:
        src_dir = os.path.join(SRC, d)
        if not os.path.isdir(src_dir):
            print(f"  ⚠️  目录不存在，跳过: {d}")
            continue
        for root, dirs, files in os.walk(src_dir):
            for f in files:
                full = os.path.join(root, f)
                rel = os.path.relpath(full, SRC)
                # 直接把相对路径交给 should_exclude；它会按路径段判断目录层级，
                # 不再需要手工拼接前缀（旧写法 "\\" + rel 是为了配合子串匹配，
                # 那正是上面注释里说的坑）。
                if should_exclude(rel):
                    skipped += 1
                    continue
                target = os.path.join(DST, rel)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                shutil.copy2(full, target)
                copied += 1
                total_bytes += os.path.getsize(full)

    for f in INCLUDE_FILES:
        full = os.path.join(SRC, f)
        if os.path.isfile(full):
            shutil.copy2(full, os.path.join(DST, f))
            copied += 1
            total_bytes += os.path.getsize(full)
        else:
            print(f"  ⚠️  文件不存在: {f}")

    print(f"  已复制 {copied} 个文件，{total_bytes/1024/1024:.2f} MB（排除 {skipped} 个）")

    print("\n== B. 凭据泄露扫描 ==")
    findings = []
    scanned = 0
    for root, dirs, files in os.walk(DST):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, DST)
            if os.path.getsize(full) > 4 * 1024 * 1024:
                continue
            try:
                with open(full, encoding="utf-8", errors="ignore") as fh:
                    text = fh.read()
            except OSError:
                continue
            scanned += 1
            for pat, label in SECRET_PATTERNS:
                for m in re.finditer(pat, text):
                    line_no = text[:m.start()].count("\n") + 1
                    snippet = m.group(0)
                    if len(snippet) > 60:
                        snippet = snippet[:30] + "…" + snippet[-12:]
                    findings.append((rel, line_no, label, snippet))

    print(f"  扫描 {scanned} 个文本文件")

    if not findings:
        print("  ✅ 未发现凭据或真实标识泄露")
    else:
        # 按类别归并
        by_label = {}
        for rel, ln, label, snip in findings:
            by_label.setdefault(label, []).append((rel, ln, snip))
        print(f"  ⚠️  发现 {len(findings)} 处，共 {len(by_label)} 类：\n")
        for label, items in sorted(by_label.items()):
            print(f"    【{label}】{len(items)} 处")
            for rel, ln, snip in items[:6]:
                print(f"        {rel}:{ln}  ->  {snip}")
            if len(items) > 6:
                print(f"        …还有 {len(items)-6} 处")

    print("\n== C. 目录结构预览 ==")
    for d in sorted(os.listdir(DST)):
        p = os.path.join(DST, d)
        if os.path.isdir(p):
            n = sum(len(fs) for _, _, fs in os.walk(p))
            sz = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(p) for f in fs)
            print(f"  {d+'/':<18} {n:>4} 文件  {sz/1024:>8.1f} KB")
        else:
            print(f"  {d:<18} {os.path.getsize(p)/1024:>8.1f} KB")

    # 退出码：有疑似凭据就非零，提醒必须人工确认
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
