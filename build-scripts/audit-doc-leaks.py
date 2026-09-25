# -*- coding: utf-8 -*-
"""audit-doc-leaks.py —— 检查 staging 与文档里是否残留真实身份标识。

## 为什么需要它（单独于 sanitize-staging.py）

`sanitize-staging.py` 会把源码里的敏感值替换成占位值。
但**文档**是另一回事：文档里为了说明"清理过什么"，可能引用了原值本身。
实测就踩过 —— 我在交接文档里写了被清理的真实 QQ 号与私人词作为对照，
结果文档自己变成了泄露源。

而且文档会随仓库分发，风险与源码相同。所以需要独立一步复查。

## 敏感值从哪来

同样**不在本脚本里硬编码**（原因见 `privacy_needles.py`）。
从仓库外的私有清单读取：

    ~/.qq-agent-privacy-needles.txt

## 判定

- ❌ staging 里出现真实值 → 必须处理，这是要发布的内容
- ⚠️  出现占位值（10001 / 早安 / 在吗）→ 若文档在讲"清理过程"，属正常
- 工作区文档（未发布）出现真实值 → 也建议清掉：文档会被传阅、截图、转发
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import privacy_needles as pn  # noqa: E402

ROOT = r"F:\kmy\Documents\dpsk\harness"
STAGE = os.path.join(ROOT, ".gh-stage")
WORK_DOCS = os.path.join(ROOT, r"QQ-Agent-for-Linux\docs")
APP_DOCS = os.path.join(ROOT, r"QQ-Agent-for-Linux\port\app\docs")

# 只扫这些后缀（文档与文本源码）
TEXT_EXT = (".md", ".txt", ".js", ".mjs", ".cjs", ".json", ".sh", ".py", ".yml", ".yaml")


def scan_file(path: str, needles: list[str]) -> list[tuple[int, str, str]]:
    """返回 [(行号, 命中的值, 该行片段)]。"""
    hits = []
    try:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            for i, line in enumerate(fh, 1):
                for v in needles:
                    if v and v in line:
                        hits.append((i, v, line.strip()[:110]))
                        break
    except OSError:
        pass
    return hits


def walk_text_files(root: str):
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if name.lower().endswith(TEXT_EXT):
                yield os.path.join(dirpath, name)


def main() -> int:
    print("=" * 76)
    print("隐私标识复查")
    print("=" * 76)

    print("\n== 加载敏感值清单 ==")
    needles = pn.load_needles()
    if not needles:
        print("\n  ⚠️  无清单，无法复查 —— 请先创建私有清单文件")
        return 0

    ids, words = pn.split_identifiers(needles)
    print(f"  ID 类 {len(ids)} 条，词语类 {len(words)} 条")

    # 占位值用于区分"正常引用"与"泄露"
    placeholders = {pn.placeholder_for(v) for v in needles}
    print(f"  占位值: {sorted(placeholders)}")

    total_real = 0
    total_ph = 0

    # ── 1. staging（要发布的内容）──────────────────────────────────────
    print("\n" + "─" * 76)
    print("【1】staging —— ⚠️ 这是要发布的内容，出现真实值即阻断")
    print("─" * 76)
    if not os.path.isdir(STAGE):
        print("  （staging 不存在，先跑 stage-for-github.py）")
    else:
        stage_hits = []
        for p in walk_text_files(STAGE):
            h = scan_file(p, needles)
            if h:
                stage_hits.append((os.path.relpath(p, STAGE), h))
        if stage_hits:
            total_real += sum(len(h) for _n, h in stage_hits)
            print(f"  ❌ 命中 {len(stage_hits)} 个文件：")
            for rel, h in stage_hits[:15]:
                print(f"    {rel}  ({len(h)} 处)")
                for ln, v, text in h[:3]:
                    masked = v if v.isdigit() is False else f"{v[:3]}***{v[-3:]}"
                    print(f"        L{ln}: {text}")
            print("\n  → 先跑 sanitize-staging.py，或用私有清单核查来源")
        else:
            print("  ✅ 未发现真实标识")

    # ── 2. 文档目录 ────────────────────────────────────────────────────
    for idx, (label, d) in enumerate(
        [("工作区 docs/（未发布，但会被传阅）", WORK_DOCS),
         ("源码树 docs/（随源码走）", APP_DOCS)], start=2
    ):
        print("\n" + "─" * 76)
        print(f"【{idx}】{label}")
        print("─" * 76)
        if not os.path.isdir(d):
            print("  （目录不存在）")
            continue
        found = False
        for p in walk_text_files(d):
            h = scan_file(p, needles)
            if h:
                found = True
                total_real += len(h)
                print(f"  ❌ {os.path.basename(p)}  ({len(h)} 处)")
                for ln, v, text in h[:4]:
                    print(f"      L{ln}: {text}")
            else:
                ph_hits = [ln for ln, line in
                           ((i, l) for i, l in enumerate(open(p, encoding='utf-8', errors='ignore'), 1))
                           if any(ph in line for ph in placeholders)]
                if ph_hits:
                    total_ph += len(ph_hits)
                    print(f"  ⚠️  {os.path.basename(p)} —— 含占位值 {len(ph_hits)} 处（讲解清理过程时属正常）")
        if not found:
            print("  ✅ 未发现真实标识")

    # ── 结论 ───────────────────────────────────────────────────────────
    print("\n" + "=" * 76)
    if total_real:
        print(f"❌ 发现 {total_real} 处真实标识残留 —— 发布前必须清除")
        print("=" * 76)
        return 1

    print("✅ 未发现真实标识残留（占位值出现属正常）")
    print("=" * 76)
    return 0


if __name__ == "__main__":
    sys.exit(main())
