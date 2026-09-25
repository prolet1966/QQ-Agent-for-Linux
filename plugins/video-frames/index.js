// 视频抽帧 Skill 入口。
//
// 只提供一个能力：`video.frames`
//   输入  { filePath, count?, maxWidth?, quality?, durationSec?, ffmpegPath? }
//   输出  { frames: string[], times: number[], error? }
//
// 核心模块（video-reader / tools）通过能力名取用它，**不 import 本文件**：
// 这样关掉这个 Skill 就退回"只给元信息"，换实现也不用改核心代码。
//
// 为什么抽帧要单独做成 Skill 而不是写死在核心：
//   · ffmpeg 是**外部可执行文件**，装没装、装在哪、能不能用都是环境相关的
//   · 抽几帧、多大尺寸、什么质量是**口味问题**，不同机器/不同模型差别很大
//   · 有些模型（Gemini、Qwen-VL 等）能原生读视频，那就完全不需要抽帧 ——
//     这时把 Skill 关掉即可，核心会走"原生视频输入"那条路
//   这三件事都符合"可插拔能力"的定位，而"决定走哪条路"是核心的职责。

import { extractFrames, findFfmpeg, probeDuration } from './frames.js';

let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log;
}

export const providers = {
  // 抽帧：参数优先级 调用方传入 > 用户在设置页配的 > 默认值
  'video.frames': async ({ filePath, count, maxWidth, quality, durationSec, ffmpegPath } = {}) => {
    const c = cfg();
    const want = Math.max(1, Math.min(12, Math.round(Number(count) || Number(c.count) || 4)));
    const result = await extractFrames({
      filePath,
      count: want,
      maxWidth: Number(maxWidth) || Number(c.maxWidth) || 768,
      quality: Number(quality) || Number(c.quality) || 4,
      durationSec,
      ffmpegPath: ffmpegPath || null
    });
    if (result.error) log(`抽帧未成功：${result.error}`);
    return result;
  },

  // 让核心能问"现在这条路走得通吗"，用于 auto 模式的降级判断
  'video.frames.available': async ({ ffmpegPath } = {}) => {
    const ff = ffmpegPath || await findFfmpeg();
    return { ok: Boolean(ff), reason: ff ? '' : '未找到 ffmpeg（抽帧需要它）' };
  }
};

/**
 * 自检：没有 ffmpeg 时标为"依赖不满足"，UI 会直接显示原因。
 *
 * ⚠️ 这个函数**必须是同步的** —— SkillManager 的可用性判定（以及工具可用性判定）
 * 是同步调用链，`available()` 返回 Promise 会被当成"可用"（Promise 是 truthy）。
 * 但探测 ffmpeg 要 spawn 进程，只能异步。
 * 折中：首次调用先乐观返回"可用"并在后台探测，探测结果缓存下来，
 * 之后每次判定都读到真实状态（UI 下一次刷新就能看到原因）。
 * 不这么做的话表现是：明明没装 ffmpeg，设置页却显示"生效中"，
 * 而真正抽帧时又失败 —— 正是要消灭的那种"界面与实际不一致"。
 */
let ffmpegKnown = null;   // null = 还没探测出来；'' = 确认没有；路径 = 确认有
let probing = false;
let probeAt = 0;          // 上次探测时间：失败结果最多缓存 60 秒，之后允许重探
const PROBE_RETRY_MS = 60000;
function probeFfmpegInBackground() {
  if (probing) return;
  if (ffmpegKnown) return;                                     // 成功结果长期有效
  if (ffmpegKnown !== null && Date.now() - probeAt < PROBE_RETRY_MS) return;
  probing = true;
  findFfmpeg()
    .then((p) => { ffmpegKnown = p || ''; probeAt = Date.now(); })
    .catch(() => { ffmpegKnown = ''; probeAt = Date.now(); })
    .finally(() => { probing = false; });
}

/**
 * 自检。
 *
 * ⚠️ 「未知」必须当作**不可用**返回，不能乐观放行（2026-09-20 修，一次缓存抖动事故）。
 *
 * 旧写法是：
 *   if (ffmpegKnown === null) { probeFfmpegInBackground(); return { ok: true }; }
 * 配合上面"失败结果 60 秒后重探 → 把 ffmpegKnown 置回 null"，就形成了每 60 秒一次的循环：
 *   探测失败(不可用) → 60s 后置 null → 乐观放行(可用) → 再探测失败 → …
 * 而本插件的 promptSections() 会跟着这个状态增删「▸ 视频理解」那一段，
 * 于是**系统提示每 60 秒在两个字节版本之间来回跳**。
 *
 * 后果是缓存灾难：系统提示只要变一个字符，服务商的整段前缀缓存就失效。
 * 实测（本机确实没装 ffmpeg）表现为新会话第 1 次调用命中率在
 * 2688(35%) 与 7424(96%) 之间无规律跳动，保活也跟着白做。
 *
 * 现在改为：只有**探测确认可用**才返回 ok。代价是首次探测完成前（毫秒级，
 * 后台进行）会短暂报"不可用"，但状态不再来回抖，系统提示因此字节稳定。
 * 探测仍照常重试，所以用户后来装好 ffmpeg 依然能在下一轮恢复。
 */
export function available() {
  // 失败结果超 60 秒自动重探：用户后来装好 ffmpeg 不需要重启就能恢复
  if (ffmpegKnown === '' && Date.now() - probeAt > PROBE_RETRY_MS) ffmpegKnown = null;
  if (ffmpegKnown === null) {
    probeFfmpegInBackground();
    // 「还在探测」= 尚不可用（保持悲观）。旧实现这里返回 ok:true，
    // 正是它在每次重探时把「视频理解」段又变出来。
    return { ok: false, reason: '正在探测 ffmpeg…' };
  }
  if (!ffmpegKnown) return { ok: false, reason: '未找到 ffmpeg，无法抽帧（装好 ffmpeg 后约 1 分钟内自动恢复）' };
  return { ok: true };
}

export function promptSections() {
  const c = cfg();
  return [{
    // ⚠️ id 必须与 plugin.json 里那条**完全相同**（2026-09-20 修，与
    //    thinking-adapters 同一个毛病）：原来这里写 'video-frames-active'、
    //    manifest 写 'video-frames-note'，两段都讲"抽帧"且都带「视频理解」
    //    标题 → 按-id-去重认不出是同一件事 → 系统提示里出现两遍，
    //    每次调用白付约 100 字符，而且两段说法还不一致（manifest 没写帧数）。
    //    同 id 后由 manager 的去重保证本条（信息更全）胜出。
    id: 'video-frames-note',
    title: '视频理解',
    priority: 35,
    content: `你看到的视频画面是从视频里抽出的 ${Number(c.count) || 4} 张截图，不是连续视频。帧与帧之间发生的事你看不到，描述时不要断言中间的连续过程。`
  }];
}

export const internals = {
  extractFrames, findFfmpeg, probeDuration,
  // 测试用：重置 ffmpeg 探测缓存
  __resetFfmpegCache: () => { ffmpegKnown = null; probing = false; }
};
