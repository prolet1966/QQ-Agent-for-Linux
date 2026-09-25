// instance-lock —— 单实例锁（宿主 src/instance-lock.js 语义照搬）
//
// 宿主兼容性修复（qq-agent-plugins README 第三节）：宿主 config.js 不导出 PROFILE_ID 符号
//   → 本插件用「防御式获取 + 环境变量兜底」，导入即崩的问题已修。
// 宿主真机验证：instance.lock = 运行中的 PID（29360），冲突时打日志放行绝不拦启动。
//
// 纯钩子插件：before-context 钩子在每轮运行前自检锁（冲突时打日志放行，不否决）。
// 无 providers（原 instance.lock 自建能力名核心无消费点，已降级删除，见 _note）。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
// 数据根目录唯一真源（多实例下必须与运行进程一致）
import { DATA_DIR } from '../../src/config.js';

let cfg = () => ({});
let lockPath = null;
let lockHeld = false;
let staleNote = '';

function resolveLockPath() {
  const c = cfg();
  // 复用核心 DATA_DIR（遵守 QQ_AGENT_DATA_DIR / QQ_AGENT_PROFILE 三层推导）——
  // 自己拼 data/ 会让实例 #2 把锁写进 #1 的目录，两个实例抢同一把锁、互相误报冲突。
  return path.join(DATA_DIR, c.lockFileName || 'instance.lock');
}

/** 防御式取 PROFILE_ID（宿主兼容修复：config.js 不导出 → 环境变量兜底 → 回退 'default'）。 */
function profileId() {
  try {
    const env = process.env;
    if (env.QQ_AGENT_PROFILE_ID) return String(env.QQ_AGENT_PROFILE_ID);
  } catch {}
  return 'default';
}

let api = null;

export function setup(a) {
  api = a;
  cfg = a.config;
  api.log('instance-lock 已加载（冲突打日志放行，绝不拦启动）');
}

export function available() {
  return { ok: true, reason: lockHeld ? '锁已持有（PID ' + process.pid + '）' : '未持有锁' };
}

export async function activate(ctx) {
  lockPath = resolveLockPath();
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const existing = readLock();
    if (existing && existing.pid !== process.pid && processAlive(existing.pid)) {
      // 宿主语义：冲突 → 打日志放行（绝不拦启动），记录给后续判断
      staleNote = '检测到同数据目录已有实例运行（PID ' + existing.pid + '）；本实例放行运行，但 data/ 写操作可能与它冲突。建议关掉其中一个。';
      api.warn?.('instance-lock: ' + staleNote);
    }
    // 写/刷新锁
    writeLock({ pid: process.pid, profile: profileId(), startedAt: new Date().toISOString() });
    lockHeld = true;
    api.log?.('instance-lock: 锁已写入 ' + lockPath + '（PID ' + process.pid + '）');
  } catch (e) {
    staleNote = '锁写入失败：' + e?.message;
    api.warn?.('instance-lock: ' + staleNote);
  }
}

export async function deactivate(ctx) {
  if (lockHeld) {
    try {
      const existing = readLock();
      if (existing?.pid === process.pid) fs.unlinkSync(lockPath);  // 只删自己的锁
      lockHeld = false;
      api.log?.('instance-lock: 锁已释放');
    } catch {}
  }
}

export function dispose() {
  lockHeld = false;
  lockPath = null;
}

function readLock() {
  try {
    if (!fs.existsSync(lockPath)) return null;
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return { pid: Number(raw.pid), profile: raw.profile, startedAt: raw.startedAt };
  } catch { return null; }
}
function writeLock(payload) {
  const tmp = lockPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  try { fs.unlinkSync(lockPath); } catch {}
  fs.renameSync(tmp, lockPath);
}
function processAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

export const hooks = {
  /**
   * 每轮运行前自检锁（宿主语义：冲突时打日志放行，不否决）。
   * 不返回 { block: true } —— 单实例锁是「提示」不是「拦截」（宿主：绝不拦启动）。
   */
  'before-context': (ctxArg) => {
    if (staleNote && ctxArg?.store) {
      try { ctxArg.store.instanceLockWarning = staleNote; } catch {}
    }
  },
};
