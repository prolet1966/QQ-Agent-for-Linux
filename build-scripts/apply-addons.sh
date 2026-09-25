#!/usr/bin/env bash
# apply-addons.sh —— 把 V0.3.1 的额外插件与技能纳入 V0.4.4 源码树。
#
# 背景与前置验证（都已做完，结论写在这里便于回溯）：
#   1. 插件：17 个 V0.3.1 独有插件，静态扫描确认**只使用 V0.4.4 提供的 api 方法**
#      （capability / config / log / warn），不调用任何未提供的 api。
#      其声明的 capabilities 里有些是 V0.4.4 宿主不认识的新能力
#      （affinity.* / bodystate.* / knowledge.* / meme.* / mood.* / threads.* 等），
#      但 V0.4.4 对能力是**软依赖**语义（见 plugin-loader.js L96-98、L105）：
#      宿主会为声明的能力自动注册 null provider，不认识也不会加载失败，
#      只是没人消费。因此加入是安全的。
#   2. 技能：25 个 V0.3.1 独有技能，与 V0.4.4 已有技能**无工具 id 冲突**
#      （V0.4.4 现有工具 id 只有 4 个）。全部 enabledByDefault=false，
#      默认不启用，用户可自行在界面打开。
#
# 幂等：重复执行不会产生重复文件（同名目录先删后拷）。

set -euo pipefail

SRC_PLUGINS="/mnt/e/QQ-Agent V0.3.1 For developer/develop/plugins"
SRC_SKILLS="/mnt/e/QQ-Agent V0.3.1 For developer/develop/skills"

# 目标：既写进 WSL 的构建目录，也写回 Windows 工作区源码（后者才是持久源）
DST_DESKTOP="/mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/app"
DST_WSL="$HOME/qq-agent-linux/app"

[ -d "$SRC_PLUGINS" ] || { echo "❌ 源插件目录不存在: $SRC_PLUGINS"; exit 1; }
[ -d "$SRC_SKILLS" ]  || { echo "❌ 源技能目录不存在: $SRC_SKILLS"; exit 1; }

echo "############ 纳入 V0.3.1 插件与技能 $(date '+%F %T') ############"

# ── 计算「待纳入」清单：V0.4.4 里不存在的 ────────────────────────────────
echo
echo "== 1. 计算待纳入清单（对比目标现有内容）=="

added_plugins=()
for d in "$SRC_PLUGINS"/*/; do
  name=$(basename "$d")
  if [ ! -d "$DST_DESKTOP/plugins/$name" ]; then
    added_plugins+=("$name")
  fi
done

added_skills=()
for d in "$SRC_SKILLS"/*/; do
  name=$(basename "$d")
  if [ ! -d "$DST_DESKTOP/skills/$name" ]; then
    added_skills+=("$name")
  fi
done

echo "  待纳入插件 ${#added_plugins[@]} 个"
echo "  待纳入技能 ${#added_skills[@]} 个"

# ── 复制到两处目标 ──────────────────────────────────────────────────────
echo
echo "== 2. 复制插件 =="
for name in "${added_plugins[@]}"; do
  rm -rf "$DST_DESKTOP/plugins/$name"
  rm -rf "$DST_WSL/plugins/$name" 2>/dev/null || true
  cp -a "$SRC_PLUGINS/$name" "$DST_DESKTOP/plugins/$name"
  printf "  + %s\n" "$name"
done

echo
echo "== 3. 复制技能 =="
for name in "${added_skills[@]}"; do
  rm -rf "$DST_DESKTOP/skills/$name"
  rm -rf "$DST_WSL/skills/$name" 2>/dev/null || true
  cp -a "$SRC_SKILLS/$name" "$DST_DESKTOP/skills/$name"
  printf "  + %s\n" "$name"
done

# WSL 侧直接从工作区同步（避免 /mnt/e 读两遍）
echo
echo "== 4. 同步到 WSL 构建目录 =="
if [ -d "$DST_WSL" ]; then
  for name in "${added_plugins[@]}"; do
    mkdir -p "$DST_WSL/plugins"
    cp -a "$DST_DESKTOP/plugins/$name" "$DST_WSL/plugins/$name"
  done
  for name in "${added_skills[@]}"; do
    mkdir -p "$DST_WSL/skills"
    cp -a "$DST_DESKTOP/skills/$name" "$DST_WSL/skills/$name"
  done
  echo "  已同步（插件 $(find "$DST_WSL/plugins" -maxdepth 1 -type d | tail -n +2 | wc -l) 个，技能 $(find "$DST_WSL/skills" -maxdepth 1 -type d | tail -n +2 | wc -l) 个）"
else
  echo "  ⚠️  WSL 构建目录尚不存在，跳过（pipeline.sh 会重新同步）"
fi

# ── 统计 ────────────────────────────────────────────────────────────────
echo
echo "== 5. 纳入后统计 =="
printf "  插件总数: %s\n" "$(find "$DST_DESKTOP/plugins" -maxdepth 1 -mindepth 1 -type d | wc -l)"
printf "  技能总数: %s\n" "$(find "$DST_DESKTOP/skills" -maxdepth 1 -mindepth 1 -type d | wc -l)"
printf "  新增体积: 约 %s KB\n" "$(du -sk "$DST_DESKTOP/plugins" "$DST_DESKTOP/skills" 2>/dev/null | awk '{s+=$1} END {print s}')"

echo
echo "== 6. 清单完整性抽查 =="
bad=0
for name in "${added_plugins[@]}"; do
  d="$DST_DESKTOP/plugins/$name"
  if [ ! -f "$d/plugin.json" ] && [ ! -f "$d/skill.json" ]; then
    echo "  ❌ 缺清单: plugins/$name"; bad=$((bad+1))
  fi
done
for name in "${added_skills[@]}"; do
  d="$DST_DESKTOP/skills/$name"
  if [ ! -f "$d/skill.json" ] && [ ! -f "$d/plugin.json" ]; then
    echo "  ❌ 缺清单: skills/$name"; bad=$((bad+1))
  fi
done
[ $bad -eq 0 ] && echo "  ✅ 全部条目都有清单文件"

echo
echo "############ 完成 $(date '+%F %T') ############"
