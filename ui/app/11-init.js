// 〔页签切换 / 启动〕——M9 拆分第 12 段（末段）
'use strict';
// ── 标签页切换 ──
// ⚠️ 必须统一走 switchTab：曾经这里把切换逻辑 inline 复制了一份，
//    结果漏了 usage 分支 —— 点「用量」页签只切了视图、从不加载内容，
//    页面永远空白（轮询走的是"只更新数值"路径，骨架从未建立也救不回来）。
//    两条路径各维护一份必然再次分叉，所以这里只准调 switchTab。
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ── 原生 <select> → 自绘下拉（主题风格 + 展开过渡动画）──
// 初始 DOM 里的和之后任何渲染塞进来的都会被自动接管（见 00-core.js 的说明）。
startSelectEnhancer();

// ── 分组导航（消息 / 扩展）：点击组标题展开 / 收起下拉 ──
// 触发方式由 CSS :hover 改为 .tab-group.open 类（见 style.css）：悬停即弹的菜单
// 在顶栏这种位置太容易误触 —— 鼠标扫过去就展开并盖住下方页面。
// 组内页签仍是原 .tab 按钮，切换沿用上面 switchTab 的绑定，这里不复制切换逻辑。
const closeTabMenus = (except) => {
  $$('.tab-group.open').forEach((g) => {
    if (g === except) return;
    g.classList.remove('open');
    g.querySelector('.tab-group-head')?.setAttribute('aria-expanded', 'false');
  });
};
$$('.tab-group').forEach((group) => {
  const head = group.querySelector('.tab-group-head');
  if (!head) return;
  const setOpen = (open) => {
    closeTabMenus(open ? group : null);   // 同时只允许展开一个
    group.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
  };
  head.setAttribute('aria-expanded', 'false');
  head.addEventListener('click', () => setOpen(!group.classList.contains('open')));
  // 选中组内某个页签后自动收起（页签切换本身由上面的 .tab 绑定负责）
  group.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setOpen(false)));
});
// 点空白处 / 按 Esc 收起。
// 点在 .tab-group 内部的一律不处理 —— 那正是"刚点开的那一次"点击本身（会冒泡到 document）。
document.addEventListener('click', (event) => {
  if (event.target?.closest?.('.tab-group')) return;
  closeTabMenus(null);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeTabMenus(null);
});

// ── 启动 ──
(async function init() {
  // 主题：先按本地偏好应用（index.html 的内联脚本已做过一次，这里同步按钮图标），
  // 再用后端配置覆盖（若用户换了设备，以后端为准）。
  applyTheme(getThemePref());
  try {
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
    // 仅在"跟随系统"时响应系统主题变化
    mq?.addEventListener?.('change', () => { if (getThemePref() === 'system') applyTheme('system'); });
  } catch { /* 老浏览器不支持 addEventListener，忽略 */ }
  $('#theme-btn')?.addEventListener('click', cycleTheme);

  // 启动 loading：先等 HTTP 服务可用（页面可能先于服务打开）
  setLoadingStatus('正在启动 QQ Agent 服务…');
  await bootLoop();
  runUpdateCheck();                                 // 启动时静默查一次（失败不打扰）
  setInterval(() => runUpdateCheck(), 3600_000);    // 之后每小时查一次

  // 主题：以后端配置为准（跨设备同步），仅当后端确实存过才覆盖本地
  try {
    const cfg0 = await api('/api/config');
    const t = cfg0?.ui?.theme;
    if (THEME_VALUES.includes(t)) applyTheme(t);
    else if (cfg0 && !('ui' in cfg0)) { /* 后端还没这个字段，保持本地值 */ }
    // 外观个性化（R40）：强调色/底色/不透明度/背景图/整窗不透明度。
    // ⚠️ 必须在首屏就应用一次 —— 否则"设了半透明"重启后要等用户点进设置页才生效。
    applyUiCustom(cfg0?.ui || {});
  } catch { /* 接口不可用就用本地的 */ }

  // 首启引导：关键配置（模型/白名单）没填就直接带去设置页
  try {
    const cfg = await api('/api/config');
    const ready = !!cfg.api.model && ((cfg.allow.groups?.length || cfg.allow.private?.length) || cfg.allowAllWhenEmpty);
    // 自由布局（R51）：必须在 state.config 就位后应用 —— 列宽/页签顺序存在
    // config.ui.layout 里，这是唯一能读到它的时机（设置页的保存也会重渲染）。
    state.config = state.config || cfg;
    try { initFreeLayout(); } catch (e) { console.warn('[layout] 初始化失败：', e?.message ?? e); }
    if (!ready) {
      switchTab('settings');
      connectSSE();
      refreshStatus();
      startStatusPoller();
      return;
    }
  } catch { /* 按默认流程走 */ }
  refreshStatus();
  startStatusPoller();
  connectSSE();
  loadSessions();
  loadMemoryView();
  initSessionScrollLoader();
})();