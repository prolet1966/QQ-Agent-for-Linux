#!/usr/bin/env bash
# ============================================================================
#  50-rpm-deps-resolve.sh — 用 dnf 对着真实发行版元数据解析 rpm 的依赖
#
#  ⚠️ 解决什么问题：
#    rpm 冒烟在 Ubuntu 上只能 `rpm -i --nodeps`（Ubuntu 没有 rpm 依赖库），
#    于是「依赖是否合理」**从来没被验证过** —— 冒烟报告里那条
#    「依赖未被真实验证」的警告指的就是这件事。
#
#    但不需要一台 RHEL 机器：Ubuntu 源里有 **dnf**，它就是 Fedora/RHEL 用的
#    那个解析引擎。配一份目标发行版的 repo 元数据，就能对**目标架构**
#    做完整解析（纯解析，不装系统、不建虚拟机）。
#
#  能验到的：每条 Requires（含 rpmbuild 自动生成的 87 条 soname/版本化符号依赖）
#            是否都能在目标发行版里找到提供者，以及整个依赖闭包是否可解。
#  验不到的：真实安装时的文件冲突、脚本执行；以及 rpmfusion 等第三方仓库。
#
#  用法：
#    bash test/50-rpm-deps-resolve.sh                       # 默认 out/ 里的产物
#    bash test/50-rpm-deps-resolve.sh --arch arm64
#    bash test/50-rpm-deps-resolve.sh --rpm out/xxx.rpm
#
#  依赖：dnf（Debian/Ubuntu: sudo apt install dnf）、curl、可访问发行版镜像
# ============================================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

ql_parse_args "$@"
if [ "${#QL_REST[@]}" -gt 0 ]; then set -- "${QL_REST[@]}"; else set --; fi

RPM_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rpm)   [ $# -ge 2 ] || die "--rpm 后面要跟文件"; RPM_FILE="$2"; shift 2 ;;
    --rpm=*) RPM_FILE="${1#*=}"; shift ;;
    *)       die "未知选项：$1" ;;
  esac
done
[ -n "$RPM_FILE" ] || RPM_FILE="$OUT_DIR/${PKG_NAME}-${APP_VERSION}-${PKG_RELEASE}.${RPM_ARCH}.rpm"
[ -f "$RPM_FILE" ] || die "找不到 rpm：$RPM_FILE（先跑 05-build-rpm.sh）"

command -v dnf >/dev/null 2>&1 || die "没有 dnf —— 它是对着 Fedora/RHEL 元数据做解析的关键工具
  Debian/Ubuntu 上装它： sudo apt install -y dnf"

TS="https://mirrors.tuna.tsinghua.edu.cn"
# 目标清单：名称|releasever|repo（多个用 ; 分隔）
# ⚠️ 版本号是**刻意钉死**的：解析结果要可复现，不能靠"取最新"。
#    将来某个版本从镜像下线时，这里会明确报"镜像不可达"而不是静默跳过。
#
# ⚠️ 镜像选择也踩过坑：ROCKY 曾用 mirrors.ustc.edu.cn，结果它**限流返回 429**，
#    元数据拉不下来，dnf 于是报成「nothing provides gtk3/libX11…」——
#    **看起来像依赖问题，其实是环境问题**。所以：
#      1) 每个 repo 的 repomd.xml 都要**逐个预检**，不可达就明确报"环境问题"
#      2) 换用已验证两个仓库都 200 的 aliyun
TARGETS=(
  "Fedora 44|44|$TS/fedora/releases/44/Everything/$RPM_ARCH/os/"
  "CentOS Stream 9（RHEL 9 上游）|9|$TS/centos-stream/9-stream/BaseOS/$RPM_ARCH/os/;$TS/centos-stream/9-stream/AppStream/$RPM_ARCH/os/"
  "Rocky Linux 9（RHEL 9 重建）|9|https://mirrors.aliyun.com/rockylinux/9/BaseOS/$RPM_ARCH/os/;https://mirrors.aliyun.com/rockylinux/9/AppStream/$RPM_ARCH/os/"
)

echo "===== rpm 依赖解析验证 ====="
echo "  包: $(basename "$RPM_FILE")"
echo "  内架构: $(rpm -qp --qf '%{ARCH}' "$RPM_FILE" 2>/dev/null || echo '?')"
echo "  目标架构: $RPM_ARCH"
echo "  总依赖条数: $(rpm -qpR "$RPM_FILE" 2>/dev/null | wc -l)"
echo "  其中 soname 形式: $(rpm -qpR "$RPM_FILE" 2>/dev/null | grep -cE '\.so' || true)"
echo "  自提供（自满足）: $(comm -12 <(rpm -qpR "$RPM_FILE" 2>/dev/null | grep -E '\.so' | sort -u) <(rpm -qp --provides "$RPM_FILE" 2>/dev/null | sort -u) | wc -l) 条"

WORK="$(mktemp -d)"
cleanup() { sudo rm -rf "$WORK" 2>/dev/null || rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

fails=0
env_fails=0
for t in "${TARGETS[@]}"; do
  IFS='|' read -r name ver urls <<< "$t"
  echo
  echo "──────── $name（releasever=$ver / $RPM_ARCH）────────"

  # ★ 逐个预检每个 repo 的 repomd.xml：任何一个拉不到，元数据就不完整，
  #   之后的「nothing provides」全是假象（实测踩到过 USTC 429 那次）。
  repo_bad=0
  for u in ${urls//;/ }; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 40 "$u/repodata/repomd.xml" || echo 000)"
    if [ "$code" != "200" ]; then
      printf '\033[33m  ! 仓库元数据不可达（HTTP %s）：%s\033[0m\n' "$code" "$u"
      repo_bad=1
    fi
  done
  if [ "$repo_bad" = "1" ]; then
    printf '\033[33m  ! 跳过此目标 —— 这是**环境问题**（镜像限流/下线），不是包的缺陷\033[0m\n'
    echo "    提示：换一个镜像或稍后重试；也可以更新本脚本里的目标清单。"
    env_fails=$((env_fails + 1)); continue
  fi

  CONF="$WORK/conf-$ver-$(echo "$name" | tr -dc 'A-Za-z0-9')"
  ROOT="$WORK/root-$ver-$(echo "$name" | tr -dc 'A-Za-z0-9')"
  CACHE="$WORK/cache-$ver-$(echo "$name" | tr -dc 'A-Za-z0-9')"
  mkdir -p "$CONF" "$ROOT" "$CACHE"
  i=0
  for u in ${urls//;/ }; do
    i=$((i + 1))
    cat > "$CONF/repo$i.repo" <<EOF
[repo$i]
name=repo$i
baseurl=$u
enabled=1
gpgcheck=0
metadata_expire=86400
EOF
  done

  OUT="$WORK/out.txt"
  # ⚠️ 这里必须临时关掉 errexit。
  #    lib.sh 里有 `set -e`，而 `dnf --assumeno` 在**成功解析之后必然返回 1**
  #    （因为它主动放弃事务）。不关的话，脚本会在这一行**静默退出**：
  #    exit=1、没有任何报错信息，极难排查（实测踩到过）。
  set +e
  sudo dnf -y --releasever="$ver" --forcearch="$RPM_ARCH" \
      --installroot="$ROOT" \
      --setopt=reposdir="$CONF" \
      --setopt=cachedir="$CACHE" \
      --setopt=persistdir="$ROOT/var/lib/dnf" \
      --setopt=install_weak_deps=False \
      --setopt=tsflags=test \
      --assumeno install "$RPM_FILE" > "$OUT" 2>&1
  dnf_rc=$?
  set -e
  sudo chown "$(id -u):$(id -g)" "$OUT" 2>/dev/null || true
  echo "    （dnf 退出码 $dnf_rc —— --assumeno 下非 0 属正常）"

  if grep -qiE 'nothing provides|no match for argument|unable to find a match' "$OUT"; then
    printf '\033[31m  ✗ 有依赖无法满足：\033[0m\n'
    grep -iE 'nothing provides|no match for argument|unable to find a match' "$OUT" | sort -u | head -12 | sed 's/^/      /'
    fails=$((fails + 1)); continue
  fi
  cnt="$(grep -oE 'Install +[0-9]+ Packages?' "$OUT" | head -1 | grep -oE '[0-9]+')"
  if [ -n "$cnt" ]; then
    printf '\033[32m  ✓ 依赖闭包可解：%s 个包\033[0m\n' "$cnt"
    grep -E 'Total download size|Installed size' "$OUT" | sed 's/^/      /'
  else
    printf '\033[31m  ✗ 没拿到事务计划，输出尾部：\033[0m\n'
    tail -8 "$OUT" | sed 's/^/      /'
    fails=$((fails + 1))
  fi
  rm -rf "$ROOT" 2>/dev/null || sudo rm -rf "$ROOT" 2>/dev/null || true
done

echo
echo "===== 结论 ====="
evaluated=$(( ${#TARGETS[@]} - env_fails ))
if [ "$evaluated" -le 0 ]; then
  printf '\033[31m  所有目标的镜像都不可达 —— 这次**什么都没验证到**，不能算通过。\033[0m\n' >&2
  echo "  请换镜像或稍后重试。" >&2
  exit 1
fi
if [ "$fails" -gt 0 ]; then
  printf '\033[31m  有 %s 个目标的依赖**真**解析不过 —— rpm 在那些发行版上可能装不上。\033[0m\n' "$fails" >&2
  exit 1
fi
ok "$evaluated 个目标发行版的依赖解析全部通过。"
if [ "$env_fails" -gt 0 ]; then
  printf '\033[33m  另有 %s 个目标因镜像不可达被跳过（环境问题，**不计入通过**）\033[0m\n' "$env_fails"
fi
echo "  （这填补了 rpm 冒烟里「依赖未被真实验证」那个缺口）"
exit 0
