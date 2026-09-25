#!/usr/bin/env bash
# verify-all.sh —— 串行跑完三套冒烟测试，并核对产物时间戳。
#
# 为什么要串行：之前我并发跑了「rpm 冒烟」和「重新构建」，结果冒烟脚本收尾时的
# `pkill -f app.asar` 把还在跑的 electron-builder 一起杀了，产出时间戳错乱。
# 这类竞争不会报错，只会让「验过的包」和「要发布的包」不是同一份 —— 很危险。
# 所以统一串行执行，并在跑之前先记录产物指纹，跑完再核对未被改动。

set -uo pipefail

BS="/mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/app/build-scripts"
DIST="$HOME/qq-agent-linux/app/dist"

echo "############ 全量验证 $(date '+%F %T') ############"

echo
echo "===== 0. 产物指纹（测试前）====="
BEFORE=$(cd "$DIST" && sha256sum *.deb *.rpm *.AppImage 2>/dev/null)
echo "$BEFORE" | while read -r h f; do
  printf "  %s  %s  (%s)\n" "${h:0:16}" "$f" "$(du -h "$DIST/$f" | cut -f1)"
done

echo
echo "===== 1/3 .deb 安装冒烟 ====="
bash "$BS/smoke-test.sh" 2>&1 | grep -E "^\s+(✅|❌)|通过 [0-9]+ 项" | sed 's/^/  /'

echo
echo "===== 2/3 .rpm 冒烟 ====="
bash "$BS/rpm-smoke-test.sh" 2>&1 | grep -E "^\s+(✅|❌)|通过 [0-9]+ 项" | sed 's/^/  /'

echo
echo "===== 3/3 AppImage 冒烟 ====="
bash "$BS/appimage-smoke-test.sh" 2>&1 | grep -E "^\s+(✅|❌)|通过 [0-9]+ 项|方式:" | sed 's/^/  /'

echo
echo "===== 4. 产物指纹核对（测试后，必须与之前一致）====="
AFTER=$(cd "$DIST" && sha256sum *.deb *.rpm *.AppImage 2>/dev/null)
if [ "$BEFORE" = "$AFTER" ]; then
  echo "  ✅ 三份产物在测试过程中未被改动，验的就是待发布的包"
else
  echo "  ❌ 产物发生变化！验的包与发布的包不一致"
  diff <(echo "$BEFORE") <(echo "$AFTER") | sed 's/^/    /'
fi

echo
echo "===== 5. 最终产物 ====="
ls -la --time-style=+%H:%M "$DIST"/*.deb "$DIST"/*.rpm "$DIST"/*.AppImage 2>/dev/null |
  awk '{printf "  %-42s %10s  %s\n", $NF, $5, $6}'

echo
echo "############ 完成 $(date '+%F %T') ############"
