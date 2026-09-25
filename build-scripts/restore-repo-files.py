# -*- coding: utf-8 -*-
"""restore-repo-files.py —— 从历史提交里取回被误删的仓库级文件。

## 背景

push-via-api.py 把「staging 里没有的文件」当成「应当删除」，
结果删掉了仓库根部的三个东西：

    .gitattributes                   行尾规范化规则
    LICENSE                          上游 MIT 许可（MIT 要求随附，绝不能少）
    .github/ISSUE_TEMPLATE/*.yml     Issue 模板
    .github/PULL_REQUEST_TEMPLATE.md

**根本原因**：staging 只镜像「源码树」（port/app/），
而这三个是**仓库根自己的文件**，不在源码树里。
推送脚本却把它们当作"已从源码树移除 → 应删除"。

## 修法

1. 从误删前的提交里取回这些文件的内容（git 的 objects 还在，取历史很可靠）
2. 写进 staging，让它成为**完整的仓库镜像**而不只是源码树镜像
3. 同时改造 push 脚本：只允许删除「受管理的目录前缀」下的文件，
   仓库根部的 .gitattributes / LICENSE / .github 永不在删除范围内
"""

import base64
import json
import os
import subprocess
import sys

REPO = "prolet1966/QQ-Agent-for-Linux"
STAGE = r"F:\kmy\Documents\dpsk\harness\.gh-stage"

# 误删前最后一个良好提交（81bc2ea 是删之前的那次）
GOOD_COMMIT = "81bc2ea"

FILES = [
    ".gitattributes",
    "LICENSE",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
]


def gh_json(args):
    r = subprocess.run(["gh"] + args, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        return None
    out = (r.stdout or "").strip()
    return json.loads(out) if out.startswith(("{", "[")) else out


def main() -> int:
    print(f"== 从提交 {GOOD_COMMIT} 取回文件 ==")
    ok = 0
    fail = 0

    for path in FILES:
        # 先看远端当前是否真的缺
        cur = gh_json(["api", f"repos/{REPO}/contents/{path}"])
        if cur and cur.get("sha"):
            print(f"  ℹ️  {path} 远端已存在，跳过")
            ok += 1
            continue

        obj = gh_json(["api", f"repos/{REPO}/contents/{path}?ref={GOOD_COMMIT}"])
        if not obj or not obj.get("content"):
            print(f"  ❌ 取不到 {path}")
            fail += 1
            continue

        data = base64.b64decode(obj["content"])
        dest = os.path.join(STAGE, path.replace("/", os.sep))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(data)
        print(f"  ✅ {path}  ({len(data)} 字节) → staging")
        ok += 1

    print(f"\n  取回 {ok} 个，失败 {fail} 个")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
