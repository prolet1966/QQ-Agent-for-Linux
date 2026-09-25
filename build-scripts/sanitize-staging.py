# -*- coding: utf-8 -*-
"""sanitize-staging.py —— 清除 staging 目录里硬编码的真实标识，替换为占位值。

## 背景

插件发布件的默认值里可能硬编码了真实身份信息。实测发现过这类：

    plugins/kb-growth/plugin.json     settings.adminWriteQq: "<真实 QQ 号>"
    plugins/kb-growth/lib/kb-config.js admin.writeQq: ['<真实 QQ 号>']
    plugins/wake-policy/plugin.json    keywordsByUser 示例: {"<真实 QQ 号>":["<私人词>", ...]}
    plugins/wake-policy/lib/wake-rules.js  注释里的写法示例同上

这些是**插件默认值**（不是用户运行时数据）。若原样发布，等于公开
使用者的 QQ 号与其私人关键词。

## 敏感值从哪来

**不在本脚本里硬编码。** 原因见 `privacy_needles.py` 的模块注释 ——
简言之：把敏感值写进清理脚本，清理工具自己就成了泄露源
（脚本会被提交到公开仓库），而且每次运行都要先替换自己。
实测出现过替换数从 6 处涨到 14 处，多出来的正是这几个脚本自身。

现在改为从仓库外的私有清单读取：

    ~/.qq-agent-privacy-needles.txt      （可用 QQ_AGENT_PRIVACY_NEEDLES 覆盖）

## 替换原则

只动标识与私人内容，**不改结构与语义** ——
使接收方拿到的是「格式正确的中性示例默认值」，而不是「某人的真实配置」。

## 行尾处理

写回时保持原文件的行尾。曾因统一写成 LF，把 CRLF 文件（如 src/personas.js）
变成"几乎每一行都改了"，真实改动只有 1-2 处，审阅者无法判断改了什么。
"""

import os
import sys

# 与脚本同目录的隐私清单加载模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import privacy_needles as pn  # noqa: E402

STAGE = r"F:\kmy\Documents\dpsk\harness\.gh-stage"


def main() -> int:
    if not os.path.isdir(STAGE):
        print(f"❌ staging 不存在: {STAGE}")
        return 2

    print("== 加载敏感值清单 ==")
    needles = pn.load_needles()
    if not needles:
        print("\n  ⚠️  没有可替换的值，本步骤跳过（不是失败）")
        return 0

    ids, words = pn.split_identifiers(needles)
    print(f"  ID 类 {len(ids)} 条，词语类 {len(words)} 条")

    # 每个值配一个占位值（词语按出现顺序配中性示例词）
    replacements: list[tuple[str, str]] = []
    for v in ids:
        replacements.append((v, pn.placeholder_for(v)))
    for i, v in enumerate(words):
        replacements.append((v, pn.placeholder_for(v, i)))

    changed_files = []
    hit_total = 0
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

            # 逐个替换（顺序无所谓，值之间不会互相包含）
            file_hits = 0
            for real, ph in replacements:
                if not real:
                    continue
                c = text.count(real)
                if c:
                    text = text.replace(real, ph)
                    file_hits += c
                    hit_total += c

            if text != original:
                with open(full, "wb") as fh:
                    fh.write(text.encode("utf-8"))
                changed_files.append((os.path.relpath(full, STAGE), file_hits))
                if uses_crlf:
                    crlf_preserved.append(os.path.relpath(full, STAGE))

    print()
    print("== 替换结果 ==")
    print(f"  替换总次数: {hit_total} 处")
    print(f"  改动文件 {len(changed_files)} 个：")
    for rel, n in changed_files:
        print(f"    {rel}  ({n} 处)")
    if crlf_preserved:
        print(f"  其中 CRLF 行尾已保持原样: {len(crlf_preserved)} 个")

    # ── 行尾完整性复查 ──────────────────────────────────────────────────
    print("\n== 行尾完整性复查 ==")
    # ── 行尾完整性复查 ──────────────────────────────────────────────────
    print("\n== 行尾完整性复查 ==")
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
            for v in needles:
                if v and v in text:
                    leftovers.append((rel, v if v.isdigit() else f"私人词（{len(v)} 字）"))

    if leftovers:
        print("  ❌ 仍有残留：")
        for rel, what in leftovers[:20]:
            print(f"    {rel}: {what}")
        if len(leftovers) > 20:
            print(f"    …还有 {len(leftovers) - 20} 处")
        return 1

    print(f"  ✅ 清单里的 {len(needles)} 个值已全部清除干净")

    # 顺带确认占位值确实写进去了。
    # 占位值集合从 replacements 里取，不再依赖模块级常量
    # （那些常量已随敏感值一起移出脚本，见 privacy_needles.py）。
    placeholders = {ph for _real, ph in replacements}
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
        hits = 0
        with open(p, encoding="utf-8") as fh:
            for i, line in enumerate(fh, 1):
                if any(ph and ph in line for ph in placeholders):
                    print(f"    L{i}: {line.strip()[:120]}")
                    hits += 1
        if not hits:
            print("    （本文件未出现占位值 —— 可能本就不含敏感值，属正常）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
