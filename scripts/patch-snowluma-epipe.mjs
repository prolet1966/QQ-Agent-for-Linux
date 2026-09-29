#!/usr/bin/env node
/**
 * R68 构建期注入：给 vendored snowluma 的 logger 补上 stdout/stderr 的 'error' 兜底。
 *
 * 为什么需要这个脚本：
 *   snowluma/ 是 vendored 上游产物（从 snowluma-2/ 拷贝而来），每次跟随上游更新都会
 *   把手工补丁冲掉。把注入固化成构建步骤，就能保证任何一次 `npm run dist:*` 打出来的
 *   包都带兜底，不依赖"记得手动改一遍"。
 *
 * 背景（详见 logger 内注入处的注释）：
 *   emit() 里写控制台的 try/catch 只挡得住**同步** throw。stderr 是管道时写入是异步的，
 *   对端消失不会同步 throw，而是异步 emit 'error' → 无监听器 → 冒泡成 uncaughtException
 *   → 处理器又调 logger.error() → 写回同一个已断的管道 → EPIPE → 无限自激。
 *   实测单文件 69,442 条 EPIPE / 763,862 行，20+ 个 50MB 轮转文件循环复用，约 0.5MB/s 写盘。
 *
 * 幂等：已注入的文件跳过。用法：
 *   node scripts/patch-snowluma-epipe.mjs [目录...]     默认 ./snowluma
 * 退出码恒为 0（注入失败不该拦住打包，但会打印告警）。
 */
import fs from 'node:fs';
import path from 'node:path';

const MARK = '_r68Stream';
const ANCHOR = 'function emit(level, options, args) {';
const GUARD = [
  '// ── R68 兜底（构建期由 scripts/patch-snowluma-epipe.mjs 注入，勿手改）──',
  '// 不能加 listenerCount(\'error\') 守卫后跳过：调用方可能已挂过监听器，',
  '// 守卫会让整段不执行，等于没修。',
  'for (const _r68Stream of [process.stdout, process.stderr]) {',
  '\tif (_r68Stream && typeof _r68Stream.on === "function") _r68Stream.on("error", () => {});',
  '}',
  '',
].join('\n');

const roots = process.argv.slice(2);
if (roots.length === 0) roots.push('snowluma');

let patched = 0, skipped = 0, missed = 0;
for (const root of roots) {
  if (!fs.existsSync(root)) {
    console.warn(`[R68] 跳过不存在的目录：${root}`);
    continue;
  }
  const files = fs.readdirSync(root)
    .filter((f) => f.startsWith('logger-') && f.endsWith('.js'));
  if (files.length === 0) console.warn(`[R68] ${root} 下没有 logger-*.js`);
  for (const file of files) {
    const full = path.join(root, file);
    const src = fs.readFileSync(full, 'utf8');
    if (src.includes(MARK)) { skipped++; continue; }
    const at = src.indexOf(ANCHOR);
    if (at === -1) {
      console.warn(`[R68] ${full} 找不到锚点，跳过（上游结构可能变了，请人工确认）`);
      missed++;
      continue;
    }
    try {
      fs.writeFileSync(full, src.slice(0, at) + GUARD + src.slice(at), 'utf8');
      console.log(`[R68] 已注入：${full}`);
      patched++;
    } catch (error) {
      console.warn(`[R68] 写入失败（无权限？）：${full} —— ${error?.code ?? error}`);
      missed++;
    }
  }
}
console.log(`[R68] 完成：注入 ${patched}，已存在 ${skipped}，未匹配 ${missed}`);
process.exit(0);
