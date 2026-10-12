// Shared between the core and offline storage maintenance. Keep the on-disk
// record a plain PID for deployment-tool compatibility, but hold an in-process
// ownership token so a refused contender cannot release another caller's lock.
import fs from 'node:fs';
import path from 'node:path';

const owned = new Map();
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}
function pidFrom(file) { return Number(String(fs.readFileSync(file, 'utf8')).trim()); }
function validPid(pid) { return Number.isSafeInteger(pid) && pid > 0; }

export function acquireProcessLock(file) {
  file = path.resolve(file);
  const recovery = `${file}.recovery`;
  if (owned.has(file)) return { ok: false, reason: '本进程已有 QQA 或存储维护任务持有数据目录锁', existingPid: process.pid };
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); }
  catch (error) { return { ok: false, reason: `无法创建实例锁目录：${error.message}` }; }
  function claim() {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
    const token = Symbol('process-lock'); owned.set(file, token);
    return { ok: true, release() {
      if (owned.get(file) !== token) return;
      try { if (pidFrom(file) === process.pid) fs.unlinkSync(file); }
      catch { /* absent or replaced; never release another PID's lock */ }
      owned.delete(file);
    } };
  }
  try { return claim(); }
  catch (error) {
    if (error?.code !== 'EEXIST') return { ok: false, reason: `无法写入实例锁文件：${error.message}` };
  }
  let existingPid;
  try { existingPid = pidFrom(file); }
  catch (error) { return { ok: false, reason: `实例锁正在创建或无法读取：${error.message}` }; }
  if (!validPid(existingPid)) return { ok: false, reason: '实例锁正在创建或格式异常；请先检查现有进程和 qq-agent.lock，不自动删除。' };
  if (alive(existingPid)) return { ok: false, reason: `已有 QQA 或存储维护进程仍在运行（PID ${existingPid}）`, existingPid };
  let recovering = false;
  try {
    // Only one stale reclaimer may unlink a dead owner's record. Reread under
    // the guard: another starter could have won the normal wx claim meanwhile.
    fs.writeFileSync(recovery, String(process.pid), { flag: 'wx', mode: 0o600 });
    recovering = true;
    const currentPid = pidFrom(file);
    if (!validPid(currentPid)) return { ok: false, reason: '实例锁格式异常，拒绝清理。' };
    if (alive(currentPid)) return { ok: false, reason: `已有 QQA 或存储维护进程仍在运行（PID ${currentPid}）`, existingPid: currentPid };
    fs.unlinkSync(file);
    return claim();
  } catch (error) {
    return { ok: false, reason: `实例锁恢复被占用或失败；请检查 qq-agent.lock.recovery：${error.message}` };
  } finally {
    if (recovering) {
      try { fs.unlinkSync(recovery); } catch { /* retained for manual inspection */ }
    }
  }
}
