/* 主题预置：在样式生效前就定好 data-theme，避免首屏闪白/闪黑。
   优先级：localStorage 里的显式选择 > 系统偏好 > 暗色。
   这里只做"应用"，真正的切换逻辑与持久化在 app.js。
   （2026-09-20：原先是 index.html 里的内联脚本，靠 CSP hash 白名单放行 ——
   脚本一改 hash 就失效、被 CSP 静默拦截。改成外链同步脚本，
   script-src 'self' 直接覆盖，不再有这个问题。） */
(function () {
  try {
    var saved = localStorage.getItem('qqa-theme') || '';
    var sys = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    // 合法值：dark / light / system / ?（整活主题）。未知值回退暗色。
    var theme = (saved === 'light' || saved === 'dark' || saved === '?') ? saved : (saved === 'system' ? sys : (saved || sys));
    if (theme !== 'light' && theme !== 'dark' && theme !== '?') theme = 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
