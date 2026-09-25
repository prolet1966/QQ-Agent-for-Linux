# -*- coding: utf-8 -*-
"""check-staging-diff.py —— 诊断 staging 与远端到底差在哪。

起因：push-via-api.py 报告 59 个文件"修改"，但本轮我只动了文档与少量脚本，
不可能有 59 个源文件真的变了。怀疑是行尾差异（仓库里是 LF，本机源码树是 CRLF）。

本脚本抽查若干文件，把「本地 blob 哈希 / 远端 blob 哈希 / 行尾统计」都打出来，
用来判断差异是真实内容变化还是纯粹的行尾表示不同。
不猜，直接看数据。
"""

import hashlib
import json
import os
import subprocess

REPO = "prolet1966/QQ-Agent-for-Linux"
STAGE = r"F:\kmy\Documents\dpsk\harness\.gh-stage"


def blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def gh_json(args):
    r = subprocess.run(["gh"] + args, capture_output=True, text=True, encoding="utf-8")
    return json.loads(r.stdout)


tree = gh_json(["api", f"repos/{REPO}/git/trees/main?recursive=1"])
remote = {i["path"]: i["sha"] for i in tree["tree"] if i.get("type") == "blob"}
print(f"远端 blob 数: {len(remote)}\n")

# 全量比对
same = 0
diff_eol_only = 0
diff_real = 0
missing = 0
samples_eol = []
samples_real = []

for root, _dirs, names in os.walk(STAGE):
    for n in names:
        full = os.path.join(root, n)
        rel = os.path.relpath(full, STAGE).replace("\\", "/")
        with open(full, "rb") as fh:
            data = fh.read()
        lsha = blob_sha(data)
        rsha = remote.get(rel)
        if rsha is None:
            missing += 1
            continue
        if lsha == rsha:
            same += 1
            continue
        # 不同 —— 判断是否仅行尾差异
        norm = data.replace(b"\r\n", b"\n")
        if blob_sha(norm) == rsha:
            diff_eol_only += 1
            if len(samples_eol) < 5:
                samples_eol.append(rel)
        else:
            diff_real += 1
            if len(samples_real) < 10:
                samples_real.append(rel)

print("== 全量比对结果 ==")
print(f"  完全一致        : {same}")
print(f"  仅行尾差异(CRLF) : {diff_eol_only}")
print(f"  真实内容差异     : {diff_real}")
print(f"  staging 有而远端没有: {missing}")

if samples_eol:
    print("\n  仅行尾差异的样例：")
    for s in samples_eol:
        print(f"    {s}")
if samples_real:
    print("\n  真实内容差异：")
    for s in samples_real:
        print(f"    {s}")

# 远端有而 staging 没有的（会被 push 脚本当成删除）
stage_paths = set()
for root, _dirs, names in os.walk(STAGE):
    for n in names:
        full = os.path.join(root, n)
        stage_paths.add(os.path.relpath(full, STAGE).replace("\\", "/"))

only_remote = sorted(p for p in remote if p not in stage_paths)
print(f"\n== 远端有、staging 没有的（{len(only_remote)} 个）—— push 脚本会当成删除 ==")
for p in only_remote[:20]:
    print(f"    D {p}")
if len(only_remote) > 20:
    print(f"    …还有 {len(only_remote)-20} 个")
