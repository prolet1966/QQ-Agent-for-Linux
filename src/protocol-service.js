import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
const exec = promisify(execFile);
const UNITS = { snow: 'qq-agent-snowluma.service', qq: 'qq-agent-qq.service', desktop: 'qq-agent-desktop.service' };
export async function requestComponentAction(socketPath, kind, action, { timeoutMs = 30000 } = {}) {
  if (!Object.hasOwn(UNITS, kind) || !['start', 'stop', 'restart'].includes(action)) throw new Error('无效的协议服务操作');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks = []; let bytes = 0;
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('组件管理请求超时')));
    socket.once('connect', () => socket.write(`${JSON.stringify({ kind, action })}\n`));
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 8192) socket.destroy(new Error('组件管理响应超限'));
      else chunks.push(chunk);
    });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result?.ok !== true) throw new Error(String(result?.error || '组件管理失败').slice(0, 500));
        resolve(result);
      } catch (error) { reject(error); }
      finally { socket.destroy(); }
    });
  });
}
export async function protocolService(kind, action = 'show') {
  const unit = UNITS[kind];
  if (!unit || !['show', 'start', 'stop', 'restart'].includes(action)) throw new Error('无效的协议服务操作');
  if (process.platform !== 'linux') return { ok: false, error: '服务器协议服务需要 Linux systemd' };
  try {
    if (action !== 'show') {
      if (process.env.QQ_AGENT_COMPONENT_SOCKET) await requestComponentAction(process.env.QQ_AGENT_COMPONENT_SOCKET, kind, action);
      else await exec('systemctl', ['--no-ask-password', action, unit], { timeout: 25000, maxBuffer: 64 * 1024 });
    }
    const { stdout } = await exec('systemctl', ['show', unit, '--property=LoadState,ActiveState,SubState,MainPID'], { timeout: 3000, maxBuffer: 4096 });
    const fields = Object.fromEntries(stdout.trim().split('\n').map(line => line.split('=')));
    return { ok: fields.LoadState === 'loaded', unit, running: fields.ActiveState === 'active', state: fields.SubState,
      pid: Number(fields.MainPID) || null, error: fields.LoadState === 'loaded' ? '' : '独立服务未安装，请运行服务器安装脚本' };
  } catch (error) {
    return { ok: false, unit, error: String(error.stderr || error.message).slice(0, 500),
      hint: '检查固定服务是否安装及 qqa 用户的服务管理授权；详情见服务器安装文档' };
  }
}
