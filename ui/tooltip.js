/**
 * 自定义气泡提示 —— 全局接管 [title] 与 [data-tip]。
 *
 * 为什么要存在这个文件：
 *   应用窗口是 transparent + 无边框（electron/main.js）。Windows 的原生 tooltip
 *   是一个独立的系统小窗口，叠在透明窗口上会渲染成一坨淡黄色矩形
 *   （#FFFFE1 是 Windows 经典提示底色），提示文字根本看不见，关闭后偶尔还留残影。
 *   所以不能让任何原生 tooltip 出现 —— 悬停时把 title 摘下来换成自己画的气泡。
 *
 * 工作方式（全部事件委托，不需要各处改动）：
 *   · mouseover 命中带 title 的元素 → 把 title 暂存进 data-title 并**移除原生 title**
 *     （移除后系统提示就没有触发条件了），450ms 后弹出气泡；
 *   · mouseout → 立刻收气泡，并把 title 还回去（此时指针已离开，原生提示不会再触发）；
 *   · focusin/focusout 同样处理，键盘用户也能看到；
 *   · mousedown / wheel / scroll / resize 时直接收气泡（气泡是 fixed 定位，不跟着滚）。
 *
 * 图表圆点原来用的是 SVG <title> 子元素（同样会触发原生提示），已改为 data-tip 属性，
 * 这里一并接管。
 */
(() => {
  const DELAY = 450;          // 悬停多久才弹（和原生手感接近）
  const GAP = 8;              // 气泡与目标的间距

  let tipEl = null;           // 气泡 DOM（懒创建）
  let curTarget = null;       // 当前命中的元素
  let timer = 0;

  const findTarget = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      // data-tip 优先（图表圆点），其次原生 title
      if (n.hasAttribute && (n.hasAttribute('data-tip') || n.hasAttribute('title'))) return n;
    }
    return null;
  };

  const textOf = (el) => el.getAttribute('data-tip') ?? el.getAttribute('title') ?? '';

  /** 摘掉原生 title（阻止系统提示），返回文本。 */
  const stripNative = (el) => {
    const t = el.getAttribute('title');
    if (t != null && !el.hasAttribute('data-title')) el.setAttribute('data-title', t);
    el.removeAttribute('title');
    return el.getAttribute('data-tip') ?? (t || '');
  };

  const restoreNative = (el) => {
    if (!el || !el.hasAttribute('data-title')) return;
    if (!el.hasAttribute('data-tip')) el.setAttribute('title', el.getAttribute('data-title'));
    el.removeAttribute('data-title');
  };

  const hideBubble = () => {
    clearTimeout(timer);
    if (tipEl) tipEl.classList.remove('on');
  };

  /** 把摘掉的 title 还原 —— 只在指针/焦点真正离开时调用（见下）。
   *  ⚠️ 绝对不能在 mousedown/wheel/scroll 里还原：那些事件触发时鼠标往往还停在
   *  元素上，title 一回去，约 1s 后原生黄色提示又会冒出来（实测踩坑：点开关就冒黄条）。 */
  const releaseTarget = () => {
    if (curTarget) {
      restoreNative(curTarget);
      curTarget = null;
    }
  };

  const hide = () => {
    hideBubble();
    releaseTarget();
  };

  const show = (target, text) => {
    if (!text) return;
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'app-tip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = text;
    tipEl.classList.add('on');

    // 定位：优先放目标下方水平居中，放不下就翻到上面，左右夹到视口内
    const r = target.getBoundingClientRect();
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = r.left + r.width / 2 - tw / 2;
    let y = r.bottom + GAP;
    if (y + th > vh - 6) y = r.top - th - GAP;           // 下方放不下 → 上方
    if (y < 6) y = Math.max(6, vh - th - 6);
    x = Math.min(Math.max(6, x), vw - tw - 6);
    tipEl.style.left = Math.round(x) + 'px';
    tipEl.style.top = Math.round(y) + 'px';
  };

  const schedule = (target, text) => {
    clearTimeout(timer);
    timer = setTimeout(() => show(target, text), DELAY);
  };

  const onOver = (e) => {
    const t = findTarget(e.target);
    if (!t || t === curTarget) return;
    hide();
    curTarget = t;
    const text = stripNative(t);        // 关键：先摘掉原生 title，系统提示就不会出现
    if (text) schedule(t, text);
  };

  const onOut = (e) => {
    const t = findTarget(e.target);
    if (t && t === findTarget(e.relatedTarget)) return; // 只是在元素内部移动
    // 指针真的离开了（relatedTarget 为 null = 离开窗口）：收气泡 + 还原 title
    hide();
  };

  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mouseout', onOut, true);
  document.addEventListener('focusin', (e) => {
    const t = findTarget(e.target);
    if (!t || t === curTarget) return;
    hide();
    curTarget = t;
    const text = stripNative(t);
    if (text) schedule(t, text);
  }, true);
  document.addEventListener('focusout', hide, true);
  // 点击 / 滚轮 / 滚动 / 缩放：只收气泡，**不动 title**（指针多半还在原元素上）
  document.addEventListener('mousedown', hideBubble, true);
  window.addEventListener('wheel', hideBubble, { passive: true });
  window.addEventListener('resize', hideBubble);
  document.addEventListener('scroll', hideBubble, true);
  // 页面卸载前把 title 还回去，免得留下一堆 data-title
  window.addEventListener('beforeunload', () => {
    document.querySelectorAll('[data-title]').forEach(restoreNative);
  });
})();
