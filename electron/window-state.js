// 窗口几何存档的解析与校验（R66）。
//
// 为什么单独一个模块：这是"记住窗口位置"最容易翻车的一步 —— 存档里的 x/y 是
// **上一次那套屏幕布局**下的坐标，换显示器 / 拔掉副屏 / 改分辨率之后可能指向
// 不存在的区域，直接照着用就会把窗口开到看不见的地方（用户会以为程序打不开）。
// 这段判定逻辑必须能被 test/ 直接跑，所以**刻意不 import electron**：
// 屏幕信息由调用方（electron/main.js）以参数传进来。
//
// 用法：
//   const parsed = parseWindowState(fs.readFileSync(file, 'utf8'));   // → 对象 | null
//   const bounds = resolveWindowBounds(parsed, screen.getAllDisplays()); // → 对象 | null
//   bounds 为 null 时，调用方应回退到默认尺寸 + 系统居中。
'use strict';

export const WINDOW_MIN_W = 960;
export const WINDOW_MIN_H = 640;
export const WINDOW_DEFAULT_W = 1360;
export const WINDOW_DEFAULT_H = 860;

/**
 * 解析存档 JSON 文本 → { x, y, width, height, maximized }。
 * 任何不合法（空文件、坏 JSON、字段缺失、非有限数）一律返回 null ——
 * 「读不出来就当没存过」比「猜一个值」安全得多。
 */
export function parseWindowState(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
  const x = round(raw.x);
  const y = round(raw.y);
  const width = round(raw.width);
  const height = round(raw.height);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height, maximized: !!raw.maximized };
}

/**
 * 把存档几何落到**当前这套屏幕**上。
 *
 * 规则：
 *   ① 尺寸夹到最小尺寸（存档可能是手改过的、或来自更小的旧窗口）；
 *   ② 窗口矩形必须与某块屏幕的工作区有交集，否则整体作废；
 *   ③ 拿不到任何屏幕信息时也作废（宁可回退默认居中，也不赌一把）。
 *
 * 注意 ② 用的是"有交集"而不是"完全包含"：Aero Snap 贴边、或窗口比屏幕还大
 * （改了分辨率）都属于合法状态，只要还能看到一部分就该保留。
 * 坐标为负是合法的（副屏在主屏左侧/上方），这里不做 x>=0 的限制。
 *
 * @param {{x:number,y:number,width:number,height:number,maximized?:boolean}} state
 * @param {Array<{workArea:{x:number,y:number,width:number,height:number}}>} displays
 * @returns {{x:number,y:number,width:number,height:number,maximized:boolean}|null}
 */
export function resolveWindowBounds(state, displays, opts = {}) {
  if (!state || typeof state !== 'object') return null;
  const minW = Number.isFinite(opts.minW) ? opts.minW : WINDOW_MIN_W;
  const minH = Number.isFinite(opts.minH) ? opts.minH : WINDOW_MIN_H;

  const width = Math.max(minW, Math.round(state.width));
  const height = Math.max(minH, Math.round(state.height));
  const x = Math.round(state.x);
  const y = Math.round(state.y);

  const list = Array.isArray(displays) ? displays : [];
  const areas = list
    .map((d) => (d && typeof d === 'object' ? d.workArea : null))
    .filter((a) => a && typeof a === 'object'
      && Number.isFinite(a.x) && Number.isFinite(a.y)
      && Number.isFinite(a.width) && Number.isFinite(a.height));
  if (!areas.length) return null;

  const visible = areas.some((a) => x < a.x + a.width && x + width > a.x
    && y < a.y + a.height && y + height > a.y);
  if (!visible) return null;

  return { x, y, width, height, maximized: !!state.maximized };
}
