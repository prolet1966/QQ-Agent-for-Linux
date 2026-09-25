# -*- coding: utf-8 -*-
"""push-via-api.py —— 用 GitHub Git Data API 提交改动（git push 不通时的备用通道）。

背景：本机 git 直连 github.com 时通时断，实测连续 8 次推送全部失败；
而 `gh api`（走 api.github.com）稳定可用（1 秒级）。

Git Data API 的优势是**一次提交**：创建 blob → 创建 tree → 创建 commit → 更新 ref，
不需要按文件逐个提交（Contents API 的局限），改动多个文件也只产生一个 commit。

本脚本只重建**受影响的文件**，其余条目沿用远端现有 tree（base_tree），
避免把 348 个文件重新上传一遍。

用法：python push-via-api.py "提交信息" <要提交的文件1> <文件2> ...
文件路径相对仓库根，且必须存在于本地工作副本目录中。
"""

import base64
import json
import os
import subprocess
import sys

REPO = "prolet1966/QQ-Agent-for-Linux"
BRANCH = "main"
WORK = r"F:\kmy\Documents\dpsk\harness\.gh-work"


def gh(args, input_path=None, check=True):
    cmd = ["gh"] + args
    if input_path:
        cmd += ["--input", input_path]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if check and r.returncode != 0:
        print(f"  ❌ gh {' '.join(args)}")
        print(f"     {(r.stderr or r.stdout or '').strip()[:500]}")
        sys.exit(1)
    return r


def gh_json(args, payload=None):
    """调用 gh api，payload 为 dict 时走临时文件（避免命令行长度与转义问题）。"""
    tmp = None
    if payload is not None:
        tmp = os.path.join(os.environ.get("TEMP", "/tmp"), "gh-payload.json")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
    r = gh(args, input_path=tmp)
    if tmp and os.path.exists(tmp):
        os.remove(tmp)
    out = (r.stdout or "").strip()
    return json.loads(out) if out.startswith(("{", "[")) else out


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2

    message = sys.argv[1]
    paths = sys.argv[2:]

    print("== 1. 读取当前 main 的 HEAD ==")
    ref = gh_json(["api", f"repos/{REPO}/git/ref/heads/{BRANCH}"])
    head_sha = ref["object"]["sha"]
    print(f"  HEAD: {head_sha[:10]}")

    print("\n== 2. 读取 HEAD 的 tree（作为 base_tree）==")
    commit = gh_json(["api", f"repos/{REPO}/git/commits/{head_sha}"])
    base_tree = commit["tree"]["sha"]
    print(f"  base_tree: {base_tree[:10]}")

    print("\n== 3. 为每个改动文件创建 blob ==")
    entries = []
    for p in paths:
        local = os.path.join(WORK, p.replace("/", os.sep))
        if not os.path.isfile(local):
            print(f"  ❌ 本地文件不存在: {local}")
            return 1
        with open(local, "rb") as fh:
            content = fh.read()
        blob = gh_json(
            ["api", "--method", "POST", f"repos/{REPO}/git/blobs"],
            {
                "content": base64.b64encode(content).decode("ascii"),
                "encoding": "base64",
            },
        )
        entries.append({
            "path": p,
            "mode": "100644",
            "type": "blob",
            "sha": blob["sha"],
        })
        print(f"  ✅ {p}  ({len(content)} 字节)  blob {blob['sha'][:10]}")

    print("\n== 4. 创建 tree（基于 base_tree，只覆盖受影响条目）==")
    tree = gh_json(
        ["api", "--method", "POST", f"repos/{REPO}/git/trees"],
        {"base_tree": base_tree, "tree": entries},
    )
    print(f"  新 tree: {tree['sha'][:10]}")

    print("\n== 5. 创建 commit ==")
    new_commit = gh_json(
        ["api", "--method", "POST", f"repos/{REPO}/git/commits"],
        {"message": message, "tree": tree["sha"], "parents": [head_sha]},
    )
    print(f"  新 commit: {new_commit['sha'][:10]}")

    print("\n== 6. 更新 main 引用 ==")
    gh_json(
        ["api", "--method", "PATCH", f"repos/{REPO}/git/refs/heads/{BRANCH}"],
        {"sha": new_commit["sha"], "force": False},
    )
    print(f"  ✅ main 已指向 {new_commit['sha'][:10]}")

    print("\n== 7. 核对远端 ==")
    check = gh_json(["api", f"repos/{REPO}/commits/{BRANCH}"])
    print(f"  远端最新提交: {check['sha'][:10]}  {check['commit']['message'].splitlines()[0]}")
    for p in paths:
        info = gh_json(["api", f"repos/{REPO}/contents/{p}?ref={BRANCH}"])
        print(f"  {p}: {info['size']} 字节  sha {info['sha'][:10]}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
