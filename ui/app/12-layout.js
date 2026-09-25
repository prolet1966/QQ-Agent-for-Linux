// 〔自由布局〕——用户可拖拽排布界面（R51）
'use strict';
/* ══════════════════════════════════════════════════════════════
 自由布局：拖动分隔条调宽 + 拖动页签排序 + 排布持久化

 需求（用户）："将所有窗口底下的东西随意拖动，让用户可以自由排布，
               组合出自己最喜欢的 UI 界面"，且排布要记住。

 本段负责两件事：
   ① 列宽：各页左右分栏之间的分隔条可拖动；双击分隔条复位。
   ② 页签顺序：顶部导航可拖拽重排。
 两者都写进 config.ui.layout，下次启动恢复。

 ⚠️ 实现要点：
   - 宽度写成 CSS 变量（--pane-w），不改 .list-pane 的 width 属性 ——
     这样 CSS 里 width: var(--pane-w, 320px) 一处生效，且不动原有样式。
   - 拖动用 pointer events（比 mouse 事件更稳，且天然支持触摸）。
   - 拖动期间给 body 加 .dragging-resize：全局禁选中 + 改光标，
     否则鼠标划过文字会变成"选中一片文字"的怪异手感。
   - 宽度做 clamp（最小/最大），避免把面板拖成 0 宽或吃掉整个窗口。
 ══════════════════════════════════════════════════════════════ */

/** 可拖拽分栏的页面配置：viewId → 左侧窗格选择器。
 *  只列左右分栏的页面；单栏页面（用量/技能/插件/设置）无需分隔条。 */
const RESIZABLE_VIEWS = [
  { view: 'view-sessions', pane: '#session-list', key: 'sessions' },
  { view: 'view-chats', pane: '#chat-list', key: 'chats' },
  { view: 'view-memory', pane: '#memory-list', key: 'memory' }
];

const PANE_MIN = 200;    // 再窄列表条目就挤成两行了
const PANE_MAX = 720;    // 再宽详情区就没地方了

/** 当前生效的布局（从 config.ui.layout 读，缺字段用默认） */
function layoutCfg() {
  const c = state.config || {};
  const l = c.ui && c.ui.layout && typeof c.ui.layout === 'object' ? c.ui.layout : {};
  return {
    panes: l.panes && typeof l.panes === 'object' ? l.panes : {},
    tabOrder: Array.isArray(l.tabOrder) ? l.tabOrder : [],
    float: l.float && typeof l.float === 'object' ? l.float : {}
  };
}

/** 把单个窗格宽度应用到 CSS 变量 */
function applyPaneWidth(paneSel, px) {
  const el = $(paneSel);
  if (!el) return;
  if (!px || px <= 0) el.style.removeProperty('--pane-w');
  else el.style.setProperty('--pane-w', `${Math.round(px)}px`);
}

/** 应用全部已保存的列宽 */
function applyLayoutPanes() {
  const { panes } = layoutCfg();
  for (const cfg of RESIZABLE_VIEWS) applyPaneWidth(cfg.pane, panes[cfg.key]);
}

/** 把当前 ui 配置发往后端 —— 布局保存的唯一出口。
 *  keepalive=true 用于页面卸载兜底（见 flushLayoutSave）。 */
function postLayoutSave(keepalive) {
  try {
    api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ ui: state.config.ui }),
      keepalive
    }).catch(() => { /* 保存失败不影响本次会话内的布局 */ });
  } catch { /* 同上：保存失败不影响本次会话内的布局 */ }
}

/** 保存布局（防抖：拖动过程不写盘，松手后落一次） */
let layoutSaveTimer = null;
let layoutSavePending = false;   // 有改动还没发出去
function saveLayout(patch) {
  state.config = state.config || {};
  const cur = layoutCfg();
  const next = {
    panes: { ...cur.panes, ...(patch.panes || {}) },
    tabOrder: patch.tabOrder || cur.tabOrder,
    float: patch.float !== undefined ? patch.float : cur.float
  };
  state.config.ui = { ...(state.config.ui || {}), layout: next };
  layoutSavePending = true;
  clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => {
    layoutSaveTimer = null;
    layoutSavePending = false;
    postLayoutSave(false);
  }, 400);
}

/** 卸载兜底（R66）：把还压在防抖窗口里的布局改动立刻发出去。
 *
 *  背景（用户反馈"UI 移动后退出重进位置不能正确保存"）：saveLayout 有 400ms 防抖，
 *  而**真正退出**（托盘菜单退出 → before-quit → core.stop → app.quit）会连同渲染
 *  进程一起销毁 —— 那个待触发的 setTimeout 直接消失，刚拖完的列宽/浮层位置就
 *  静默丢了，且没有任何报错。设置页早就有同款兜底（07-settings-events.js 的
 *  beforeunload + form.__settingsBound.flushSave），布局这条链一直漏着。
 *
 *  ⚠️ 关窗（走 close → hide 缩托盘）不会销毁渲染进程，定时器照常触发，所以
 *     这个兜底只在"真退出/刷新"时才起作用 —— 那正是防抖会丢数据的那两条路径。
 *  ⚠️ 用 fetch 的 keepalive 而不是 sendBeacon：后者带不了 x-console-token 头。
 *  ⚠️ 只发"确有改动"的那一次：无改动的卸载不该凭空多一次写盘。 */
function flushLayoutSave() {
  if (!layoutSavePending) return;
  layoutSavePending = false;
  if (layoutSaveTimer) { clearTimeout(layoutSaveTimer); layoutSaveTimer = null; }
  postLayoutSave(true);
}
window.addEventListener('pagehide', flushLayoutSave);
window.addEventListener('beforeunload', flushLayoutSave);

/* ── R67：设置页「保存当前排布」按钮 ────────────────────────────────────────

   背景（用户反馈）："并没有记住我之前的窗口拖拽的位置，我建议你添加一个保存
   当前界面设置的按钮，点击之后能保存。"

   自动保存其实一直在（拖拽松手 → saveLayout 防抖 400ms → POST /api/config），
   但它有两个用户感受得到的缺口：
     ① **完全没有反馈** —— 存没存下、存的是什么，用户无从判断，只能靠"重启试试"
        来验证；一旦某次没生效，也永远不知道断在哪一步。
     ② 防抖窗口内的改动只压在内存里，要靠 flushLayoutSave 在卸载时兜底 ——
        页面重载、接口报错这类路径都是静默丢。
   所以补一个显式入口：**以此刻看到的画面为准，当场落盘，并把结果回显给用户。**

   ⚠️ 快照刻意**不用 getBoundingClientRect()**：非活动页签的视图是 display:none，
      量出来宽高全是 0，照抄进去等于把已保存的列宽/浮层位置**抹成 0**，
      比不保存更糟（而且这类"保存反而弄坏"最难排查）。列宽在 --pane-w 变量、
      浮层坐标在 style.left/top 里，两者都与元素可见性无关，读它们才是忠实的。 */

/** 从内联样式 / CSS 变量实测当前排布。返回 { panes, float, tabOrder }。 */
function snapshotLayoutFromDom() {
  const px = (v) => {
    const n = Math.round(parseFloat(v));
    return Number.isFinite(n) ? n : null;
  };

  const panes = {};
  for (const cfg of RESIZABLE_VIEWS) {
    const el = $(cfg.pane);
    const w = el ? px(el.style.getPropertyValue('--pane-w')) : null;
    // 量不到（从未拖过 / 已被复位成默认）就不写这个 key —— 与 applyLayoutPanes
    // 的"缺字段用默认"语义一致，而不是存一个 0 进去。
    if (w && w > 0) panes[cfg.key] = w;
  }

  // 以存档为底：statusCard 等不在 FLOATABLE_PANELS 里的条目原样保留，
  // 只覆盖/删除本函数管得到的 key —— 否则一次保存就会把它们抹掉。
  const float = { ...floatCfg() };

  for (const cfg of FLOATABLE_PANELS) {
    const el = $(cfg.sel);
    if (!el) continue;
    if (!el.classList.contains('panel-floating')) { delete float[cfg.key]; continue; }
    const x = px(el.style.left);
    const y = px(el.style.top);
    if (x === null || y === null) continue;    // 定位还没写进去，保留原值
    const rec = { x, y };
    const w = px(el.style.width);
    const h = px(el.style.height);
    if (w) rec.w = w;
    if (h) rec.h = h;
    float[cfg.key] = rec;
  }

  // 状态卡（R54）走的是另一套类名，同样以实测为准
  const st = $(STATUS_CARD_SEL);
  if (st) {
    if (st.classList.contains('status-detached')) {
      const x = px(st.style.left);
      const y = px(st.style.top);
      if (x !== null && y !== null) {
        const wRaw = px(st.style.width);
        const prev = float[STATUS_KEY] || {};
        const w = wRaw !== null ? wRaw : prev.w;
        float[STATUS_KEY] = w ? { x, y, w } : { x, y };
      }
    } else {
      delete float[STATUS_KEY];
    }
  }

  const tabOrder = draggableNavBlocks().map(navBlockKey).filter(Boolean);
  return { panes, float, tabOrder };
}

/** 立即保存当前排布（不等防抖），返回实际落盘的快照。
 *  ⚠️ 失败时**抛出**而不是吞掉 —— 调用方要能如实告诉用户"没存上"，
 *     静默失败正是这个功能要解决的问题本身。 */
async function saveLayoutNow() {
  const snap = snapshotLayoutFromDom();
  state.config = state.config || {};
  const ui = { ...(state.config.ui || {}) };
  ui.layout = { panes: snap.panes, tabOrder: snap.tabOrder, float: snap.float };
  state.config.ui = ui;
  // 压掉待触发的防抖：它的回调读的是**调用时**的 layoutCfg()，晚一步写下去
  // 会把这次刚存的内容覆盖回旧值。
  if (layoutSaveTimer) { clearTimeout(layoutSaveTimer); layoutSaveTimer = null; }
  layoutSavePending = false;
  await api('/api/config', { method: 'POST', body: JSON.stringify({ ui }) });
  return snap;
}

/* ── ① 分隔条：拖动调宽 ── */
function initPaneResizers() {
  for (const cfg of RESIZABLE_VIEWS) {
    const view = document.getElementById(cfg.view);
    const pane = $(cfg.pane);
    if (!view || !pane) continue;
    // 分隔条只建一次（视图元素是静态的，但防重复调用）
    if (view.querySelector(':scope > .pane-resizer')) continue;

    const bar = document.createElement('div');
    bar.className = 'pane-resizer';
    bar.setAttribute('role', 'separator');
    bar.setAttribute('aria-orientation', 'vertical');
    bar.title = '拖动调整宽度 · 双击复位';
    // 插在列表窗格之后
    pane.insertAdjacentElement('afterend', bar);

    bar.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const startX = ev.clientX;
      const startW = pane.getBoundingClientRect().width;
      const move = (e) => {
        const w = Math.max(PANE_MIN, Math.min(PANE_MAX, startW + (e.clientX - startX)));
        applyPaneWidth(cfg.pane, w);
      };
      const up = () => {
        document.body.classList.remove('dragging-resize');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const finalW = Math.round(pane.getBoundingClientRect().width);
        saveLayout({ panes: { [cfg.key]: finalW } });
        showLayoutFloatActions();   // R70：拖动分隔条后显快捷操作
      };
      document.body.classList.add('dragging-resize');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      try { bar.setPointerCapture(ev.pointerId); } catch { /* 可选能力 */ }
    });

    // 双击复位该栏宽度（R55：改前先记一份，方便用撤销回来）
    bar.addEventListener('dblclick', () => {
      const prev = Math.round(pane.getBoundingClientRect().width);
      applyPaneWidth(cfg.pane, 0);
      saveLayout({ panes: { [cfg.key]: 0 } });
      rememberPaneUndo(cfg, prev);
      showLayoutFloatActions();   // R70：栏宽复位后也允许保存/撤销
    });
  }
}

/* ── ①b 宽度误复位撤销（R55）─────────────────────────────────────
   用户反馈「拖动没有任何用」，排查中发现一个真实的体验风险：
   分隔条现在是很宽的整栏热区，**双击**即复位栏宽 —— 而拖动过程中
   手抖多点一下、或想"再拖一次"时连点，就会在毫无提示的情况下把
   辛苦调好的宽度清掉，看起来正是"调整没生效 / 拖了也白拖"。
   这里给复位加一条后悔路：记一档旧宽度，右下角浮一个提示条，
   可点「撤销」或按 Ctrl+Z 还原；下一次拖动/复位会覆盖它。 */
let paneUndo = null;        // { key, pane, sel, width }  宽度 0 表示"回到默认"
let paneUndoEl = null;
let paneUndoTimer = null;

function rememberPaneUndo(cfg, prevWidth) {
  paneUndo = { key: cfg.key, sel: cfg.pane, width: prevWidth };
  showPaneUndoToast();
  clearTimeout(paneUndoTimer);
  paneUndoTimer = setTimeout(hidePaneUndoToast, 6000);
}

function hidePaneUndoToast() {
  if (paneUndoEl) { paneUndoEl.remove(); paneUndoEl = null; }
}

function showPaneUndoToast() {
  if (!paneUndo) return;
  if (!paneUndoEl) {
    paneUndoEl = document.createElement('div');
    paneUndoEl.className = 'layout-undo';
    paneUndoEl.innerHTML = '<span>已复位栏宽</span><button type="button" class="lu-btn">撤销</button>';
    paneUndoEl.querySelector('.lu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      undoPaneReset();
    });
    document.body.appendChild(paneUndoEl);
  }
  // 重启计时器：重新浮现
  paneUndoEl.classList.remove('lu-out');
}

function undoPaneReset() {
  if (!paneUndo) return;
  const { sel, key, width } = paneUndo;
  applyPaneWidth(sel, width || 0);
  saveLayout({ panes: { [key]: width || 0 } });
  paneUndo = null;
  clearTimeout(paneUndoTimer);
  hidePaneUndoToast();
}

/** Ctrl+Z 撤销栏宽复位（只在有可撤销项时拦截，不抢其它快捷键） */
function initPaneUndoKeys() {
  window.addEventListener('keydown', (ev) => {
    if (!paneUndo) return;
    if (!(ev.ctrlKey || ev.metaKey)) return;
    if (ev.key !== 'z' && ev.key !== 'Z') return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    ev.preventDefault();
    undoPaneReset();
  });
}

/* ── ② 顶部页签：拖拽排序 ──
   ⚠️ 只重排**顶级导航块**的顺序（组块 / 独立页签）。组块内部的页签顺序保持
      （它们本来就是"同类收进下拉"的固定搭配，拆开会让语义变乱）。
      .nav-spacer / 窗口控制按钮 / 隐藏的确认按钮不参与。 */
function draggableNavBlocks() {
  const nav = document.getElementById('tabs');
  if (!nav) return [];
  return [...nav.children].filter((el) => {
    if (el.classList.contains('nav-spacer')) return false;
    if (el.classList.contains('win-controls')) return false;
    if (el.classList.contains('hidden')) return false;
    if (el.tagName !== 'BUTTON' && el.tagName !== 'DIV') return false;
    // 独立页签要求有 data-tab；组块是 .tab-group
    return el.classList.contains('tab-group') || el.dataset.tab;
  });
}

/** 导航块的身份键：组块用组标题文案（无 id），独立页签用 data-tab */
function navBlockKey(el) {
  if (el.classList.contains('tab-group')) {
    const head = el.querySelector('.tab-group-head');
    return 'group:' + (head?.textContent || '').replace(/[▾\s]/g, '');
  }
  return 'tab:' + (el.dataset.tab || '');
}

/** 刚拖动过 → 抑制紧随其后的一次导航 click（模块级：跨两个监听器共享） */
let suppressNextNavClick = false;

function initTabDrag() {
  const nav = document.getElementById('tabs');
  if (!nav || nav.dataset.dragBound === '1') return;
  nav.dataset.dragBound = '1';

  let dragEl = null;
  let startX = 0;
  let moved = false;

  nav.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const el = ev.target.closest('.tab, .tab-group-head');
    if (!el) return;
    dragEl = el.classList.contains('tab-group-head') ? el.closest('.tab-group') : el;
    if (!dragEl || !nav.contains(dragEl)) { dragEl = null; return; }
    startX = ev.clientX;
    moved = false;
  });

  // 拖动阈值 5px：小于它算点击（不影响页签切换 / 下拉展开）
  window.addEventListener('pointermove', (ev) => {
    if (!dragEl) return;
    if (!moved && Math.abs(ev.clientX - startX) < 5) return;
    if (!moved) {
      moved = true;
      dragEl.classList.add('dragging-tab');
      document.body.classList.add('dragging-tab-body');
    }
    // 实时指示：找出指针落在哪个导航块上，标出插入位置
    const others = draggableNavBlocks().filter((x) => x !== dragEl);
    for (const x of others) x.classList.remove('drop-before', 'drop-after');
    for (const x of others) {
      const r = x.getBoundingClientRect();
      if (ev.clientX >= r.left && ev.clientX <= r.right) {
        x.classList.add(ev.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
        break;
      }
    }
  });

  window.addEventListener('pointerup', (ev) => {
    if (!dragEl) return;
    const wasDragged = moved;
    const el = dragEl;
    dragEl = null;
    document.body.classList.remove('dragging-tab-body');
    el.classList.remove('dragging-tab');
    const marks = draggableNavBlocks().filter((x) => x !== el);
    let before = null, after = null;
    for (const x of marks) {
      if (x.classList.contains('drop-before')) before = x;
      if (x.classList.contains('drop-after')) after = x;
      x.classList.remove('drop-before', 'drop-after');
    }
    if (!wasDragged) return;   // 只是点击，交给原有 click 处理

    if (before) nav.insertBefore(el, before);
    else if (after) nav.insertBefore(el, after.nextSibling);

    // 刚拖动过 → 抑制紧随其后的一次 click（否则松手瞬间会误切页签/误开下拉）
    suppressNextNavClick = true;
    setTimeout(() => { suppressNextNavClick = false; }, 0);

    // 记录新顺序（按身份键）
    const order = draggableNavBlocks().map(navBlockKey).filter(Boolean);
    saveLayout({ tabOrder: order });
    showLayoutFloatActions();   // R70：拖动页签后显快捷操作
    void ev;
  });

  // 捕获阶段拦下拖动引发的那一次 click
  nav.addEventListener('click', (ev) => {
    if (!suppressNextNavClick) return;
    suppressNextNavClick = false;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);
}

/** 恢复已保存的页签顺序（启动时调一次） */
function applyTabOrder() {
  const nav = document.getElementById('tabs');
  if (!nav) return;
  const { tabOrder } = layoutCfg();
  if (!tabOrder.length) return;
  const byKey = new Map(draggableNavBlocks().map((el) => [navBlockKey(el), el]));
  // 按保存的顺序依次追加到末尾 —— 未在记录里的块（新增页签）留在原位
  const anchor = nav.querySelector('.nav-spacer');
  for (const key of tabOrder) {
    const el = byKey.get(key);
    if (!el) continue;
    if (anchor) nav.insertBefore(el, anchor); else nav.appendChild(el);
  }
}

/* ── R70：右下角布局快捷操作（保存 / 恢复默认）────────────────────────────
   用户需求：把设置页里的「保存当前排布」「排布恢复默认」两个按钮挪到主界面，
   只在检测到拖动 UI（分隔条 / 页签 / 浮层面板 / 状态卡）后显示在右下角。
   显示后 6 秒自动隐藏；点击保存/恢复后立即给出反馈并隐藏。 */

let layoutActionsTimer = null;

function showLayoutFloatActions() {
  const box = document.getElementById('layout-float-actions');
  if (!box) return;
  box.hidden = false;
  clearTimeout(layoutActionsTimer);
  layoutActionsTimer = setTimeout(() => { if (box) box.hidden = true; }, 6000);
}

function hideLayoutFloatActions() {
  const box = document.getElementById('layout-float-actions');
  if (box) box.hidden = true;
  clearTimeout(layoutActionsTimer);
}

function setLayoutFloatHint(text) {
  const hint = document.getElementById('lfa-hint');
  if (hint) hint.textContent = text;
}

function initLayoutFloatActions() {
  const box = document.getElementById('layout-float-actions');
  const saveBtn = document.getElementById('lfa-save');
  const resetBtn = document.getElementById('lfa-reset');
  if (!box || !saveBtn || !resetBtn) return;

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    setLayoutFloatHint('正在保存…');
    try {
      const snap = await saveLayoutNow();
      let win = null;
      try { win = await window.qqaDesktop?.saveWindowGeometry?.(); } catch { win = null; }
      const parts = [];
      if (win && win.ok) {
        parts.push(`窗口 ${win.x},${win.y} · ${win.width}×${win.height}${win.maximized ? '（最大化）' : ''}`);
      } else if (window.qqaDesktop) {
        parts.push('窗口位置没存上');
      }
      parts.push(`栏宽 ${Object.keys(snap.panes).length} 项`);
      parts.push(`浮层 ${Object.keys(snap.float).length} 个`);
      setLayoutFloatHint(`已保存：${parts.join(' · ')}`);
      showLayoutFloatActions();        // 刷新 6 秒隐藏计时，让用户看清反馈
      setTimeout(hideLayoutFloatActions, 2500);
    } catch (e) {
      setLayoutFloatHint(`保存失败：${e.message || e}`);
      showLayoutFloatActions();
    } finally {
      saveBtn.disabled = false;
    }
  });

  resetBtn.addEventListener('click', async () => {
    resetBtn.disabled = true;
    setLayoutFloatHint('正在恢复…');
    try {
      resetLayout();
      state.config = state.config || {};
      const cur = state.config.ui || {};
      state.config.ui = { ...cur, layout: { panes: {}, tabOrder: [], float: {} } };
      await api('/api/config', { method: 'POST', body: JSON.stringify({ ui: state.config.ui }) });
      setLayoutFloatHint('排布已恢复默认（页签顺序刷新后生效）');
      showLayoutFloatActions();
      setTimeout(hideLayoutFloatActions, 2500);
    } catch (e) {
      setLayoutFloatHint(`恢复失败：${e.message || e}`);
      showLayoutFloatActions();
    } finally {
      resetBtn.disabled = false;
    }
  });
}

/** 布局总入口：启动时调用 */
function initFreeLayout() {
  applyLayoutPanes();
  applyTabOrder();
  initPaneResizers();
  initPaneUndoKeys();   // R55：Ctrl+Z 撤销栏宽复位
  initTabDrag();
  initFloatPanels();
  initStatusCard();     // R54：状态卡可独立拖出
  initLayoutFloatActions();   // R70：右下角布局快捷操作
}

/** 恢复默认布局（设置页按钮调用） */
function resetLayout() {
  for (const cfg of RESIZABLE_VIEWS) applyPaneWidth(cfg.pane, 0);
  for (const cfg of FLOATABLE_PANELS) undockPanel(cfg, { save: false });
  dockStatusCard({ save: false });   // R54：状态卡也归位
  paneUndo = null;                   // R55：整局都复位了，单项撤销就该失效
  clearTimeout(paneUndoTimer);
  hidePaneUndoToast();
  saveLayout({ panes: Object.fromEntries(RESIZABLE_VIEWS.map((c) => [c.key, 0])), tabOrder: [], float: {} });
}

/* ══════════════════════════════════════════════════════════════
 ③ 面板自由拖拽（磁贴式）：把手柄拖出去 → 面板变浮层，可放窗口任意位置

 设计取舍（刻意不做成完整 IDE 停靠系统）：
   完整停靠要处理 mullion 分割、拖放热区、嵌套 splitter —— 工程量数倍，
   且会与现有 flex + 响应式断点叠加出难以预料的布局。这里用
   「停靠 ⇄ 浮层」两态模型，覆盖用户 90% 的"我要把这个面板挪到那边"的诉求：
   - 手柄（⠿）按住拖离原位 → 面板升级为 position:fixed 浮层，跟手移动；
   - 松手自动吸附到最近的窗口边缘（留 12px 边距），不会盖住顶栏；
   - 浮层带自己的标题条（含 ⤢ 复位按钮），可再次拖动、双击复位；
   - 位置存 config.ui.layout.float，重启原样恢复。
 ══════════════════════════════════════════════════════════════ */

/** 可浮层化的面板：selector + 持久化 key + 显示名 */
const FLOATABLE_PANELS = [
  { sel: '#session-list', key: 'sessionsList', title: '会话列表' },
  { sel: '#chat-list', key: 'chatList', title: '消息存档' },
  { sel: '#memory-list', key: 'memoryList', title: '记忆文件' }
];

const FLOAT_EDGE = 12;    // 吸附到窗口边缘时留的边距
const FLOAT_MIN_W = 220;
const FLOAT_MIN_H = 160;
/** 吸附灵敏度（R52）：只有面板边缘离窗口边**小于**这个像素数才吸附，
 *  否则松手就停在原地 —— 这样用户可以把它放在窗口正中间，不再被硬拉走。 */
const FLOAT_SNAP_PX = 26;

/** 浮层状态：key → {x, y, w, h} */
function floatCfg() {
  const l = layoutCfg();
  return l.float && typeof l.float === 'object' ? l.float : {};
}

/* ── R66：浮层面板 × 视图入场动画的冲突（用户反馈"移动后退出重进位置不能正确保存"）──
   `.view.active` 带一条 pageIn 入场动画（切页签时会由 JS 重放），关键是它动画
   **transform**。而按 CSS 包含块规则，transform 不为 none 的元素会成为其
   position:fixed 后代的包含块 —— 于是浮层面板在动画那 260ms 里是按 `.view`
   的盒子定位的：`#layout` 的 padding(16px/14px) + pageIn 的 4px 位移，
   实测偏移 **(+16, +18)**，动画一结束再"啪"地跳回存档位置。
     启动时 initFloatPanels 恰好在动画期间恢复浮层 → 一开机就抖一下；
     之后每次切页签重放动画 → 再抖一次。
   （如果这 260ms 内刚好松手存了位置，getBoundingClientRect() 读到的也是偏移值，
     存档就被永久带偏 —— 所以这不只是观感问题。）

   修法：**视图里有浮层面板时，把该视图的入场动画降级为纯淡入**（fadeIn 只有
   opacity，不产生包含块），没有浮层时保留原来的位移入场。
   类挂在视图上而不是 body 上：只有受影响的那个视图让路，其他页签照常有位移感。 */
function refreshViewFloatFlag(panel) {
  const view = panel && panel.closest ? panel.closest('.view') : null;
  if (!view) return;
  view.classList.toggle('has-floating-panel', !!view.querySelector('.panel-floating'));
}

/** 把面板升级为浮层并定位 */
function applyFloat(panel, rect) {
  panel.classList.add('panel-floating');
  panel.style.left = `${Math.round(rect.x)}px`;
  panel.style.top = `${Math.round(rect.y)}px`;
  if (rect.w) panel.style.width = `${Math.round(rect.w)}px`;
  if (rect.h) panel.style.height = `${Math.round(rect.h)}px`;
  ensureResizeHandles(panel);   // R53：浮层才有的 8 向缩放把手
  // R66：**必须在 applyFloatEdgeClasses 之前** —— 后者要 getBoundingClientRect()，
  // 那是会强制同步布局的读操作；视图若还带着入场动画的 transform，量到的就是
  // 偏移了 16/18px 的值，贴边判定随之失真（贴左边 12px 的面板算出来是 28px，
  // flush-l 点亮不了，投影白留着）。先把视图的动画降级掉，再量。
  refreshViewFloatFlag(panel);
  applyFloatEdgeClasses(panel); // R53：贴边时压平该侧投影，消除"色差线"
}

/** 贴边标记（R53）：
 *  浮层离窗口某条边很近（≤ FLOAT_EDGE + 2）时，给面板加 .flush-l/.flush-r/.flush-t/.flush-b，
 *  CSS 据此把那一侧的投影收掉 —— 投影本该落在"面板之外"，
 *  贴边时那侧外面已经没有画布，硬画出来就成了一条突兀的暗线（用户反馈）。 */
function applyFloatEdgeClasses(panel) {
  const r = panel.getBoundingClientRect();
  // R66：面板没有面积时（所在页签未激活 / 尚未测量到尺寸）任何"贴边"判断都是假的。
  // 此时 getBoundingClientRect() 全 0 → 左边和上边必然判成贴边，四个 flush-* 会
  // 一起点亮，而且这个错误标记会**一直留在元素上** —— 用户之后切到该页签，
  // 看到的是投影被无端压平（本该有的那圈浮起感没了）。
  // 启动时 initFloatPanels 会恢复全部三个面板的浮层位置，其中两个必然在
  // 非活动页签里，所以这条路径每次启动都会走一遍。
  // （R59 给脱离的 .session-status 修的是同一个毛病，面板这边一直漏着。）
  if (!r.width && !r.height) return;
  const near = FLOAT_EDGE + 2;
  panel.classList.toggle('flush-l', r.left <= near);
  panel.classList.toggle('flush-r', window.innerWidth - r.right <= near);
  panel.classList.toggle('flush-t', r.top <= 46 + 2);
  panel.classList.toggle('flush-b', window.innerHeight - r.bottom <= near);
}

/** 面板回到停靠态 */
function undockPanel(cfg, { save = true } = {}) {
  const el = $(cfg.sel);
  if (!el) return;
  restoreHeadButtons(el);        // R60：先把搬上标题条的按钮插回列表头（必须在 bar 移除前）
  el.classList.remove('panel-floating');
  el.style.removeProperty('left');
  el.style.removeProperty('top');
  el.style.removeProperty('width');
  el.style.removeProperty('height');
  el.querySelector('.panel-float-bar')?.remove();
  refreshViewFloatFlag(el);      // R66：本视图可能还有别的浮层，按实际情况重算
  refreshFloatingBackdrop();
  if (save) {
    const f = { ...floatCfg() };
    delete f[cfg.key];
    saveLayout({ float: f });
  }
}

/** 给浮层加标题条（含操作按钮 + 复位按钮）；已存在则跳过 */
function ensureFloatBar(panel, title) {
  if (panel.querySelector('.panel-float-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'panel-float-bar';
  bar.innerHTML = `<span class="pfb-title">⠿ ${esc(title)}</span>`
    + `<span class="pfb-actions"></span>`
    + `<button class="pfb-reset" type="button" title="复位（回到原来的位置）">⤢</button>`;
  bar.title = '拖动标题条可移动面板';
  panel.insertBefore(bar, panel.firstChild);
  bar.querySelector('.pfb-reset').addEventListener('pointerdown', (e) => e.stopPropagation());
  bar.querySelector('.pfb-reset').addEventListener('click', () => {
    const cfg = FLOATABLE_PANELS.find((c) => $(c.sel) === panel);
    if (cfg) undockPanel(cfg);
  });
  parkHeadButtons(panel, bar.querySelector('.pfb-actions'));   // R60
}

/* ── R60：浮层态把列表头里的操作按钮（群发 / 清空）搬到标题条上 ──────────
   用户需求：「这俩能否做成按钮的形式在标题条这里显示」。
   在列表头里这两颗按钮的底色与列表头同为 --layer-1，看着几乎就是纯文字；
   浮层化后标题条才是"操作带"，搬上去再补一份明确的按钮外观（见 style.css
   `.panel-float-bar .pfb-actions .list-head-btn`），和右侧 ⤢ 同一套语言。

   做法是**搬 DOM、不复制**：click 监听（10-feedback.js 里按 id 绑的）与
   所有状态都跟着元素走，不会出现"两份按钮要同步状态"的坑。
   原位置用一个注释锚点记着，退出浮层时按原顺序插回。 */
const HEAD_PARK_PROP = '_r60HeadAnchor';

/** 把 `.lh-row` 里的操作按钮搬进标题条；该面板没有这类按钮时连容器一起摘掉 */
function parkHeadButtons(panel, box) {
  if (!box) return;
  const btns = [...panel.querySelectorAll('.lh-row .list-head-btn')];
  if (!btns.length) { box.remove(); return; }
  const anchor = document.createComment('r60-head-park');
  btns[0].parentNode.insertBefore(anchor, btns[0]);
  panel[HEAD_PARK_PROP] = anchor;
  for (const b of btns) box.appendChild(b);
}

/** 退出浮层：把搬走的按钮插回锚点原位，并清掉锚点 */
function restoreHeadButtons(panel) {
  const bar = panel.querySelector('.panel-float-bar');
  const anchor = panel[HEAD_PARK_PROP];
  if (bar && anchor && anchor.parentNode) {
    for (const b of [...bar.querySelectorAll('.pfb-actions .list-head-btn')]) {
      anchor.parentNode.insertBefore(b, anchor);   // 依次插到锚点前 → 保持原顺序
    }
  }
  anchor?.remove();
  panel[HEAD_PARK_PROP] = null;
}

/** 浮层数量 > 0 时给 body 加类（用于给停靠区让出背景等微调） */
function refreshFloatingBackdrop() {
  const any = document.querySelectorAll('.panel-floating').length > 0;
  document.body.classList.toggle('has-floating-panel', any);
}

/* ── 浮层缩放（R53）──────────────────────────────────────────────
   用户反馈「框的大小自定义也不够自由」：浮层化之后尺寸被固定成停靠时的宽高，
   只能靠分隔条改停靠宽度、对已经飘起来的面板无效。
   这里给浮层加 8 向缩放把手（四边 + 四角），拖哪边改哪边，尺寸写回
   config.ui.layout.float[key].{w,h,x,y}（左上角拖动会同时改 x/y）。
   ⚠️ 把手用绝对定位浮在面板四周，不占内部布局；尺寸受 FLOAT_MIN_* 与窗口边界约束。 */

/** 8 向缩放把手：方向 → CSS 类的后缀 */
const FLOAT_RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

const FLOAT_MAX_W = () => Math.max(FLOAT_MIN_W, window.innerWidth - 24);
const FLOAT_MAX_H = () => Math.max(FLOAT_MIN_H, window.innerHeight - 70);

/** 给浮层注入缩放把手（只在浮层态显示） */
function ensureResizeHandles(panel) {
  if (panel.querySelector('.panel-resize-handle')) return;
  for (const dir of FLOAT_RESIZE_DIRS) {
    const h = document.createElement('div');
    h.className = `panel-resize-handle prh-${dir}`;
    h.dataset.dir = dir;
    h.title = '拖动调整大小';
    panel.appendChild(h);
    bindPanelResize(panel, h, dir);
  }
}

/** 单个把手的缩放逻辑 */
function bindPanelResize(panel, handle, dir) {
  const onDown = (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const start = panel.getBoundingClientRect();
    const sx = ev.clientX, sy = ev.clientY;
    let { left, top, width, height } = { left: start.left, top: start.top, width: start.width, height: start.height };

    const has = (c) => dir.includes(c);
    document.body.classList.add('dragging-panel-resize');

    const onMove = (e) => {
      const dx = e.clientX - sx, dy = e.clientY - sy;
      let l = left, t = top, w = width, h = height;
      if (has('e')) w = width + dx;
      if (has('w')) { w = width - dx; l = left + dx; }
      if (has('s')) h = height + dy;
      if (has('n')) { h = height - dy; t = top + dy; }

      // clamp 尺寸（先夹尺寸，再回推被拖的那条边，保证另一侧不动）
      const minW = FLOAT_MIN_W, minH = FLOAT_MIN_H;
      const maxW = FLOAT_MAX_W(), maxH = FLOAT_MAX_H();
      if (w < minW) { if (has('w')) l -= (minW - w); w = minW; }
      if (w > maxW) { if (has('w')) l += (w - maxW); w = maxW; }
      if (h < minH) { if (has('n')) t -= (minH - h); h = minH; }
      if (h > maxH) { if (has('n')) t += (h - maxH); h = maxH; }
      // 不让面板跑出窗口（顶栏 46px 以下）
      if (l < 0) { if (has('w')) w += l; l = 0; }
      if (t < 46) { if (has('n')) h += (t - 46); t = 46; }
      if (l + w > window.innerWidth) w = window.innerWidth - l;
      if (t + h > window.innerHeight) h = window.innerHeight - t;

      panel.style.left = `${Math.round(l)}px`;
      panel.style.top = `${Math.round(t)}px`;
      panel.style.width = `${Math.round(w)}px`;
      panel.style.height = `${Math.round(h)}px`;
      applyFloatEdgeClasses(panel);   // R53：缩放时实时刷新贴边标记
    };

    const onUp = () => {
      document.body.classList.remove('dragging-panel-resize');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      applyFloatEdgeClasses(panel);   // R53：贴边判定要跟着尺寸变
      const r = panel.getBoundingClientRect();
      const cfg = FLOATABLE_PANELS.find((c) => $(c.sel) === panel);
      if (!cfg) return;
      const f = { ...floatCfg() };
      f[cfg.key] = {
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height)
      };
      saveLayout({ float: f });
      showLayoutFloatActions();   // R70：缩放浮层后显快捷操作
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    try { handle.setPointerCapture(ev.pointerId); } catch { /* 可选能力 */ }
  };
  handle.addEventListener('pointerdown', onDown);
}

/* ── R61：⠿ 手柄挂到哪儿 ─────────────────────────────────────────
   症状（用户截图）：停靠态下右上角的 ⠿ 手柄压在列表头右端「清空」按钮上，
   把"空"字遮掉半个；浮层态同理，会压住标题条右端的 ⤢ 复位按钮。

   成因：手柄原先固定挂在面板右上角（`.panel-grip` = absolute; top/right 6px;
   28×28），而右上角**永远被操作按钮占着** —— 两者的右缘基准还是同一个
   （面板内容盒，已经扣掉 10.4px 的滚动条保留槽）：
     · 手柄  right:6px + width:28px  → 占内容盒最右 6~34px
     · 清空  `.list-head` padding-right:14px + width:42px → 占 14~56px
   重叠 14~34px，正好是半个按钮。R52 注释里写的"避开操作按钮"从未成立。

   修法：**列表头里有操作按钮行的面板**（`.lh-row`）把 ⠿ 直接挂进那一行，
   成为行内的一员 —— 交给 flex 排布，结构上不可能重叠。附带修好另一个
   隐性缺陷：手柄原先是滚动容器（`.list-pane` 有 overflow-y:auto）里的
   绝对定位元素，列表一滚它就跟着内容跑掉了；挂进 sticky 的列表头后
   它跟按钮一起吸顶。没有 `.lh-row` 的面板（消息存档 / 记忆文件，列表头
   只有一行标题、右侧本来就是空的）继续用原来的右上角悬浮定位。 */
function mountFloatGrip(panel, grip) {
  const row = panel.querySelector('.list-head .lh-row');
  if (!row) { panel.appendChild(grip); return; }
  grip.classList.add('panel-grip-inline');
  row.appendChild(grip);
}

/** 在面板左上角注入拖拽手柄 */
function initFloatPanels() {
  for (const cfg of FLOATABLE_PANELS) {
    const panel = $(cfg.sel);
    if (!panel || panel.dataset.floatBound === '1') continue;
    panel.dataset.floatBound = '1';

    // 恢复上次的浮层位置
    const saved = floatCfg()[cfg.key];
    if (saved && Number.isFinite(saved.x)) {
      applyFloat(panel, saved);
      ensureFloatBar(panel, cfg.title);
    }

    // 手柄：拖拽把手。放哪儿由 mountFloatGrip 决定 —— 列表头带操作按钮行的
    // 面板挂进那一行，其余面板仍是右上角悬浮（R61）。
    const grip = document.createElement('div');
    grip.className = 'panel-grip';
    grip.title = '拖动我：把面板拖到窗口任意位置（也可直接拖标题行，或按住 Alt 拖面板空白处）';
    grip.textContent = '⠿';
    mountFloatGrip(panel, grip);

    bindPanelDrag(panel, grip, cfg);
  }
  refreshFloatingBackdrop();
}

/** 绑定拖拽（R52 扩展）：
 *  可拖的"把手"有三处 ——
 *    ① ⠿ 手柄（原配，仍然最直观）。位置见 mountFloatGrip：列表头带操作按钮行
 *       的面板（会话列表）它在那一行里，其余面板在右上角；浮层态下它被收起；
 *    ② 面板顶部的标题行 .list-head（**新增**：整条都能抓，只有里面的按钮除外）；
 *    ③ 浮层态下的 .panel-float-bar 标题条。
 *  另外 **按住 Alt 拖面板任意空白处** 也能移动（给"想随手挪"的用户一条快速通道）。 */
function bindPanelDrag(panel, grip, cfg) {
  let dragging = false, moved = false;
  let startX = 0, startY = 0, originX = 0, originY = 0, startRect = null;

  const onDown = (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true;
    moved = false;
    startX = ev.clientX;
    startY = ev.clientY;
    startRect = panel.getBoundingClientRect();
    originX = startRect.left;
    originY = startRect.top;
    document.body.classList.add('dragging-panel');
  };

  const onMove = (ev) => {
    if (!dragging) return;
    if (!moved && (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4)) return;
    if (!moved) {
      moved = true;
      // 首次真正移动：停靠态 → 浮层（保持原尺寸与当前屏幕位置，视觉不跳）
      if (!panel.classList.contains('panel-floating')) {
        applyFloat(panel, { x: startRect.left, y: startRect.top, w: startRect.width, h: startRect.height });
        ensureFloatBar(panel, cfg.title);
        refreshFloatingBackdrop();
      }
      panel.classList.add('panel-dragging');
    }
    const x = originX + (ev.clientX - startX);
    const y = originY + (ev.clientY - startY);
    // 不越界：留出顶栏高度（顶栏是 46px 左右）
    const maxX = window.innerWidth - FLOAT_MIN_W;
    const maxY = window.innerHeight - FLOAT_MIN_H;
    panel.style.left = `${Math.min(Math.max(0, x), maxX)}px`;
    panel.style.top = `${Math.min(Math.max(46, y), maxY)}px`;
    applyFloatEdgeClasses(panel);   // R53：拖动过程中实时刷新贴边标记（阴影跟着收/放）
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dragging-panel');
    panel.classList.remove('panel-dragging');
    if (!moved) return;
    if (!panel.classList.contains('panel-floating')) return;

    // 吸附（R52 已放宽）：**只有**贴到窗口边附近才吸附，否则原地停。
    const r = panel.getBoundingClientRect();
    let x = r.left;
    let y = r.top;
    // 水平：分别看左边缘与右边缘到窗口边的距离，谁近（且 < 阈值）吸谁
    const distLeft = r.left;
    const distRight = window.innerWidth - (r.left + r.width);
    if (distLeft < FLOAT_SNAP_PX) x = FLOAT_EDGE;
    else if (distRight < FLOAT_SNAP_PX) x = Math.max(FLOAT_EDGE, window.innerWidth - r.width - FLOAT_EDGE);
    // 垂直：顶边贴顶栏时不吸附（视觉上是"顶到头"），这里只在离窗口底边很近时吸附
    const distBottom = window.innerHeight - (r.top + r.height);
    if (distBottom < FLOAT_SNAP_PX) y = Math.max(46, window.innerHeight - r.height - FLOAT_EDGE);
    y = Math.min(Math.max(46, y), window.innerHeight - FLOAT_MIN_H);
    x = Math.min(Math.max(0, x), window.innerWidth - FLOAT_MIN_W);
    panel.style.left = `${Math.round(x)}px`;
    panel.style.top = `${Math.round(y)}px`;
    applyFloatEdgeClasses(panel);   // R53：吸附后刷新贴边标记（压平贴边侧投影）

    const f = { ...floatCfg() };
    f[cfg.key] = { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height) };
    saveLayout({ float: f });
    showLayoutFloatActions();   // R70：拖动浮层面板后显快捷操作
  };

  grip.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  // ② 标题行整条可拖（列表头）——按钮（群发/清空/刷新等）除外，避免误触发
  panel.addEventListener('pointerdown', (ev) => {
    const head = ev.target.closest?.('.list-head');
    if (!head) return;
    if (ev.target.closest?.('button, .list-head-btn, input, select, a')) return;
    onDown(ev);
  });

  // ③ 浮层标题条也可拖（浮层态下用户更自然会抓标题）
  panel.addEventListener('pointerdown', (ev) => {
    if (!panel.classList.contains('panel-floating')) return;
    if (!ev.target.closest?.('.panel-float-bar')) return;
    // 复位按钮、以及 R60 搬上来的操作按钮（群发/清空）自己处理点击，别变成拖窗口
    if (ev.target.closest?.('.pfb-reset, .pfb-actions')) return;
    onDown(ev);
  });

  // ③b Alt + 拖面板任意空白处 → 也能移动（快速通道；避开交互元素）
  panel.addEventListener('pointerdown', (ev) => {
    if (!ev.altKey) return;
    if (ev.target.closest?.('button, input, select, a, .session-item, .chat-item, .memory-item, .list-head, .panel-float-bar')) return;
    onDown(ev);
  });
}

/* ══════════════════════════════════════════════════════════════
 ④ 状态卡独立拖出（R54）：把 .session-status 从会话列表头里"摘"出来

 用户需求：「这个东西也可以调整位置，可以拖出来」。
 与 ③ 的面板浮层不同 —— 这是**子元素的脱离**：
   .session-status 本来是 #session-list 列表头里的一块卡（OneBot 状态 +
   模型 + 就绪圆点 + 暂停），用户希望把它单独拎出来停在窗口任意角落
   （比如右上角），列表本身仍保持停靠。

 实现要点：
   - 拖出后给卡加 .status-detached + position:fixed，并从 list-head 的
     正常流里脱离。留一个占位符 .status-placeholder 在原位，但**收拢到 0 高**
     （R64，用户要求「拖走后空位被底下自动填充，拖回来再自动顶下去」）；
     拖动中卡片中心回到面板上时才长回原高度 + 虚线框，作为落点预览。
     R54 当初是反的（占位符写死高度"避免整块塌下去"），会让列表里留一片死空地。
   - 卡自身变成可拖动载体（整块可抓，按钮除外）；右下角给一个"归位"按钮。
   - 位置写 config.ui.layout.float.statusCard，重启原样恢复。
   - 不依赖 .panel-floating 那套（那是面板级），单独一套更简单可控。
 ══════════════════════════════════════════════════════════════ */

const STATUS_CARD_SEL = '.session-status';
const STATUS_KEY = 'statusCard';
const STATUS_MIN_W = 180;
const STATUS_SNAP_PX = 26;   // 与面板一致的"接近才吸"手感

/** 状态卡是否已独立 */
function isStatusDetached() {
  const el = $(STATUS_CARD_SEL);
  return !!(el && el.classList.contains('status-detached'));
}

/** 把状态卡脱离成独立浮卡 */
function detachStatusCard(rect) {
  const el = $(STATUS_CARD_SEL);
  if (!el || isStatusDetached()) return;
  const parent = el.parentElement;
  // R64：占位符不再"顶住高度"—— 默认收拢成 0，把空位让给下面的会话；
  // 只有拖动中卡片中心回到面板上（.status-drop-target）才按 --ph-h 长回来，
  // 把会话顶下去当作落点预览。所以这里量出的原高度写进自定义属性，
  // 而不是写死内联 height（定值没法在"收拢 / 长回"之间切换）。
  const ph = document.createElement('div');
  ph.className = 'status-placeholder';
  ph.style.setProperty('--ph-h', `${Math.round(el.getBoundingClientRect().height)}px`);
  parent.insertBefore(ph, el);
  document.body.appendChild(el);          // 移到 body 下，脱离 list-head 的 sticky/overflow
  el.classList.add('status-detached');
  el.style.left = `${Math.round(rect.x)}px`;
  el.style.top = `${Math.round(rect.y)}px`;
  el.style.width = `${Math.round(rect.w)}px`;
  ensureStatusResetBtn(el);
  refreshFloatingBackdrop();
}

/** 状态卡归位（回到会话列表头里） */
function dockStatusCard({ save = true } = {}) {
  const el = $(STATUS_CARD_SEL);
  if (!el || !isStatusDetached()) return;
  const ph = document.querySelector('.status-placeholder');
  if (ph && ph.parentElement) ph.parentElement.insertBefore(el, ph);
  else document.querySelector('#session-list .list-head')?.appendChild(el);
  ph?.remove();
  el.classList.remove('status-detached', 'status-dragging', 'status-dropping',
    'flush-l', 'flush-r', 'flush-t', 'flush-b');
  el.style.removeProperty('left');
  el.style.removeProperty('top');
  el.style.removeProperty('width');
  el.querySelector('.status-reset')?.remove();
  refreshFloatingBackdrop();
  if (save) {
    const f = { ...floatCfg() };
    delete f[STATUS_KEY];
    saveLayout({ float: f });
  }
}

/** 给独立状态卡加"归位"小按钮 */
function ensureStatusResetBtn(el) {
  if (el.querySelector('.status-reset')) return;
  const b = document.createElement('button');
  b.className = 'status-reset';
  b.type = 'button';
  b.title = '归位（放回会话列表）';
  b.textContent = '⤢';
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.addEventListener('click', (e) => { e.stopPropagation(); dockStatusCard(); });
  el.appendChild(b);
}

/** 状态卡贴边标记（与面板同一套阈值，复用 .flush-* 的投影处理） */
function applyStatusEdgeClasses(el) {
  const r = el.getBoundingClientRect();
  // R59：卡没有面积时（不在当前页签 / 尚未测量到尺寸）任何"贴边"判断都是假的，
  // 直接跳过、保持上一次的标记 —— 否则四个方向会一起被点亮成 flush-*，
  // 切回会话页会看到投影全被压平。
  // （R59 隐藏用的是 visibility，盒子仍在，这条是防 0×0 的兜底。）
  if (!r.width && !r.height) return;
  const near = 14;
  el.classList.toggle('flush-l', r.left <= near);
  el.classList.toggle('flush-r', window.innerWidth - r.right <= near);
  el.classList.toggle('flush-t', r.top <= 46 + 2);
  el.classList.toggle('flush-b', window.innerHeight - r.bottom <= near);
}

/* ── R62：把状态卡拖到「会话列表」面板上 → 自动吸附到面板最上面 ──────
   需求（用户）：把脱离态的状态卡（飘在窗口上的那种）拖到会话列表面板上松手，
   它应当自动"吸"回面板顶部 —— 也就是回到列表头里原来的位置（用户给的
   第三张图），而不是继续做窗口边缘吸附、停在面板中间挡着列表。

   判定：拖动中**卡片中心点**落在 `#session-list` 的盒子内即视为要放进去。
   用一个点而不是"面积重叠"：卡片比面板窄，中心点在面板里 ⟺ 用户确实把它
   挪到了面板上，规则好理解、也不会出现"擦到一角就被吸走"。

   反馈（拖动中实时的落点预览）：面板亮一圈 accent 描边、卡片半透明缩小，
   同时列表头里的占位槽（`.status-placeholder`，脱离期本来隐形）亮成虚线框
   —— 虚线框的位置就是松手后的落点，用户能直接看到它会停在哪。
   ⚠️ 只对 `#session-list` 生效：状态卡本来就是它的一部分，别的面板没它的位置。
   ⚠️ 面板在别的页签时 `display:none`（矩形 0×0）→ 不吸附，避免"看不见的目标"。 */
const STATUS_DROP_SEL = '#session-list';

/** 拖动中的卡是否落在可吸附的面板上；是则返回该面板元素，否则 null */
function statusDropPanel(el) {
  if (!isStatusDetached()) return null;         // 还没脱离就不用吸回去
  const panel = document.querySelector(STATUS_DROP_SEL);
  if (!panel) return null;
  const p = panel.getBoundingClientRect();
  if (!p.width || !p.height) return null;       // 面板不在当前页签
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  if (cx < p.left || cx > p.right || cy < p.top || cy > p.bottom) return null;
  return panel;
}

/** 点亮 / 熄灭"吸附落点"提示（面板描边 + 卡片态 + 占位槽虚线框） */
function setStatusDropTarget(panel) {
  for (const p of document.querySelectorAll('.status-drop-target')) {
    if (p !== panel) p.classList.remove('status-drop-target');
  }
  panel?.classList.add('status-drop-target');
  $(STATUS_CARD_SEL)?.classList.toggle('status-dropping', !!panel);
}

function clearStatusDropTarget() {
  for (const p of document.querySelectorAll('.status-drop-target')) p.classList.remove('status-drop-target');
  $(STATUS_CARD_SEL)?.classList.remove('status-dropping');
}

/** 绑定状态卡的拖出/移动 */
function bindStatusCardDrag() {
  const el = $(STATUS_CARD_SEL);
  if (!el || el.dataset.statusDragBound === '1') return;
  el.dataset.statusDragBound = '1';

  let dragging = false, moved = false;
  let sx = 0, sy = 0, ox = 0, oy = 0, startRect = null;

  const onDown = (ev) => {
    if (ev.button !== 0) return;
    if (ev.target.closest?.('button, input, select, a, .readiness-dots, .rdot')) return;
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true; moved = false;
    clearStatusDropTarget();          // R62：每次开拖先熄掉落点提示
    sx = ev.clientX; sy = ev.clientY;
    startRect = el.getBoundingClientRect();
    ox = startRect.left; oy = startRect.top;
    document.body.classList.add('dragging-panel');
  };

  const onMove = (ev) => {
    if (!dragging) return;
    if (!moved && (Math.abs(ev.clientX - sx) < 4 && Math.abs(ev.clientY - sy) < 4)) return;
    if (!moved) {
      moved = true;
      // 首次真正移动：若还在列表头里 → 脱离成独立浮卡（保持当前位置与宽度，视觉不跳）
      if (!isStatusDetached()) {
        detachStatusCard({ x: startRect.left, y: startRect.top, w: startRect.width, h: startRect.height });
      }
      el.classList.add('status-dragging');
    }
    const x = Math.min(Math.max(0, ox + (ev.clientX - sx)), window.innerWidth - STATUS_MIN_W);
    const y = Math.min(Math.max(46, oy + (ev.clientY - sy)), window.innerHeight - 44);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    // R62：卡片中心落在会话列表上 → 亮出"将吸附到面板顶部"的落点预览；
    // 此时不再做窗口贴边判定 —— 那套 flush-* 会压平投影，与"即将被吸走"
    // 的半透明状态叠在一起看着像坏了。
    const dropPanel = statusDropPanel(el);
    setStatusDropTarget(dropPanel);
    if (dropPanel) el.classList.remove('flush-l', 'flush-r', 'flush-t', 'flush-b');
    else applyStatusEdgeClasses(el);
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dragging-panel');
    el.classList.remove('status-dragging');
    // R62：先取落点再熄提示 —— 松手时卡片中心还在面板上就"吸"进去
    const target = statusDropPanel(el);
    clearStatusDropTarget();
    if (!moved || !isStatusDetached()) return;
    if (target) { dockStatusCard(); return; }   // 吸附到面板最上面（= 归位到列表头）

    // 接近边缘才吸附（同面板手感）
    const r = el.getBoundingClientRect();
    let x = r.left, y = r.top;
    if (r.left < STATUS_SNAP_PX) x = FLOAT_EDGE;
    else if (window.innerWidth - r.right < STATUS_SNAP_PX) x = Math.max(FLOAT_EDGE, window.innerWidth - r.width - FLOAT_EDGE);
    if (window.innerHeight - r.bottom < STATUS_SNAP_PX) y = Math.max(46, window.innerHeight - r.height - FLOAT_EDGE);
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    applyStatusEdgeClasses(el);

    const f = { ...floatCfg() };
    f[STATUS_KEY] = { x: Math.round(x), y: Math.round(y), w: Math.round(r.width) };
    saveLayout({ float: f });
    showLayoutFloatActions();   // R70：拖动状态卡后显快捷操作
  };

  el.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/** 恢复上次独立位置（启动时调一次） */
function restoreStatusCard() {
  const saved = floatCfg()[STATUS_KEY];
  if (!saved || !Number.isFinite(saved.x)) return;
  const el = $(STATUS_CARD_SEL);
  if (!el) return;
  // 脱离态需要 body 下挂载 + 占位符，这里走一次 detach 再覆盖位置
  detachStatusCard({ x: saved.x, y: saved.y, w: saved.w || 260, h: 60 });
  el.style.left = `${Math.round(saved.x)}px`;
  el.style.top = `${Math.round(saved.y)}px`;
  if (saved.w) el.style.width = `${Math.round(saved.w)}px`;
  applyStatusEdgeClasses(el);
}

/** 状态卡独立排布入口（initFreeLayout 里调用） */
function initStatusCard() {
  bindStatusCardDrag();
  restoreStatusCard();
}
