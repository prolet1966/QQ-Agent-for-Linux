#!/usr/bin/env bash
# 查询 SnowLuma 官方 release 的全部产物，确认是否提供 Linux 版本
set -u
API="https://api.github.com/repos/SnowLuma/SnowLuma"

echo "===== 最新 release ====="
curl -sSL -H 'Accept: application/vnd.github+json' "$API/releases/latest" \
  | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception as e:
    print("解析失败:", e); sys.exit(0)
if "tag_name" not in d:
    print("响应:", json.dumps(d)[:500]); sys.exit(0)
print("tag:", d.get("tag_name"), "| published:", d.get("published_at"))
print("assets (%d):" % len(d.get("assets",[])))
for a in d.get("assets",[]):
    print("   %-46s %10s  %s" % (a["name"], a["size"], a["browser_download_url"]))
'

echo
echo "===== 最近 10 个 release 的产物名 ====="
curl -sSL -H 'Accept: application/vnd.github+json' "$API/releases?per_page=10" \
  | python3 -c '
import json,sys
d=json.load(sys.stdin)
if not isinstance(d,list):
    print("响应:", json.dumps(d)[:300]); sys.exit(0)
for r in d:
    print("\n%s  (%s)" % (r.get("tag_name"), (r.get("published_at") or "")[:10]))
    if not r.get("assets"):
        print("   <无 assets>")
    for a in r.get("assets",[]):
        print("   %-46s %10s" % (a["name"], a["size"]))
'
