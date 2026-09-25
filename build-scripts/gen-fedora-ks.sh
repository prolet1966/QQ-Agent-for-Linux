#!/usr/bin/env bash
# gen-fedora-ks.sh —— 生成 Fedora 无人值守安装的 kickstart 文件。
#
# ## 为什么用 openssl 而不是 python crypt
#   Python 3.13 起移除了标准库 crypt 模块（实测本机 python3 就是如此）。
#   `openssl passwd -6` 生成的就是 kickstart/shadow 都认的 $6$ SHA-512 哈希。
#
# ## 为什么密码哈希必须是真的
#   我上一版 Rocky 的 ks 里直接抄了一串编造的 `$6$rpmtest$...` 哈希。
#   那是无效的 —— 装完系统根本登录不上，而失败现象是"密码错"，
#   很容易被误判成"密码填错了"，从而在错误方向上排查。
#   这里用 openssl 真实生成，并当场验证。
#
# 用法: bash gen-fedora-ks.sh <输出路径>

set -euo pipefail

OUT="${1:-/mnt/f/rpm-vm/ks.cfg}"
PASSWORD="rpmtest123"          # 测试机密码，VM 仅在宿主内网可达
PUBKEY_FILE="$HOME/.ssh/id_ed25519.pub"

echo "== 生成 Fedora kickstart =="

# ── 1. 公钥 ──────────────────────────────────────────────────────────────
if [ ! -f "$PUBKEY_FILE" ]; then
  echo "❌ 找不到 SSH 公钥: $PUBKEY_FILE"
  echo "   没有公钥就无法免密登录。先执行 ssh-keygen -t ed25519"
  exit 1
fi
PUBKEY=$(cat "$PUBKEY_FILE")
echo "  SSH 公钥: ${PUBKEY:0:50}..."

# ── 2. 密码哈希（真实生成 + 当场验证）────────────────────────────────────
if ! command -v openssl >/dev/null 2>&1; then
  echo "❌ 没有 openssl，无法生成密码哈希"
  exit 1
fi
PW_HASH=$(openssl passwd -6 "$PASSWORD")
echo "  密码哈希: ${PW_HASH:0:34}..."

# 验证哈希确实对应这个明文 —— 不验证就等于又写了个"看起来像"的值
if command -v python3 >/dev/null 2>&1; then
  VERIFY=$(python3 - "$PW_HASH" "$PASSWORD" <<'PY'
import sys, subprocess
h, pw = sys.argv[1], sys.argv[2]
# 用 openssl 重新算一次同样的明文与同样的 salt，比对结果
salt = h.split("$")[2]
out = subprocess.run(["openssl", "passwd", "-6", "-salt", salt, pw],
                     capture_output=True, text=True).stdout.strip()
print("ok" if out == h else "mismatch")
PY
)
  if [ "$VERIFY" = "ok" ]; then
    echo "  ✅ 哈希验证通过（用相同 salt 重算一致）"
  else
    echo "  ❌ 哈希验证失败，停止（否则装出的系统无法登录）"
    exit 1
  fi
fi

# ── 3. 写 kickstart ──────────────────────────────────────────────────────
mkdir -p "$(dirname "$OUT")"

cat > "$OUT" <<'KSEOF'
# Fedora Server 无人值守安装（由 gen-fedora-ks.sh 自动生成）
#
# 密码哈希与 SSH 公钥都是真实有效的（已当场验证）。
#
# 目的：建一台用于验证 QQ Agent .rpm 包的最小 Fedora 环境。
#
# ⚠️ 安装源必须用网络仓库，**不能用 cdrom**。
#    踩过的坑：最初写的是 cdrom，安装器启动后失败并反复重启
#    （内存 93MB → 4145MB → 掉回 44MB 循环；磁盘始终只有 3.8MB，未写入任何数据）。
#    原因是逻辑矛盾 —— netinst ISO 上**只有安装器，没有软件包**，
#    必须从网络仓库拉取，cdrom 这个源在 netinst 上装不了任何东西。
#
# ⚠️ 下面 $releasever / $basearch 是给**安装器**用的变量，不是给本脚本的。
#    所以 heredoc 用了带引号的分隔符 <<'KSEOF'（不做任何展开），
#    密码与公钥则用哨兵标记 @@PW_HASH@@ / @@PUBKEY@@，写完后再替换进去。
#    踩过的坑：最初 heredoc 没加引号，$releasever 被 bash 当自己的变量展开 →
#      line 64: releasever: unbound variable → 整个脚本中断，产出 0 字节 ks.cfg。
#
# ⚠️ 安装源改为**显式 baseurl**，不再用 metalink。
#    踩过的坑：用 metalink 时，Anaconda 停在 INSTALLATION SUMMARY，
#    "Software Selection" 显示红色 "Warning checking software selection"，
#    底部橙条要求先解决带警告的项，于是无人值守永远等不到 Begin Installation，
#    磁盘始终 3.8MB（没有任何写入），内存却在反复起落 —— 现象很像崩溃，其实是等输入。
#    metalink 会把请求重定向到第三方镜像，是否可用不可控；dl.fedoraproject.org 是
#    Fedora 官方 CDN（实测 HTTP 200），并且用显式路径时不需要靠变量展开去猜。

url --url="https://dl.fedoraproject.org/pub/fedora/linux/releases/$releasever/Everything/$basearch/os/"
repo --name="fedora" --baseurl="https://dl.fedoraproject.org/pub/fedora/linux/releases/$releasever/Everything/$basearch/os/"
repo --name="updates" --baseurl="https://dl.fedoraproject.org/pub/fedora/linux/updates/$releasever/Everything/$basearch/"

lang en_US.UTF-8
keyboard us
timezone Asia/Shanghai --utc

network --bootproto=dhcp --device=link --activate --hostname=rpm-test

rootpw --iscrypted @@PW_HASH@@
user --name=kmy --groups=wheel --iscrypted --password=@@PW_HASH@@

zerombr
clearpart --all --initlabel
autopart --type=lvm

# --ignoremissing：Fedora 各版本包组名会变（如 @^minimal-environment 在某个版本改名），
# 少一个包不该让整台机器装不出来。本 VM 只用于验证 rpm 依赖解析与安装，
# 缺个 curl/tar 不影响结论，但装不出系统会让整个验证停滞。
%packages --ignoremissing
@^minimal-environment
curl
tar
which
sudo
openssh-server
dnf
rpm
%end

%post --log=/root/ks-post.log
set -e

mkdir -p /home/kmy/.ssh
cat > /home/kmy/.ssh/authorized_keys <<'PUBKEY'
@@PUBKEY@@
PUBKEY
chmod 700 /home/kmy/.ssh
chmod 600 /home/kmy/.ssh/authorized_keys
chown -R kmy:kmy /home/kmy/.ssh

echo 'kmy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/kmy-nopasswd
chmod 440 /etc/sudoers.d/kmy-nopasswd

# SELinux permissive：本次只验 rpm 装包与依赖解析，与 SELinux 策略无关。
# 若 enforcing 拦住协议端注入，会把 SELinux 问题误判成包的问题。
# 测试脚本会单独报告 SELinux 状态，不掩盖这个差异。
sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config || true

systemctl disable --now firewalld >/dev/null 2>&1 || true
systemctl enable sshd >/dev/null 2>&1 || true

echo "kickstart post 完成: \$(date)" >> /root/ks-post.log
%end

reboot
KSEOF

# ── 4. 把哨兵标记替换为真实值 ────────────────────────────────────────────
# heredoc 用了 <<'KSEOF'（不展开），所以密码与公钥要在这一步注入。
# 用 python 做替换而不是 sed：公钥与哈希里可能含 / & 等 sed 特殊字符。
python3 - "$OUT" "$PW_HASH" "$PUBKEY" <<'PYEOF'
import sys
path, pw, key = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding="utf-8") as fh:
    text = fh.read()
before_pw = text.count("@@PW_HASH@@")
before_key = text.count("@@PUBKEY@@")
text = text.replace("@@PW_HASH@@", pw).replace("@@PUBKEY@@", key)
with open(path, "w", encoding="utf-8", newline="\n") as fh:
    fh.write(text)
print(f"  注入密码哈希 {before_pw} 处，公钥 {before_key} 处")
PYEOF

echo "  已写出: $OUT ($(stat -c%s "$OUT") 字节)"

echo
echo "== 自检 =="
OK=1
check_kw() {
  if grep -q "$1" "$OUT"; then printf "  ✅ %s\n" "$2"; else printf "  ❌ 缺少 %s\n" "$2"; OK=0; fi
}
# 固定字符串匹配：$6$ 里的 $ 在正则里是行尾锚点，用 -qF 才不会误判
check_fixed() {
  if grep -qF "$1" "$OUT"; then printf "  ✅ %s\n" "$2"; else printf "  ❌ 缺少 %s\n" "$2"; OK=0; fi
}

check_fixed "url --url="        "安装源：显式 baseurl（不是 metalink / cdrom）"
check_kw 'dl\.fedoraproject\.org'  "安装源指向 Fedora 官方 CDN"
check_fixed "rootpw --iscrypted \$6\$" "root 密码（真实 \$6\$ 哈希）"
check_kw "user --name=kmy"     "普通用户 kmy"
check_kw "autopart"            "自动分区"
check_kw "authorized_keys"     "SSH 公钥注入"
check_kw "^%end"               "段结束标记"

if grep -q "__" "$OUT"; then
  echo "  ⚠️  残留占位符 __"
  OK=0
fi

[ $OK -eq 1 ] && echo "  ✅ 自检全部通过" || echo "  ❌ 自检有问题"
exit $((1-OK))
