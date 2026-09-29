// 〔设置事件绑定〕——M9 拆分第 8 段
'use strict';
// ── 设置页渲染守卫 ─────────────────────────────────────────────────────
// 自动保存期间（表单读取 + 保存请求在途），任何代码路径想整页重渲染设置表单
// 都会被拦下并记为"待重绘"（真正的拦截在 renderSettings 开头）。原因：
// 重渲染 = 用 state.config（上一次保存的旧值）重建整个表单 DOM ——
// 用户正在输入的未保存内容会被直接吹掉，看起来就是"设置存不上 / 改了又弹回去"。
// 拦下后等保存完成再补一次重绘，那时 state.config 已是最新值，不会丢内容。
const settingsGuard = { pending: 0, needRerender: false };

function beginSettingsGuard() { settingsGuard.pending++; }
function endSettingsGuard() {
  settingsGuard.pending = Math.max(0, settingsGuard.pending - 1);
  if (settingsGuard.pending === 0 && settingsGuard.needRerender) {
    settingsGuard.needRerender = false;
    renderSettings();
  }
}

// ── 离开设置页前的"挂起保存"清单 ───────────────────────────────────────
// bindSettingsEvents 每次重渲染都重建闭包，外部（switchTab）拿不到最新的
// flushSave —— 用模块级数组中转：渲染时登记、切页时逐个调用、
// 重渲染前清掉同表单的旧登记（表单 DOM 已换，旧 flush 引用的闭包失效）。
let settingsFlushHandlers = [];

/** 切走设置页前调用：把防抖窗口内还没落盘的改动立即保存。 */
function flushSettingsSaves() {
  for (const fn of settingsFlushHandlers) {
    try { fn(); } catch (e) { console.error('离开设置页前保存失败:', e); }
  }
}

/* ── 外观个性化（R40）────────────────────────────────────────────────────
   色板/取色器/滑块/背景图按钮的绑定与即时应用。
   ⚠️ 这些控件都在 #settings-form 里，改动会触发既有的一次防抖自动保存；
      这里只负责"立刻看到效果"和需要原生能力的两件事（选图、清图）。
      选图走 Electron 桥（原生对话框 + 复制到数据目录），浏览器里打开时按钮会提示不可用。 */
function bindUiCustomEvents() {
  const ui = () => (state.config?.ui || {});

  // 读取页面上当前所有个性化控件的值，合成一份 ui 片段（live 预览 + 保存共用口径）
  const readUi = () => ({
    accent: ($('#cfg-accent-hex')?.value || '').trim(),
    bgColor: ($('#cfg-bgcolor-hex')?.value || '').trim(),
    frameAlpha: Number($('#cfg-framealpha')?.value ?? 100),
    bgImage: String(ui().bgImage || ''),
    bgFit: $('#cfg-bgfit')?.value || 'cover',
    bgDim: Number($('#cfg-bgdim')?.value ?? 0),
    winOpacity: Number($('#cfg-winopacity')?.value ?? 100)
  });

  // 让页面上的输入框与内存里的 ui 保持同一份真值（保存前先把 state.config.ui 同步，
  // saveConfig 的 app 分支就是这样读的，避免"预览变了但保存的还是旧值"）
  const syncToState = () => {
    if (!state.config) return;
    state.config.ui = { ...(state.config.ui || {}), ...readUi() };
  };

  const apply = () => {
    const patch = readUi();
    applyUiCustom(patch);
    syncToState();
  };

  // 色板（强调色 / 底色）
  const wireSwatches = (boxSel, attr, hexInputSel, colorInputSel, key) => {
    const box = $(boxSel);
    if (!box) return;
    const mark = (val) => {
      box.querySelectorAll('.swatch').forEach((el) => {
        const v = el.getAttribute(attr) ?? '';
        el.classList.toggle('on', String(v).toLowerCase() === String(val || '').toLowerCase());
      });
    };
    box.querySelectorAll('.swatch').forEach((el) => {
      const pick = () => {
        const v = el.getAttribute(attr) ?? '';
        const hexEl = $(hexInputSel);
        if (hexEl) hexEl.value = v;
        const cEl = $(colorInputSel);
        if (cEl && isHexColor(v)) cEl.value = v;
        mark(v);
        apply();
      };
      el.addEventListener('click', pick);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    });
    return mark;
  };
  const markAccent = wireSwatches('#accent-swatches', 'data-accent', '#cfg-accent-hex', '#cfg-accent', 'accent');
  const markBg = wireSwatches('#bg-swatches', 'data-bg', '#cfg-bgcolor-hex', '#cfg-bgcolor', 'bgColor');

  // 取色器 / 手填 hex：两边互相同步
  const wireColorPair = (colorSel, hexSel, markFn) => {
    const cEl = $(colorSel);
    const hEl = $(hexSel);
    if (cEl) cEl.addEventListener('input', () => {
      if (hEl) hEl.value = cEl.value;
      if (markFn) markFn(cEl.value);
      apply();
    });
    if (hEl) hEl.addEventListener('input', () => {
      const v = hEl.value.trim();
      if (isHexColor(v) && cEl) cEl.value = v;
      if (markFn) markFn(v);
      apply();
    });
  };
  wireColorPair('#cfg-accent', '#cfg-accent-hex', markAccent);
  wireColorPair('#cfg-bgcolor', '#cfg-bgcolor-hex', markBg);

  // 滑块：拖动时同步显示数字 + 即时应用
  const wireRange = (sel, labelSel) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('input', () => {
      const lab = $(labelSel);
      if (lab) lab.textContent = el.value;
      apply();
    });
  };
  wireRange('#cfg-framealpha', '#framealpha-val');
  wireRange('#cfg-bgdim', '#bgdim-val');
  wireRange('#cfg-winopacity', '#winopacity-val');

  // 背景图填充方式
  $('#cfg-bgfit')?.addEventListener('change', () => apply());

  // 选择背景图（走 Electron 原生对话框；没有桥时给出明确提示，不静默失败）
  $('#cfg-bg-pick')?.addEventListener('click', async () => {
    const hint = $('#cfg-bg-hint');
    if (!window.qqaDesktop || typeof window.qqaDesktop.pickBgImage !== 'function') {
      if (hint) hint.textContent = '当前不是桌面端（或外壳版本较旧），无法选择本地图片。';
      return;
    }
    try {
      const r = await window.qqaDesktop.pickBgImage();
      if (!r?.ok) return;                       // 用户取消了，什么都不做
      // 保存：背景图不进防抖队列（它是"选完就定"的一次性动作，即时落盘更可预期）
      state.config = state.config || {};
      state.config.ui = { ...(state.config.ui || {}), bgImage: r.name, bgFit: $('#cfg-bgfit')?.value || 'cover' };
      await api('/api/config', { method: 'POST', body: JSON.stringify({ ui: state.config.ui }) });
      applyUiCustom(state.config.ui);
      const clearBtn = $('#cfg-bg-clear');
      if (clearBtn) clearBtn.disabled = false;   // 有图可清了（R50）
      if (hint) hint.textContent = `已设置：${r.name}（图片已复制到数据目录）。想看到它，把「底色不透明度」调低一点。`;
    } catch (e) {
      if (hint) hint.textContent = `选择背景图失败：${e.message || e}`;
    }
  });

  // 清除背景图
  $('#cfg-bg-clear')?.addEventListener('click', async () => {
    const hint = $('#cfg-bg-hint');
    try {
      if (window.qqaDesktop && typeof window.qqaDesktop.clearBgImage === 'function') {
        await window.qqaDesktop.clearBgImage();
      }
      state.config = state.config || {};
      state.config.ui = { ...(state.config.ui || {}), bgImage: '' };
      await api('/api/config', { method: 'POST', body: JSON.stringify({ ui: state.config.ui }) });
      applyUiCustom(state.config.ui);
      const clearBtn = $('#cfg-bg-clear');
      if (clearBtn) { clearBtn.disabled = true; clearBtn.title = '还没有设置背景图'; }   // 没图可清了（R50）
      if (hint) hint.textContent = '已清除背景图。';
    } catch (e) {
      if (hint) hint.textContent = `清除失败：${e.message || e}`;
    }
  });

  // 外观恢复默认：清掉所有个性化字段并立即落盘 + 重渲染（让控件回到默认位）
  $('#cfg-uicustom-reset')?.addEventListener('click', async () => {
    const hint = $('#cfg-uicustom-hint');
    try {
      if (window.qqaDesktop && typeof window.qqaDesktop.clearBgImage === 'function') {
        await window.qqaDesktop.clearBgImage();
      }
      state.config = state.config || {};
      state.config.ui = {
        ...(state.config.ui || {}),
        accent: '', bgColor: '', frameAlpha: 100, bgImage: '', bgFit: 'cover', bgDim: 0, winOpacity: 100
      };
      await api('/api/config', { method: 'POST', body: JSON.stringify({ ui: state.config.ui }) });
      applyUiCustom(state.config.ui);
      renderSettings();
      if (hint) hint.textContent = '已恢复默认外观。';
    } catch (e) {
      if (hint) hint.textContent = `恢复失败：${e.message || e}`;
    }
  });

  // 保存当前排布（R67）：用户反馈"并没有记住我之前的窗口拖拽的位置"。
  // 自动保存一直在（拖拽松手 → 防抖 400ms），但没有任何反馈 —— 存没存下、
  // 存的是什么，用户只能靠"重启试试"来猜。这里给一个显式入口：
  // 以此刻画面为准当场落盘，并把窗口几何与实际存下的条目回显出来。
  $('#cfg-layout-save')?.addEventListener('click', async () => {
    const hint = $('#cfg-layout-hint');
    const btn = $('#cfg-layout-save');
    if (btn) btn.disabled = true;
    if (hint) hint.textContent = '正在保存…';
    try {
      // ① 排布：列宽 / 浮层位置尺寸 / 页签顺序（12-layout.js，实测 DOM 内联值）
      const snap = await saveLayoutNow();

      // ② 窗口位置尺寸：只有桌面端拿得到（浏览器里没有 window.qqaDesktop）
      let win = null;
      try { win = await window.qqaDesktop?.saveWindowGeometry?.(); } catch { win = null; }

      const parts = [];
      if (win && win.ok) {
        parts.push(`窗口 ${win.x},${win.y} · ${win.width}×${win.height}${win.maximized ? '（最大化）' : ''}`);
      } else if (window.qqaDesktop) {
        parts.push('窗口位置没存上');
      } else {
        parts.push('窗口位置需在桌面端保存');
      }
      parts.push(`栏宽 ${Object.keys(snap.panes).length} 项`);
      parts.push(`浮层 ${Object.keys(snap.float).length} 个`);
      if (hint) hint.textContent = `已保存：${parts.join(' · ')}`;
    } catch (e) {
      if (hint) hint.textContent = `保存失败：${e.message || e}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // 排布恢复默认（R51）：列宽回默认、页签顺序回默认并落盘
  $('#cfg-layout-reset')?.addEventListener('click', async () => {
    const hint = $('#cfg-layout-hint');
    try {
      resetLayout();                    // 清 --pane-w 变量（12-layout.js）
      state.config = state.config || {};
      const cur = state.config.ui || {};
      // R67：float 也一并清空 —— resetLayout 已把浮层全部归位（undockPanel /
      // dockStatusCard 都是 save:false），这里补上同名空对象，与保存快照的
      // 结构保持一致（原先整个键被删掉，语义相同但结构不一致）。
      state.config.ui = { ...cur, layout: { panes: {}, tabOrder: [], float: {} } };
      await api('/api/config', { method: 'POST', body: JSON.stringify({ ui: state.config.ui }) });
      if (hint) hint.textContent = '排布已恢复默认（页签顺序请刷新界面后生效）。';
    } catch (e) {
      if (hint) hint.textContent = `恢复失败：${e.message || e}`;
    }
  });
}

function bindSettingsEvents(c) {
  /* ── 即时保存：任何设置项变动 → 防抖 600ms 自动保存 ──
     变动反馈由「↩ 撤销本次设置」按钮承担（见 showUndoBtn）。
     原先还有一条"流动的浅黄色渐变带"（.dirty-glow）作为变动提示，已废弃：
     它是 rgba(255,213,79,.10~.22) 的半透明渐变 + background-position 无限动画，
     在透明分层窗口上会被逐帧 alpha 混合成一条黄色残影（用户反馈的"黄色的一坨"）。
     style.css 里 .dirty-glow 样式已置空，这里也不再收集 dirtyEls。 */
  let saveTimer = null;
  let saving = false;
  // 撤销快照：进入本设置区块时拍一份配置；有改动后显示「撤销」按钮，
  // 点击 = 整份配置回滚到快照（设置是即时生效的，回滚与改动之间发生的一切不负责）。
  const sectionSnapshot = structuredClone(state.config || {});
  let undoBtn = null;

  function markDirty() {
    showUndoBtn();
    scheduleSave();
  }

  function showUndoBtn() {
    if (undoBtn || !$('#settings-form')) return;
    undoBtn = document.createElement('button');
    undoBtn.className = 'btn btn-small settings-undo-btn';
    undoBtn.textContent = '↩ 撤销本次设置';
    undoBtn.title = '把本区块的设置整体还原到你进入时的状态。\n注意：设置是即时生效的，改动到撤销之间机器人可能已按新设置运行过，这部分不回滚。';
    undoBtn.addEventListener('click', async () => {
      if (!confirm('确定撤销本次设置？\n将把整个配置还原到你进入本设置区块之前的状态。\n（改动期间的运行行为不会被追回）')) return;
      try {
        // 整份快照写回（后端 updateConfig 深合并；快照含全部字段，等价整体覆盖）。
        // ⚠️ 不带 keepalive：fetch keepalive 有 64KB body 上限，整份配置快照
        // （含 providers/价格表/技能设置）很容易超 —— 超限时 fetch 直接以
        // "Failed to fetch" 拒绝，这就是"撤销设置偶发报错"的根源（2026-09-19 修）。
        // keepalive 只该用于页面卸载兜底（小 patch），撤销是普通点击场景。
        const r = await api('/api/config', { method: 'POST', body: JSON.stringify(sectionSnapshot) });
        if (r && r.config) state.config = r.config;
        renderSettings();
      } catch (e) {
        alert(`撤销失败：${e.message}`);
      }
    });
    const form = $('#settings-form');
    // 放在整页表单**最底下**（prepend 会顶在标题上方，把第一行设置项挤下去；
    // 有改动时视线应该在内容末尾收尾，而不是被顶上的按钮打断阅读）
    if (form) form.appendChild(undoBtn);
  }

  function scheduleSave(delay = 600) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; doSave(); }, delay);
  }

  async function doSave() {
    if (saving) { scheduleSave(); return; }
    saving = true;
    // 渲染守卫：从"开始收集表单"到"state.config 更新完成"期间不允许整页重渲染。
    // saveConfig 会先逐字段读 DOM、再 POST 并用响应覆盖 state.config ——
    // 中途任何重渲染（SSE 事件 / 轮询回调）都会吹掉用户正在输入的值。
    beginSettingsGuard();
    try {
      await saveConfig({ quiet: true });
      refreshStatus();
      startListPoller();
      // 刷新间隔可能刚被改过：重建状态轮询，让新间隔立刻生效
      startStatusPoller();
    } catch (e) {
      console.error('自动保存失败:', e);
    } finally {
      saving = false;
      endSettingsGuard();
    }
  }

  // 立即保存（清掉防抖定时器，当场发起）。
  // 两个触发点：
  //   1. change 事件（复选框勾选/下拉框切换/日期时间选择）——这类操作语义上
  //      已经"完成"，没有继续输入的后续，等 600ms 毫无意义，还留出
  //      "改完立刻切页签 → 定时器随 DOM 一起销毁 → 改动丢失"的窗口。
  //   2. 切走设置页前（switchTab flush）—— 同上，是离开前的最后一刻。
  // 定时器回调里先清引用：doSave 里若正在保存会再次 scheduleSave()，
  // 旧引用不清掉会让"已取消的定时器"看起来还活着。
  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    doSave();
  }

  // 表单变动监听（设置页所有输入都会经过这里）。
  // input（打字/拖滑条）保持 600ms 防抖聚批；change（勾选/选择完成）立即保存 ——
  // change 之后再没有"同一字段的后续输入"，防抖只会增加丢失窗口。
  //
  // ⚠️ 防重复绑定：#settings-form 是静态元素（只换 innerHTML），renderSettings
  //    每次都会调 bindSettingsEvents。曾经每次都在 form 上 addEventListener +
  //    向 window 挂 beforeunload —— N 次重渲染后每敲一个字触发 N 次保存
  //    （N 个并发 POST），关页时 N 次 keepalive 请求可能撞配额。
  //    这里仿照 attachScrollLoader 的做法：监听器只挂一次，闭包引用存在
  //    元素属性上，重渲染时只更新引用。
  const form = $('#settings-form');
  if (form && !form.__settingsBound) {
    form.__settingsBound = {
      markDirty: (el) => markDirty(el),
      flushSave: () => flushSave()
    };
    form.addEventListener('input', (e) => form.__settingsBound.markDirty(e.target), { passive: true });
    form.addEventListener('change', (e) => form.__settingsBound.markDirty(e.target), { passive: true });
    // 页面关闭/刷新兜底：防抖窗口内直接关页面前，先把挂起的保存发出去。
    // fetch keepalive 让请求在页面卸载后仍能完成（sendBeacon 带不了
    // 自定义头，这里用同款 api() 的 POST + keepalive 更简单可靠）。
    // 只挂一次：N 个闭包各带一个定时器，关页时并发 POST 反而丢数据。
    window.addEventListener('beforeunload', () => {
      if (form.__settingsBound) form.__settingsBound.flushSave();
    });
  } else if (form) {
    // 已绑定过：只刷新引用，指向本次渲染的新闭包
    form.__settingsBound.markDirty = (el) => markDirty(el);
    form.__settingsBound.flushSave = () => flushSave();
  }

  // 暴露给页签切换等外部路径：离开设置页前把挂起的改动落盘。
  // ⚠️ 必须挂在模块级状态上（bindSettingsEvents 每次重渲染都重建闭包），
  //    switchTab 永远能找到"当前这一份"的 flush。
  //    #settings-form 是静态元素（从不被替换），旧登记的去重条件曾用
  //    attachedForm 比较 —— 永远不相等，每次重渲染 push 一个新闭包，
  //    数组无限增长。改成"清空只留当前一份"：重渲染后旧闭包的
  //    saveTimer 引用已失效，留着只会有害。
  settingsFlushHandlers = [];
  const flush = () => flushSave();
  settingsFlushHandlers.push(flush);

  // ── Skill 开关 ──
  // 与工具开关的关键区别：Skill 开关**立即生效并落盘**，不走"未保存更改"流程。
  // 原因：Skill 的启停要跑生命周期回调（activate/deactivate），
  // 如果只是改本地 state 等用户点保存，就会出现"界面显示已开、后端还没开"的中间态；
  // 而且用户随手关掉一个 Skill 后忘了保存，会以为已经生效 —— 正是要消灭的割裂。
  $$('.skill-toggle').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const id = cb.dataset.skillId;
      cb.disabled = true;
      try {
        const r = await api(`/api/skills/${encodeURIComponent(id)}`, {
          method: 'POST',
          body: JSON.stringify({ enabled: cb.checked })
        });
        // 用后端返回的状态覆盖本地，保证展示与判定一致
        const idx = (state.skills || []).findIndex((s) => s.id === id);
        if (idx >= 0 && r.skill) state.skills[idx] = r.skill;
        if (r.config) state.config = r.config;
        await loadSkillsStatus();
        renderSettings();
      } catch (err) {
        cb.checked = !cb.checked;   // 失败回滚勾选状态
        alert(`切换技能失败：${err.message}`);
      } finally {
        cb.disabled = false;
      }
    });
  });

  // ── 工具分类块：按块绑定 + 局部刷新 ──────────────────────────────────
  // 分类总开关 / 折叠展开**只重建自己这一个 .tool-category 块**
  // （refreshToolCategory），不再整页 renderSettings() —— 整页 innerHTML
  // 重建在这里的表现就是肉眼可见的整页闪烁（2026-09-20 用户反馈），还会
  // 白白重绑全页事件。块内渲染与整页渲染同源（buildToolCategoryHTML，
  // 见 06-settings-render.js）。
  function refreshToolCategory(cat) {
    const el = document.querySelector(`.tool-category[data-category="${cat}"]`);
    // 找不到块（已切走设置页等）→ 兜底走整页渲染
    if (!el) { renderSettings(); return; }
    const tpl = document.createElement('template');
    tpl.innerHTML = buildToolCategoryHTML(cat).trim();
    const fresh = tpl.content.firstElementChild;
    if (!fresh) { el.remove(); return; }
    el.replaceWith(fresh);
    bindToolCategoryEvents(fresh);
  }

  function bindToolCategoryEvents(block) {
    const cat = block.dataset.category;

    // 单个工具开关
    block.querySelectorAll('.tool-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        const toolId = cb.dataset.toolId;
        state.config.tools = state.config.tools || {};
        // send_to 的勾选 = 「跨会话发送」开关本身（收编进消息发送分类）
        if (cb.dataset.crossChat) {
          state.config.tools.crossChatSend = cb.checked;
        } else {
          state.config.tools.overrides = state.config.tools.overrides || {};
          state.config.tools.overrides[toolId] = cb.checked;
        }
        const card = cb.closest('.tool-card');
        if (card) {
          card.classList.toggle('enabled', cb.checked);
          card.classList.toggle('disabled', !cb.checked);
          const box = card.querySelector('.tool-checkbox-box');
          if (box) box.textContent = cb.checked ? '✓' : '✗';
        }
        // 实时更新提示词预览
        updatePromptPreview();
        // 标脏走表单链（自动保存 'tools' 分支读 state.config.tools 整体提交）
        const form = $('#settings-form');
        if (form && form.__settingsBound) form.__settingsBound.markDirty(card || cb);
      });
    });

    // 分类开关 = 一键总闸（2026-09-20 改版）：
    //   关 → 整类停用，子开关视觉跟着全关且不可拨（渲染层按 categories[cat] 汇合）；
    //   开 → 自动展开该分类并**把子工具全部打开**（一键全开），子开关各自仍可单独关。
    // 单个开/关只写自己的 override，**不回写**分类开关 —— 两个层级互不干扰。
    const catCb = block.querySelector('.category-checkbox');
    if (catCb) catCb.addEventListener('change', () => {
      state.config.tools = state.config.tools || {};
      state.config.tools.categories = state.config.tools.categories || {};
      state.config.tools.categories[cat] = catCb.checked;
      if (catCb.checked) {
        // 一键全开 + 展开：子工具 override 全部置真（send_to 特殊：它对应 crossChatSend）
        state.config.tools.overrides = state.config.tools.overrides || {};
        (state.toolRegistry || []).filter((t) => t.category === cat).forEach((t) => {
          if (t.id === 'send_to') state.config.tools.crossChatSend = true;
          else state.config.tools.overrides[t.id] = true;
        });
        state.expandedToolCategories = state.expandedToolCategories || new Set(['messaging']);
        state.expandedToolCategories.add(cat);
      }
      // 只重绘这一个分类块（子开关全亮/全灰、展开态），其余 DOM 原地不动
      refreshToolCategory(cat);
      updatePromptPreview();
    });

    // 头部点击 = 展开/折叠（点在开关上不触发，也不闪整页）
    const header = block.querySelector('.tool-category-header');
    if (header) header.addEventListener('click', (e) => {
      if (e.target.closest('.tool-category-toggle')) return;
      state.expandedToolCategories = state.expandedToolCategories || new Set(['messaging']);
      if (state.expandedToolCategories.has(cat)) state.expandedToolCategories.delete(cat);
      else state.expandedToolCategories.add(cat);
      refreshToolCategory(cat);
    });
  }

  $$('.tool-category').forEach(bindToolCategoryEvents);

  // 全局开关
  const toolsEnabledCb = $('#cfg-tools-enabled');
  if (toolsEnabledCb) toolsEnabledCb.addEventListener('change', () => {
    state.config.tools = state.config.tools || {};
    state.config.tools.enabled = toolsEnabledCb.checked;
    updatePromptPreview();
  });

  // 全部启用/禁用/恢复默认
  $('#tools-enable-all')?.addEventListener('click', () => {
    state.config.tools = state.config.tools || {};
    state.config.tools.enabled = true;
    state.config.tools.overrides = {};
    state.config.tools.categories = {};
    renderSettings();});
  $('#tools-disable-all')?.addEventListener('click', () => {
    state.config.tools = state.config.tools || {};
    state.config.tools.enabled = false;
    renderSettings();});
  $('#tools-reset')?.addEventListener('click', () => {
    state.config.tools = { enabled: true, overrides: {}, categories: {} };
    renderSettings();});

  /** 实时更新提示词预览（旧版在前端拼静态模板，已改为后端同源组装） */
  function updatePromptPreview() {
    // 立即刷：后端按当前内存态组装（工具开关已同步写进 state.config.tools，
    // 但自动保存有 600ms 防抖、还没落盘）——所以先把当前工具态随请求发过去，
    // 后端合并补丁组装但不落盘，预览即刻反映刚点的开关。
    const overrides = { tools: state.config?.tools || {} };
    refreshPromptPreview(overrides);
  }

  // 分类展开/折叠已并入上方 bindToolCategoryEvents（局部刷新，不再整页重绘）

  // 搜索提供方切换
  const searchProviderSel = $('#cfg-searchprovider');
  if (searchProviderSel) searchProviderSel.addEventListener('change', () => {
    const v = searchProviderSel.value;
    const fields = {
      bing: '#bing-search-fields',
      deepseek: '#deepseek-search-fields',
      zhipu: '#zhipu-search-fields',
      bocha: '#bocha-search-fields',
      baidu: '#baidu-search-fields',
      metaso: '#metaso-search-fields'
    };
    for (const [provider, sel] of Object.entries(fields)) {
      const el = $(sel);
      // 自定义项形如 'custom:<id>'，统一按 custom 前缀匹配
      if (el) el.style.display = provider === v ? '' : 'none';
    }
    const manage = $('#custom-provider-manage');
    if (manage) manage.style.display = v.startsWith('custom:') ? '' : 'none';
    // 自定义服务 Key 框随选中项重置：不同服务各自的掩码/空状态在渲染时生成，
    // 但切换提供方是原地改 display 不重渲染 —— 这里手动对齐，避免上一家的
    // Key 残留显示给下一家（看起来像"共享 Key"，实际两家的 Key 互不相干）。
    const cpKey = $('#cfg-custom-sp-key');
    const cpToggle = $('#cfg-custom-sp-key-toggle');
    if (cpKey) {
      const cp = (state.config?.webSearch?.providers || []).find((p) => `custom:${p.id}` === v);
      cpKey.type = 'password';
      cpKey.value = cp?.hasApiKey ? '******' : '';
      cpKey.placeholder = '输入新 Key 可替换；留空保持不变';
      if (cpToggle) cpToggle.textContent = '显示';
    }
  });

  // ── 自定义搜索服务：测试 / 删除 ──
  // （"添加"已整体搬进 openAddSearchProviderModal 弹窗，08-modals.js 自带绑定；
  //   页面上的 <details> 表单 2026-09-21 改成了「⚙ 添加自定义搜索服务」入口按钮。）
  $('#open-add-search-provider-btn')?.addEventListener('click', () => openAddSearchProviderModal());

  $('#test-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#search-provider-action-hint');
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) { if (hint) hint.textContent = '请先选择一个自定义搜索服务'; return; }
    if (hint) hint.textContent = '测试中…';
    try {
      const r = await api('/api/search-providers/test', {
        method: 'POST',
        body: JSON.stringify({ providerId: v })
      });
      const res = r.result || {};
      if (hint) {
        hint.textContent = res.ok
          ? `✓ 可用（${res.count} 条结果，${res.latencyMs}ms）${res.sample ? `：${res.sample.slice(0, 30)}` : ''}`
          : `✗ ${res.note || '不可用'}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `测试失败：${e.message}`;
    }
  });

  $('#del-search-provider-btn')?.addEventListener('click', async () => {
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) return;
    const id = v.slice('custom:'.length);
    const opt = sel.querySelector(`option[value="${v}"]`);
    const name = opt ? opt.textContent : id;
    if (!confirm(`确定删除搜索服务「${name}」？`)) return;
    try {
      await api('/api/search-providers', { method: 'DELETE', body: JSON.stringify({ id }) });
      await loadSettings();
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });

  // ── 聊天设置两个收纳模态框的入口（2026-09-18 改版）──
  $('#open-send-config-btn')?.addEventListener('click', () => openSendConfigModal());
  $('#open-active-config-btn')?.addEventListener('click', () => openActiveConfigModal());

  // ── 屏蔽名单 ──
  $('#blocklist-btn')?.addEventListener('click', () => openBlocklistModal());

  // ── 主题选择器（设置页「界面」区）──
  const themePicker = $('#theme-picker');
  if (themePicker) {
    themePicker.querySelectorAll('[data-theme-opt]').forEach((el) => {
      const pick = () => {
        applyTheme(el.dataset.themeOpt);
        themePicker.querySelectorAll('[data-theme-opt]').forEach((x) => x.classList.toggle('on', x === el));
      };
      el.addEventListener('click', pick);
      // 键盘可达：Enter / Space 等价点击
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    });
  }

  // ── 外观个性化（R40）──
  // 全部"改了立刻看得到"，落盘交给设置页统一的防抖自动保存（saveConfig）。
  bindUiCustomEvents();

  // ── 成本核算：价格卡片随模型/开关变化 ──
  const useOfficialBox = $('#cfg-useofficialprice');
  if (useOfficialBox) useOfficialBox.addEventListener('change', () => {
    // 开关一变，当前模型的可用单价来源就变了，重刷卡片
    refreshModelPriceCard();
  });
  // 直接在模型输入框里改模型时也要刷新 —— 只有从目录里选才会走另一条路径。
  // 用 input 而非 change：边打字边更新，避免"点了别处才变"的迟滞感。
  const modelInput = $('#cfg-model');
  if (modelInput) modelInput.addEventListener('input', () => refreshModelPriceCard());
  refreshModelPriceCard();

  // 批量自定义价格编辑
  $('#batch-price-btn')?.addEventListener('click', () => openBatchPriceModal());

  // ── 前缀缓存保活 ──
  // 开关与间隔都即时保存（后端每次 tick 重读配置，无需重启）。
  $('#cfg-cachewarm')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ cacheWarm: { enabled } }) });
      e.target.checked = enabled;
    } catch (err) {
      // 保存失败要把勾选状态回滚 —— 否则界面显示"已开"而后端仍是关的
      e.target.checked = !enabled;
      alert(`保存失败：${err.message}`);
    }
  });
  $('#cfg-cachewarm-interval')?.addEventListener('change', async (e) => {
    const n = Math.min(1440, Math.max(1, Number(e.target.value) || 10));
    e.target.value = n;
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ cacheWarm: { intervalMin: n } }) });
    } catch (err) {
      alert(`保存失败：${err.message}`);
    }
  });

  // ── 远程价格表：状态展示 + 立即拉取 ──
  renderPriceFeedStatus();
  $('#price-feed-refresh-btn')?.addEventListener('click', async () => {
    const statusEl = $('#price-feed-status');
    if (statusEl) statusEl.textContent = '正在拉取官网价格表…';
    try {
      const r = await api('/api/model-prices/refresh', { method: 'POST', body: '{}' });
      state.modelPrices = { prices: r.prices, current: r.current, remote: r.remote };
      renderPriceFeedStatus();
      refreshModelPriceCard();   // 价格可能变了，当前模型卡片跟着刷
    } catch (e) {
      if (statusEl) statusEl.textContent = `拉取失败：${e.message}`;
    }
  });

  // ── 通用折叠：总开关关闭 → 对应子设置块平滑收起（CSS grid 1fr↔0fr 动画）──
  // 保存不用这里管：上面的表单级 input/change 监听已统一走防抖自动保存，
  // 折叠只是视觉收起，控件仍在 DOM 里，val()/chk() 照常读到值。
  // 表里的顺序 = 模板里出现的顺序，新增折叠块时两边一起加。
  for (const [swSel, subId] of [
    ['#cfg-useofficialprice', 'price-sub'],
    ['#cfg-cachewarm', 'cachewarm-sub'],
    ['#cfg-websearch', 'websearch-sub'],
    ['#cfg-mem-consolidate', 'mem-sub'],
    ['#cfg-proactive', 'proactive-sub'],
    ['#cfg-sticker', 'sticker-sub'],
  ]) {
    const box = $(swSel);
    const sub = document.getElementById(subId);
    if (box && sub) box.addEventListener('change', () => sub.classList.toggle('folded', !box.checked));
  }

  // ── 记忆整理区块事件 ──
  const memUseChat = $('#cfg-mem-usechat');
  if (memUseChat) memUseChat.addEventListener('change', () => {
    // 反向：勾上「用主模型」→ 不需要选专用模型 → 折叠（CSS grid 动画，不再是瞬隐）
    const box = $('#mem-model-box');
    if (box) box.classList.toggle('folded', memUseChat.checked);
  });
  const memModelPick = $('#cfg-mem-model-pick');
  if (memModelPick) memModelPick.addEventListener('click', () => openMemoryModelPicker());

  // ── 模型 API 区块事件 ──
  // 密码框显示/隐藏切换（点击按钮切换对应输入框的 type）
  // 已保存 Key 的输入框初始值统一为掩码 "******"；
  // 点「显示」→ 替换成真实 Key 明文；点「隐藏」→ 重新变回掩码 "******"。
  const pwdToggles = [
    ['cfg-apikey-toggle', 'cfg-apikey'],
    ['cfg-ds-searchkey-toggle', 'cfg-ds-searchkey'],
    ['cfg-zhipu-key-toggle', 'cfg-zhipu-key'],
    ['cfg-bocha-key-toggle', 'cfg-bocha-key'],
    ['cfg-baidu-key-toggle', 'cfg-baidu-key'],
    ['cfg-metaso-key-toggle', 'cfg-metaso-key'],
    ['cfg-custom-sp-key-toggle', 'cfg-custom-sp-key'],
    ['cfg-obtoken-toggle', 'cfg-obtoken'],
    ['cfg-obhttptoken-toggle', 'cfg-obhttptoken']
  ];
  for (const [btnId, inputId] of pwdToggles) {
    const btn = $(`#${btnId}`);
    const input = $(`#${inputId}`);
    if (btn && input) {
      btn.addEventListener('click', async () => {
        const show = input.type === 'password';
        // 所有 Key 统一走 fetchRealKey：/api/config 里的密钥都是脱敏的，
        // 明文只能向后端专用端点取（服务端会校验请求来源）。
        const real = await fetchRealKey(inputId);
        if (show) {
          // 切到明文：显示真实 Key（若之前是掩码/空占位）
          input.type = 'text';
          input.value = real;
          btn.textContent = '隐藏';
        } else {
          // 切回密码态：如果框里是真实 Key（用户没改过），用掩码盖住。
          // ⚠️ 空输入不再被强制回填掩码：曾经 current === '' 也变成 '******'，
          //    用户"清空输入框想清除 Key"的意图被吞掉 —— 保存时空串
          //    会被后端按"不修改"处理，导致已存 Key 永远无法清除。
          //    现在空 = 保持空（保存即清除）；掩码只盖"真实 Key 原样"这一种。
          const current = input.value || '';
          input.type = 'password';
          if (real && current === real) {
            input.value = '******';
          } else if (current === '******') {
            input.value = '******';
          } else {
            // 空串（清空意图）或新输入的 Key：保持原值
          }
          btn.textContent = '显示';
        }
      });
    }
  }

  // 输入框 id -> 搜索服务字段名（/api/config 里的搜索 Key 是脱敏的，
  // 所以“显示”必须向后端专用端点要明文，不能直接读 state.config）
  // 自定义服务是动态的：field 值在切换提供方时才定（custom:<id>），
  // 所以这里是个函数而不是常量表。
  const SEARCH_KEY_FIELDS = {
    'cfg-ds-searchkey': () => 'deepseek',
    'cfg-zhipu-key': () => 'zhipu',
    'cfg-bocha-key': () => 'bocha',
    'cfg-baidu-key': () => 'baidu',
    'cfg-metaso-key': () => 'metaso',
    'cfg-custom-sp-key': () => ($('#cfg-searchprovider')?.value || '').startsWith('custom:')
      ? $('#cfg-searchprovider').value
      : null
  };

  // 搜索服务 Key 的「清除密钥」按钮（与模型 API 页同款语义：
  // 留空保存 = 保持不变，真清除必须点按钮）
  const SEARCH_KEY_CLEAR_BTN = {
    'cfg-ds-searchkey-clear': 'cfg-ds-searchkey',
    'cfg-zhipu-key-clear': 'cfg-zhipu-key',
    'cfg-bocha-key-clear': 'cfg-bocha-key',
    'cfg-baidu-key-clear': 'cfg-baidu-key',
    'cfg-metaso-key-clear': 'cfg-metaso-key',
    'cfg-custom-sp-key-clear': 'cfg-custom-sp-key'
  };
  for (const [btnId, inputId] of Object.entries(SEARCH_KEY_CLEAR_BTN)) {
    const btn = $(`#${btnId}`);
    if (!btn) continue;
    btn.addEventListener('click', async () => {
      const isCustom = inputId === 'cfg-custom-sp-key';
      const field = SEARCH_KEY_FIELDS[inputId]?.();
      if (!field) return;
      const input = $(`#${inputId}`);
      if (!confirm('确定清除该搜索服务已保存的 API Key？')) return;
      try {
        if (isCustom) {
          // 自定义服务的 Key 存在 providers 数组条目里，不能走 webSearch.<field> 路径；
          // 重用 POST /api/search-providers 的"已存在则更新"分支：同一 baseUrl+type
          // 命中 existing，传空 apiKey 清除（后端只在 submitted 非空时覆盖 —— 空 = 清除
          // 需要 existing.apiKey = ''，见下方显式置空）
          const cp = (state.config?.webSearch?.providers || []).find((p) => `custom:${p.id}` === field);
          if (!cp) throw new Error('找不到这个自定义搜索服务');
          await api('/api/search-providers', {
            method: 'POST',
            body: JSON.stringify({
              name: cp.name, type: cp.type, baseUrl: cp.baseUrl,
              model: cp.model, apiKey: '', count: cp.count, timeoutMs: cp.timeoutMs
            })
          });
        } else {
          // 内置五家：空串走正常保存链就能清除（sanitize 删掉了掩码、空串覆盖旧值）
          await api('/api/config', { method: 'POST', body: JSON.stringify({ webSearch: { [field]: { apiKey: '' } } }) });
        }
        if (input) { input.value = ''; input.placeholder = '输入新 Key 可替换'; }
        const hint = $('#search-provider-action-hint');
        if (hint) hint.textContent = 'API Key 已清除';
        await loadSettings();
      } catch (e) {
        alert(`清除失败：${e.message}`);
      }
    });
  }

  // 前端点“显示”时向后端要真实 Key。
  // 说明：三个端点都只放行本机控制台请求（服务端校验来源），本地单机使用不受影响。
  async function fetchRealKey(inputId) {
    if (inputId === 'cfg-apikey') {
      const pid = state.config?.api?.provider;
      if (pid) {
        const r = await api(`/api/providers/key?providerId=${encodeURIComponent(pid)}`);
        return String(r.apiKey || '');
      }
      const r = await api('/api/api-key');
      return String(r.apiKey || '');
    }
    const field = SEARCH_KEY_FIELDS[inputId]?.();
    if (field) {
      const r = await api(`/api/search-key?field=${encodeURIComponent(field)}`);
      // 环境变量提供的 Key：配置里没存（apiKey 空）但 env 有 —— 显示时
      // 直接把 env 值亮出来（web-search.js 的运行时优先级就是 cfg > env，
      // 用户"看一眼"的语义应该覆盖两种来源）。
      return String(r.apiKey || '');
    }
    // OneBot 令牌：与搜索 Key 同样的"显示明文"专用端点
    if (inputId === 'cfg-obtoken' || inputId === 'cfg-obhttptoken') {
      const which = inputId === 'cfg-obtoken' ? 'ws' : 'http';
      const r = await api(`/api/onebot-token?which=${encodeURIComponent(which)}`);
      return String(r.token || '');
    }
    return '';
  }
  // 备选模型行：模型 ID + 可选提供商（留空 = 沿用主模型的提供商）
  let fallbackRows = (Array.isArray(c.api?.fallbackModels) ? c.api.fallbackModels : []).map((f) => ({ model: f.model || '', provider: f.provider || '' }));
  if (fallbackRows.length === 0) fallbackRows = [{ model: '', provider: '' }];
  // 备选模型点选：readonly 输入框 → 弹模型目录选择器，选完写回行数据并触发表单保存。
  // 与手输并行不存在了（readonly），杜绝"打错模型 id 等运行时才报错"。
  function openFallbackModelPicker(rowIdx) {
    const providers = state.providers || [];
    if (!providers.length) { alert('模型目录为空：请先在本页上方添加提供商。'); return; }
    const currentModel = fallbackRows[rowIdx]?.model || '';
    const overlay = modelModalShell({
      head: `选择备选模型（第 ${rowIdx + 1} 行）`,
      body: `
        <div class="model-modal-left" id="mm-left"></div>
        <div class="model-modal-right" id="mm-right"></div>`,
      foot: `<button class="btn" id="mm-cancel">取消</button>`
    });
    const left = overlay.querySelector('#mm-left');
    const right = overlay.querySelector('#mm-right');
    let activePid = providers[0].id;
    function renderLeft() {
      left.innerHTML = providers.map((p) =>
        `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
      left.querySelectorAll('.mm-prov').forEach((el) => {
        el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
      });
    }
    function renderRight() {
      const p = providers.find((x) => x.id === activePid);
      if (!p) { right.innerHTML = ''; return; }
      const names = p.modelNames || {};
      right.innerHTML = p.models.map((m) => `
        <div class="mm-model" data-model="${esc(m)}">
          <span class="mm-check">${m === currentModel ? '✓' : ''}</span>
          <span>${esc(names[m] || m)}</span>
          <span class="muted" style="font-size:11px">${esc(m)}</span>
        </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
      right.querySelectorAll('.mm-model').forEach((el) => {
        el.addEventListener('click', () => {
          fallbackRows[rowIdx].model = el.dataset.model;
          // 提供商下拉同步指向所选提供商（备选可跨提供商，这里帮用户带上）
          fallbackRows[rowIdx].provider = activePid;
          closeModelModal(overlay);
          renderFallbackRows();
          // 通知自动保存：fallbackModels 从 DOM 实时读，触发表单监听即可
          $('#fallback-model-rows')?.dispatchEvent(new Event('input', { bubbles: true }));
        });
      });
    }
    renderLeft();
    renderRight();
    overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
  }
  function renderFallbackRows() {
    const box = $('#fallback-model-rows');
    if (!box) return;
    // 提供商列已删（2026-09-18 用户需求）：选模型时自动带上所属提供商（跨渠道
    // 备选仍有效），手动再选一遍纯属多余。行内只留 模型点选 + 删除。
    const provNameOf = (pid) => {
      const p = (state.providers || []).find((x) => x.id === pid);
      return p ? (p.displayName || p.id) : '';
    };
    box.innerHTML = `
      <table class="model-rows-table">
        <tr><th style="width:88%">备选模型（点击选择；提供商随模型自动确定）</th><th></th></tr>
        ${fallbackRows.map((row, i) => `
          <tr>
            <td><input type="text" class="fb-model-pick" data-i="${i}" readonly placeholder="点击选择模型" data-model="${esc(row.model || '')}" data-provider="${esc(row.provider || '')}" value="${esc(row.model ? (provNameOf(row.provider) ? `${provNameOf(row.provider)} · ${row.model}` : row.model) : '')}" style="cursor:pointer" /></td>
            <td style="width:56px;text-align:right"><button class="btn btn-small btn-danger fb-del" data-i="${i}" ${fallbackRows.length <= 1 ? 'disabled' : ''}>删除</button></td>
          </tr>`).join('')}
      </table>`;
    box.querySelectorAll('.fb-model-pick').forEach((el) => {
      el.addEventListener('click', () => { openFallbackModelPicker(Number(el.dataset.i)); });
    });
    box.querySelectorAll('.fb-del').forEach((el) => {
      el.addEventListener('click', () => {
        if (fallbackRows.length <= 1) return;
        fallbackRows.splice(Number(el.dataset.i), 1);
        renderFallbackRows();
      });
    });
  }
  renderFallbackRows();
  const addFallbackRowBtn = $('#add-fallback-row-btn');
  if (addFallbackRowBtn) addFallbackRowBtn.addEventListener('click', () => {
    fallbackRows.push({ model: '', provider: '' });
    renderFallbackRows();
  });

  // ── 「模型配置」「模型管理」两个入口模态框（2026-09-18 改版）──
  // 原页面上的 模型目录/baseURL/Key/专用模型/图片视频开关/视频理解方式
  // 全部收进「模型配置」（mc-* 字段，弹窗内部自带绑定）；删除模型/手动添加
  // 提供商收进「模型管理」。Key 的显示/清除都已搬进「模型配置」弹窗
  // （mc-apikey-toggle / mc-apikey-clear，弹窗内自带绑定），旧绑定全部删除。
  $('#open-model-config-btn')?.addEventListener('click', () => openModelConfigModal());
  $('#open-model-manage-btn')?.addEventListener('click', () => openModelManageModal());
  // 拿当前 API Key 的真实值：如果输入框里是用户刚输入的新 Key（非掩码非空），优先用；否则向后端取
  // 2026-09-19（M9 清理）：唯一调用点已随「模型配置」弹窗改版删除（弹窗内自带取 Key
  // 逻辑），此函数成为死代码且引用不存在的 #cfg-apikey —— 一并删除。

  // 连通性测试：抽成公共逻辑，两个入口共用
  // （健康卡片的 test-api-btn 与「模型配置」弹窗里的测试按钮做的是同一件事）
  async function runConnectivityTest(btn, out, idleLabel) {
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '测试中…';
    if (out) out.textContent = '';
    try {
      // 2026-09-18 模型配置改版后，设置页上只剩隐藏字段（cfg-baseurl-value），
      // 旧的 #cfg-baseurl / #cfg-apikey 输入框已搬进弹窗（mc-*）。这里按
      // 「界面实时值优先、隐藏字段兜底、最后用已保存配置」的顺序取值 ——
      // 否则健康卡片上的「测试一下」永远拿空 baseUrl，必报"请先填写 Base URL"。
      const baseUrl = ($('#mc-baseurl')?.value || $('#cfg-baseurl-value')?.value || state.config?.api?.baseUrl || '').trim();
      const model = ($('#mc-model-pick')?.dataset?.model || $('#cfg-model')?.value || state.config?.api?.model || '').trim();
      // 只把"用户新输入的明文 Key"传给服务端；若是掩码/空则不传，
      // 让服务端用自己保存的 Key —— 不依赖明文读取端点，未设 token 时也能测试。
      const raw = ($('#mc-apikey')?.value || '').trim();
      const apiKey = (raw && raw !== '******') ? raw : '';
      const r = await api('/api/providers/test-chat', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey, model })
      });
      const res = r.result || {};
      // 思考方言由服务端 model.thinking-detect 能力给出，让用户提前知道这个模型
      // 会走哪套思考参数（避免"开了思考但实际没生效"的黑箱感）。
      const dialect = res.thinking?.label ? ` · 思考参数：${res.thinking.label}` : '';
      if (out) out.textContent = res.ok
        ? `✓ 测试通过（${res.latencyMs}ms）：${res.note || '请求成功'}${dialect}`
        : `✗ 测试失败：${res.note || '未知错误'}`;
    } catch (e) {
      if (out) out.textContent = `测试失败：${e.message}`;
    }
    btn.disabled = false;
    btn.textContent = idleLabel;
  }

  // 健康卡片上的「测试一下」：此前 renderHealthCard 渲染后从未绑定事件
  // （旧代码绑的是不存在的 test-provider-btn），按钮点了完全没反应。
  const testApiBtn = $('#test-api-btn');
  if (testApiBtn) testApiBtn.addEventListener('click', () => runConnectivityTest(testApiBtn, $('#test-api-result'), '测试一下'));

  // 健康卡片上的「去设置」按钮：点击跳转到对应设置区块并高亮
  $$('.hc-fix-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      if (target === 'snowluma') {
        switchTab('snowluma');
        // 高亮一键启动按钮
        setTimeout(() => {
          const quickBtn = $('#quick-start-btn');
          if (quickBtn) {
            quickBtn.style.boxShadow = '0 0 0 3px var(--accent)';
            setTimeout(() => { quickBtn.style.boxShadow = ''; }, 2000);
          }
        }, 300);
      } else if (target === 'settings-api') {
        // 切换到 API 设置区块
        state.settingsSection = 'api';
        renderSettingsSidebar();
        renderSettings();
        // 高亮模型配置入口按钮（2026-09-18 改版后 Base URL 不再是页面输入框，
        // 引导用户进「模型配置」弹窗；旧 #cfg-baseurl 已不存在）
        setTimeout(() => {
          const input = $('#open-model-config-btn');
          if (input) {
            input.focus();
            input.style.boxShadow = '0 0 0 3px var(--accent)';
            setTimeout(() => { input.style.boxShadow = ''; }, 2000);
          }
        }, 100);
      } else if (target === 'settings-allow') {
        // 切换到白名单设置区块
        state.settingsSection = 'allow';
        renderSettingsSidebar();
        renderSettings();
        // 高亮白名单区域
        setTimeout(() => {
          const section = $('#settings-form');
          if (section) {
            section.style.boxShadow = '0 0 0 3px var(--accent)';
            setTimeout(() => { section.style.boxShadow = ''; }, 2000);
          }
        }, 100);
      }
    });
  });




  // 图片输入能力提示（视觉扫描结果）：图片输入开关本体已移入「模型配置」模态框，
  // 这里只更新区块头部的 #model-vision-hint。
  function syncVisionSwitch(pid, model) {
    const vhint = $('#model-vision-hint');
    if (!vhint) return;
    const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
    if (r && (r.verdict === 'vision' || r.verdict === 'no-vision')) {
      vhint.textContent = r.verdict === 'vision' ? '✅ 当前模型支持图片输入' : '🚫 当前模型不支持图片输入';
    } else {
      vhint.textContent = '';
    }
  }
  syncVisionSwitch(c.api.provider, c.api.model);

  // 「扫描视觉能力」按钮已按需求删除（2026-09-17）。
  // 视觉能力数据仍由内置视觉表 + 模型目录徽标提供；后端 /api/vision/scan
  // 端点保留（无 UI 入口），SSE vision-scan 事件监听保留兜底。

  // 模型目录“支持图片输入/不支持图片输入”徽标开关
  function applyShowVision() {
    const show = state.config?.ui?.showVision !== false;
    $$('.vbadge').forEach((el) => { el.style.display = show ? '' : 'none'; });
  }
  applyShowVision();

  // ── 人设区块事件 ──
  const personaPick = $('#cfg-persona-pick');
  function currentPersonaId() {
    const roleText = $('#cfg-roletext')?.value ?? '';
    const found = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === roleText);
    return found ? found[0] : '';
  }
  function syncPersonaButtons() {
    const id = currentPersonaId();
    const tpl = state.personaTemplates[id];
    const isCustom = id.startsWith('custom_');
    const delBtn = $('#del-persona-btn');
    if (delBtn) delBtn.classList.toggle('hidden', !isCustom);
    const hint = $('#persona-pick-hint');
    if (hint) hint.textContent = tpl ? (tpl.builtin ? '内置人设' : '自定义人设') : '';
  }
  if (personaPick) {
    personaPick.addEventListener('click', () => openPersonaPicker());
  }
  const newPersonaBtn = $('#new-persona-btn');
  if (newPersonaBtn) newPersonaBtn.addEventListener('click', () => openPersonaCreateModal());
  const delPersonaBtn = $('#del-persona-btn');
  if (delPersonaBtn) delPersonaBtn.addEventListener('click', async () => {
    const id = currentPersonaId();
    if (!id.startsWith('custom_')) return;
    const tpl = state.personaTemplates[id];
    if (!tpl) return;
    if (!confirm(`确定删除自定义人设「${tpl.name}」？`)) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
      $('#cfg-roletext').value = state.personaTemplates.xiaojingyu?.text || '';
      $('#cfg-customrules').value = '';
      // 删除 = 表单值被程序化改回默认人设：同样派发 input 触发自动保存，
      // 否则"删完切走"后配置里还是被删掉的那套角色设定（保存从未发起）。
      $('#cfg-roletext')?.dispatchEvent(new Event('input', { bubbles: true }));
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `删除失败：${e.message}`;
    }
  });
  
  syncPersonaButtons();

  // ── 白名单区块事件 ──
  const pickGroupsBtn = $('#pick-groups-btn');
  if (pickGroupsBtn) pickGroupsBtn.addEventListener('click', () => openWhitelistPicker('groups'));
  const pickFriendsBtn = $('#pick-friends-btn');
  if (pickFriendsBtn) pickFriendsBtn.addEventListener('click', () => openWhitelistPicker('friends'));

  // ── 按会话独立人设 ──
  // 唯一真相是隐藏 input 里的 JSON（与分群档位滑条同一套做法）：
  // ── 人设页：统一/分会话切换 + 分会话按钮网格 ──
  // 统一开关：切显隐（不触发保存——display 切换不是配置变化，真正的值在 checkbox 上）。
  const personaUnifiedChk = $('#cfg-persona-unified');
  if (personaUnifiedChk) personaUnifiedChk.addEventListener('change', () => {
    const ub = $('#persona-unified-box');
    const pb = $('#persona-perchat-box');
    if (ub) ub.style.display = personaUnifiedChk.checked ? '' : 'none';
    if (pb) pb.style.display = personaUnifiedChk.checked ? 'none' : '';
  });
  // 分会话按钮：点开独立人设模态框（写回隐藏 JSON → 自动保存）
  // root 判空：DOM 测试环境里 #persona-perchat-box 可能不在场（统一模式渲染时它存在，
  // 但旧测试快照可能没这个节点——$$ 对 null root 直接抛错）
  const perChatBox = $('#persona-perchat-box');
  if (perChatBox) $$('.persona-chat-btn', perChatBox).forEach((btn) => {
    btn.addEventListener('click', () => openPerChatPersonaModal(btn.dataset.chat));
  });
  // 人设编辑入口：两个模式各一个按钮（统一模式=「编辑人设」，分群模式=「全局人设设置」），
  // 打开的是同一个弹窗 —— 所以用一个函数绑两次，别让哪个模式漏掉入口。
  $('#open-global-persona-btn')?.addEventListener('click', () => openGlobalPersonaModal());
  $('#open-persona-editor-btn')?.addEventListener('click', () => openGlobalPersonaModal());
  // 群名异步补显：按钮文字先显示"群 号"，拉到群名后替换
  api('/api/onebot/groups').then((d) => {
    const names = new Map((d.groups || []).map((g) => [String(g.id), g.name]));
    if (perChatBox) $$('.persona-chat-btn', perChatBox).forEach((btn) => {
      const m = /^group:(\d+)$/.exec(String(btn.dataset.chat || ''));
      if (!m) return;
      const n = names.get(m[1]);
      if (!n) return;
      const hasDot = btn.textContent.includes('●');
      btn.textContent = hasDot ? `${n} ●` : n;
    });
  }).catch(() => {});

  // ── 检查更新（桌面端区块） ──
  const curVerEl = $('#update-current');
  if (curVerEl) {
    api('/api/version').then((d) => { curVerEl.textContent = `v${d.version || '?'}`; })
      .catch(() => { curVerEl.textContent = ''; });
  }
  const checkUpdateBtn = $('#check-update-btn');
  if (checkUpdateBtn) checkUpdateBtn.addEventListener('click', async () => {
    const hint = $('#update-hint');
    checkUpdateBtn.disabled = true;
    if (hint) hint.textContent = '检查中…';
    const data = await runUpdateCheck({ manual: true });   // 手动：即使关过浮窗也再弹一次
    if (!data) {
      if (hint) hint.textContent = '检查失败：网络不可达';
    } else if (!data.ok) {
      if (hint) hint.textContent = `检查失败：${data.error || '未知错误'}`;
    } else if (data.hasUpdate) {
      // 有新版：给下载链接。Electron 里 target=_blank 会被 main.js 转给系统浏览器。
      if (hint) hint.innerHTML = `发现新版本 <b>v${esc(data.latest)}</b>（当前 v${esc(data.current)}） <a href="${esc(data.url)}" target="_blank" rel="noopener">去下载</a>`;
    } else if (hint) hint.textContent = `已是最新（v${data.current}）`;
    checkUpdateBtn.disabled = false;
  });

  // ── OneBot 区块事件 ──
  const openSnowlumaBtn = $('#open-snowluma-btn');
  if (openSnowlumaBtn) openSnowlumaBtn.addEventListener('click', async () => {
    await saveConfig({ quiet: true });
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { $('#snowluma-hint').textContent = `失败：${e.message}`; }
  });

  // ── 预览演示模式开关（「界面与应用」页 · 界面区块）──
  // 它不是配置项（不写进 config）：只切换 URL 的 #preview 哈希然后重载整个界面，
  // 00-preview.js 在启动时读这个哈希决定是否拦截 fetch 提供模拟数据。
  // stopPropagation：别让这次 change 冒泡到 #settings-form 触发与它无关的自动保存。
  const previewSw = $('#cfg-previewmode');
  if (previewSw) previewSw.addEventListener('change', (e) => {
    e.stopPropagation();
    if (previewSw.checked) location.hash = 'preview';
    else history.replaceState(null, '', location.pathname + location.search);
    location.reload();
  });

  // ── 数据管理区块事件 ──
  const openDataDirBtn = $('#open-datadir-btn');
  if (openDataDirBtn) openDataDirBtn.addEventListener('click', async () => {
    try {
      await api('/api/open-data-dir', { method: 'POST', body: '{}' });
    } catch (e) {
      console.error('打开数据目录失败:', e);
    }
  });

  const resetDataBtn = $('#reset-data-btn');
  if (resetDataBtn) resetDataBtn.addEventListener('click', async () => {
    const hint = $('#reset-data-hint');
    if (!confirm('⚠️ 确定要重置为初始形态吗？\n\n此操作会删除所有用户数据：\n- 配置（API Key、模型、白名单）\n- 聊天记录\n- 长期记忆\n- 表情包库\n\n不可恢复！建议先备份 data/ 目录。')) return;
    if (!confirm('再次确认：真的要删除所有用户数据吗？')) return;
    resetDataBtn.disabled = true;
    if (hint) hint.textContent = '重置中…';
    try {
      const r = await api('/api/reset-data', { method: 'POST', body: '{}' });
      if (r.ok) {
        if (hint) hint.textContent = '✅ 已重置，请重启应用';
        setTimeout(() => {
          alert('已重置为初始形态！\n\n请关闭应用并重新启动。');
        }, 500);
      } else {
        if (hint) hint.textContent = `重置失败：${r.error}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `重置失败：${e.message}`;
    }
    resetDataBtn.disabled = false;
  });
}
