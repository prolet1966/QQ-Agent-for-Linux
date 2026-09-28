#!/usr/bin/env bash
# ============================================================================
#  _smoke-common.sh — 冒烟测试共享逻辑
#
#  被 test/10-deb-smoke.sh 与 test/20-rpm-smoke.sh source，**不独立运行**。
#
#  判据纪律（沿用 02-构建方案.md §5）：
#    * 一律用**端口探测**判进程活跃，不用 ps/进程名 —— 沙箱里 ps 不可靠，
#      历史上出现过返回 0 导致误判。
#    * 应用必须以**非 root 用户**运行：否则测不出「数据目录落在用户主目录」，
#      而那条恰恰是本方案最核心的设计。
# ============================================================================

# ── 可调参数 ──
SMOKE_STARTUP_TIMEOUT="${SMOKE_STARTUP_TIMEOUT:-75}"   # 等 3210 端口的上限（秒）
SMOKE_ALIVE_SECONDS="${SMOKE_ALIVE_SECONDS:-15}"       # 存活判定时长（秒）
SMOKE_CONSOLE_PORT="${SMOKE_CONSOLE_PORT:-3210}"

SMOKE_KEEP=0
SMOKE_SKIP_UNINSTALL=0
SMOKE_RUN_USER="${SMOKE_USER:-}"
SMOKE_RUN_HOME=""
SMOKE_CREATED_USER=0
SMOKE_TMP=""
SMOKE_APP_PID=""
SMOKE_USED_NO_SANDBOX=0
# deb / rpm —— **报告文件名必须区分**：否则先跑 deb 冒烟、再跑 rpm 冒烟，
# 两份报告同名互相覆盖，CI 上传的 artifact 里就只剩一份（丢证据）。
SMOKE_KIND="pkg"
# AppImage 冒烟用：把启动目标指向 .AppImage 文件，并允许 extract-and-run
SMOKE_BIN=""
SMOKE_EXTRACT_AND_RUN=0

RESULTS=()      # "STATUS|名称|细节"

# ── 结果记录 ──
smoke_pass() { RESULTS+=("PASS|$1|$2"); printf '\033[32m  ✓\033[0m %-46s %s\n' "$1" "$2"; }
smoke_fail() { RESULTS+=("FAIL|$1|$2"); printf '\033[31m  ✗\033[0m %-46s %s\n' "$1" "$2"; }
smoke_warn() { RESULTS+=("WARN|$1|$2"); printf '\033[33m  !\033[0m %-46s %s\n' "$1" "$2"; }
smoke_info() { RESULTS+=("INFO|$1|$2"); printf '  ·  %-46s %s\n' "$1" "$2"; }
smoke_head() { printf '\n\033[36m=== %s ===\033[0m\n' "$1"; }

smoke_counts() {
  local pass=0 fail=0 warn=0
  for r in "${RESULTS[@]:-}"; do
    [ -n "$r" ] || continue
    case "${r%%|*}" in
      PASS) pass=$((pass+1)) ;;
      FAIL) fail=$((fail+1)) ;;
      WARN) warn=$((warn+1)) ;;
    esac
  done
  echo "$pass $fail $warn"
}

# ── 前置：装包要 root；但应用一律以非 root 跑 ──
#   SMOKE_NEEDS_ROOT=0 时（AppImage 冒烟）允许非 root 直接跑 ——
#   AppImage 本来就不需要安装，这也是它相对 deb/rpm 的一个优点。
smoke_resolve_run_user() {
  if [ "$(id -u)" != "0" ]; then
    if [ "${SMOKE_NEEDS_ROOT:-1}" = "1" ]; then
      die "本脚本需要 root 安装软件包。请用： sudo bash $0 $*"
    fi
    SMOKE_RUN_USER="$(id -un)"
    SMOKE_RUN_HOME="$HOME"
    smoke_info "应用运行用户" "$SMOKE_RUN_USER（HOME=$SMOKE_RUN_HOME，未用 sudo）"
    return 0
  fi
  if [ -n "$SMOKE_RUN_USER" ]; then
    :
  elif [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER:-}" != "root" ]; then
    SMOKE_RUN_USER="$SUDO_USER"
  else
    # 没有可用的非 root 用户（比如直接在 root shell 里跑）→ 造一个一次性的
    SMOKE_RUN_USER="qqa-smoke"
    if ! id "$SMOKE_RUN_USER" >/dev/null 2>&1; then
      useradd -m -s /bin/bash "$SMOKE_RUN_USER" >/dev/null 2>&1 \
        || die "创建测试用户 $SMOKE_RUN_USER 失败"
      SMOKE_CREATED_USER=1
    fi
  fi
  SMOKE_RUN_HOME="$(getent passwd "$SMOKE_RUN_USER" | cut -d: -f6)"
  [ -n "$SMOKE_RUN_HOME" ] || die "拿不到用户 $SMOKE_RUN_USER 的 HOME"
  smoke_info "应用运行用户" "$SMOKE_RUN_USER（HOME=$SMOKE_RUN_HOME）"
  smoke_info "判定：以非 root 运行" "这样才测得到「数据写在用户主目录」"
}

# 以「运行用户」身份执行命令。已经是该用户时不再套 sudo
# （套了会要密码，而 AppImage 冒烟本来就不该需要 root）。
smoke_as_user() {
  if [ "$(id -u)" = "0" ]; then
    sudo -u "$SMOKE_RUN_USER" -H "$@"
  else
    "$@"
  fi
}

smoke_setup() {
  SMOKE_TMP="$(mktemp -d)"
  chmod 755 "$SMOKE_TMP"
  command -v xvfb-run >/dev/null 2>&1 || die "没有 xvfb-run（sudo apt install xvfb）"
  command -v curl     >/dev/null 2>&1 || die "没有 curl（sudo apt install curl）"

  # 装前清理：保证测的是「全新状态」
  smoke_head "装前清理"
  if [ "$(id -u)" = "0" ]; then
    if command -v dpkg >/dev/null 2>&1 && dpkg -s "$PKG_NAME" >/dev/null 2>&1; then
      dpkg -r "$PKG_NAME" >/dev/null 2>&1 || true
      smoke_info "已卸载既有 deb" "$PKG_NAME"
    fi
    if command -v rpm >/dev/null 2>&1 && rpm -q "$PKG_NAME" >/dev/null 2>&1; then
      rpm -e "$PKG_NAME" >/dev/null 2>&1 || true
      smoke_info "已卸载既有 rpm" "$PKG_NAME"
    fi
  else
    smoke_info "跳过 deb/rpm 卸载" "非 root 运行（AppImage 冒烟不需要）"
  fi
  rm -rf "$SMOKE_RUN_HOME/.local/share/qq-agent" 2>/dev/null || true
  smoke_info "已清空用户数据目录" "保证从零开始"
}

# ── 端口探测（bash 内置 /dev/tcp，不依赖 nc/ss）──
smoke_port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

smoke_wait_port() {
  local port="$1" timeout="${2:-60}" i=0
  while [ "$i" -lt "$timeout" ]; do
    smoke_port_open "$port" && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# ── 启动应用（以非 root 用户 + xvfb）──
smoke_start_app() {
  local extra="$1" logfile="$2"
  # SMOKE_BIN：默认用装好的启动器；AppImage 冒烟会把它指向 .AppImage 文件本身
  local bin="${SMOKE_BIN:-$BIN_LINK}"
  # 无 FUSE 环境（如 WSL / 容器）下跑 AppImage 需要 extract-and-run
  local extra_env=""
  [ "${SMOKE_EXTRACT_AND_RUN:-0}" = "1" ] && extra_env="export APPIMAGE_EXTRACT_AND_RUN=1"
  cat > "$SMOKE_TMP/run-app.sh" <<EOF
#!/bin/sh
# 故意**不**设置 QQ_AGENT_DATA_DIR：要测的就是「启动器/补丁自己算得对不对」
export HOME='$SMOKE_RUN_HOME'
export XDG_DATA_HOME='$SMOKE_RUN_HOME/.local/share'
export ELECTRON_OZONE_PLATFORM_HINT=auto
export LANG=C.UTF-8
$extra_env
exec xvfb-run -a --server-args='-screen 0 1280x800x24' '$bin' --disable-gpu $extra
EOF
  chmod 755 "$SMOKE_TMP/run-app.sh"
  chown "$SMOKE_RUN_USER" "$SMOKE_TMP/run-app.sh" 2>/dev/null || true
  smoke_as_user bash "$SMOKE_TMP/run-app.sh" > "$logfile" 2>&1 &
  SMOKE_APP_PID=$!
}

smoke_stop_app() {
  if [ -n "$SMOKE_APP_PID" ]; then
    kill -TERM "$SMOKE_APP_PID" 2>/dev/null || true
  fi
  sleep 2
  pkill -f "$PREFIX/qq-agent"      >/dev/null 2>&1 || true
  pkill -f 'xvfb-run'              >/dev/null 2>&1 || true
  sleep 1
  pkill -9 -f "$PREFIX/qq-agent"   >/dev/null 2>&1 || true
  SMOKE_APP_PID=""
  return 0
}

smoke_cleanup() {
  smoke_stop_app
  if [ "$SMOKE_CREATED_USER" = 1 ]; then
    userdel -r "$SMOKE_RUN_USER" >/dev/null 2>&1 || true
  fi
  if [ "$SMOKE_KEEP" = 1 ]; then
    echo "「--keep」已指定，保留临时目录：$SMOKE_TMP"
  else
    [ -n "$SMOKE_TMP" ] && [ -d "$SMOKE_TMP" ] && rm -rf "$SMOKE_TMP"
  fi
}

# ── 静态检查（装卸之间做）──
smoke_static_checks() {
  smoke_head "静态检查"

  if [ -x "$PREFIX/qq-agent" ]; then
    smoke_pass "主程序存在且可执行" "$PREFIX/qq-agent"
  else
    smoke_fail "主程序缺失或不可执行" "$PREFIX/qq-agent"
  fi

  # 架构（用 lib.sh 自带的魔数探测，不依赖 file 命令）
  local m; m="$(elf_machine "$PREFIX/qq-agent")"
  if [ "$m" = "$(expected_elf_machine)" ]; then
    smoke_pass "主程序架构正确" "$m"
  else
    smoke_fail "主程序架构不符" "期望 $(expected_elf_machine)，实际 ${m:-未知}"
  fi

  if [ -f /usr/share/applications/qq-agent.desktop ]; then
    if command -v desktop-file-validate >/dev/null 2>&1; then
      if desktop-file-validate /usr/share/applications/qq-agent.desktop 2>"$SMOKE_TMP/dfv.txt"; then
        smoke_pass "desktop 文件校验通过" "desktop-file-validate"
      else
        smoke_fail "desktop 文件校验失败" "$(head -3 "$SMOKE_TMP/dfv.txt" | tr '\n' ' ')"
      fi
    else
      smoke_warn "跳过 desktop 校验" "没有 desktop-file-validate"
    fi
  else
    smoke_fail "desktop 文件未安装" "/usr/share/applications/qq-agent.desktop"
  fi

  # 动态库依赖
  if command -v ldd >/dev/null 2>&1; then
    local missing
    missing="$(ldd "$PREFIX/qq-agent" 2>/dev/null | grep 'not found' || true)"
    if [ -z "$missing" ]; then
      smoke_pass "动态库无缺失" "ldd 全部解析"
    else
      smoke_fail "动态库缺失" "$(printf '%s' "$missing" | head -5 | tr '\n' ';')"
    fi
  else
    smoke_warn "跳过 ldd 检查" "没有 ldd"
  fi

  # 补丁是否真的打上了（漏打的包在 Linux 上必坏）
  if grep -q 'QQA_LINUX_PATCH:snowluma-runtime-mirror' "$PREFIX/resources/app/src/app.js" 2>/dev/null; then
    smoke_pass "snowluma-runtime-mirror 补丁已应用" "关键：否则 SnowLuma 写配置必失败"
  else
    smoke_fail "snowluma-runtime-mirror 补丁未应用" "Linux 上 SnowLuma 无法写 config/data"
  fi
  if grep -q 'QQA_LINUX_PATCH:data-dir-xdg' "$PREFIX/resources/app/electron/main.js" 2>/dev/null; then
    smoke_pass "data-dir-xdg 补丁已应用" "关键：否则数据写到只读 /opt"
  else
    smoke_fail "data-dir-xdg 补丁未应用" "数据会写到只读的 /opt"
  fi

  # chrome-sandbox 权限
  if [ -f "$PREFIX/chrome-sandbox" ]; then
    if [ -u "$PREFIX/chrome-sandbox" ]; then
      smoke_pass "chrome-sandbox 有 setuid 位" "成 $(stat -c '%U:%G %a' "$PREFIX/chrome-sandbox" 2>/dev/null)"
    else
      smoke_warn "chrome-sandbox 缺 setuid 位" "将回退 --no-sandbox（安全性降低）"
    fi
  fi
}

# ── 应用级检查（核心）──
smoke_app_checks() {
  smoke_head "启动与运行"
  local log="$SMOKE_TMP/app.log"

  smoke_info "启动命令" "xvfb-run /usr/bin/qq-agent --disable-gpu"
  smoke_start_app "" "$log"

  if smoke_wait_port "$SMOKE_CONSOLE_PORT" "$SMOKE_STARTUP_TIMEOUT"; then
    smoke_pass "控制台端口 $SMOKE_CONSOLE_PORT 已监听" "启动成功"
  else
    # 沙箱不可用时回退再试一次（如实记录用了哪条路）
    smoke_warn "首次启动未在 ${SMOKE_STARTUP_TIMEOUT}s 内监听 $SMOKE_CONSOLE_PORT" "回退 --no-sandbox 重试"
    smoke_stop_app
    smoke_start_app "--no-sandbox" "$log"
    if smoke_wait_port "$SMOKE_CONSOLE_PORT" "$SMOKE_STARTUP_TIMEOUT"; then
      SMOKE_USED_NO_SANDBOX=1
      smoke_pass "（回退）控制台端口已监听" "用的是 --no-sandbox"
    else
      smoke_fail "控制台端口始终未监听" "$SMOKE_CONSOLE_PORT 不通；日志见下"
      smoke_info "日志尾部" "$(tail -15 "$log" 2>/dev/null | tr '\n' '|')"
      return 1
    fi
  fi

  # 存活判定：过 ALIVE_SECONDS 后再探一次端口
  smoke_info "存活判定" "等待 ${SMOKE_ALIVE_SECONDS}s 后再探"
  sleep "$SMOKE_ALIVE_SECONDS"
  if smoke_port_open "$SMOKE_CONSOLE_PORT"; then
    smoke_pass "进程存活 > ${SMOKE_ALIVE_SECONDS}s" "未秒退"
  else
    smoke_fail "进程在 ${SMOKE_ALIVE_SECONDS}s 内退出" "日志尾部：$(tail -10 "$log" 2>/dev/null | tr '\n' '|')"
  fi

  # HTTP API
  local code body ct
  ct="$(curl -s -D - -o "$SMOKE_TMP/api.json" -w '%{http_code}' \
        "http://127.0.0.1:$SMOKE_CONSOLE_PORT/api/config" 2>/dev/null | tr -d '\r' | grep -i '^content-type' || true)"
  code="$(curl -s -o /dev/null -w '%{http_code}' \
        "http://127.0.0.1:$SMOKE_CONSOLE_PORT/api/config" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then
    smoke_pass "GET /api/config 返回 200" "本地无鉴权（已核对源码）"
  else
    smoke_fail "GET /api/config 返回 $code" "期望 200"
  fi
  if [ -s "$SMOKE_TMP/api.json" ] && node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$SMOKE_TMP/api.json" 2>/dev/null; then
    smoke_pass "响应是合法 JSON" "$(wc -c <"$SMOKE_TMP/api.json") 字节"
  else
    smoke_fail "响应不是合法 JSON" "$(head -c 120 "$SMOKE_TMP/api.json" 2>/dev/null)"
  fi
  case "$ct" in
    *charset=utf-8*|*charset=UTF-8*) smoke_pass "Content-Type 带 charset=utf-8" "中文不乱码" ;;
    *) smoke_warn "Content-Type 未显式声明 charset" "${ct:-（无 header）}" ;;
  esac

  smoke_head "数据目录（★ 本方案的核心设计）"
  local DATA_DIR="$SMOKE_RUN_HOME/.local/share/qq-agent/data"
  if [ -d "$DATA_DIR" ]; then
    smoke_pass "数据目录落在用户主目录" "$DATA_DIR"
  else
    smoke_fail "用户主目录下没有数据目录" "$DATA_DIR 不存在"
  fi
  if [ -f "$DATA_DIR/config.json" ]; then
    smoke_pass "config.json 已创建" "$(wc -c <"$DATA_DIR/config.json") 字节"
  else
    smoke_fail "config.json 未创建" "说明写盘失败（/opt 只读的老问题）"
  fi
  if [ -e "$PREFIX/data" ]; then
    smoke_fail "★ /opt 下出现了 data 目录" "$PREFIX/data —— 说明补丁没生效"
  else
    smoke_pass "/opt 下没有 data 目录" "程序与数据分离成立"
  fi
  if [ -e "$PREFIX/resources/app/data" ]; then
    smoke_fail "★ 安装目录内出现运行期数据" "$PREFIX/resources/app/data"
  else
    smoke_pass "安装目录内无运行期数据" "安装树保持只读"
  fi

  smoke_head "SnowLuma 运行目录镜像（★ 新增机制）"
  local MIRROR="$SMOKE_RUN_HOME/.local/share/qq-agent/snowluma"
  # 触发：POST /api/snowluma/launch 的第一步就是 snowlumaDir()
  local lcode
  lcode="$(curl -s -o "$SMOKE_TMP/launch.json" -w '%{http_code}' -X POST \
           "http://127.0.0.1:$SMOKE_CONSOLE_PORT/api/snowluma/launch" 2>/dev/null || echo 000)"
  smoke_info "POST /api/snowluma/launch" "HTTP $lcode（触发 snowlumaDir()）"

  if [ -d "$MIRROR" ]; then
    smoke_pass "镜像目录已创建" "$MIRROR"
  else
    smoke_fail "镜像目录未创建" "$MIRROR 不存在 —— snowlumaDir() 可能没走 Linux 分支"
  fi
  if [ -L "$MIRROR/native" ]; then
    smoke_pass "镜像里 native/ 是符号链接" "→ $(readlink "$MIRROR/native")"
  else
    smoke_fail "镜像里 native/ 不是符号链接" "静态件应当软链回只读安装目录"
  fi
  if [ -L "$MIRROR/config" ] || [ -L "$MIRROR/data" ]; then
    smoke_fail "★ config/ 或 data/ 被软链了" "它们必须留给 SnowLuma 在镜像里自建，否则又写回只读目录"
  else
    smoke_pass "config/ data/ 未被软链" "将由 SnowLuma 在镜像内自行创建"
  fi
  # 反向验证：SnowLuma 的安装目录里不该被写出 config/
  if [ -e "$PREFIX/resources/app/snowluma/config" ]; then
    smoke_fail "★ 安装目录里出现了 snowluma/config" "写入跑回 /opt 了，镜像机制失效"
  else
    smoke_pass "安装目录内无 snowluma/config" "写入确实被重定向了"
  fi

  smoke_head "日志健康检查"
  if grep -iE '(wmic|taskkill|explorer\.exe|cmd\.exe)' "$log" 2>/dev/null \
     | grep -iE '(error|failed|not found|错误|失败|不存在)' > "$SMOKE_TMP/win.txt" 2>/dev/null; then
    if [ -s "$SMOKE_TMP/win.txt" ]; then
      smoke_fail "日志里有 Windows 调用报错" "$(head -3 "$SMOKE_TMP/win.txt" | tr '\n' ';')"
    fi
  else
    smoke_pass "无残留 Windows 调用报错" "wmic/taskkill/explorer.exe 均无"
  fi
  if grep -qiE '(ENOENT|EACCES|EROfS|read-only file system)' "$log" 2>/dev/null; then
    smoke_warn "日志里有文件系统错误" "$(grep -iE '(ENOENT|EACCES|EROfS|read-only)' "$log" | head -2 | tr '\n' ';')"
  else
    smoke_pass "无文件系统类错误" "无 ENOENT/EACCES/只读 报错"
  fi

  smoke_head "单实例锁"
  local log2="$SMOKE_TMP/app2.log"
  smoke_as_user timeout 25 bash "$SMOKE_TMP/run-app.sh" > "$log2" 2>&1
  local rc2=$?
  if grep -qE '(已有|单实例|已在运行|already running)' "$log2" 2>/dev/null; then
    smoke_pass "第二个实例被拦下" "$(grep -oE '.{0,30}(已有|单实例|已在运行).{0,30}' "$log2" | head -1)"
  elif [ "$rc2" = 124 ]; then
    smoke_fail "第二个实例一直在跑" "单实例锁没起作用（timeout 25s 到点）"
  else
    smoke_warn "第二个实例退出了，但没看到锁日志" "退出码 $rc2；日志：$(tail -3 "$log2" | tr '\n' '|')"
  fi

  return 0
}

# ── 卸载检查 ──
smoke_uninstall_check() {
  smoke_head "卸载检查"
  smoke_stop_app

  if [ "$SMOKE_SKIP_UNINSTALL" = 1 ]; then
    smoke_warn "跳过卸载检查" "--no-uninstall 已指定"
    return 0
  fi

  if command -v dpkg >/dev/null 2>&1 && dpkg -s "$PKG_NAME" >/dev/null 2>&1; then
    dpkg -r "$PKG_NAME" >/dev/null 2>&1 || dpkg --purge "$PKG_NAME" >/dev/null 2>&1 || true
  fi
  if command -v rpm >/dev/null 2>&1 && rpm -q "$PKG_NAME" >/dev/null 2>&1; then
    rpm -e "$PKG_NAME" >/dev/null 2>&1 || true
  fi
  sleep 1

  if [ -e "$PREFIX/qq-agent" ]; then
    smoke_fail "卸载后安装目录仍在" "$PREFIX/qq-agent"
  else
    smoke_pass "安装目录已移除" "$PREFIX"
  fi
  if [ -d "$SMOKE_RUN_HOME/.local/share/qq-agent" ]; then
    smoke_pass "★ 用户数据保留" "卸载不丢数据（本方案的设计目标）"
  else
    smoke_fail "用户数据被一并删掉了" "$SMOKE_RUN_HOME/.local/share/qq-agent 消失"
  fi
  if [ -e "$BIN_LINK" ]; then
    smoke_warn "启动器残留" "$BIN_LINK（dpkg 一般会清理；rpm 也可能留）"
  else
    smoke_pass "启动器已清理" "$BIN_LINK"
  fi
}

# ── 报告 ──
smoke_write_report() {
  local outfile="$1"
  mkdir -p "$(dirname "$outfile")"
  read -r p f w <<< "$(smoke_counts)"
  {
    echo "# QQ-Agent Linux 冒烟测试报告"
    echo
    echo "- 时间：$(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "- 架构：$ARCH（deb=$DEB_ARCH rpm=$RPM_ARCH electron=$ELECTRON_ARCH）"
    echo "- 包文件：$(basename "${PKG_FILE:-未知}")"
    echo "- 运行用户：$SMOKE_RUN_USER（HOME=$SMOKE_RUN_HOME）"
    echo "- 沙箱：$([ "$SMOKE_USED_NO_SANDBOX" = 1 ] && echo '回退用了 --no-sandbox' || echo '正常（setuid 沙箱）')"
    echo "- 结果：**通过 $p · 失败 $f · 警告 $w**"
    echo
    echo "| 状态 | 检查项 | 细节 |"
    echo "|---|---|---|"
    for r in "${RESULTS[@]:-}"; do
      [ -n "$r" ] || continue
      # ⚠️ 必须「先声明、后赋值」分两句写。
      #    写成 `local st="${r%%|*}" rest="${r#*|}" nm="${rest%%|*}"` 会炸：
      #    bash 在执行 local **之前**就把整行的 ${...} 全部展开，
      #    于是 ${rest%%|*} 里引用的 rest 尚未赋值 → set -u 报 unbound variable
      #    → 整个报告子 shell 死掉，表格一行都写不出来（实测踩到过）。
      local st rest nm dt
      st="${r%%|*}"
      rest="${r#*|}"
      nm="${rest%%|*}"
      dt="${rest#*|}"
      local mark="⬜"
      case "$st" in PASS) mark="✅" ;; FAIL) mark="❌" ;; WARN) mark="⚠️" ;; INFO) mark="ℹ️" ;; esac
      echo "| $mark | $nm | ${dt//|/ } |"
    done
    echo
    echo "## 测试盲区（如实记录）"
    echo
    echo "- 未覆盖：真实 QQ 客户端登录、扫码、SnowLuma 实际注入与 OneBot 消息收发"
    echo "  （需要真实 QQ 账号与 Linux QQ 客户端，CI 环境不具备）"
    echo "- 未覆盖：多显示器、中文输入法、声音输出"
    echo "- 判据纪律：进程活跃一律以端口探测为准，不用 ps/进程名"
  } > "$outfile"
  echo "$outfile"
}

smoke_finish() {
  local report
  report="$(smoke_write_report "$OUT_DIR/report-smoke-$ARCH-$SMOKE_KIND.md")"
  read -r p f w <<< "$(smoke_counts)"
  echo
  printf '\033[36m=== 冒烟结论 ===\033[0m\n'
  printf '  通过 %s · 失败 %s · 警告 %s\n' "$p" "$f" "$w"
  echo "  报告：$report"
  if [ "$f" -gt 0 ]; then
    printf '\033[31m  冒烟未通过（%s 项失败）。\033[0m\n' "$f"
    return 1
  fi
  ok "冒烟全部通过。"
  return 0
}
