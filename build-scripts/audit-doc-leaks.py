# -*- coding: utf-8 -*-
"""audit-doc-leaks.py —— 检查我写的文档里是否残留真实标识。

起因：sanitize-staging.py 这轮的替换数是 7 处 QQ 号 / 13 处私人词，
比上一轮（6 / 11）多 —— 说明**我新写的文档里引用了真实标识**。
交接文档里为了说明"清理过什么"而列了原始值，那些原始值本身就不该出现在要发布的文件里。
"""

import os
import re

REAL_IDS = ["10001", "2215188985"]
REAL_WORDS = ["早安", "在吗"]
PLACEHOLDERS = ["10001", "早安", "在吗"]

DOC_DIRS = [
    r"F:\kmy\Documents\dpsk\harness\QQ-Agent-for-Linux\docs",
    r"F:\kmy\Documents\dpsk\harness\.gh-stage\docs",
    r"F:\kmy\Documents\dpsk\harness\QQ-Agent-for-Linux\port\app\docs",
]


def scan(path: str, needles: list[str]) -> list[tuple[int, str]]:
    hits = []
    try:
        with open(path, encoding="utf-8") as fh:
            for i, line in enumerate(fh, 1):
                for n in needles:
                    if n in line:
                        hits.append((i, line.strip()[:110]))
                        break
    except (OSError, UnicodeDecodeError):
        pass
    return hits


print("=" * 78)
print("检查：文档里是否残留真实标识")
print("=" * 78)

for d in DOC_DIRS:
    if not os.path.isdir(d):
        continue
    print(f"\n【目录】{d}")
    for name in sorted(os.listdir(d)):
        p = os.path.join(d, name)
        if not os.path.isfile(p):
            continue

        real = scan(p, REAL_IDS + REAL_WORDS)
        ph = scan(p, PLACEHOLDERS)

        if real:
            print(f"  ❌ {name}  —— 含真实标识 {len(real)} 处")
            for ln, text in real:
                print(f"       L{ln}: {text}")
        elif ph:
            print(f"  ⚠️  {name}  —— 含占位值 {len(ph)} 处（若文档本身就在讲清理，属正常）")
            for ln, text in ph[:4]:
                print(f"       L{ln}: {text}")

print()
print("=" * 78)
print("结论说明")
print("=" * 78)
print("""
两类命中要区别对待：

· 在 **工作区文档**（F:...\\docs\\）里出现真实标识 —— 只要不推送就没问题，
  但因为交接文档是给人看的，写明"清理了哪个 QQ 号"其实没必要，
  用占位符描述同样能说清楚。

· 在 **staging**（.gh-stage\\docs\\）里出现真实标识 —— 这是要推送的内容，
  必须在推送前清除。

· 出现占位值（10001 / 早安 / 在吗）—— 如果文档本身在讲解"清理过程"，
  出现占位值是正常的、也是应该的；出现真实值才是问题。
""")
