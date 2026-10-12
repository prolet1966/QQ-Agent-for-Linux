// 进程单实例锁：确保同一数据目录下只有一个 QQ Agent 核心在跑。
//
// 为什么需要（Electron 的 requestSingleInstanceLock 管不到的场景）：
//   - Electron 桌面端 + `npm run server` headless 同时启动 → 两份核心
//   - 双击 .bat 又手动 node src/server.js → 两份核心
//   两份核心会双份连 SnowLuma、双份处理群消息 → 群里看到重复回复。
//
// 原理：在数据目录放一个 qq-agent.lock 文件，内容 = PID。
//   启动时若锁文件存在且对应进程仍活着 → 判定已有实例，拒绝启动；
//   锁文件存在但进程已死（上次异常退出残留）→ 抢占锁，继续启动。
//   正常退出 / 被 kill 时删除锁文件。
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { acquireProcessLock } from './process-lock.js';

const LOCK_FILE = path.join(DATA_DIR, 'qq-agent.lock');
let releaseOwnedLock = null;
let cleanupRegistered = false;

/**
 * 尝试获取单实例锁。
 *
 * 用 `wx`（O_CREAT|O_EXCL）原子创建锁文件：文件已存在则创建失败，
 * 这是唯一能真正防"两个进程同时通过检查、都以为自己拿到锁"的机制。
 * 存在时再读 PID 判断是活锁（拒绝）还是残留锁（删除后重试一次）。
 *
 * @returns {{ ok: boolean, reason?: string, existingPid?: number }}
 */
export function acquireInstanceLock() {
  const result = acquireProcessLock(LOCK_FILE);
  if (result.ok) releaseOwnedLock = result.release;
  const { release: _release, ...publicResult } = result;
  return publicResult;
}

/** 释放单实例锁（正常退出时调用）。 */
export function releaseInstanceLock() {
  releaseOwnedLock?.();
  releaseOwnedLock = null;
}

/** 注册退出时自动释放锁（SIGINT/SIGTERM/正常 exit）。 */
export function registerLockCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const cleanup = () => releaseInstanceLock();
  // 锁的**唯一**释放时机是 'exit' 钩子：SIGINT 时立即释放会让优雅退出
  //（server.js 的 await app.stop()，可能数秒）期间新实例抢先拿锁、
  // 与旧实例短暂并存（双核心 = 群里重复回复）。交给 exit 钩子则天然
  // 排在进程真正结束之后，无竞态窗口。
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      // ⚠️ 不做任何事：不退出、不提前释放锁 —— 优雅退出 handler
      //   （server.js / electron）紧随其后执行，最终 process.exit 触发
      //   上面的 'exit' 钩子释放锁。
      // 保险丝：若 30 秒内没有别的 handler 退出进程（异常场景，优雅退出
      // 挂死），强制退出 —— 用非零码，让外层（守护脚本）能识别异常退出。
      const fuse = setTimeout(() => process.exit(1), 30000);
      fuse.unref?.();
    });
  }
}
