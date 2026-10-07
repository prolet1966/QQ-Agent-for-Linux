#!/usr/bin/env bash
# ============================================================================
#  99-selfcheck.sh — 全工程自检
#
#  两种用法：
#    bash scripts/99-selfcheck.sh                  # 语法检查 + 排除清单断言
#    bash scripts/99-selfcheck.sh --input <DIR>    # 只对某个目录做「隐私红线复检」
#                                                  # （CI 用：确认进 CI 的应用代码是干净的）
#
#  ⚠️ 每改完任何脚本都先跑这个。
# ============================================================================
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

INPUT=""
ql_parse_args "$@"
if [ "${#QL_REST[@]}" -gt 0 ]; then set -- "${QL_REST[@]}"; else set --; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --input)   [ $# -ge 2 ] || { echo "--input 后面要跟目录" >&2; exit 2; }; INPUT="$2"; shift 2 ;;
    --input=*) INPUT="${1#*=}"; shift ;;
    *)         echo "未知选项：$1" >&2; exit 2 ;;
  esac
done

# ════════════════════════════════════════════════════════════
#  模式 B：对指定目录做隐私红线复检（CI 里的第二道闸门）
# ════════════════════════════════════════════════════════════
if [ -n "$INPUT" ]; then
  echo "===== 隐私红线复检（--input 模式）====="
  echo "  目标目录: $INPUT"
  echo
  [ -d "$INPUT" ] || { echo "目录不存在：$INPUT" >&2; exit 1; }

  fails=0
  assert_no_redline "$INPUT" || fails=$((fails + 1))

  echo
  echo "--- 附加扫描：疑似密钥字面量 ---"
  # 只扫文本类文件，避免在二进制里误报
  key_hits="$(grep -rIl --exclude-dir=.git -E '(sk-[A-Za-z0-9]{16,}|api[_-]?key["'"'"']?\s*[:=]\s*["'"'"'][A-Za-z0-9_-]{20,})' "$INPUT" 2>/dev/null | head -10 || true)"
  if [ -n "$key_hits" ]; then
    printf '\033[33m  ! 以下文件疑似含密钥字面量，务必人工确认：\033[0m\n' >&2
    printf '    %s\n' $key_hits >&2
    # 只警告不失败：正常的配置模板里也可能出现占位 key
  else
    echo "  未发现明显的密钥字面量"
  fi

  echo
  echo "--- 应当存在的关键文件 ---"
  for must in package.json electron/main.js src/app.js src/routes.js; do
    if [ -f "$INPUT/$must" ]; then echo "  OK   $must"; else echo "  FAIL 缺少 $must"; fails=$((fails + 1)); fi
  done
  # 正向断言：排除规则过宽会把必需文件**静默**吃掉（2026-10-06 data-url.js 事故：
  # `--exclude=data-*` 非锚定匹配，连 node_modules 深处的文件一起排掉，
  # 而当时只有"不许有什么"的断言，于是全套自检照样全绿）。
  # 这里断言 REQUIRED_PRESENT 里的文件必须存在。
  for must in "${REQUIRED_PRESENT[@]}"; do
    if [ -f "$INPUT/$must" ]; then
      echo "  OK   $must"
    else
      echo "  FAIL 缺少必需文件 $must（多半被某条 --exclude 误伤，检查 EXCLUDE_PATTERNS 是否锚定到 ./）"
      fails=$((fails + 1))
    fi
  done
  if [ -e "$INPUT/snowluma" ]; then
    echo "  FAIL snowluma/ 不应出现在应用代码 tar 里（要由官方 Linux 包补上）"; fails=$((fails + 1))
  else
    echo "  OK   snowluma/ 已排除"
  fi

  echo
  echo "--- 依赖图完整性（跟着 require 图走，0 缺失才通过）---"
  assert_requires_complete "$INPUT" || fails=$((fails + 1))

  echo
  if [ "$fails" -eq 0 ]; then echo "红线复检通过。"; exit 0; fi
  echo "红线复检未通过：$fails 项。" >&2
  exit 1
fi

# ════════════════════════════════════════════════════════════
#  模式 A：全工程自检
# ════════════════════════════════════════════════════════════
fails=0

echo "===== shell 脚本语法检查（bash -n）====="
sh_files="$(find . -name '*.sh' \
  -not -path './cache/*' -not -path './stage/*' -not -path './stage-*/*' \
  -not -path './out/*' -not -path './.anchor-test*/*' -not -path './.git/*' \
  | sort)"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if bash -n "$f" 2>/dev/null; then
    echo "  OK   $f"
  else
    echo "  FAIL $f"
    bash -n "$f"
    fails=$((fails + 1))
  fi
done <<< "$sh_files"

echo
echo "===== node 脚本语法检查 ====="
for f in patches/patch-linux.mjs patches/verify-anchors.mjs patches/diag-anchors.mjs \
         scripts/verify-no-missing-requires.mjs; do
  if [ -f "$f" ]; then
    if node --check "$f" 2>/dev/null; then echo "  OK   $f"; else echo "  FAIL $f"; node --check "$f"; fails=$((fails + 1)); fi
  fi
done

echo
echo "===== 关键文件存在性 ====="
for f in scripts/lib.sh scripts/01-extract.sh scripts/02-test-patch.sh \
         scripts/03-stage.sh scripts/04-build-deb.sh scripts/05-build-rpm.sh \
         scripts/06-build-appimage.sh scripts/verify-no-missing-requires.mjs \
         test/_smoke-common.sh test/05-arch-audit.sh \
         test/10-deb-smoke.sh test/20-rpm-smoke.sh test/30-appimage-smoke.sh \
         test/40-apprun-sandbox-test.sh test/50-rpm-deps-resolve.sh \
         test/70-requires-gate-test.sh \
         patches/patch-linux.mjs patches/verify-anchors.mjs \
         .github/workflows/build-linux-arm64.yml; do
  if [ -f "$f" ]; then echo "  OK   $f"; else echo "  --   $f（尚未编写）"; fi
done

echo
echo "===== 架构参数自检 ====="
for a in x86_64 arm64; do
  ARCH="$a"; apply_arch
  if assert_arch_triplet 2>/dev/null; then
    printf '  OK   %-7s deb=%-6s rpm=%-8s electron=%-7s snowluma=%s\n' \
      "$ARCH" "$DEB_ARCH" "$RPM_ARCH" "$ELECTRON_ARCH" "$SNOWLUMA_ARCH"
  else
    echo "  FAIL 架构组合非法：$a"; fails=$((fails + 1))
  fi
done
apply_arch   # 还原成默认

echo
echo "===== 补丁清单自检 ====="
# 补丁数从 9 增至 10（新增 snowluma-runtime-mirror）。
# 这条断言的作用：万一有人误删补丁块，自检立刻报出来，而不是等装到真机上才发现。
PATCH_COUNT="$(grep -c "^patch(" patches/patch-linux.mjs || echo 0)"
echo "  patch-linux.mjs 里的补丁数: $PATCH_COUNT"
if [ "$PATCH_COUNT" -ge 10 ]; then echo "  OK   补丁数 >= 10"; else echo "  FAIL 补丁数偏少（应为 10）"; fails=$((fails + 1)); fi
for id in data-dir-xdg snowluma-stop-posix snowluma-launch-posix snowluma-launch-node-bin \
          snowluma-runtime-mirror routes-open-data-dir routes-open-snowluma-dir \
          routes-open-webui routes-openwith-helper portable-qq-unsupported; do
  if grep -q "'$id'" patches/patch-linux.mjs; then echo "  OK   $id"; else echo "  FAIL 缺补丁: $id"; fails=$((fails + 1)); fi
done

echo
echo "===== lib.sh 排除清单自检 ====="
echo "  版本: $APP_VERSION  |  包名: $PKG_NAME  |  Electron $ELECTRON_VERSION  |  SnowLuma $SNOWLUMA_VERSION"
echo "  安装前缀: $PREFIX"
echo "  排除项 ${#EXCLUDE_PATTERNS[@]} 条:"
for p in "${EXCLUDE_PATTERNS[@]}"; do printf '    - %s\n' "$p"; done

echo
echo "===== 关键排除项存在性断言 ====="
for must in "community.key" "snowluma/data" "snowluma/config" "snowluma/logs" "./data" "./data-*"; do
  hit=0
  for p in "${EXCLUDE_PATTERNS[@]}"; do [ "$p" = "$must" ] && hit=1; done
  if [ "$hit" = 1 ]; then echo "  OK   已排除: $must"; else echo "  FAIL 未排除: $must"; fails=$((fails + 1)); fi
done

echo
echo "===== 非锚定排除项必须缺席（2026-10-06 data-url.js 事故的根因）====="
# tar 的 --exclude 默认不锚定，所以裸 "data" / "data-*" 会匹配路径任意一段，
# 把 node_modules/undici/lib/web/fetch/data-url.js 一起排掉。必须写成 ./ 前缀。
for must_not in "data" "data-*"; do
  hit=0
  for p in "${EXCLUDE_PATTERNS[@]}"; do [ "$p" = "$must_not" ] && hit=1; done
  if [ "$hit" = 1 ]; then
    echo "  FAIL 存在非锚定排除项: $must_not（应写成 ./$must_not）"; fails=$((fails + 1))
  else
    echo "  OK   无非锚定排除项: $must_not"
  fi
done

echo
echo "===== 正向断言清单自检 ====="
if [ "${#REQUIRED_PRESENT[@]}" -ge 1 ]; then
  echo "  OK   REQUIRED_PRESENT 有 ${#REQUIRED_PRESENT[@]} 条（负数断言之外的"必须有什么"侧）"
  for p in "${REQUIRED_PRESENT[@]}"; do printf '    + %s\n' "$p"; done
else
  echo "  FAIL REQUIRED_PRESENT 为空 —— 门禁又变回只会说"不该有什么""; fails=$((fails + 1))
fi

echo
echo "===== 隐私红线断言清单 ====="
for must in "snowluma/data" "data/config.json" "community.key"; do
  hit=0
  for p in "${REDLINE_MUST_ABSENT[@]}"; do [ "$p" = "$must" ] && hit=1; done
  if [ "$hit" = 1 ]; then echo "  OK   硬红线: $must"; else echo "  FAIL 硬红线缺失: $must"; fails=$((fails + 1)); fi
done

echo
echo "===== arm64 已知前置条件 ====="
if [ "${SNOWLUMA_SHA256_arm64#__}" != "$SNOWLUMA_SHA256_arm64" ] || [ -z "$SNOWLUMA_SHA256_arm64" ]; then
  echo "  ⬜ SnowLuma arm64 的 SHA256 尚未核对 —— arm64 构建会主动失败（这是设计）"
  echo "     取得方法见 lib.sh 的 SNOWLUMA_SHA256_arm64 注释"
else
  echo "  OK   SnowLuma arm64 SHA256 已填写"
fi

echo
if [ "$fails" = 0 ]; then echo "全部自检通过。"; else echo "有 $fails 项未通过。"; exit 1; fi
