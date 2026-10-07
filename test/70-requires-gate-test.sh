#!/usr/bin/env bash
# ============================================================================
#  70-requires-gate-test.sh — 「正向完整性门禁」的回归测试
#
#  用法：
#    bash test/70-requires-gate-test.sh
#
#  为什么需要它（neo-plan 阶段 0 / R11）：
#    2026-10-06 的 data-url.js 事故里，排除规则过宽把必需文件静默吃掉，而
#    当时的门禁**只有"不该有什么"的负面断言**（assert_no_redline），于是
#    "烟测 27/0/0、包内扫描 0 命中"全绿，缺陷随三代产物发布。
#    修完东西必须锁住：这个测试造一棵同时含
#      · 应用根 data/            （必须被排掉）
#      · 应用根 data-profile/    （必须被排掉）
#      · node_modules 深处 data-url.js（**必须留下**）
#      · node_modules 嵌套 data/ （必须留下）
#    的树，用 lib.sh 里真正在用的 EXCLUDE_PATTERNS 做一次 tar，
#    再对"好树/坏树"分别跑依赖图校验器，断言退出码 0 / 1。
#
#  四类断言：
#    A. EXCLUDE_PATTERNS 里不存在非锚定的 "data" / "data-*"（事故根因）
#    B. 用真实排除清单 tar 之后：该留的留下、该排的排掉
#    C. 校验器本身可靠：好树退出码 0，坏树退出码 1（不是"永远绿"）
#    D. 真实产物/装机树依赖图完整（若存在则必查，退出码 0）
# ============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

fails=0
pass() { printf '\033[32m  ✅ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m  ❌ %s\033[0m\n' "$*" >&2; fails=$((fails + 1)); }
chk() { # 名称 期望(exist|absent) 路径
  local name="$1" want="$2" p="$3"
  if [ "$want" = exist ]; then
    if [ -e "$p" ]; then pass "$name"; else fail "$name（期望存在：${p}）"; fi
  else
    if [ ! -e "$p" ]; then pass "$name"; else fail "$name（期望缺席，但存在：${p}）"; fi
  fi
}

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

echo "===== A. 排除清单锚定性 ====="
for bad in "data" "data-*"; do
  hit=0
  for p in "${EXCLUDE_PATTERNS[@]}"; do [ "$p" = "$bad" ] && hit=1; done
  if [ "$hit" = 1 ]; then
    fail "EXCLUDE_PATTERNS 含非锚定项 $bad —— tar --exclude 不锚定，会误伤 node_modules 深处"
  else
    pass "无非锚定项：$bad"
  fi
done
for good in "./data" "./data-*"; do
  hit=0
  for p in "${EXCLUDE_PATTERNS[@]}"; do [ "$p" = "$good" ] && hit=1; done
  if [ "$hit" = 1 ]; then pass "已锚定：$good"; else fail "缺锚定项：$good"; fi
done

echo
echo "===== B. 用真实排除清单做一次 tar（复刻 copy_app_code 的逻辑）====="
FIX="$T/src"
mkdir -p "$FIX/data" "$FIX/data-profile" \
         "$FIX/node_modules/undici/lib/web/fetch" \
         "$FIX/node_modules/pkg/data" \
         "$FIX/logs"
: > "$FIX/package.json"
: > "$FIX/src-app.js"
: > "$FIX/data/config.json"
: > "$FIX/data-profile/keep.json"
: > "$FIX/node_modules/undici/lib/web/fetch/data-url.js"
: > "$FIX/node_modules/undici/lib/web/fetch/util.js"
printf "require('./data-url');\n" > "$FIX/node_modules/undici/lib/web/fetch/util.js"
: > "$FIX/node_modules/pkg/data/x.js"
: > "$FIX/logs/run.log"

ex=(); for p in "${EXCLUDE_PATTERNS[@]}"; do ex+=("--exclude=$p"); done
mkdir -p "$T/out"
( cd "$FIX" && tar -cf - "${ex[@]}" . ) | ( cd "$T/out" && tar -xf - )

chk "★ data-url.js 未被误删（核心）"          exist  "$T/out/node_modules/undici/lib/web/fetch/data-url.js"
chk "嵌套 node_modules/pkg/data/ 保留"        exist  "$T/out/node_modules/pkg/data/x.js"
chk "package.json 保留"                       exist  "$T/out/package.json"
chk "应用根 data/ 已排除"                     absent "$T/out/data/config.json"
chk "应用根 data-profile/ 已排除"             absent "$T/out/data-profile/keep.json"
chk "*.log 已排除"                            absent "$T/out/logs/run.log"

echo
echo "===== C. 校验器可靠性（好树 0 / 坏树 1）====="
rc=0
node scripts/verify-no-missing-requires.mjs "$T/out" >/dev/null 2>&1 || rc=$?
[ "$rc" = 0 ] && pass "好树退出码 0" || fail "好树退出码应为 0，实际 $rc"

rm -f "$T/out/node_modules/undici/lib/web/fetch/data-url.js"
rc=0
node scripts/verify-no-missing-requires.mjs "$T/out" >/dev/null 2>&1 || rc=$?
[ "$rc" = 1 ] && pass "坏树退出码 1（被引用却缺失 → 拒绝）" || fail "坏树退出码应为 1，实际 $rc"

rc=0
node scripts/verify-no-missing-requires.mjs "$T/does-not-exist" >/dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] && pass "用法错误退出码 2（不会被当成通过）" || fail "目录不存在应退出 2，实际 $rc"

echo
echo "===== D. 真实产物 / 装机树依赖图 ====="
checked=0
seen=""
for root in stage/*/opt/qq-agent/resources/app "$STAGE_ARCH_DIR$PREFIX/resources/app" /opt/qq-agent/resources/app; do
  [ -d "$root" ] || continue
  # 去重（同一个树可能被两个模式命中）
  case " $seen " in *" $root "*) continue ;; esac
  seen="$seen $root"
  checked=$((checked + 1))
  rc=0
  node scripts/verify-no-missing-requires.mjs "$root" >/dev/null 2>&1 || rc=$?
  if [ "$rc" = 0 ]; then
    pass "依赖图完整：$root"
  else
    fail "依赖图残缺（rc=$rc）：$root"
  fi
done
[ "$checked" -gt 0 ] || echo "  (没有已组装的 stage 树，也没有 /opt/qq-agent 装机树 —— 跳过；这不是失败)"

echo
if [ "$fails" -eq 0 ]; then
  printf '\033[32m===== 正向完整性门禁回归测试通过 =====\033[0m\n'
  exit 0
fi
printf '\033[31m===== 正向完整性门禁回归测试失败：%d 项 =====\033[0m\n' "$fails" >&2
exit 1
