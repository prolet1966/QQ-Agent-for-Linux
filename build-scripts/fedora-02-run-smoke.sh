#!/usr/bin/env bash
# fedora-02-run-smoke.sh —— 在 Fedora WSL 里跑 .rpm 冒烟测试的**单一入口**。
#
# ## 为什么要单独落一个脚本文件，而不是让 PowerShell 拼命令喂给 wsl.exe
#
# 踩了一串坑，逐个记下来，避免以后重复：
#
#   1. `wsl.exe -d X -- wslpath -a "F:\a\b"` → PowerShell 调原生程序会**吃掉反斜杠**，
#      路径变成 `F:a b`，wslpath 直接报错。
#   2. 改用 `bash -s` 从 stdin 喂脚本：PowerShell here-string 是 **CRLF**，
#      `echo "P=$VAR" >> f` 会把行尾 `\r` 写进变量，导致 `[ -f "$P" ]` 失败，
#      现象是"传了路径却报用法错误"，极容易误判。
#   3. 改成单行 `bash -lc "...; ...; ..."`：多层引号 + PowerShell 转义后，
#      `$(wslpath ...)` 干脆没被执行，两个变量都是空的 —— 静默失效，最难查。
#
# 结论：**不要把命令拼进 wsl.exe 的参数里**。落一个 LF 换行的脚本文件，
# 让 wsl 直接 `bash /mnt/f/.../xxx.sh`，参数与路径全在脚本内部处理。
# 这样只有一个变量（脚本路径本身）需要跨层传递，且它不含反斜杠以外的特殊字符。
#
# 用法（在 Fedora WSL 内执行）:
#   bash fedora-02-run-smoke.sh

set -uo pipefail

# ── 待测包与期望哈希 ──────────────────────────────────────────────────────
RPM_WIN="F:\kmy\Documents\dpsk\harness\QQ-Agent-for-Linux\port\dist\qq-agent-v0.4.4-x86_64.rpm"
EXPECT_SHA="7eab74f312d81373d9f83865c112f3e8447838d64202df256e7a3abf723e822c"
SMOKE_WIN="F:\kmy\Documents\dpsk\harness\QQ-Agent-for-Linux\port\build-scripts\fedora-01-rpm-smoke.sh"

echo "########## Fedora WSL .rpm 冒烟测试入口 ##########"

# Windows 路径 → Fedora 挂载路径。用 printf 而不是 echo，避免任何转义歧义。
RPM_PATH=$(wslpath -a "$RPM_WIN")
SMOKE_PATH=$(wslpath -a "$SMOKE_WIN")

echo "  待测包  : $RPM_PATH"
echo "  测试脚本: $SMOKE_PATH"

[ -f "$RPM_PATH" ]   || { echo "❌ rpm 在 Fedora 侧不可见: $RPM_PATH"; exit 1; }
[ -f "$SMOKE_PATH" ] || { echo "❌ 脚本在 Fedora 侧不可见: $SMOKE_PATH"; exit 1; }

# ── 校验包完整性（挂载层读取 vs 期望值）───────────────────────────────────
echo
echo "== 包完整性（挂载层读取）=="
ACTUAL=$(sha256sum "$RPM_PATH" | awk '{print $1}')
echo "  实际 SHA256: $ACTUAL"
echo "  期望 SHA256: $EXPECT_SHA"
if [ "$ACTUAL" != "$EXPECT_SHA" ]; then
  echo "  ❌ 不一致 —— 文件在挂载层读取异常，停止测试"
  exit 1
fi
echo "  ✅ 一致"

# ── 把测试脚本规范化到本地（去 CR、加执行位）后执行 ────────────────────────
echo
echo "== 执行测试脚本 =="
tr -d '\r' < "$SMOKE_PATH" > /tmp/qa-fedora-smoke.sh
chmod +x /tmp/qa-fedora-smoke.sh
bash /tmp/qa-fedora-smoke.sh "$RPM_PATH" "$EXPECT_SHA"
RC=$?

echo
echo "########## 退出码 $RC ##########"
exit $RC
