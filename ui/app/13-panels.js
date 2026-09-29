// 〔数据看板〕—— 通用面板渲染器（panel.* 能力通道的配套前端）
//
// 后端契约（docs/panels-interface.md）：
//   GET /api/panels                     → { panels: [{key,name,source,kind,loaded,enabled,active,available,usable,reason}] }
//   GET /api/panels/:key?args=<json>    → { ok, data: { title, summary:[{label,value}], sections:[{type,...}] } }
//
// section.type 支持：
//   note   { title, text }                        说明/空态/告警
//   table  { title, columns[], rows[][] }         表格
//   bars   { title, data:[{label,value,color}] }  横向条形图
//   donut  { title, data:[{label,value,color}] }  环形图（SVG，无三方库）
//   kv     { title?, rows:[[label,value]] }       键值网格
//
// 新面板接入：任何技能/插件实现 `panel.<key>` 能力并返回上述结构即可，
// 本页无需改动 —— 「看板」页签自动出现新入口。
'use strict';

const PANEL_VIEW_STATE = {
  list: [],
  activeKey: null,
  q: '',
  loading: false,
};

function panelsPageHTML() {
  return `
    <div class="panels-wrap">
      <aside class="panels-rail">
        <div class="panels-rail-head">
          <span class="prh-title">数据面板</span>
          <button class="prh-refresh" id="panels-refresh-list" title="刷新面板列表">⟳</button>
        </div>
        <div id="panels-rail-list" class="panels-rail-list"></div>
      </aside>
      <div class="panels-main">
        <div id="panels-main-box"></div>
      </div>
    </div>`;
}

/** 页签入口：拉面板列表 + 渲染布局 + 自动打开第一个可用面板。 */
async function loadPanelsView({ quiet = false } = {}) {
  const box = $('#panels-page');
  if (!box) return;
  const html = panelsPageHTML();
  if (box.dataset.built !== '1') {
    box.innerHTML = html;
    box.dataset.built = '1';
    $('#panels-refresh-list').addEventListener('click', () => loadPanelsView({ quiet: true }));
  }
  let data;
  try {
    data = await api('/api/panels', { timeoutMs: 10000 });
  } catch (e) {
    $('#panels-rail-list').innerHTML = `<div class="panels-empty">面板列表加载失败：${esc(e?.message || e)}</div>`;
    return;
  }
  PANEL_VIEW_STATE.list = data.panels || [];
  renderPanelsRail();
  // 自动选中：上一个选中的可用面板 > 列表里第一个可用 > 第一个（显示其不可用原因）
  if (!PANEL_VIEW_STATE.activeKey || !PANEL_VIEW_STATE.list.some((p) => p.key === PANEL_VIEW_STATE.activeKey)) {
    const usable = PANEL_VIEW_STATE.list.filter((p) => p.usable);
    PANEL_VIEW_STATE.activeKey = (usable[0] || PANEL_VIEW_STATE.list[0] || {}).key || null;
  }
  if (PANEL_VIEW_STATE.activeKey) loadPanelState(PANEL_VIEW_STATE.activeKey, { quiet: true });
  else renderPanelError(null, '没有可用的数据面板。请到「技能 / 插件」页启用提供了 panel.* 能力的模块。');
}

function renderPanelsRail() {
  const list = $('#panels-rail-list');
  if (!list) return;
  const panels = PANEL_VIEW_STATE.list;
  if (!panels.length) {
    list.innerHTML = `<div class="panels-empty">暂无面板（技能/插件都未提供 panel.* 能力）</div>`;
    return;
  }
  list.innerHTML = panels.map((p) => {
    const on = p.key === PANEL_VIEW_STATE.activeKey;
    const badge = p.usable
      ? '<span class="pi-badge pi-on" title="可用">●</span>'
      : `<span class="pi-badge pi-off" title="${esc(p.reason || '不可用')}">✕</span>`;
    return `
      <button class="panels-item${on ? ' on' : ''}${p.usable ? '' : ' off'}" data-panel-key="${esc(p.key)}">
        <span class="pi-name">${badge}${esc(p.name || p.key)}</span>
        <span class="pi-meta">${esc(p.source)}${p.kind ? ' · ' + esc(p.kind) : ''}</span>
      </button>`;
  }).join('');
  list.querySelectorAll('.panels-item').forEach((el) => {
    el.addEventListener('click', () => {
      const k = el.dataset.panelKey;
      if (!k || k === PANEL_VIEW_STATE.activeKey) return;
      PANEL_VIEW_STATE.activeKey = k;
      PANEL_VIEW_STATE.q = '';
      renderPanelsRail();
      loadPanelState(k);
    });
  });
}

function renderPanelError(key, message) {
  const box = $('#panels-main-box');
  if (!box) return;
  box.innerHTML = `<div class="panels-error">${esc(message || '加载失败')}</div>`;
}

/** 拉具体面板数据并渲染（搜索参数随 args 一起传）。 */
async function loadPanelState(key, { quiet = false } = {}) {
  const box = $('#panels-main-box');
  if (!box) return;
  if (PANEL_VIEW_STATE.loading) return;
  PANEL_VIEW_STATE.loading = true;
  if (!quiet) box.innerHTML = `<div class="panels-loading">加载面板…</div>`;
  const args = PANEL_VIEW_STATE.q ? { q: PANEL_VIEW_STATE.q } : {};
  try {
    const path = `/api/panels/${encodeURIComponent(key)}` + (Object.keys(args).length ? `?args=${encodeURIComponent(JSON.stringify(args))}` : '');
    const resp = await api(path, { timeoutMs: 10000 });
    renderPanelContent(resp.data, key);
  } catch (e) {
    renderPanelError(key, `面板「${key}」加载失败：${e?.message || e}`);
  } finally {
    PANEL_VIEW_STATE.loading = false;
  }
}

function renderPanelContent(data, key) {
  const box = $('#panels-main-box');
  if (!box) return;
  if (!data || typeof data !== 'object') {
    box.innerHTML = `<div class="panels-error">面板「${key}」返回了空数据</div>`;
    return;
  }
  const title = data.title || key;
  const q = PANEL_VIEW_STATE.q;
  box.innerHTML = `
    <div class="panels-header">
      <h2 class="panels-title">${esc(title)}</h2>
      <div class="panels-actions">
        <input id="panels-q" type="search" placeholder="搜索（昵称 / QQ 号）…" value="${esc(q)}" autocomplete="off" />
        <button id="panels-refresh" class="btn btn-small" title="重新拉取面板数据">刷新</button>
      </div>
    </div>
    <div class="panels-summary">${(data.summary || []).map((s) =>
      `<span class="panels-chip"><em>${esc(String(s.label ?? ''))}</em><b>${esc(String(s.value ?? ''))}</b></span>`).join('')}</div>
    <div class="panels-sections">${(data.sections || []).map((sec) => renderPanelSection(sec)).join('')}</div>
    ${renderPanelActions(data.actions)}`;
  const qEl = $('#panels-q');
  if (qEl) {
    let t = null;
    qEl.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        PANEL_VIEW_STATE.q = qEl.value.trim();
        loadPanelState(PANEL_VIEW_STATE.activeKey, { quiet: true });
      }, 350);
    });
    qEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        clearTimeout(t);
        PANEL_VIEW_STATE.q = qEl.value.trim();
        loadPanelState(PANEL_VIEW_STATE.activeKey, { quiet: true });
      }
    });
  }
  $('#panels-refresh')?.addEventListener('click', () => loadPanelState(PANEL_VIEW_STATE.activeKey, { quiet: true }));
  bindPanelActions();
}

// ── actions（写通道）────────────────────────────────────────────────
// panel.affinity 等面板会带 actions: [{ type:'input', label, capability, args, fields, submit, confirm? }]
// 提交走 POST /api/action（capability 必须 action.* 前缀 = 核心放行的写白名单）。
function renderPanelActions(actions) {
  if (!Array.isArray(actions) || !actions.length) return '';
  return `
    <div class="panels-actions-box">
      <div class="pab-title">操作</div>
      <div class="pab-cards">${actions.map((a, i) => renderActionCard(a, i)).join('')}</div>
    </div>`;
}

function renderActionCard(a, i) {
  const fields = Array.isArray(a.fields) ? a.fields : [];
  return `
    <div class="pab-card" data-action-i="${i}">
      <div class="pab-label">${esc(a.label || '操作')}</div>
      <div class="pab-fields">
        ${fields.map((f) => `
          <label class="pab-field">
            ${f.name ? `<span class="pab-fname">${esc(f.name)}</span>` : ''}
            <input type="text" name="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}"
                   value="${esc(f.value ?? '')}" autocomplete="off" />
          </label>`).join('')}
      </div>
      <button class="pab-submit" data-capability="${esc(a.capability || '')}"
              data-args='${esc(JSON.stringify(a.args || {}))}'
              data-confirm="${esc(a.confirm || '')}">${esc(a.submit || '执行')}</button>
      <div class="pab-result" hidden></div>
    </div>`;
}

function bindPanelActions() {
  document.querySelectorAll('.pab-submit').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const card = btn.closest('.pab-card');
      const resultEl = card?.querySelector('.pab-result');
      const show = (cls, text) => {
        if (!resultEl) return;
        resultEl.hidden = false;
        resultEl.className = 'pab-result ' + cls;
        resultEl.textContent = text;
      };
      try {
        if (btn.dataset.confirm && !window.confirm(btn.dataset.confirm)) { show('pab-err', '已取消'); return; }
        const baseArgs = JSON.parse(btn.dataset.args || '{}');
        const inputs = card ? [...card.querySelectorAll('.pab-field input')] : [];
        for (const inp of inputs) {
          if (inp.value === '') continue;
          if (inp.name === 'delta') baseArgs[inp.name] = Number(inp.value);
          else if (inp.name === 'confirm') baseArgs[inp.name] = inp.value === 'true';
          else baseArgs[inp.name] = inp.value;
        }
        const resp = await api('/api/action', {
          method: 'POST',
          body: JSON.stringify({ capability: btn.dataset.capability, args: baseArgs }),
          timeoutMs: 10000,
        });
        const r = resp?.result || {};
        const detail = r.error || (r.ok === false ? (r.reason || '执行失败') : JSON.stringify(r).slice(0, 220));
        show(r.error || r.ok === false ? 'pab-err' : 'pab-ok', detail);
        if (!r.error && r.ok !== false) loadPanelState(PANEL_VIEW_STATE.activeKey, { quiet: true });
      } catch (e) {
        show('pab-err', '操作失败：' + (e?.message || e));
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// ── section 渲染器 ─────────────────────────────────────────────────
function renderPanelSection(sec) {
  if (!sec || typeof sec !== 'object') return '';
  switch (sec.type) {
    case 'table': return panelTableHTML(sec);
    case 'bars': return panelBarsHTML(sec);
    case 'donut': return panelDonutHTML(sec);
    case 'kv': return panelKvHTML(sec);
    case 'note': return panelNoteHTML(sec);
    default:
      return `<div class="panel-note"><div class="pn-title">${esc(sec.title || sec.type || '')}</div>
        <div class="pn-text">未知 section 类型：${esc(String(sec.type || '(无)'))}</div></div>`;
  }
}

function panelNoteHTML(sec) {
  return `
    <div class="panel-note">
      ${sec.title ? `<div class="pn-title">${esc(sec.title)}</div>` : ''}
      <div class="pn-text">${esc(sec.text ?? '')}</div>
    </div>`;
}

function panelTableHTML(sec) {
  const cols = sec.columns || [];
  const rows = sec.rows || [];
  if (!rows.length) return `<div class="panel-note"><div class="pn-title">${esc(sec.title || '表格')}</div><div class="pn-text">（空）</div></div>`;
  return `
    <div class="panel-table">
      <div class="pt-title">${esc(sec.title || '')}</div>
      <table>
        <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map((r) => `<tr>${(Array.isArray(r) ? r : [r]).map((cell, i) =>
            `<td${i + 1 === (Array.isArray(r) ? r.length : 1) && cols.length > 4 ? ' class="td-main"' : ''}>${esc(cell == null ? '' : String(cell))}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function panelBarsHTML(sec) {
  const data = sec.data || [];
  const max = Math.max(1, ...data.map((d) => Number(d.value) || 0));
  return `
    <div class="panel-bars">
      <div class="pb-title">${esc(sec.title || '')}</div>
      ${data.map((d) => {
        const v = Number(d.value) || 0;
        const pct = Math.round((v / max) * 100 * 10) / 10;
        return `
          <div class="pb-row">
            <span class="pb-label" title="${esc(d.label)}">${esc(d.label)}</span>
            <span class="pb-track"><span class="pb-fill" style="width:${Math.max(1.5, pct)}%;background:${esc(d.color || 'var(--accent)')}"></span></span>
            <span class="pb-value">${v}</span>
          </div>`;
      }).join('')}
    </div>`;
}

function panelDonutHTML(sec) {
  const data = (sec.data || []).filter((d) => Number(d.value) > 0);
  const total = data.reduce((a, d) => a + Number(d.value) || 0, 0);
  if (!total) return `<div class="panel-note"><div class="pn-title">${esc(sec.title || '环形图')}</div><div class="pn-text">（无数据）</div></div>`;
  const size = 168;
  const thickness = 22;
  const r = (size - thickness) / 2 - 4;
  const C = 2 * Math.PI * r;
  let acc = 0;
  const circles = data.map((d) => {
    const frac = (Number(d.value) || 0) / total;
    const dash = Math.max(0.5, frac * C - 2.5);
    const off = -(acc / total) * C;
    acc += Number(d.value) || 0;
    return `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
      stroke="${esc(d.color || '#8a91a1')}" stroke-width="${thickness}"
      stroke-dasharray="${dash} ${C - dash}" stroke-dashoffset="${off}"
      transform="rotate(-90 ${size / 2} ${size / 2})" />`;
  }).join('');
  return `
    <div class="panel-donut">
      <div class="pd-title">${esc(sec.title || '')}</div>
      <div class="pd-body">
        <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(sec.title || '')}">
          ${circles}
          <text x="50%" y="47%" text-anchor="middle" class="pd-total">${total}</text>
          <text x="50%" y="58%" text-anchor="middle" class="pd-total-label">总计</text>
        </svg>
        <div class="pd-legend">
          ${data.map((d) => `
            <div class="pd-legend-row">
              <span class="pd-swatch" style="background:${esc(d.color || '#8a91a1')}"></span>
              <span class="pd-lname">${esc(d.label)}</span>
              <span class="pd-lval">${Number(d.value) || 0}（${Math.round(((Number(d.value) || 0) / total) * 100)}%）</span>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
}

function panelKvHTML(sec) {
  const rows = sec.rows || [];
  return `
    <div class="panel-kv">
      ${sec.title ? `<div class="pk-title">${esc(sec.title)}</div>` : ''}
      <div class="pk-grid">
        ${rows.map(([k, v]) => `<span class="pk-cell"><em>${esc(k)}</em><b>${esc(String(v))}</b></span>`).join('')}
      </div>
    </div>`;
}