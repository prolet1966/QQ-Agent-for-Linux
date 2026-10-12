#!/usr/bin/env bash
set -Eeuo pipefail
install_root=${1:-/opt/qq-agent-server}
[[ $EUID -eq 0 ]] || { echo '请以 root 运行回滚器' >&2; exit 2; }
install_root=$(readlink -m -- "$install_root")
[[ "$install_root" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo '安装路径含不支持的字符' >&2; exit 2; }
case "$install_root" in /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/proc|/root|/run|/sbin|/sys|/tmp|/usr|/var) echo '拒绝危险安装目录' >&2; exit 2;; esac
[[ -L "$install_root/current" && -L "$install_root/previous" ]] || { echo 'current 和 previous 必须是版本符号链接' >&2; exit 2; }
current=$(readlink -f -- "$install_root/current" 2>/dev/null || true)
[[ -n "$current" && -d "$current" ]] || { echo '没有可回滚的 current 版本' >&2; exit 1; }
previous=$(readlink -f -- "$install_root/previous" 2>/dev/null || true)
[[ -n "$previous" && -d "$previous" ]] || { echo '没有上一版本；不会删除当前版本' >&2; exit 1; }
case "$current" in "$install_root/releases/"*) :;; *) echo 'current 不在 releases 内，拒绝回滚' >&2; exit 2;; esac
case "$previous" in "$install_root/releases/"*) :;; *) echo 'previous 不在 releases 内，拒绝回滚' >&2; exit 2;; esac
unit_file=/etc/systemd/system/qq-agent-server.service
previous_unit="$install_root/unit-state/$(basename "$previous").service"
[[ -f "$unit_file" && -f "$previous_unit" ]] || { echo '缺少上一版本的 unit 快照；保留当前核心，需手动核对历史安装。' >&2; exit 2; }
node_exec=$(awk '/^ExecStart=/{sub(/^ExecStart=/,""); split($0,a,/[[:space:]]+/); print a[1]; exit}' "$previous_unit")
[[ "$node_exec" =~ ^/[a-zA-Z0-9_./-]+$ && -x "$node_exec" ]] || { echo '上一版本 Node 路径无效或已不存在，未切换核心' >&2; exit 2; }
health_port=$(awk -F= '/^[[:space:]]*QQ_AGENT_PORT[[:space:]]*=/{sub(/^[^=]*=/,""); gsub(/^[[:space:]"\047]+|[[:space:]"\047]+$/,"",$0); print; exit}' /etc/qq-agent/server.env)
health_port=${health_port:-3210}
[[ "$health_port" =~ ^[0-9]+$ && health_port -ge 1 && health_port -le 65535 ]] || { echo 'server.env 中 QQ_AGENT_PORT 无效，未切换核心' >&2; exit 2; }
old_active=0
systemctl is-active --quiet qq-agent-server.service && old_active=1 || true
unit_backup=$(mktemp /run/qq-agent-server-rollback.XXXXXX)
cp -a -- "$unit_file" "$unit_backup"
switched=0
restore_current() {
  set +e
  systemctl stop qq-agent-server.service >/dev/null 2>&1 || true
  ln -sfn -- "$current" "$install_root/current.new"
  mv -Tf -- "$install_root/current.new" "$install_root/current"
  ln -sfn -- "$previous" "$install_root/previous"
  cp -a -- "$unit_backup" "$unit_file"
  systemctl daemon-reload >/dev/null 2>&1 || true
  if (( old_active )); then systemctl start qq-agent-server.service >/dev/null 2>&1 || true; fi
  switched=0
  echo '回滚版本未通过健康检查，已恢复本次操作前的核心与 unit。用户数据保持原状。' >&2
}
trap 'status=$?; if (( switched )); then restore_current; fi; rm -f -- "$unit_backup"; exit "$status"' ERR
trap 'rm -f -- "$unit_backup"' EXIT
switched=1
systemctl stop qq-agent-server.service
install -m 0644 "$previous_unit" "$unit_file"
ln -sfn -- "$previous" "$install_root/current.new"
mv -Tf -- "$install_root/current.new" "$install_root/current"
ln -sfn -- "$current" "$install_root/previous"
systemctl daemon-reload
if (( old_active )); then
  systemctl start qq-agent-server.service
  ready=0
  for _ in $(seq 1 40); do
    if systemctl is-active --quiet qq-agent-server.service && "$node_exec" - "$health_port" <<'NODE'
const http=require('http');
const req=http.get({host:'127.0.0.1',port:Number(process.argv[2]),path:'/api/auth/session',headers:{connection:'close'}},res=>{
  let body=''; res.on('data',chunk=>{body+=chunk; if(body.length>8192)req.destroy();});
  res.once('end',()=>{try { process.exit(res.statusCode===200&&typeof JSON.parse(body).authenticated==='boolean'?0:1); } catch { process.exit(1); }});
});
req.setTimeout(800,()=>req.destroy()); req.on('error',()=>process.exit(1));
NODE
    then ready=1; break; fi
    sleep 0.5
  done
  if (( ! ready )); then restore_current; exit 1; fi
fi
switched=0
echo "核心已回滚到：$previous；原服务启停状态已保留。"
echo '消息 SQLite/JSON 回滚需要单独执行 message-storage.mjs；本脚本不改变用户数据。'
