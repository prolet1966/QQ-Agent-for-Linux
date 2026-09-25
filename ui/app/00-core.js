// QQ Agent 控制台前端：会话式（每次运行 = 一个会话）。
// ── 本文件是 12 段拆分（M9）中的第 1 段：基础层（工具函数 / state / 主题 / 峰谷 / 滑条）。
//    拆分原则：所有段都是**普通脚本**（无 import/export），按 index.html 里的 defer 顺序
//    执行；跨段共享的顶层 let/const 是全局词法绑定，语义与原单文件完全一致。
//    vendor 模块（tier-slider / price-match）由 /app.js（ESM 桥）挂到 window 上。
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── 活性心跳（R69）─────────────────────────────────────────────────────────
// 主进程的看门狗（electron/main.js 的 probePage）每 5 秒读一次 window.__qaBeat：
// 只要它在递增，就说明渲染主线程还在正常跑。
//
// 为什么需要它：有一类僵死是"JS 还活着、但界面已经冻住"（渲染/合成层面），
// 这类故障 render-process-gone 不会触发、appReady 之类的启动标志也恒为真，
// 只有"心跳还在不在动"能把它和正常工作区分开。
//
// ⚠️ 窗口隐藏时 Chromium 会节流甚至暂停定时器，心跳会停 —— 这是正常的，
//    所以主进程只在窗口可见时才拿它做判定（缩到托盘不会误判成僵死）。
window.__qaBeat = 0;
setInterval(() => { window.__qaBeat = (window.__qaBeat || 0) + 1; }, 1000);

// 列表分页：一次渲染多少条 / 滚到底部再追加多少条
const SESSION_PAGE = 50;      // 会话页：一次渲染多少条
const SESSION_KEEP = 400;     // 会话页：内存里最多保留多少条（与请求量一致）
const CHAT_MSG_PAGE = 500;    // 存档页：首次加载条数
const CHAT_MSG_MORE = 200;    // 存档页：每次滚动追加

// ── 峰谷时段预设 ──────────────────────────────────────────────────────────
// 内置作息模板（一键填充时段+档位）+ 一份用户自定义（custom）。
// sliderPos 口径：0~100（10=仅艾特，100=全响应），与峰谷设置页输入框一致。
const PEAK_PRESETS = {
  workbuddy: { label: 'workbuddy（早8~晚11 高峰）',
    peak: { start: '08:00', end: '23:00', sliderPos: 10 }, valley: { start: '23:00', end: '08:00', sliderPos: 100 } },
  deepseek: { label: 'deepseek（早9~晚6 高峰）',
    peak: { start: '09:00', end: '18:00', sliderPos: 10 }, valley: { start: '18:00', end: '09:00', sliderPos: 100 } }
};

/** 预设下拉的选项列表：内置 2 个 + 自定义（有才显示）。 */
function peakPresetOptions(ps) {
  const out = Object.entries(PEAK_PRESETS).map(([k, v]) => [k, v.label]);
  const cu = ps?.custom;
  if (cu?.peak?.start) {
    out.push(['custom', `自定义（峰 ${cu.peak.start}~${cu.peak.end} @${cu.peak.sliderPos} / 其余时间 @${cu.valley?.sliderPos ?? 100}）`]);
  }
  return out;
}

/** 把预设套进当前表单（改 DOM 值，用户仍可继续微调后保存）。 */
function applyPeakPreset(key) {
  const p = PEAK_PRESETS[key] || state.config?.store?.peakSchedule?.custom;
  if (!p?.peak) return;
  // ⚠️ 设值后必须派发 input 事件：程序改 .value 不会触发监听，
  // 不派发的话时段字段的联动全停留在旧状态。
  const setVal = (sel, v) => {
    const el = $(sel);
    if (!el) return;
    el.value = v;
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* 旧环境无 Event 构造器时退化为只设值 */ }
  };
  setVal('#cfg-peak-start', p.peak.start);
  setVal('#cfg-peak-end', p.peak.end);
  // 档位点走自定义竖向滑条控制器（activeVSlider 在活跃设置弹窗打开时挂上）。
  // 高峰珠（档位低）与低谷珠（档位高）各就各位；applyValues 会触发一次
  // onChange 把值写进弹窗草稿 —— 刻度/区间带/说明文字随之刷新。
  const hi = Math.min(Number(p.peak.sliderPos) || 0, Number(p.valley?.sliderPos ?? 100) || 100);
  const lo = Math.max(Number(p.peak.sliderPos) || 0, Number(p.valley?.sliderPos ?? 100) || 100);
  activeVSlider?.applyValues(lo, hi);
  const hint = $('#peak-preset-hint');
  if (hint) hint.textContent = key === 'custom' ? '已套用「自定义」。可继续微调，保存后生效。' : `已套用「${PEAK_PRESETS[key].label}」。可继续微调，保存后生效。`;
}

/* ═══ 自定义竖向档位滑条（2026-09-19）═══
   从零实现的指针驱动滑条，**不用任何 <input type=range>** —— 原生 range 无法
   在同一条轨道上放两颗可独立抓取的珠子（两个 range 叠加只能点到最上面那个，
   这是本轮实测踩过的坑）。控制器协议：
     createVSlider({ mount, dual, low, high, onChange, onInput })
       mount    挂载点元素
       dual     true = 双珠（峰谷），false = 单珠
       low/high 初始值（0~100，恒满足 low >= high；单珠只用 low）
       onChange 值变化回调 ({ low, high, byUser })
       onInput  拖动中高频回调（同参，可选）
     .setValues(low, high)   外部装值（不触发 onChange）
     .applyValues(low, high) 外部装值并**触发一次** onChange（预设套用用）
     .setDual(bool)          切换单/双珠形态（不触发 onChange）
     .setDisabled(bool)      只读态（分群模式但白名单为空）
     .destroy()              摘监听（弹窗关闭时调用）
   可访问性：容器 role=slider + aria-valuenow/min/max + 方向键步进（上下 1、
   PgUp/PgDn 10、Home/End 到端点）；双珠时 Tab 在两颗珠间切换，各自响应键盘。 */
let activeVSlider = null;   // 活跃设置弹窗当前打开的控制器实例（applyPeakPreset 要用）

function createVSlider({ mount, dual = false, low = 100, high = 10, onChange = null, onInput = null } = {}) {
  if (!mount) return null;
  const el = typeof mount === 'string' ? $(mount) : mount;
  if (!el) return null;

  el.classList.add('vslider2');
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-orientation', 'vertical');
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '100');
  el.setAttribute('tabindex', '0');

  // DOM：轨道（渐变）+ 可选区间带 + 两颗珠（低谷彩珠 / 高峰灰珠）
  el.innerHTML = `
    <div class="vs2-track"></div>
    <div class="vs2-band"></div>
    <div class="vs2-thumb vs2-low" tabindex="0" role="slider" aria-orientation="vertical"
      aria-label="低谷时段档位（活跃）" aria-valuemin="0" aria-valuemax="100"></div>
    <div class="vs2-thumb vs2-high" tabindex="0" role="slider" aria-orientation="vertical"
      aria-label="高峰时段档位（安静）" aria-valuemin="0" aria-valuemax="100"></div>`;
  const trackEl = el.querySelector('.vs2-track');
  const bandEl = el.querySelector('.vs2-band');
  const lowEl = el.querySelector('.vs2-low');
  const highEl = el.querySelector('.vs2-high');

  let lo = Math.min(100, Math.max(0, Number(low) || 0));
  let hi = Math.min(100, Math.max(0, Number(high) || 0));
  if (hi > lo) { const x = hi; hi = lo; lo = x; }
  let isDual = !!dual;
  let disabled = false;
  let dragging = null;         // 'low' | 'high' | null
  let destroyed = false;

  // ── 渲染 ──
  function render() {
    // 珠心锚在值的位置（CSS 里 margin-bottom:-12px 把 bottom 锚点折回珠心）
    lowEl.style.bottom = lo + '%';
    lowEl.setAttribute('aria-valuenow', String(Math.round(lo * 10) / 10));
    highEl.style.bottom = hi + '%';
    highEl.setAttribute('aria-valuenow', String(Math.round(hi * 10) / 10));
    el.setAttribute('aria-valuenow', String(Math.round(lo * 10) / 10));
    highEl.style.display = isDual ? '' : 'none';
    if (isDual && lo > hi) {
      bandEl.style.display = '';
      bandEl.style.bottom = hi + '%';
      bandEl.style.height = (lo - hi) + '%';
    } else {
      bandEl.style.display = 'none';
    }
  }

  // ── 事件 ──
  function posFromEvent(e) {
    const rect = el.getBoundingClientRect();
    // bottom=0 在下（1 档端），100 在上（4 档端）：值 = (底部距离 / 高度) * 100
    const y = (e.touches?.[0] ?? e).clientY;
    const raw = ((rect.bottom - y) / rect.height) * 100;
    return Math.min(100, Math.max(0, raw));
  }

  function onDown(e) {
    if (disabled || destroyed) return;
    const pos = posFromEvent(e);
    // 抓取判定：离哪颗珠近抓哪颗；双珠重叠时优先低谷（彩珠在上层）
    const dLow = Math.abs(pos - lo);
    const dHigh = isDual ? Math.abs(pos - hi) : Infinity;
    dragging = dHigh < dLow ? 'high' : 'low';
    moveTo(dragging, pos, true);
    e.preventDefault();   // 阻止文本选中/触摸滚动
  }
  function onMove(e) {
    if (!dragging || disabled || destroyed) return;
    moveTo(dragging, posFromEvent(e), true);
    e.preventDefault();
  }
  function onUp() { dragging = null; }
  // 指针事件统一走 pointer 系列（鼠标+触摸+笔一套搞定），move/up 挂 window 才能拖出边界
  el.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  function moveTo(which, pos, byUser) {
    if (which === 'high') {
      hi = pos;
      if (hi > lo) hi = lo;          // 高峰珠不能越过低谷珠（上界）
    } else {
      lo = pos;
      // 约束只在双珠时有意义：单珠模式下隐藏的高峰珠是"幽灵下界"，
      // 会把低谷珠锁死在初始位置以下（表现为"全局档位拖不动"，2026-09-19 修）。
      if (isDual && lo < hi) lo = hi;
      if (!isDual) hi = Math.min(hi, lo);   // 维持 lo >= hi 不变量（切双珠时干净）
    }
    render();
    if (byUser) {
      onInput?.({ low: lo, high: hi, byUser: true });
      onChange?.({ low: lo, high: hi, byUser: true });
    }
  }

  // 键盘：每颗珠各自响应方向键（可访问性硬要求）
  function keyFor(target, e) {
    const which = target === highEl ? 'high' : 'low';
    const step = e.shiftKey ? 10 : 1;
    let pos = which === 'high' ? hi : lo;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': pos += step; break;
      case 'ArrowDown': case 'ArrowLeft': pos -= step; break;
      case 'PageUp': pos += 10; break;
      case 'PageDown': pos -= 10; break;
      case 'Home': pos = 0; break;
      case 'End': pos = 100; break;
      default: return false;
    }
    e.preventDefault();
    moveTo(which, Math.min(100, Math.max(0, pos)), true);
    return true;
  }
  lowEl.addEventListener('keydown', (e) => keyFor(lowEl, e));
  highEl.addEventListener('keydown', (e) => keyFor(highEl, e));

  return {
    get values() { return { low: lo, high: hi }; },
    setValues(lowV, highV) {
      let nLo = Math.min(100, Math.max(0, Number(lowV) || 0));
      let nHi = Math.min(100, Math.max(0, Number(highV ?? nLo) || 0));
      if (nHi > nLo) { const x = nHi; nHi = nLo; nLo = x; }
      lo = nLo; hi = nHi; render();
    },
    applyValues(lowV, highV) {
      this.setValues(lowV, highV);
      onChange?.({ low: lo, high: hi, byUser: false });
    },
    setDual(on) { isDual = !!on; render(); },
    setDisabled(on) {
      disabled = !!on;
      el.classList.toggle('vs2-disabled', disabled);
      lowEl.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      highEl.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    },
    focusLow() { try { lowEl.focus({ preventScroll: true }); } catch { /* ignore */ } },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.innerHTML = '';
    }
  };
}

const state = {
  tab: 'sessions',
  sessions: [],          // 摘要列表
  currentSessionId: null,
  sessionDetail: null,   // 完整记录
  chats: [],
  currentChatKey: null,
  chatMessages: [],
  config: null,
  personaTemplates: {},
  skills: [],            // 扩展条目状态列表（技能+插件，后端判定，含 kind 与不可用原因）
  skillsSummary: {},     // 后端全量摘要 { total, active, disabled, broken, capabilities }
                         // ⚠️ 两页的"生效 N/M"不读它，而是按本页条目现算 ——
                         // 否则技能页会把插件的数量也算进去，两个页签显示同一组数字。
  uninstalledSkills: [], // 配置里有 skills.<id> 段、但磁盘上已无此条目（删目录后的配置残留）
  status: null,
  paused: false,
  pauseReason: null,
  autoFollowRunning: true,
  settingsSection: 'api',
  memoryView: 'events',
  usageMetric: 'runs',   // 用量页三张图当前显示的指标（USAGE_METRICS 里的键）
  currentMemoryChatKey: null,
  groupMembers: [],
  groupMembersLoaded: false,
  // 记忆整理状态：按 chatKey 存，不依赖 DOM。
  // 切页签会导致记忆页 DOM 重建，状态若只存在按钮/文本节点里就会丢失，
  // 用户切回来时看不出整理是在跑还是已经结束了。
  consolidating: {},      // chatKey -> { startedAt }
  consolidateResult: {}, // chatKey -> { note, at, failed? }
  // 提示词预览缓存（GET /api/prompt-preview）：按当前启停状态组装的系统提示 + 可用工具。
  // 设置-工具页与技能页右侧共用；开关变动后 refreshPromptPreview() 拉新并原地替换 DOM。
  promptPreview: null
};

// ── 工具函数 ──
// 控制台标识头：证明请求来自本控制台页面，而非外部网页冒用浏览器。
// 带自定义头的请求必须过 CORS 预检，天然挡住跨站脚本/表单的静默读取。
/** 数字加千分位（token 计数用）。 */
const fmtTok = (n) => (Number(n) || 0).toLocaleString('zh-CN');

/**
 * 金额格式化（成本用）。
 * 成本经常是小额（几分钱），固定两位小数会全显示成 ¥0.00 看不出差别，
 * 所以小于 1 时多给两位有效数字。
 */
const fmtYuan = (n) => {
  const v = Number(n) || 0;
  if (v === 0) return '¥0';
  if (Math.abs(v) < 1) return `¥${v.toFixed(4)}`;
  return `¥${v.toFixed(2)}`;
};

/**
 * 用量页当前选中的时间范围（对应 USAGE_RANGES 里的值）。
 * 用 let 而不是 const：点范围按钮会改它，改完要重新拉取数据。
 */
let usageRange = '7';

/*
 * 工具的中文名与分类，用于"调用明细"弹窗。
 *
 * 用 emoji 当图标只是为了扫一眼好认 —— 这类"没什么实际用处但有趣"的细节，
 * 是特意保留的：一张纯数字的表格很无聊，分类 + 图标能让人真的去看一眼。
 */
const TOOL_META = {
  // 发言类
  send_message:      { name: '发消息',     cat: '发言',   icon: '💬' },
  send_sticker:      { name: '发表情包',   cat: '发言',   icon: '🎴' },
  send_poke:         { name: '戳一戳',     cat: '发言',   icon: '👆' },
  // 查看类
  get_recent_messages: { name: '翻聊天记录', cat: '查看', icon: '📜' },
  get_message_detail:  { name: '看消息详情', cat: '查看', icon: '🔍' },
  get_message_images:  { name: '看图片',     cat: '查看', icon: '🖼️' },
  get_active_members:  { name: '看活跃群友', cat: '查看', icon: '👥' },
  // 表情包
  list_stickers:     { name: '列表情库',   cat: '表情',   icon: '📚' },
  get_sticker_image: { name: '看表情图',   cat: '表情',   icon: '🖼️' },
  collect_sticker:   { name: '收藏表情',   cat: '表情',   icon: '⭐' },
  sticker_note:      { name: '备注表情',   cat: '表情',   icon: '📝' },
  // 记忆
  memory_append:     { name: '记一条',     cat: '记忆',   icon: '🧠' },
  memory_query:      { name: '查记忆',     cat: '记忆',   icon: '🧠' },
  memory_remove:     { name: '删记忆',     cat: '记忆',   icon: '🧹' },
  // 联网
  web_search:        { name: '联网搜索',   cat: '联网',   icon: '🌐' },
  web_fetch:         { name: '抓网页',     cat: '联网',   icon: '🔗' },
  // 其他
  report_feedback:   { name: '汇报反馈',   cat: '其他',   icon: '📣' },
  finish:            { name: '结束本次',   cat: '其他',   icon: '🏁' }
};

/** 分类的展示顺序（"其他"垫底） */
const TOOL_CAT_ORDER = ['发言', '查看', '表情', '记忆', '联网', '其他'];

/** 用量页的时间范围选项：[传给后端的值, 按钮文案] */
const USAGE_RANGES = [
  ['today', '今日'],
  ['7', '近 7 天'],
  ['30', '近 30 天'],
  ['all', '全部']
];

/** 三张图表（按天折线 / 按会话条形 / 按模型条形）共用的指标：[键, 按钮文案] */
const USAGE_METRICS = [
  ['runs', '调用次数'],
  ['cost', '成本'],
  ['tokens', 'Token']
];

const CONSOLE_MARKER = 'qq-agent-console';

/* ══════════════════════════════════════════════════════════════
   主题（明/暗/系统/？）
   ══════════════════════════════════════════════════════════════
   四种取值：'dark' | 'light' | 'system'（跟随系统偏好）| '?'（整活主题）。
   持久化两层：
     1. localStorage —— 立即生效，避免每次启动都等接口
     2. 后端 config.ui.theme —— 跨设备/重装后保留（尽力而为，失败不阻塞）
   首屏防闪由 index.html 的内联脚本负责（读 localStorage 直接设 data-theme）。
*/
const THEME_ICON = { dark: '🌙', light: '☀️', system: '🖥️', '?': '❓' };
const THEME_LABEL = { dark: '暗色', light: '亮色', system: '跟随系统', '?': '？' };
const THEME_VALUES = ['dark', 'light', 'system', '?'];

/** 读取当前主题设置（localStorage 优先，其次系统偏好）。 */
function getThemePref() {
  try {
    const v = localStorage.getItem('qqa-theme');
    if (THEME_VALUES.includes(v)) return v;
  } catch { /* 隐私模式下 localStorage 可能不可用 */ }
  return 'dark';
}

/** 把设置解析成实际要应用的主题名。 */
function resolveTheme(pref) {
  if (THEME_VALUES.includes(pref) && pref !== 'system') return pref;
  // system：跟随系统
  try {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  } catch { return 'dark'; }
}

/** 应用主题到 <html>，并同步按钮图标。 */
function applyTheme(pref) {
  const actual = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', actual);
  syncChaosLayers(actual === '?');
  const btn = $('#theme-btn');
  if (btn) {
    btn.textContent = THEME_ICON[pref] || THEME_ICON.dark;
    btn.title = `主题：${THEME_LABEL[pref] || '暗色'}（点击切换）`;
  }
  try { localStorage.setItem('qqa-theme', pref); } catch { /* 忽略 */ }
}

/* ══════════════════════════════════════════════════════════════
   外观个性化（R40）：强调色 / 界面底色 / 底色不透明度 / 背景图 / 整窗不透明度
   ══════════════════════════════════════════════════════════════
   全部只改 CSS 变量与一个静态背景层，不重建 DOM、不加动画 ——
   本机是软件渲染，个性化不能变成性能负担。
   空值一律"跟随主题"：不覆盖对应变量，这样换主题仍然协调。 */

/** 判断一个字符串是不是可用的 #rgb / #rrggbb 颜色。 */
function isHexColor(v) {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v || '').trim());
}

/** 预设色板：调色不必先想十六进制，点一下就有。 */
const ACCENT_PRESETS = [
  ['#5b8cff', '默认蓝'], ['#7c6cff', '紫罗兰'], ['#00b3a4', '青碧'],
  ['#3fce7a', '草绿'], ['#ffb454', '琥珀'], ['#ff6b8a', '樱粉'],
  ['#e5484d', '朱红'], ['#8b9bb4', '石墨']
];
const BG_PRESETS = [
  ['#0e1013', '默认墨'], ['#151515', '纯黑'], ['#101a24', '深夜蓝'],
  ['#1b1420', '暗紫'], ['#0f1a14', '墨绿'], ['#241a14', '暖棕']
];

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 把 config.ui 里的个性化项应用到界面上。
 * 任何一项留空/非法 = 用主题默认值（把对应的内联样式删掉，而不是写成空串 ——
 * 空串会让 var() 回落到"无效"，同样整条声明失效）。
 * @param {object} ui config.ui（可为空对象）
 */
function applyUiCustom(ui) {
  const u = ui || {};
  const root = document.documentElement;

  // 强调色
  if (isHexColor(u.accent)) root.style.setProperty('--accent', String(u.accent).trim());
  else root.style.removeProperty('--accent');

  // 界面底色：只覆盖 --layer-0（--bg 由它派生），卡片仍用 layer-1/2 保持层次
  const bg = isHexColor(u.bgColor) ? String(u.bgColor).trim() : '';
  if (bg) root.style.setProperty('--layer-0', bg);
  else root.style.removeProperty('--layer-0');

  // 底色不透明度：100 = 不透明；调低后窗口底色变半透明（透明窗口下透出背景图/桌面）
  const alpha = clampInt(u.frameAlpha, 30, 100, 100);
  if (alpha >= 100) root.style.setProperty('--frame-bg', 'var(--layer-0)');
  else root.style.setProperty('--frame-bg', `color-mix(in srgb, var(--layer-0) ${alpha}%, transparent)`);

  // 背景图
  const bgEl = document.getElementById('app-bg');
  if (bgEl) {
    const name = String(u.bgImage || '').trim();
    if (name) {
      const dim = clampInt(u.bgDim, 0, 85, 0) / 100;
      const fit = String(u.bgFit || 'cover');
      // 暗化不靠 backdrop-filter（软件渲染的帧率杀手），直接叠一层黑纱
      const veil = dim > 0 ? `linear-gradient(rgba(0,0,0,${dim}), rgba(0,0,0,${dim})), ` : '';
      bgEl.style.backgroundImage = `${veil}url("/api/ui-bg?v=${encodeURIComponent(name)}")`;
      if (fit === 'repeat') {
        bgEl.style.backgroundSize = 'auto';
        bgEl.style.backgroundRepeat = 'repeat';
      } else if (fit === 'contain') {
        bgEl.style.backgroundSize = 'contain';
        bgEl.style.backgroundRepeat = 'no-repeat';
      } else {
        bgEl.style.backgroundSize = 'cover';
        bgEl.style.backgroundRepeat = 'no-repeat';
      }
    } else {
      bgEl.style.backgroundImage = '';
    }
  }

  // 整窗不透明度：只有 Electron 桌面端有这座桥（浏览器里打开没有 qqaDesktop）
  const op = clampInt(u.winOpacity, 30, 100, 100);
  try {
    if (window.qqaDesktop && typeof window.qqaDesktop.setOpacity === 'function') {
      window.qqaDesktop.setOpacity(op / 100);
    }
  } catch { /* 桥不可用（浏览器/旧壳）就只保留界面内的个性化 */ }
}

/* ── 「？」主题的 JS 层：VHS 覆盖层 + 点击爆粒子 ──
   CSS 管不了的就这两件需要一个真实 DOM 层（body 的 ::before/::after 已被占用）。
   主题切走即移除，零残留。 */
function syncChaosLayers(on) {
  let vhs = document.getElementById('chaos-vhs');
  if (on && !vhs) {
    vhs = document.createElement('div');
    vhs.id = 'chaos-vhs';
    vhs.innerHTML = '<div class="vhs-track"></div>';   // 白闪太刺眼已移除，只留扫描线+追踪误差带
    document.body.appendChild(vhs);
  } else if (!on && vhs) {
    vhs.remove();
  }
}

// 点击爆「？」粒子：只在「？」主题下生效（判断放点击时，不绑状态）
document.addEventListener('click', (e) => {
  if (document.documentElement.getAttribute('data-theme') !== '?') return;
  // 一次爆 3~5 个，方向随机（抽象 = 不统一）
  const n = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const el = document.createElement('span');
    el.className = 'chaos-pop';
    el.textContent = '？';
    el.style.left = `${e.clientX}px`;
    el.style.top = `${e.clientY}px`;
    el.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
    el.style.setProperty('--dy', `${-40 - Math.random() * 90}px`);
    el.style.setProperty('--rot', `${(Math.random() - 0.5) * 540}deg`);
    el.style.fontSize = `${14 + Math.random() * 20}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 850);
  }
}, { passive: true });

/** 点击按钮：暗 → 亮 → 跟随系统 → ？ → 暗。 */
function cycleTheme() {
  const order = THEME_VALUES;
  const next = order[(order.indexOf(getThemePref()) + 1) % order.length];
  applyTheme(next);
  // 尽力同步到后端，失败不影响本地使用
  api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { theme: next } }) })
    .catch(() => { /* 后端不可达时静默：localStorage 已经生效 */ });
}

async function api(path, options = {}) {
  // keepalive 由调用方按需传（配置保存的 POST 用它：页面卸载后请求仍能完成）
  // timeoutMs：请求级超时（AbortSignal.timeout）。用量页统计接口在历史数据多、
  // 后端忙时可能长时间无响应 —— 没有超时兜底的话加载态会永远转下去，
  // 到点抛错让页面能显示失败原因 + 重试按钮（R49）。
  const { keepalive, timeoutMs, ...rest } = options;
  try {
    const res = await fetch(path, {
      headers: {
        'content-type': 'application/json',
        'x-console-token': CONSOLE_MARKER,
        ...(rest.headers || {})
      },
      ...rest,
      ...(keepalive ? { keepalive: true } : {}),
      ...(timeoutMs && !rest.signal ? { signal: AbortSignal.timeout(timeoutMs) } : {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    // AbortSignal.timeout 抛的是 TimeoutError DOMException，message 是英文，
    // 转成用户能看懂的中文（调用方的 catch 直接展示 e.message）
    if (e && e.name === 'TimeoutError') throw new Error(`请求超时（${Math.round((timeoutMs || 0) / 1000)} 秒无响应）`);
    throw e;
  }
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_LABEL = { waiting: '等待中', done: '已发言', noreply: '未回复', running: '运行中', error: '出错', aborted: '中止' };

// ── 启动 loading 壳：页面先渲染，等服务可用后自动隐藏 ──
const loadingOverlay = $('#loading-overlay');
const loadingStatus = $('#loading-status');
const loadingLogs = $('#loading-logs');
let appReady = false;
let bootLogs = [];

function setLoadingStatus(text) {
  bootLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`);
  if (loadingStatus) loadingStatus.textContent = text;
  if (loadingLogs) loadingLogs.textContent = bootLogs.slice(-12).join('\n');
}

function hideLoading() {
  appReady = true;
  if (loadingOverlay) {
    loadingOverlay.style.transition = 'opacity .25s ease';
    loadingOverlay.style.opacity = '0';
    setTimeout(() => { loadingOverlay?.remove(); }, 300);
  }
}

async function pollUntilReady(startedAt) {
  try {
    // ⚠️ 单次请求必须有超时（R45）：fetch 在网络栈层面"既不 resolve 也不 reject"时，
    //    await 会永久挂住 —— 启动循环停在第一次调用上，界面永远显示最开始那句
    //    "正在启动 QQ Agent 服务…"（R44 用户看到的就是这个）。加了超时至少能继续下一轮。
    const status = await api('/api/status', { signal: AbortSignal.timeout(5000) });
    if (!status.onebot?.connected) setLoadingStatus(status.onebot?.diagnosis || 'SnowLuma 已就绪，正在连接 OneBot…');
    else setLoadingStatus(`OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}，即将进入控制台…`);
    // 服务已可达，无需等到 OneBot 完全连上即可进入控制台（体检卡会继续提示）
    return 'ok';
  } catch (e) {
    // startedAt 由 bootLoop 传入：曾经在这里声明，每轮重置，
    // 45 秒超时判定永远为 false，"启动超时"提示从未出现过
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const why = e?.name === 'TimeoutError' ? '请求超时（5 秒无响应）' : (e?.message || String(e));
    setLoadingStatus(`服务还没响应：${why}（已等待 ${secs} 秒）`);
    return Date.now() - startedAt > 45000 ? 'timeout' : 'fail';
  }
}

/** 启动失败兜底界面：不再是无限转圈，给出原因、日志和一个能自己救回来的按钮。 */
function showBootFailure() {
  const card = document.querySelector('#loading-overlay .loading-card');
  appReady = false;   // 保持"未就绪"，主进程看门狗据此重载 / 弹窗提示
  if (!card) return;
  card.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'loading-title';
  title.textContent = '界面没能启动完成';
  const sub = document.createElement('div');
  sub.className = 'loading-sub';
  sub.textContent = '控制台服务 45 秒内没有响应。后端多半是正常在跑的，通常是页面这一侧没能连上它。';
  const pre = document.createElement('pre');
  pre.className = 'loading-logs';
  pre.textContent = (bootLogs || []).slice(-12).join('\n');
  const btn = document.createElement('button');
  btn.className = 'btn btn-small';
  btn.id = 'boot-retry-btn';
  btn.textContent = '重新加载界面';
  btn.style.marginTop = '10px';
  btn.addEventListener('click', () => location.reload());
  card.append(title, sub, pre, btn);
}

async function bootLoop() {
  const startedAt = Date.now();
  let result = 'fail';
  for (let i = 0; i < 120; i++) {
    result = await pollUntilReady(startedAt);
    if (result !== 'fail') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (result === 'timeout') {
    showBootFailure();
    return;
  }
  hideLoading();
  refreshStatus();
  if (state.tab === 'sessions') loadSessions();
  if (state.tab === 'memory') loadMemoryView();
}

// ── 就绪度体检（傻瓜式引导的核心） ──
function assessReadiness(cfg, status) {
  const checks = [];
  if (!cfg) return { ready: false, checks: [{ ok: false, label: '配置加载失败' }] };
  // 拆成"接口地址"与"模型"两步：合并判断时新手分不清到底缺哪个。
  // 出厂 baseUrl 为空，第一条会直接指出该填什么。
  const urlOk = !!String(cfg.api.baseUrl || '').trim();
  checks.push({
    ok: urlOk,
    label: urlOk ? `接口地址：${cfg.api.baseUrl}` : '还没有填接口地址（Base URL，必填）：官方 API 或中转站提供的 OpenAI 兼容地址',
    fix: urlOk ? null : 'settings-api'
  });
  const modelOk = !!String(cfg.api.model || '').trim();
  checks.push({
    ok: modelOk,
    label: modelOk ? `模型已选择：${cfg.api.model}` : '还没有选择模型（填好地址后点「获取列表」或手动添加）',
    fix: modelOk ? null : 'settings-api'
  });
  const allowOk = (cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty);
  checks.push({ ok: !!allowOk, label: allowOk ? `白名单：${(cfg.allow.groups || []).length} 个群 / ${(cfg.allow.private || []).length} 个好友` : '还没有配置白名单（必填）', fix: allowOk ? null : 'settings-allow' });
  const obOk = status?.onebot?.connected;
    checks.push({ ok: !!obOk, label: obOk ? `OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}` : (status.onebot.diagnosis || 'OneBot（SnowLuma）未连接 —— 请到 SnowLuma 页签启动'), fix: obOk ? null : 'snowluma-tab' });
  return { ready: urlOk && modelOk && allowOk && obOk, checks };
}

function renderBanner() {
  const banner = $('#banner');
  const s = state.status;
  let show = false;
  let html = '';
  // 预算保险丝已移除：原先这里有一个 pauseReason === 'budget' 的分支
  if (state.paused) {
    show = true;
    html = '⏸ 机器人已暂停，不会处理任何消息。';
  } else if (s && !s.onebot.connected && !s.onebot.everConnected) {
    show = true;
    html = '🔌 OneBot（SnowLuma）还没连上：请确认 SnowLuma 已启动，且设置里的 WS/HTTP 地址正确。';
  }
  banner.classList.toggle('hidden', !show);
  if (show) {
    if (state.paused) {
      html += ` <button class="btn btn-small" id="banner-resume-btn">恢复</button>
        <button class="btn btn-small btn-danger" id="banner-resume-read-btn" title="恢复运行，并把暂停期间积压的所有未读消息直接标记为已读（不再处理）">恢复并全部标为已读</button>`;
    }
    banner.innerHTML = html;
    // 注意：横幅里从来没有 #banner-goto-settings 这个元素（旧的死监听，已删）
    const resumeBtn = $('#banner-resume-btn');
    if (resumeBtn) resumeBtn.addEventListener('click', () => resumePause({ skipBacklog: false }));
    const resumeReadBtn = $('#banner-resume-read-btn');
    if (resumeReadBtn) resumeReadBtn.addEventListener('click', () => resumePause({ skipBacklog: true }));
  }
}

async function resumePause({ skipBacklog = false } = {}) {
  try {
    if (skipBacklog) {
      await api('/api/pause', { method: 'DELETE', body: '{}' });
    } else {
      await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: false }) });
    }
    await refreshStatus();
    if (state.tab === 'chats') loadChats({ quiet: true });
  } catch (e) {
    console.error('恢复失败:', e);
  }
}

function switchTab(name) {
  // 离开设置页（无论去哪）前，先把防抖窗口内还没落盘的改动立即保存。
  // 必须在页签切换、任何 loadXxx 触发**之前**做：等切走之后表单 DOM 还在
  // （只是视图隐藏）其实也能读，但"正在输入的最后一个字段"可能只过了
  // 防抖窗口的一部分 —— 不 flush 的话这次改动要等 600ms 定时器到点，
  // 期间用户看到的其它页签数据（用量/状态）就是旧配置算出来的。
  if (state.tab === 'settings' && name !== 'settings') flushSettingsSaves();
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.view').forEach((v) => {
    const on = v.id === `view-${name}`;
    v.classList.toggle('active', on);
    if (on) {
      /* 重触发入场动画：CSS 动画只在类名"重新加上"时播放，
         先移除再强制 reflow 后加回，切换页签才有平滑入场。 */
      v.style.animation = 'none';
      void v.offsetWidth;   // reflow
      v.style.animation = '';
    }
  });
  state.tab = name;
  if (state.quoteMode && name !== 'chats') exitQuoteMode();   // 离开存档页自动退出金句勾选
  if (name === 'sessions') loadSessions();
  if (name === 'chats') loadChats();
  // 群名补底：设置页（人设分群按钮/活跃设置分群下拉）用 chatNameOf 取名字，
  // 依赖 state.chats —— 若用户没先进过存档页这里是空的，会只显示群号。
  // 进设置页时悄悄拉一次（quiet，失败不报错），列表已在就跳过。
  if (name === 'settings' && !(state.chats || []).length) {
    api('/api/chats').then((d) => { state.chats = d.chats || []; }).catch(() => {});
  }
  if (name === 'memory') loadMemoryView();
  if (name === 'usage') loadUsageView({ force: true });
  if (name === 'skills') loadModulePage('skill');
  if (name === 'plugins') loadModulePage('plugin');
  if (name === 'snowluma') loadSnowlumaPage();
  if (name === 'settings') loadSettings();
}

// ── 自定义下拉框（美化原生 <select>）──
// 原生 select 的弹出列表是操作系统渲染的，改不了样式、也没法做过渡动画。
// 这里把每个 <select> 换成自绘的 .sel 组件（隐藏原 select 但保留在 DOM ——
// val()/chk() 与 change 监听全部照常工作，getElementById 绑定零改动）。
// 由 MutationObserver 自动接管所有后渲染出来的 select（设置页/弹窗/SnowLuma 页）。
function enhanceOneSelect(sel) {
  if (sel.dataset.selEnhanced) return;
  sel.dataset.selEnhanced = '1';
  sel.style.display = 'none';

  const wrap = document.createElement('span');
  wrap.className = 'sel' + (sel.disabled ? ' sel-disabled' : '');
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'sel-head';
  const CHEV = '<svg class="sel-arrow" viewBox="0 0 12 12" aria-hidden="true"><path class="ln" d="M2.5 4.5 6 8l3.5-3.5"/></svg>';
  head.innerHTML = '<span class="sel-label"></span>' + CHEV;
  const menu = document.createElement('span');
  menu.className = 'sel-menu';
  wrap.appendChild(head);
  wrap.appendChild(menu);
  sel.after(wrap);

  const label = () => (sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '');
  const syncHead = () => { head.firstElementChild.textContent = label(); };
  const syncMenu = () => {
    menu.innerHTML = [...sel.options].map((o, i) =>
      '<span class="sel-opt' + (i === sel.selectedIndex ? ' selected' : '') + '" data-i="' + i + '">' + esc(o.text) + '</span>'
    ).join('');
  };
  syncHead(); syncMenu();

  const close = () => wrap.classList.remove('open');
  head.addEventListener('click', () => {
    if (sel.disabled) return;
    // 展开前重同步：options 可能被代码重建过（如搜索服务商下拉动态填充）
    syncMenu(); syncHead();
    // 先关掉别的开着的下拉，避免菜单叠菜单
    document.querySelectorAll('.sel.open').forEach((w) => { if (w !== wrap) w.classList.remove('open'); });
    wrap.classList.toggle('open');
    // 菜单可滚动后，展开时把选中项滚进可视区（长列表不再"选中的在下面看不到"）
    if (wrap.classList.contains('open')) {
      // 视口自适应（2026-09-20）：菜单是绝对定位的，下拉框贴近窗口底部时
      // 会被设置页滚动口裁掉一截（图示反馈）。空间不够就上弹或限高 ——
      // 保证菜单永远完整落在最近的滚动容器（通常是 .settings-pane）可视区内。
      const hr = head.getBoundingClientRect();
      menu.style.top = ''; menu.style.bottom = ''; menu.style.maxHeight = '';
      // 找最近的滚动祖先，用它的可视边界（比窗口更紧）
      let lo = 8, hi = window.innerHeight - 8;
      for (let p = head.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if ((cs.overflowY && cs.overflowY !== 'visible') || (cs.overflowX && cs.overflowX !== 'visible')) {
          const pr = p.getBoundingClientRect();
          lo = Math.max(lo, pr.top + 8);
          hi = Math.min(hi, pr.bottom - 8);
          break;
        }
      }
      const below = hi - hr.bottom;
      const above = hr.top - lo;
      const NEED = 132;   // 约四行选项，低于这个数就换边/限高
      if (below < NEED && above > below) {
        menu.style.top = 'auto';
        menu.style.bottom = 'calc(100% + 5px)';
        menu.style.maxHeight = Math.min(288, Math.round(above)) + 'px';
      } else if (below < 288) {
        menu.style.maxHeight = Math.max(NEED, Math.round(below)) + 'px';
      }
      const cur = menu.querySelector('.sel-opt.selected');
      if (cur) menu.scrollTop = Math.max(0, cur.offsetTop - menu.clientHeight / 2 + cur.offsetHeight / 2);
    }
  });
  menu.addEventListener('click', (e) => {
    const opt = e.target.closest('.sel-opt');
    if (!opt || sel.disabled) return;
    const i = Number(opt.dataset.i);
    if (i !== sel.selectedIndex) {
      sel.selectedIndex = i;
      syncHead(); syncMenu();
      // 派发 change：所有既有监听（保存/联动）原样触发
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    close();
  });
  // 代码改 value 后手动 dispatch 的 change 也同步显示
  sel.addEventListener('change', () => { syncHead(); syncMenu(); });
  // 点外面 / Esc 收起（全局监听只挂一次）
  if (!window.__selOutsideBound) {
    window.__selOutsideBound = true;
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.sel')) document.querySelectorAll('.sel.open').forEach((w) => w.classList.remove('open'));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.querySelectorAll('.sel.open').forEach((w) => w.classList.remove('open'));
    });
  }
}

let selObserverStarted = false;
function startSelectEnhancer() {
  if (selObserverStarted) return;
  selObserverStarted = true;
  const scan = (root) => {
    if (root instanceof HTMLSelectElement) enhanceOneSelect(root);
    if (root.querySelectorAll) root.querySelectorAll('select').forEach(enhanceOneSelect);
  };
  scan(document);
  new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n); });
    }
  }).observe(document.body, { childList: true, subtree: true });
}
