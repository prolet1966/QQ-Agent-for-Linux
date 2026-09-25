#!/usr/bin/env bash
# syntax-check.sh —— 对 build-scripts 下所有 shell/python 脚本做语法检查。
#
# 为什么需要它：
#   从 PowerShell 调 `wsl -- bash -c '...'` 时，脚本里的 $VAR 会被 PowerShell
#   先展开成空，导致命令错乱（本项目在 $c/$A/$HOME/$D/$f/$u/$URL/$p 上都踩过）。
#   写成文件执行，内外两层 shell 都不再二次解析。

set -uo pipefail

DIR="/mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/build-scripts"

echo "== Bash 脚本语法检查 =="
sh_ok=0; sh_bad=0
for f in "$DIR"/*.sh; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  if bash -n "$f" 2>/tmp/synerr; then
    printf "  ✅ %s\n" "$name"
    sh_ok=$((sh_ok+1))
  else
    printf "  ❌ %s\n" "$name"
    sed 's/^/       /' /tmp/synerr | head -3
    sh_bad=$((sh_bad+1))
  fi
done
echo "  bash: $sh_ok 通过 / $sh_bad 失败"

echo
echo "== Python 脚本语法检查 =="
py_ok=0; py_bad=0
for f in "$DIR"/*.py; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  if python3 -m py_compile "$f" 2>/tmp/pyerr; then
    printf "  ✅ %s\n" "$name"
    py_ok=$((py_ok+1))
  else
    printf "  ❌ %s\n" "$name"
    sed 's/^/       /' /tmp/pyerr | head -3
    py_bad=$((py_bad+1))
  fi
done
echo "  python: $py_ok 通过 / $py_bad 失败"

rm -f /tmp/synerr /tmp/pyerr
find "$DIR" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

echo
echo "总计: $((sh_ok+py_ok)) 通过 / $((sh_bad+py_bad)) 失败"
[ $((sh_bad+py_bad)) -eq 0 ]
