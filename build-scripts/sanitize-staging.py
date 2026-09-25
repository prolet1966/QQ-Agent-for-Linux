# -*- coding: utf-8 -*-
"""sanitize-staging.py —— 清除 staging 目录里硬编码的真实标识，替换为占位值。

背景：凭据扫描发现 6 处硬编码了真实 QQ 号，且 wake-policy 的例子还带出私人关键词：

    plugins/kb-growth/plugin.json     "adminWriteQq": "10001"
    plugins/kb-growth/lib/kb-config.js admin: { writeQq: ['10001'] }
    plugins/wake-policy/plugin.json   {"10001":["在吗","早安"]}
    plugins/wake-policy/lib/wake-rules.js  {"10001": ["早安","在吗"]}

这些是**插件默认值**（不是用户运行时数据），若原样发布，等于公开：
  1. 你的 QQ 号
  2. 你给自己设的私人唤醒关键词

替换原则：只动标识与私人内容，**不改结构与语义**，
使接收方拿到的是「有正确格式的示例默认值」，而不是「某人的真实配置」。

对应关系：
  10001            -> 10001        （示例管理员 QQ 号）
  "早安","在吗"/"在吗","早安" -> "早安","在吗"  （示例关键词，中性）
"""

import os
import re
import sys

STAGE = r"F:\kmy\Documents\dpsk\harness\.gh-stage"

REAL_QQ = "10001"
PLACEHOLDER_QQ = "10001"

# 私人关键词 -> 中性示例词。注意两条日志里顺序不同（["早安","在吗"] / ["在吗","早安"]）
PRIVATE_WORDS = ["早安", "在吗"]
PLACEHOLDER_WORDS = ["早安", "在吗"]


def main() -> int:
    if not os.path.isdir(STAGE):
        print(f"❌ staging 不存在: {STAGE}")
        return 2

    changed_files = []
    qq_hits = 0
    word_hits = 0
    crlf_preserved = []
    crlf_converted = []

    for root, _dirs, files in os.walk(STAGE):
        for fname in files:
            full = os.path.join(root, fname)
            if os.path.getsize(full) > 4 * 1024 * 1024:
                continue

            # 二进制探测：含 NUL 字节的按二进制处理，不做文本替换
            with open(full, "rb") as fh:
                raw = fh.read()
            if b"\x00" in raw[:8192]:
                continue

            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                continue

            original = text
            # ⚠️ 行尾保持：原文件若用 CRLF，写回时也必须用 CRLF。
            #    第一次实现在这里用了 newline=""，把 personas.js / stickers.js
            #    的 CRLF 全变成 LF，导致 diff 显示「几乎每一行都改了」——
            #    真实改动其实只有 1-2 处。那种 diff 让审阅者无法判断改了什么，
            #    属于自己给评审制造障碍。
            uses_crlf = "\r\n" in text

            # 1) QQ 号
            n = text.count(REAL_QQ)
            if n:
                text = text.replace(REAL_QQ, PLACEHOLDER_QQ)
                qq_hits += n

            # 2) 私人关键词（逐个替换，保持数组顺序不变）
            for real, ph in zip(PRIVATE_WORDS, PLACEHOLDER_WORDS):
                if real in text:
                    c = text.count(real)
                    text = text.replace(real, ph)
                    word_hits += c

            if text != original:
                with open(full, "wb") as fh:
                    fh.write(text.encode("utf-8"))
                changed_files.append((os.path.relpath(full, STAGE), n))
                if uses_crlf:
                    crlf_preserved.append(os.path.relpath(full, STAGE))

    print(f"== 替换结果 ==")
    print(f"  QQ 号替换: {qq_hits} 处")
    print(f"  私人关键词替换: {word_hits} 处")
    print(f"  改动文件 {len(changed_files)} 个：")
    for rel, n in changed_files:
        print(f"    {rel}  (QQ 号 {n} 处)")
    if crlf_preserved:
        print(f"  其中 CRLF 行尾已保持原样: {len(crlf_preserved)} 个")

    # ── 行尾完整性复查 ──────────────────────────────────────────────────
    print("\n== 行尾完整性复查 ==")
    import glob
    eol_bad = []
    for root, _dirs, files in os.walk(STAGE):
        for fname in files:
            full = os.path.join(root, fname)
            try:
                with open(full, "rb") as fh:
                    b = fh.read()
            except OSError:
                continue
            if b"\x00" in b[:8192]:
                continue
            cr = b.count(b"\r")
            lf = b.count(b"\n")
            # CRLF 文件里 CR 与 LF 数量应相等；不等说明行尾被混改
            if cr and cr != lf:
                eol_bad.append((os.path.relpath(full, STAGE), cr, lf))
    if eol_bad:
        print("  ⚠️  行尾异常（CR 与 LF 数量不等）：")
        for rel, cr, lf in eol_bad[:10]:
            print(f"    {rel}: CR={cr} LF={lf}")
    else:
        print("  ✅ 无行尾混改（CR 与 LF 数量一致）")

    # ── 复查：确认已无残留 ────────────────────────────────────────────
    print("\n== 复查：确认已无残留 ==")
    leftovers = []
    for root, _dirs, files in os.walk(STAGE):
        for fname in files:
            full = os.path.join(root, fname)
            if os.path.getsize(full) > 4 * 1024 * 1024:
                continue
            try:
                with open(full, encoding="utf-8") as fh:
                    text = fh.read()
            except (OSError, UnicodeDecodeError):
                continue
            rel = os.path.relpath(full, STAGE)
            if REAL_QQ in text:
                leftovers.append((rel, "真实 QQ 号"))
            for w in PRIVATE_WORDS:
                if w in text:
                    leftovers.append((rel, f"私人词 {w}"))

    if leftovers:
        print("  ❌ 仍有残留：")
        for rel, what in leftovers:
            print(f"    {rel}: {what}")
        return 1

    print("  ✅ 真实 QQ 号与私人关键词已清除干净")

    # 顺带确认占位值确实写进去了
    print("\n== 抽查替换后的内容 ==")
    for rel in [
        r"plugins\kb-growth\plugin.json",
        r"plugins\kb-growth\lib\kb-config.js",
        r"plugins\wake-policy\plugin.json",
        r"plugins\wake-policy\lib\wake-rules.js",
    ]:
        p = os.path.join(STAGE, rel)
        if not os.path.isfile(p):
            continue
        print(f"  --- {rel} ---")
        with open(p, encoding="utf-8") as fh:
            for i, line in enumerate(fh, 1):
                if PLACEHOLDER_QQ in line or any(w in line for w in PLACEHOLDER_WORDS):
                    print(f"    L{i}: {line.strip()[:120]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
