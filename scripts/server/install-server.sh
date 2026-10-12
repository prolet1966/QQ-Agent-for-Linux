#!/usr/bin/env bash
set -Eeuo pipefail

# Install a previously verified server archive without touching user data.
# Run as root: install-server.sh ARCHIVE [INSTALL_ROOT] [DATA_DIR] [USER]
archive=${1:?用法: install-server.sh ARCHIVE [INSTALL_ROOT] [DATA_DIR] [USER] [NODE_EXEC]}
install_root=${2:-/opt/qq-agent-server}
data_dir=${3:-/var/lib/qq-agent}
service_user=${4:-qqa}
node_exec=${5:-$(command -v node || true)}
[[ $EUID -eq 0 ]] || { echo '请以 root 运行安装器' >&2; exit 2; }
[[ -f "$archive" ]] || { echo "找不到归档：$archive" >&2; exit 2; }
install_root=$(readlink -m -- "$install_root")
data_dir=$(readlink -m -- "$data_dir")
[[ "$install_root" =~ ^/[a-zA-Z0-9_./-]+$ && "$data_dir" =~ ^/[a-zA-Z0-9_./-]+$ && "$service_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo '目录或用户名含不支持的字符' >&2; exit 2; }
case "$install_root" in /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/proc|/root|/run|/sbin|/sys|/tmp|/usr|/var) echo "拒绝危险安装目录：$install_root" >&2; exit 2;; esac
case "$data_dir" in /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/proc|/root|/run|/sbin|/sys|/tmp|/usr) echo "拒绝危险数据目录：$data_dir" >&2; exit 2;; esac
[[ -x "$node_exec" && "$node_exec" == /* ]] || { echo '安装前需要 Node.js 22.16+ 的绝对可执行路径（归档不包含运行时）' >&2; exit 2; }
node_exec=$(readlink -f -- "$node_exec")
[[ "$node_exec" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Node 路径含不支持的字符' >&2; exit 2; }
"$node_exec" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<16)) process.exit(1)' || { echo 'Node 版本过低，需要 >=22.16' >&2; exit 2; }
id "$service_user" >/dev/null 2>&1 || useradd --system --home-dir "$data_dir" --create-home --shell /usr/sbin/nologin "$service_user"
service_group=$(id -gn "$service_user")
if [[ ! -d "$data_dir" ]]; then install -d -o "$service_user" -g "$service_group" -m 0750 "$data_dir"; fi
runuser -u "$service_user" -- test -w "$data_dir" || { echo "服务用户不能写入 $data_dir；请核对原有数据属主，不自动重写历史权限。" >&2; exit 2; }
# Record only the core unit/release state. An existing desktop/Electron launch
# has no unit here and is deliberately never restarted by a failed install.
unit_file=/etc/systemd/system/qq-agent-server.service
old_unit_present=0; old_unit_backup=""; old_service_active=0; old_service_enabled=0
trap '[[ -z "$old_unit_backup" ]] || rm -f -- "$old_unit_backup"' EXIT
if [[ -f "$unit_file" ]]; then
  old_unit_present=1
  old_unit_backup=$(mktemp /run/qq-agent-server-unit.XXXXXX)
  cp -a -- "$unit_file" "$old_unit_backup"
  systemctl is-active --quiet qq-agent-server.service && old_service_active=1 || true
  systemctl is-enabled --quiet qq-agent-server.service && old_service_enabled=1 || true
fi
old_current=""; old_previous=""
if [[ -L "$install_root/current" ]]; then old_current=$(readlink -f -- "$install_root/current" 2>/dev/null || true); fi
if [[ -L "$install_root/previous" ]]; then old_previous=$(readlink -f -- "$install_root/previous" 2>/dev/null || true); fi
for link in current previous; do
  [[ ! -e "$install_root/$link" || -L "$install_root/$link" ]] || { echo "$link 必须是版本符号链接" >&2; exit 2; }
done
for target in "$old_current" "$old_previous"; do
  [[ -z "$target" ]] && continue
  case "$target" in "$install_root/releases/"*) :;; *) echo '已有版本链接不在 releases 内，拒绝覆盖' >&2; exit 2;; esac
  [[ -d "$target" ]] || { echo "已有版本不存在：$target" >&2; exit 2; }
done
env_file=/etc/qq-agent/server.env
health_port=3210
if [[ -e "$env_file" ]]; then
  saved_data=$(awk -F= '/^[[:space:]]*QQ_AGENT_DATA_DIR[[:space:]]*=/{sub(/^[^=]*=/,""); gsub(/^[[:space:]"\047]+|[[:space:]"\047]+$/,"",$0); print; exit}' "$env_file")
  [[ "$saved_data" == "$data_dir" ]] || { echo '现有 server.env 的 QQ_AGENT_DATA_DIR 与安装参数不一致；请使用原数据目录重试，不会自动改写。' >&2; exit 2; }
  health_port=$(awk -F= '/^[[:space:]]*QQ_AGENT_PORT[[:space:]]*=/{sub(/^[^=]*=/,""); gsub(/^[[:space:]"\047]+|[[:space:]"\047]+$/,"",$0); print; exit}' "$env_file")
  health_port=${health_port:-3210}
fi
[[ "$health_port" =~ ^[0-9]+$ && health_port -ge 1 && health_port -le 65535 ]] || { echo 'server.env 中 QQ_AGENT_PORT 无效，未切换核心' >&2; exit 2; }
switched=0
rollback_install() {
  set +e
  echo '新核心健康检查失败，正在恢复旧核心版本；用户数据、QQ 和 SnowLuma 不会被修改。' >&2
  systemctl stop qq-agent-server.service >/dev/null 2>&1 || true
  if [[ -n "$old_current" && -d "$old_current" ]]; then
    ln -sfn -- "$old_current" "$install_root/current.new"
    mv -Tf -- "$install_root/current.new" "$install_root/current"
  else
    rm -f -- "$install_root/current" "$install_root/current.new"
  fi
  if [[ -n "$old_previous" && -d "$old_previous" ]]; then ln -sfn -- "$old_previous" "$install_root/previous"; else rm -f -- "$install_root/previous"; fi
  if (( old_unit_present )); then
    cp -a -- "$old_unit_backup" "$unit_file"
  else
    rm -f -- "$unit_file"
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  if (( old_unit_present && old_service_enabled )); then systemctl enable qq-agent-server.service >/dev/null 2>&1 || true; else systemctl disable qq-agent-server.service >/dev/null 2>&1 || true; fi
  if (( old_unit_present && old_service_active )); then
    systemctl start qq-agent-server.service >/dev/null 2>&1 || true
  else
    systemctl stop qq-agent-server.service >/dev/null 2>&1 || true
  fi
  switched=0
  [[ -z "$old_unit_backup" ]] || rm -f -- "$old_unit_backup"
}
finish_install() { [[ -z "$old_unit_backup" ]] || rm -f -- "$old_unit_backup"; }
trap 'status=$?; if (( switched )); then rollback_install; fi; exit "$status"' ERR
install -d -o root -g root -m 0755 "$install_root/releases" "$install_root/unit-state"
release="$install_root/releases/$(date -u +%Y%m%d%H%M%S)-$$"
install -d -o root -g root -m 0755 "$release"
"$node_exec" - "$archive" <<'NODE'
const fs = require('fs'), zlib = require('zlib');
const archive = zlib.gunzipSync(fs.readFileSync(process.argv[2]), { maxOutputLength: 128 * 1024 * 1024 });
const seen = new Set();
for (let offset = 0; offset + 512 <= archive.length;) {
  const header = archive.subarray(offset, offset + 512);
  if (header.every(byte => byte === 0)) break;
  const field = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/, '');
  const storedChecksum = parseInt(field(148,8).trim(),8);
  const actualChecksum = header.reduce((sum,byte,index)=>sum+(index>=148&&index<156?32:byte),0);
  if (storedChecksum!==actualChecksum) throw new Error('归档头校验失败');
  const name = [field(345,155), field(0,100)].filter(Boolean).join('/');
  const type = field(156,1);
  if (type && type !== '0') throw new Error('归档包含非普通文件');
  if (!name.startsWith('qq-agent-server/') || name.includes('\\') || name.split('/').some(part => part === '..' || part === '.' || !part) || seen.has(name)) throw new Error('归档包含不安全或重复路径');
  seen.add(name);
  const size = parseInt(field(124,12),8);
  if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > archive.length) throw new Error('归档长度损坏');
  offset += 512 + Math.ceil(size / 512) * 512;
}
if (!seen.has('qq-agent-server/server-manifest.json')) throw new Error('归档缺少服务器清单');
NODE
tar -xzf "$archive" -C "$release" --strip-components=1 --no-same-owner --no-same-permissions
[[ -f "$release/scripts/server/verify-release.mjs" ]] || { echo "归档缺少校验器，未切换核心；临时版本保留在 $release" >&2; exit 1; }
"$node_exec" "$release/scripts/server/verify-release.mjs" "$release"
find "$release" -type d -exec chmod 0755 {} +
find "$release" -type f -exec chmod 0644 {} +
find "$release/scripts/server" -name '*.sh' -exec chmod 0755 {} +
chown -R root:root "$release"
chmod -R a-w "$release"
install -d -o root -g root -m 0755 /etc/qq-agent
if [[ ! -e "$env_file" ]]; then
  umask 077; cat >"$env_file" <<EOF
QQ_AGENT_MODE=server
QQ_AGENT_PRESET=server-2c2g
QQ_AGENT_DATA_DIR=$data_dir
QQ_AGENT_PORT=3210
QQ_AGENT_BIND_HOST=0.0.0.0
# Set QQ_AGENT_PUBLIC_HOST to the public IP:port (for example 47.109.97.184:3210).
# First start creates DATA_DIR/console-initial-password.txt with mode 0600.
EOF
  chown root:root "$env_file"; chmod 0600 "$env_file"
fi
switched=1
previous=$old_current
case "$previous" in "$install_root/releases/"*) ln -sfn -- "$previous" "$install_root/previous";; '') :;; *) echo '当前符号链接不在 releases 内，拒绝覆盖' >&2; exit 1;; esac
if (( old_service_active )); then systemctl stop qq-agent-server.service; fi
runuser -u "$service_user" -- "$node_exec" - "$data_dir" <<'NODE'
const fs=require('fs'),path=require('path');
const file=path.join(process.argv[2],'qq-agent.lock');
if(fs.existsSync(file)) {
  const pid=Number(fs.readFileSync(file,'utf8').trim());
  if(!Number.isSafeInteger(pid)||pid<1) throw new Error('实例锁格式异常，请先检查');
  try { process.kill(pid,0); throw new Error('数据目录仍有 QQA 进程运行，需手动停止既有核心后再安装'); }
  catch(error) { if(error.code!=='ESRCH') throw error; }
}
NODE
install -m 0644 "$release/scripts/server/qq-agent-server.service" /etc/systemd/system/qq-agent-server.service
sed -i "s|@INSTALL_ROOT@|$install_root|g; s|@DATA_DIR@|$data_dir|g; s|@USER@|$service_user|g; s|@GROUP@|$service_group|g; s|@NODE_EXEC@|$node_exec|g" /etc/systemd/system/qq-agent-server.service
# Keep unit snapshots outside the immutable release/manifest. A manual rollback
# restores the prior Node executable and service restrictions, not only its JS.
if [[ -n "$old_current" ]] && (( old_unit_present )); then
  install -m 0644 "$old_unit_backup" "$install_root/unit-state/$(basename "$old_current").service"
fi
install -m 0644 "$unit_file" "$install_root/unit-state/$(basename "$release").service"
ln -sfn -- "$release" "$install_root/current.new"
mv -Tf -- "$install_root/current.new" "$install_root/current"
switched=1
systemctl daemon-reload
systemctl enable qq-agent-server.service
systemctl restart qq-agent-server.service
health_check() {
  local port=$1
  for _ in $(seq 1 40); do
    if systemctl is-active --quiet qq-agent-server.service && "$node_exec" - "$port" <<'NODE'
const http=require('http');
const port=Number(process.argv[2]);
const req=http.get({host:'127.0.0.1',port,path:'/api/auth/session',headers:{connection:'close'}},res=>{
  let body='';
  res.on('data',chunk=>{body+=chunk; if(body.length>8192)req.destroy();});
  res.once('end',()=>{
    try { process.exit(res.statusCode===200&&typeof JSON.parse(body).authenticated==='boolean'?0:1); }
    catch { process.exit(1); }
  });
});
req.setTimeout(800,()=>req.destroy()); req.on('error',()=>process.exit(1));
NODE
    then return 0; fi
    sleep 0.5
  done
  return 1
}
if ! health_check "$health_port"; then
  rollback_install
  echo '安装已回滚：旧核心服务状态已恢复；若此前没有受管核心 unit，则没有启动任何旧桌面进程。' >&2
  exit 1
fi
finish_install
echo "已安装核心版本：$release"
echo "数据目录保持：$data_dir；QQ/SnowLuma 独立服务不会被安装器停止或删除。"
echo '设置 /etc/qq-agent/server.env 中 QQ_AGENT_PUBLIC_HOST 后重启核心，再通过浏览器访问 3210。'
