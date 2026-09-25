// 〔存档 / 用量〕——M9 拆分第 5 段
'use strict';
// ── 存档视图 ──
async function loadChats({ quiet = false } = {}) {
  try {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    renderChatList();
    if (state.currentChatKey) {
      // 打开着某群详情时也刷新该群消息。
      // keepView=true：只更新内容，不动分页与滚动位置 ——
      // 否则用户滚出来的内容会被每 15 秒的轮询刷回去。
      loadChatMessages(state.currentChatKey, { keepView: true });
    }
  } catch (e) { if (!quiet) console.error(e); }
}

function renderChatList() {
  const box = $('#chat-items');
  state.seenChatKeys = state.seenChatKeys || new Set();
  box.innerHTML = state.chats.map((c) => {
    const name = formatChatTitle(c.key, chatNameOf(c.key));
    const isNew = !state.seenChatKeys.has(c.key);
    return `
      <div class="chat-item ${c.key === state.currentChatKey ? 'selected' : ''} ${c.unread ? 'unread-row' : ''} ${isNew ? 'new-item' : ''}" data-key="${c.key}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(name)}</span>
          ${c.unread ? `<span class="unread-pill">${c.unread}</span>` : ''}
        </div>
        <div class="chat-item-sub">${esc(c.lastText || '（空）')}</div>
        <div class="session-meta"><span>${c.total} 条</span><span>${fmtTime(c.lastTs)}</span></div>
      </div>`;
  }).join('') || '<div class="list-head muted">还没有消息存档（等白名单里的群/好友来消息）</div>';
  for (const c of state.chats) state.seenChatKeys.add(c.key);
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => selectChat(el.dataset.key));
  });
}

async function selectChat(key) {
  state.currentChatKey = key;
  if (state.quoteMode) state.quoteSelected = new Set();   // 金句按单段对话收录，换会话清空勾选
  renderChatList();
  $('#chat-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadChatMessages(key);
}

/**
 * 拉取并渲染某会话的存档消息。
 *
 * @param {string} key
 * @param {boolean} keepView  true = 保留当前分页与滚动位置（轮询刷新用）；
 *                            false = 重置为第一页并重建结构（切换会话用）。
 *
 * ⚠️ 这个参数是修"滚动被冲掉"的关键：
 *    轮询每 15 秒一次、每次 SSE 事件也会触发，如果都走"重置分页 + 重建 DOM"，
 *    用户辛辛苦苦滚出来的内容会瞬间被刷回前 500 条，滚动位置也回到顶部
 *    —— 表现为"明明滚下去了，过一会儿自己弹回上面"。
 */
async function loadChatMessages(key, { keepView = false } = {}) {
  try {
    const data = await api(`/api/chats/${key.replace(':', '_')}/messages?limit=100000`);
    // 期间用户可能切走了会话，那就别覆盖当前视图
    if (state.currentChatKey !== key) return;
    state.chatMessages = data.messages || [];

    if (keepView && (state.chatMsgLimit || 0) > 0 && $('#chat-msg-body')) {
      // 只更新表格内容：分页不变、滚动位置不变
      updateChatMessagesBody(true);
    } else {
      // 切换会话：重置分页并从第一页开始
      state.chatMsgLimit = CHAT_MSG_PAGE;
      renderChatMessages();
    }
  } catch (e) {
    if (state.currentChatKey !== key) return;
    const box = $('#chat-detail');
    if (box) box.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * 存档消息列表：首次建结构 + 填充内容。
 *
 * ⚠️ 关键：这个只在"切换会话 / 首次打开"时调用，负责建出完整骨架并绑定工具栏事件。
 *    滚动加载更多时走 updateChatMessagesBody() —— 只替换 tbody 与底部文案，
 *    不碰外层结构。
 *
 *    曾经每次加载更多都走整个函数（innerHTML 全量重建），后果有两个：
 *      1. 浏览器丢失 scrollTop → 表现为"明明在往下滚，却自己弹回上面"
 *      2. 工具栏事件被反复绑定 → 点一次发好几条
 */
function renderChatMessages() {
  const key = state.currentChatKey;
  if (!key) return;
  const detail = $('#chat-detail');
  if (!detail) return;

  // 切换会话时重置分页（每个会话独立从第一页开始）
  state.chatMsgLimit = CHAT_MSG_PAGE;

  const name = formatChatTitle(key, chatNameOf(key));
  const meta = state.chats.find((c) => c.key === key) || {};

  detail.innerHTML = `
    <div class="detail-header">
      <h2>${esc(name)} ${meta.unread ? `<span class="unread-pill">${meta.unread} 未读</span>` : ''}</h2>
      <div class="sub"><span data-field="chat-msg-count"></span></div>
    </div>
    <div class="chat-toolbar">
      <button class="btn btn-small" id="chat-wake-btn">唤醒一次处理</button>
      <button class="btn btn-small" id="chat-read-btn">全部标为已读</button>
      <button class="btn btn-small" id="chat-mute-btn" title="仅屏蔽：把未读标记为已读，不再触发回复（消息保留）">仅屏蔽</button>
      <button class="btn btn-small" id="chat-del-mode-btn" title="选择部分消息删除">选择删除</button>
      <button class="btn btn-small btn-danger" id="chat-clear-btn" title="清空这个会话的全部消息存档">清空存档</button>
      <input type="text" id="test-send-text" placeholder="手动发一条测试消息" style="flex:1" />
      <button class="btn btn-small" id="chat-testsend-btn">发送</button>
    </div>
    <div class="chat-toolbar chat-del-bar" id="chat-del-bar" style="display:none">
      <span class="muted" id="chat-del-count">已选 0 条</span>
      <button class="btn btn-small btn-danger" id="chat-del-confirm-btn">删除选中</button>
      <button class="btn btn-small" id="chat-del-cancel-btn">取消</button>
    </div>
    <table class="archive-table"><tbody id="chat-msg-body"></tbody></table>
    <div class="list-more muted" id="chat-msg-more"></div>`;

  // 工具栏事件：只在这里绑一次
  $('#chat-wake-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/wake`, { method: 'POST', body: '{}' });
    refreshStatus();
  });
  $('#chat-read-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/mark-read`, { method: 'POST', body: '{}' });
    loadChats();
    // 保持视图：用户可能已经滚到中间了，别把他弹回顶部
    loadChatMessages(key, { keepView: true });
  });
  // 仅屏蔽：未读标记为已读、不再触发回复（消息保留在存档里）
  $('#chat-mute-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/mute`, { method: 'POST', body: '{}' });
    loadChats();
    loadChatMessages(key, { keepView: true });
  });
  // 清空存档：删除这个会话的全部消息（不可恢复）
  $('#chat-clear-btn').addEventListener('click', async () => {
    const meta = state.chats.find((c) => c.key === key) || {};
    if (!confirm(`确定清空「${name}」的全部消息存档？\n\n共 ${meta.total ?? '?'} 条消息，删除后不可恢复。\n（机器人之后来新消息会重新记录）`)) return;
    try {
      await api(`/api/chats/${key.replace(':', '_')}/clear`, { method: 'POST', body: '{}' });
      loadChats();
      loadChatMessages(key);
    } catch (e) {
      alert(`清空失败：${e.message}`);
    }
  });
  // ── 选择删除（部分消息）──
  state.chatDeleteMode = state.chatDeleteMode || false;
  state.chatDeleteSelected = state.chatDeleteSelected || new Set();
  const delBar = $('#chat-del-bar');
  const updateDelBar = () => {
    $('#chat-del-count').textContent = `已选 ${state.chatDeleteSelected.size} 条`;
    delBar.style.display = state.chatDeleteMode ? 'flex' : 'none';
  };
  $('#chat-del-mode-btn').addEventListener('click', () => {
    state.chatDeleteMode = !state.chatDeleteMode;
    if (!state.chatDeleteMode) state.chatDeleteSelected.clear();
    updateDelBar();
    updateChatMessagesBody(true);   // 重渲染出行首勾选框
  });
  $('#chat-del-cancel-btn').addEventListener('click', () => {
    state.chatDeleteMode = false;
    state.chatDeleteSelected.clear();
    updateDelBar();
    updateChatMessagesBody(true);
  });
  $('#chat-del-confirm-btn').addEventListener('click', async () => {
    const ids = [...state.chatDeleteSelected];
    if (!ids.length) { alert('请先勾选要删除的消息'); return; }
    if (!confirm(`确定删除选中的 ${ids.length} 条消息？删除后不可恢复。`)) return;
    try {
      await api(`/api/chats/${key.replace(':', '_')}/delete-messages`, {
        method: 'POST', body: JSON.stringify({ ids })
      });
      state.chatDeleteMode = false;
      state.chatDeleteSelected.clear();
      updateDelBar();
      loadChats();
      loadChatMessages(key, { keepView: true });
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
  // 删除勾选框（事件委托，tbody 会被重建）
  if (!detail.__chatDelBound) {
    detail.__chatDelBound = true;
    detail.addEventListener('change', (e) => {
      const chk = e.target.closest?.('.chat-del-check');
      if (!chk) return;
      const id = Number(chk.dataset.mid);
      if (chk.checked) state.chatDeleteSelected.add(id); else state.chatDeleteSelected.delete(id);
      const cnt = $('#chat-del-count');
      if (cnt) cnt.textContent = `已选 ${state.chatDeleteSelected.size} 条`;
    });
  }
  $('#chat-testsend-btn').addEventListener('click', async () => {
    const input = $('#test-send-text');
    const text = input.value.trim();
    if (!text) return;
    await api(`/api/chats/${key.replace(':', '_')}/test-send`, {
      method: 'POST', body: JSON.stringify({ text })
    });
    input.value = '';
    // 同理，保持当前分页与滚动位置
    loadChatMessages(key, { keepView: true });
  });

  updateChatMessagesBody();
  // 滚动加载只挂一次（attachScrollLoader 内部有防重复）
  initChatScrollLoader();
  // 金句勾选：事件委托挂在容器上（tbody 会被轮询重建，委托不受影响的）。
  // 防重复：renderChatMessages 每次切会话都会跑，容器只绑一次。
  if (!detail.__quoteBound) {
    detail.__quoteBound = true;
    detail.addEventListener('change', (e) => {
      const cb = e.target.closest?.('.quote-check');
      if (!cb) return;
      const mid = Number(cb.dataset.mid);
      if (cb.checked) state.quoteSelected.add(mid); else state.quoteSelected.delete(mid);
      cb.closest('tr')?.classList.toggle('quote-selected', cb.checked);
    });
  }
}

/**
 * 排序缓存：state.chatMessages 的引用不变就复用上次的排序结果。
 *
 * 曾经在 updateChatMessagesBody 里每次都 slice + sort + 再 slice + reverse
 * （两遍全量拷贝 + O(n log n)）。轮询进来数据确实会变（新数组引用，重排一次），
 * 但滚动加载更多时数据根本没动 —— 每滚一批就白排一遍，几万条时卡在滚动事件里。
 *
 * 用"稳定排序"而不是简单 reverse：存档里 ts 是秒级精度（实测 2000 条中有 18 处
 * 同一秒内的消息毫秒级逆序）。直接 reverse 会把这些也翻过来，导致同一秒内的
 * 消息顺序不对。先按 ts 稳定升序排一遍（Array.sort 在现代引擎里是稳定的），
 * 再反转，就能保证"新的在上"且同秒内顺序也正确。
 */
let chatMsgSortCache = { src: null, newestFirst: [] };
function chatMessagesNewestFirst() {
  const src = state.chatMessages || [];
  if (chatMsgSortCache.src !== src) {
    const sorted = src.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    sorted.reverse();
    chatMsgSortCache = { src, newestFirst: sorted };
  }
  return chatMsgSortCache.newestFirst;
}

/** 单行消息 HTML（全量渲染与滚动追加共用同一个模板，保证两处长得一样）。 */
function chatMsgRowHtml(m) {
  // 金句勾选模式：行首加勾选框；选中态存 state.quoteSelected（按消息 id），
  // 轮询重建行时勾选状态不丢
  const q = state.quoteMode
    ? `<td class="q-check"><input type="checkbox" class="quote-check" data-mid="${m.id}" ${state.quoteSelected.has(m.id) ? 'checked' : ''} /></td>`
    : '';
  // 删除勾选模式：行首加删除勾选框（与金句勾选互斥）
  const d = state.chatDeleteMode
    ? `<td class="q-check"><input type="checkbox" class="chat-del-check" data-mid="${m.id}" ${state.chatDeleteSelected.has(m.id) ? 'checked' : ''} /></td>`
    : '';
  const sel = state.quoteMode && state.quoteSelected.has(m.id) ? ' quote-selected' : '';
  const dsel = state.chatDeleteMode && state.chatDeleteSelected.has(m.id) ? ' chat-del-selected' : '';
  return `
    <tr class="${m.read ? '' : 'unread'}${sel}${dsel}" data-midrow="${m.id}">${q}${d}
      <td class="t">${fmtTime(m.ts)}</td>
      <td class="w ${m.self ? 'self' : ''}">${m.self ? '我' : esc(m.senderName)}</td>
      <td class="text">${esc(m.text)}${m.read ? '' : ' <span class="unread-pill">未读</span>'}</td>
    </tr>`;
}

/** 更新底部"还有 N 条"与顶部计数文案（全量渲染与追加都要刷这两处）。 */
function updateChatMessagesMeta(newestFirst) {
  const total = newestFirst.length;
  const shownCount = Math.min(Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE), total);
  const rest = total - shownCount;
  const more = $('#chat-msg-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更早的（还有 ${rest} 条）`
      : (total > CHAT_MSG_PAGE ? `已显示全部 ${total} 条` : '');
  }
  const cnt = $('#chat-detail')?.querySelector('[data-field="chat-msg-count"]');
  if (cnt) {
    const meta = state.chats.find((c) => c.key === state.currentChatKey) || {};
    const t = meta.total || total || 0;
    cnt.textContent = t
      ? `共 ${t} 条 · 已显示 ${shownCount} 条 · 存储于 data/messages/`
      : '暂无消息';
  }
}

/**
 * 滚动加载更多的追加路径：只把新批次的行插到 tbody 末尾。
 * 不重排（走缓存）、不重建已有行、不碰滚动位置 —— 内容加在视口下方，
 * 浏览器天然保持视口稳定，所以这里**绝对不能**做 scrollTop 补偿。
 */
function appendChatMessageRows(prevShown) {
  const tbody = $('#chat-msg-body');
  if (!tbody) return;
  const newestFirst = chatMessagesNewestFirst();
  const limit = Math.min(state.chatMsgLimit, newestFirst.length);
  const rows = newestFirst.slice(prevShown, limit);
  if (rows.length) tbody.insertAdjacentHTML('beforeend', rows.map(chatMsgRowHtml).join(''));
  state.chatMsgRendered = limit;
  updateChatMessagesMeta(newestFirst);
}

/**
 * 只更新消息表格的内容（不重建外层结构）。
 * 轮询刷新与首次填充走这里 —— 表格内容变长，但滚动容器没动，
 * 所以用户的滚动位置天然保持，不会再"自己弹回上面"。
 *
 * @param {boolean} keepScroll 轮询路径传 true：新消息从**顶部**进来，
 *        内容高度变化会把视口顶走，按增量补偿回阅读位置。
 *        （滚动加载更多不走这里，走 appendChatMessageRows —— 底部追加不需要补偿）
 */
function updateChatMessagesBody(keepScroll = false) {
  const detail = $('#chat-detail');
  const tbody = $('#chat-msg-body');
  if (!detail || !tbody) return;

  const prevTop = keepScroll ? detail.scrollTop : 0;
  const prevHeight = keepScroll ? detail.scrollHeight : 0;

  // 倒序后取前 N 条 = 最新的 N 条（排序结果走引用缓存，数据没变不重排）
  const newestFirst = chatMessagesNewestFirst();
  state.chatMsgLimit = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
  const shown = newestFirst.slice(0, state.chatMsgLimit);

  tbody.innerHTML = shown.map(chatMsgRowHtml).join('');
  state.chatMsgRendered = shown.length;   // 行数账本：滚动追加靠它判断该不该走增量
  updateChatMessagesMeta(newestFirst);

  // 保险：若内容高度变了导致视口跳动，按增量补偿回来
  if (keepScroll) {
    const delta = detail.scrollHeight - prevHeight;
    if (delta !== 0) detail.scrollTop = prevTop + delta;
  }
}

/* ══════════════════════════════════════════════════════════════
 用量页图表（按天折线 + 按会话/按模型横向条形）

 表格是"精确"，图表是"一眼看懂"：趋势、谁占大头、集中在哪几天，
 这些扫一眼图就知道，扫表格得逐行做心算。图下面仍保留数值表（默认折叠）。

 ⚠️ 本项目 electron/main.js 关掉了硬件加速（软件渲染）：图表里
   不要用 backdrop-filter、不要给常驻元素加 animation。
 ══════════════════════════════════════════════════════════════ */
function usageMetric() {
  const m = state.usageMetric;
  return USAGE_METRICS.some(([k]) => k === m) ? m : 'runs';
}

/** 取某项在当前指标下的数值 */
function metricOf(item, metric = usageMetric()) {
  if (!item) return 0;
  if (metric === 'cost') return Number(item.cost) || 0;
  if (metric === 'tokens') return (Number(item.promptTokens) || 0) + (Number(item.completionTokens) || 0);
  return Number(item.runs) || 0;
}

/** 完整格式（气泡/条形末端用） */
function fmtMetric(v, metric = usageMetric()) {
  if (metric === 'cost') return fmtMoneyChart(v);
  if (metric === 'tokens') return fmtTokens(v);
  return String(Math.round(Number(v) || 0));
}

/** 图表里的金额：低于 1 元给 3 位即可（fmtYuan 给 4 位是给表格用的，条形上太吵） */
function fmtMoneyChart(n) {
  const v = Number(n) || 0;
  if (v === 0) return '¥0';
  return Math.abs(v) < 1 ? `¥${v.toFixed(3)}` : `¥${v.toFixed(2)}`;
}

/** 坐标轴刻度用的紧凑格式（太长会把图挤变形） */
function fmtMetricShort(v, metric = usageMetric()) {
  const n = Number(v) || 0;
  if (metric === 'cost') return n >= 100 ? `¥${Math.round(n)}` : `¥${n.toFixed(n < 10 ? 2 : 1)}`;
  return n >= 10000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

/** 坐标轴上界取 1 / 2 / 5 × 10^n，刻度才好看 */
function niceMax(v) {
  const n = Number(v) || 0;
  if (n <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const r = n / pow;
  const step = r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10;
  return step * pow;
}

/**
 * 平滑曲线路径（单调三次 Hermite，Fritsch–Carlson 限幅）。
 * ⚠️ 刻意不用普通的 Catmull-Rom：它在陡升陡降处会「过冲」，把曲线甩到 0 以下
 * 或刻度上界以上，数据图里看着像假数据。这里的算法保证曲线始终落在相邻两点
 * 的取值区间内 → 既没有折角，又不会冒出假的峰谷。点数 < 2 时返回空串。
 */
function smoothPath(pts) {
  const n = pts.length;
  if (n < 2) return '';
  const dx = [], sec = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x || 1;
    sec[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }
  // 端点切线取相邻割线，中间点取两侧割线的平均（异号说明是极值点 → 切线压平）
  const t = new Array(n);
  t[0] = sec[0];
  t[n - 1] = sec[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = sec[i - 1] * sec[i] <= 0 ? 0 : (sec[i - 1] + sec[i]) / 2;
  // 限幅：把切线拉回单调区，过冲就是在这里被消掉的
  for (let i = 0; i < n - 1; i++) {
    if (sec[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / sec[i], b = t[i + 1] / sec[i];
    const s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); t[i] = tau * a * sec[i]; t[i + 1] = tau * b * sec[i]; }
  }
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h3 = dx[i] / 3;
    d += `C${(pts[i].x + h3).toFixed(1)},${(pts[i].y + t[i] * h3).toFixed(1)}`
      + ` ${(pts[i + 1].x - h3).toFixed(1)},${(pts[i + 1].y - t[i + 1] * h3).toFixed(1)}`
      + ` ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
}

/**
 * 按天折线图（平滑曲线）。
 * viewBox 用真实像素尺寸（= 实测容器宽 × 固定高），所以线宽与字号不会被拉伸。
 * 窗口缩放后由 bindUsageResize() 重画一次。
 *
 * 「一眼看懂」靠三件事：
 *   1. 曲线平滑，趋势比折线好读（且不过冲）；
 *   2. 图上方摘要条直接给出 峰值（带日期）/ 日均 / 合计，不用在图上找数字；
 *   3. 峰值点带虚线下引线、最新一点实心高亮，位置一目了然。
 * ⚠️ 所有文字都放在 SVG 外的摘要条里：页面背景是渐变光晕，SVG 文字没法靠纯色描边
 *    挖底，压在线/面积上会糊成一团。图上只留形状。
 * ⚠️ 圆点提示用 data-tip 而不是 SVG <title> —— 窗口是 transparent 的，
 *    原生 tooltip 会渲染成淡黄色色块（见 tooltip.js）。
 */
function usageLineChart(points, metric, width, height = 156) {
  const w = Math.max(280, Math.round(width || 680));
  const h = height;
  const padL = 46, padR = 14, padT = 10, padB = 22;
  const iw = w - padL - padR;
  const ih = h - padT - padB;
  const n = points.length;
  const vals = points.map((p) => metricOf(p, metric));
  const max = niceMax(Math.max(...vals, 0));
  const base = padT + ih;
  const X = (i) => (n <= 1 ? padL + iw / 2 : padL + (iw * i) / (n - 1));
  const Y = (v) => base - (max > 0 ? (ih * Math.max(0, v)) / max : 0);

  let grid = '';
  // 分 5 段：niceMax 取 1/2/5×10^n，除以 5 必定是整数（除 4 会出现 12.5 这种刻度）
  for (let i = 0; i <= 5; i++) {
    const v = (max * i) / 5;
    const y = Y(v).toFixed(1);
    grid += `<line class="uc-grid" x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}"/>`
         + `<text class="uc-ylabel" x="${padL - 7}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end">${esc(fmtMetricShort(v, metric))}</text>`;
  }

  // x 轴日期：点太多就均匀抽，避免标签叠在一起
  const step = Math.max(1, Math.ceil(n / 6));
  const shownX = new Set();
  for (let i = 0; i < n; i += step) shownX.add(i);
  // 最后一天离前一个标签太近就不画了，否则两个日期会叠在一起糊成一团
  if (n && (n - 1) - Math.max(...shownX) >= Math.max(1, step * 0.6)) shownX.add(n - 1);
  let xlabels = '';
  for (const i of [...shownX].sort((a, b) => a - b)) {
    if (!points[i]) continue;
    xlabels += `<text class="uc-xlabel" x="${X(i).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(String(points[i].day || '').slice(5))}</text>`;
  }

  // ── 曲线 / 面积 ──
  const pts = points.map((p, i) => ({ x: X(i), y: Y(metricOf(p, metric)) }));
  const linePath = smoothPath(pts);
  const areaPath = linePath
    ? `${linePath} L${pts[n - 1].x.toFixed(1)},${base.toFixed(1)} L${pts[0].x.toFixed(1)},${base.toFixed(1)} Z`
    : '';

  // ── 峰值 / 日均（摘要条与图上的标记共用这两个值）──
  const peakV = Math.max(...vals, 0);
  const peakIdx = peakV > 0 ? vals.indexOf(peakV) : -1;
  const total = vals.reduce((a, v) => a + v, 0);
  const avg = n ? total / n : 0;
  const dayOf = (i) => String(points[i]?.day || '').slice(5);

  // 均值虚线：全 0 时贴着基线没意义，只有真的高于 0 才画
  const avgLine = avg > 0
    ? `<line class="uc-avg" x1="${padL}" y1="${Y(avg).toFixed(1)}" x2="${(w - padR).toFixed(1)}" y2="${Y(avg).toFixed(1)}"/>`
    : '';
  // 峰值下引线：一眼看出峰值落在哪一天（否则只能靠猜 x 轴）
  const peakGuide = peakIdx >= 0
    ? `<line class="uc-peak-guide" x1="${pts[peakIdx].x.toFixed(1)}" y1="${pts[peakIdx].y.toFixed(1)}" x2="${pts[peakIdx].x.toFixed(1)}" y2="${base.toFixed(1)}"/>`
    : '';

  // 点太密时普通点淡化处理（保留 3.4 半径的点击热区，只是不抢视线），峰值/最新永远醒目
  const dense = n > 22;
  const dots = points.map((p, i) => {
    const isPeak = i === peakIdx;
    const isLast = i === n - 1;
    const cls = ['uc-dot',
      dense && !isPeak && !isLast ? 'uc-dot-quiet' : '',
      isPeak ? 'uc-dot-peak' : '',
      isLast ? 'uc-dot-last' : ''].filter(Boolean).join(' ');
    const r = isPeak ? 4.6 : isLast ? 4.2 : 3.4;
    return `<circle class="${cls}" cx="${pts[i].x.toFixed(1)}" cy="${pts[i].y.toFixed(1)}" r="${r}" data-key="${esc(p.day)}" data-tip="${esc(String(p.day))}：${esc(fmtMetric(vals[i], metric))}"></circle>`;
  }).join('');

  const sumBar = `<div class="uc-sum">`
    + `<span class="uc-sum-item"><i>峰值</i><b>${esc(fmtMetric(peakV, metric))}</b>`
      + (peakIdx >= 0 ? `<span class="uc-sum-extra">${esc(dayOf(peakIdx))}</span>` : '') + `</span>`
    + `<span class="uc-sum-item${avg > 0 ? ' has-dash' : ''}"><i>日均</i><b>${esc(fmtMetric(avg, metric))}</b></span>`
    + `<span class="uc-sum-item"><i>合计</i><b>${esc(fmtMetric(total, metric))}</b></span>`
    + `</div>`;

  return `<div class="uc-line-wrap">${sumBar}`
       + `<svg class="usage-line" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img">`
       + grid + avgLine + peakGuide + xlabels
       + (areaPath ? `<path class="uc-area" d="${areaPath}"/>` : '')
       + (linePath ? `<path class="uc-line" d="${linePath}"/>` : '')
       + dots
       + `</svg></div>`;
}

/**
 * 横向条形图（分类排名用）。会话/模型是并列关系，折线会误导"前后有趋势"，
 * 条形一眼看出谁多谁少。
 *
 * 「一眼看懂」靠三件事：
 *   1. 左侧名次徽标 + 条色随名次递减（第一名最实），不用逐行比长度；
 *   2. 每行右侧给百分比；条形按最大值归一化，第一名永远满格；
 *   3. 底部汇总「合计 + 前 N 项占比」，直接看出集中度（少数会话吃掉大部分用量）。
 */
function usageBars(list, metric, labelOf, limit = 8) {
  const items = (list || []).slice().sort((a, b) => metricOf(b, metric) - metricOf(a, metric));
  if (!items.length) return '<div class="uc-empty muted">这段时间没有记录</div>';
  const shown = items.slice(0, limit);
  const max = Math.max(...shown.map((x) => metricOf(x, metric)), 0) || 1;
  const totalV = items.reduce((a, x) => a + metricOf(x, metric), 0);
  const topV = shown.reduce((a, x) => a + metricOf(x, metric), 0);
  const topPct = totalV > 0 ? (topV / totalV) * 100 : 0;
  const rest = items.slice(limit);

  const rows = shown.map((x, i) => {
    const v = metricOf(x, metric);
    const w = Math.max(2, (v / max) * 100);
    const share = totalV > 0 ? (v / totalV) * 100 : 0;
    // 名次色阶：第一名 1.0，每降一名淡 0.1，最低 0.34（再淡就看不清了）
    const alpha = Math.max(0.34, 1 - i * 0.1);
    return `<div class="uc-bar-row${i === 0 ? ' top' : ''}" data-key="${esc(x.key)}" role="button" tabindex="0" title="点击查看明细">`
         + `<div class="uc-bar-label"><span class="uc-rank">${i + 1}</span><span class="uc-name">${esc(labelOf(x))}</span></div>`
         + `<div class="uc-bar-track"><div class="uc-bar-fill" style="width:${w.toFixed(1)}%;opacity:${alpha.toFixed(2)}"></div></div>`
         + `<div class="uc-bar-val">${esc(fmtMetric(v, metric))}<span class="uc-bar-share">· ${share.toFixed(0)}%</span></div>`
         + `</div>`;
  }).join('');

  // 全部项都已经画出来时，「前 N 项占 100%」是废话，只留合计
  const foot = `<div class="uc-rest">合计 <b>${esc(fmtMetric(totalV, metric))}</b>`
    + (rest.length
        ? ` · 前 ${shown.length} 项占 <b>${topPct.toFixed(0)}%</b> · 其余 ${rest.length} 项占 <b>${(100 - topPct).toFixed(0)}%</b>`
        : '')
    + `</div>`;
  return `<div class="uc-bars">${rows}</div>${foot}`;
}

/** 画三张图（用 dataset.sig 做内容指纹，轮询时内容没变就不动 DOM） */
function renderUsageCharts(stats, box) {
  if (!box) return;
  const metric = usageMetric();
  const days = stats?.days || [];
  const host = box.querySelector('[data-chart="days"]');
  // 折线图要用真实像素宽度：优先量自己的容器，量不到再退回外层
  const width = (host?.clientWidth || box.clientWidth || 680) - 4;
  const html = {
    days: days.length ? usageLineChart(days, metric, width) : '<div class="uc-empty muted">这段时间没有记录</div>',
    chats: usageBars(stats?.chats, metric, (c) => formatChatTitle(c.key, chatNameOf(c.key))),
    models: usageBars(stats?.models, metric, (m) => (m.vendor ? `${m.vendor}：${m.model}` : (m.model ?? m.key)))
  };
  for (const name of Object.keys(html)) {
    const el = box.querySelector(`[data-chart="${name}"]`);
    if (!el) continue;
    // 宽度变了也要重画（否则折线图会被拉伸变形）
    const sig = `${width}|${html[name]}`;
    if (el.dataset.sig !== sig) { el.innerHTML = html[name]; el.dataset.sig = sig; }
  }
}

/** 窗口缩放后重画图表（只挂一次，防重复绑定） */
let usageResizeBound = false;
function bindUsageResize() {
  if (usageResizeBound) return;
  usageResizeBound = true;
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const args = state.usageRenderArgs;
      const box = $('#usage-page');
      if (!args || !box || state.tab !== 'usage') return;
      box.querySelectorAll('.usage-chart').forEach((el) => { el.dataset.sig = ''; });
      renderUsageCharts(args.stats, box);
    }, 200);
  }, { passive: true });
}

function renderUsageSkeleton() {
  const card = '<div class="usage-card skeleton"><div class="sk-line"></div><div class="sk-line short"></div></div>';
  // 图表占位：一排参差小柱 + 扫光（暗示"这里会出现折线/条形图"）
  const cols = [38, 62, 45, 80, 55, 70, 40, 90, 58, 66, 48, 74, 60, 42]
    .map((h) => `<i class="sk-col" style="height:${h}%"></i>`).join('');
  const chart = (h) => `<div class="sk-chart" style="height:${h}px">${cols}</div>`;
  const h3 = '<div class="sk-line" style="width:64px;height:15px;margin:22px 0 10px"></div>';
  // 顺序与正式页面一致（控制条 → 三块图 → 统计卡），加载完成时布局不跳。
  // 提示文案（R49）：大数据下统计可能要几秒，让用户知道页面没死。
  return `
    <div class="usage-wrap">
      <div class="usage-head">
        <h2>用量与成本</h2>
        <span class="muted" style="font-size:12px">正在统计…历史数据较多时可能需要几秒</span>
      </div>
      <div class="usage-ctrl"><span class="sk-line" style="width:280px;height:26px;margin:0"></span></div>
      ${h3}${chart(190)}
      ${h3}${chart(150)}
      ${h3}${chart(150)}
      <div class="usage-cards" style="margin-top:22px">${card.repeat(5)}</div>
    </div>`;
}

/** 建骨架（只建一次，轮询走 updateUsagePage 以免滚动位置丢失）。 */
function renderUsagePage(stats, st, prices) {
  const box = $('#usage-page');
  if (!box) return;

  box.innerHTML = `
    <div class="usage-wrap">
      <div class="usage-head">
        <h2>用量与成本</h2>
      </div>

      <!-- 控制条（指标 + 时间范围 + 刷新）贴着第一张图放，但要**独立于 [data-block="days"]**：
           ⚠️ 选「今日 / 24 小时」时后端 mode ≠ 'days'，updateUsagePage 会把整个
              [data-block="days"] 隐藏（那时光图表本来就没数据）——控制条若住在里面
              会跟着一起消失（实测 bug：点「今日」后所有按钮都不见了）。
           所以它必须是 days 块的**兄弟节点**，位置仍紧贴图表上方。 -->
      <div class="usage-ctrl">
        <span class="usage-metrics" title="选择三张图表显示的指标">
          <span class="usage-metrics-label">图表</span>
          ${USAGE_METRICS.map(([k, label]) => `<button class="btn btn-small" data-metric="${k}">${label}</button>`).join('')}
        </span>
        <span class="usage-sep"></span>
        ${USAGE_RANGES.map(([v, label]) => `<button class="btn btn-small" data-range="${v}">${label}</button>`).join('')}
        <button class="btn btn-small" id="usage-refresh-btn" title="立即重算（跳过 3 小时缓存）">刷新</button>
        <span class="usage-fresh" id="usage-updated"></span>
      </div>

      <div data-block="days">
        <h3 class="usage-h3">按天</h3>
        <!-- 时间序列 → 折线图（看趋势） -->
        <div class="usage-chart" data-chart="days"></div>
        <!-- 原始数值表：默认折叠，精确数字与点击下钻都还在 -->
        <details class="usage-details">
          <summary>数值表</summary>
          <table class="usage-table clickable" data-table="days">
            <thead><tr><th>日期</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">缓存命中</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody></tbody>
          </table>
        </details>
      </div>

      <div data-block="chats">
        <h3 class="usage-h3">按会话</h3>
        <!-- 分类排名 → 横向条形（折线会暗示"前后有趋势"，反而误导） -->
        <div class="usage-chart" data-chart="chats"></div>
        <details class="usage-details">
          <summary>数值表</summary>
          <table class="usage-table clickable" data-table="chats">
            <thead><tr><th>会话</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody></tbody>
          </table>
        </details>
      </div>

      <div data-block="models">
        <h3 class="usage-h3">按模型</h3>
        <div class="usage-chart" data-chart="models"></div>
        <details class="usage-details">
          <summary>数值表</summary>
          <!-- ⚠️ 这个按钮从 h3 挪进来了（表格现在默认折叠，按钮留在标题上会点不着） -->
          <div class="usage-details-tools">
            <button class="btn btn-small ub-expand" id="models-expand" style="display:none">展开全部</button>
          </div>
          <table class="usage-table clickable" data-table="models">
            <thead><tr><th>模型（渠道：模型 id）</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody></tbody>
          </table>
        </details>
      </div>

      <!-- 统计卡整排挪到图表之后（需求：先看趋势，再看精确数字；首屏只剩标题+图，更简洁）。
           ⚠️ 这些 data-field / id 一个都不能少 —— updateUsagePage 靠它们填数值，
              #runs-card 的点击绑定也挂在 renderUsagePage 里。
           估算成本仍是第一张：它是这页的主指标（accent 描边/底色突出）。 -->
      <div class="usage-cards">
        <div class="usage-card accent">
          <div class="uc-label">估算成本</div>
          <div class="uc-value" data-field="cost">-</div>
          <div class="uc-sub" data-field="cost-sub">-</div>
        </div>
        <div class="usage-card clickable" id="runs-card" title="点击查看各类工具分别调用了多少次">
          <div class="uc-label">调用次数 <span class="uc-more">明细 ›</span></div>
          <div class="uc-value" data-field="runs">-</div>
          <div class="uc-sub" data-field="runs-sub">-</div>
        </div>
        <div class="usage-card">
          <div class="uc-label">搜索次数 <span class="uc-tag">不计入成本</span></div>
          <div class="uc-value" data-field="search">-</div>
          <div class="uc-sub" data-field="search-sub">-</div>
        </div>
        <div class="usage-card">
          <div class="uc-label">输入 token</div>
          <div class="uc-value" data-field="prompt">-</div>
          <div class="uc-sub" data-field="prompt-sub">-</div>
        </div>
        <div class="usage-card">
          <div class="uc-label">缓存命中率</div>
          <div class="uc-value" data-field="rate">-</div>
          <div class="usage-bar"><div class="usage-bar-fill ok" data-field="rate-bar" style="width:0%"></div></div>
          <div class="uc-sub" data-field="rate-sub">-</div>
        </div>
      </div>
    </div>`;

  // 「调用次数」卡片可点开明细（骨架重建后重新绑定，所以放在 renderUsagePage 里）
  const runsCard = $('#usage-page #runs-card');
  if (runsCard) runsCard.addEventListener('click', () => openToolBreakdown());

  $$('#usage-page [data-range]').forEach((el) => {
    el.addEventListener('click', () => {
      usageRange = el.dataset.range;
      loadUsageView({ force: true });
    });
  });
  $('#usage-refresh-btn')?.addEventListener('click', () => loadUsageView({ force: true, hard: true }));

  // 图表指标切换：只重画图，不重新请求接口（数据没变）
  $$('#usage-page [data-metric]').forEach((el) => {
    el.addEventListener('click', () => {
      state.usageMetric = el.dataset.metric;
      const args = state.usageRenderArgs;
      if (args) updateUsagePage(args.stats, args.st, args.prices);
    });
  });

  // 图表点击 → 与表格行点击走同一套下钻
  box.addEventListener('click', (e) => {
    const hit = e.target.closest('.usage-chart [data-key]');
    if (!hit) return;
    const chart = hit.closest('[data-chart]');
    const dim = chart?.dataset.chart === 'days' ? 'day' : chart?.dataset.chart === 'chats' ? 'chat' : 'model';
    openUsageBreakdown(dim, hit.dataset.key);
  });
  // 键盘可达：条形图是 tabindex 元素，回车等同点击
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const hit = e.target.closest?.('.usage-chart [data-key]');
    if (!hit) return;
    e.preventDefault();
    const chart = hit.closest('[data-chart]');
    const dim = chart?.dataset.chart === 'days' ? 'day' : chart?.dataset.chart === 'chats' ? 'chat' : 'model';
    openUsageBreakdown(dim, hit.dataset.key);
  });

  bindUsageResize();

  // 行点击 → 弹明细
  box.querySelector('[data-table="days"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('day', tr.dataset.key);
  });
  box.querySelector('[data-table="chats"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('chat', tr.dataset.key);
  });
  box.querySelector('[data-table="models"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('model', tr.dataset.key);
  });

  // 「展开全部 / 收起」按钮：显隐与文案由 updateUsagePage 里的 fill() 负责，
  // 但此前**没有任何地方监听它的点击**，也没有代码把 tbody.dataset.expanded 置为 '1' ——
  // 结果是：模型超过 20 行时按钮会出现、写着「展开全部（还有 N 行）」，点下去却毫无反应，
  // 剩下的行永远看不到。这里补上开合逻辑（复用 updateUsagePage 重绘，不重新请求接口）。
  const modelsExpandBtn = box.querySelector('#models-expand');
  if (modelsExpandBtn) {
    modelsExpandBtn.addEventListener('click', () => {
      const tb = box.querySelector('[data-table="models"] tbody');
      const args = state.usageRenderArgs;
      if (!tb || !args) return;
      tb.dataset.expanded = tb.dataset.expanded === '1' ? '0' : '1';
      updateUsagePage(args.stats, args.st, args.prices);
    });
  }

  updateUsagePage(stats, st, prices);
}

/** 只更新数值与表格行，不碰骨架。 */
function updateUsagePage(stats, st, prices) {
  const box = $('#usage-page');
  if (!box) return;
  // 记住最近一次渲染参数：供「展开全部/收起」按钮原地重绘（不重新请求接口）
  state.usageRenderArgs = { stats, st, prices };
  const t = stats?.totals || {};
  const cfg = state.config || {};

  // 统一存字符串：曾经这里把数字直接赋给 textContent（如 runs=0 时存的是数字 0
  // 而非 '0'）。浏览器会隐式转换所以显示没问题，但类型不一致会在别处埋雷
  // （比较、测试断言、序列化时都可能踩到）。这里显式转成字符串。
  const set = (f, v) => {
    const el = box.querySelector(`[data-field="${f}"]`);
    if (!el) return;
    const s = String(v);
    if (el.textContent !== s) el.textContent = s;
  };

  // 价格口径说明（不再显示"当前模型" —— 全天可能换过多个模型）
  const today = st?.usage || {};
  set('runs', t.runs || 0);
  set('runs-sub', `今日 ${today.runs ?? 0} 次`);
  // 搜索次数：只列数量，不参与成本计算（搜索通常是资源包或免费的）
  const searches = Number(stats?.searchCount) || 0;
  set('search', fmtTok(searches));
  // 拆开显示搜索与抓取的构成（曾经三元两分支文案相同，判定是死逻辑）
  {
    const nSearch = Number(stats?.toolCounts?.web_search) || 0;
    const nFetch = Number(stats?.toolCounts?.web_fetch) || 0;
    set('search-sub', searches
      ? `搜索 ${nSearch} · 抓网页 ${nFetch}`
      : '本区间没有联网');
  }
  set('prompt', fmtTok(t.promptTokens));
  set('prompt-sub', `输出 ${fmtTok(t.completionTokens)}`);
  set('rate', `${((t.cacheHitRate || 0) * 100).toFixed(1)}%`);
  set('rate-sub', `命中 ${fmtTok(t.cachedTokens)} / 输入 ${fmtTok(t.promptTokens)}`);
  set('cost', fmtYuan(t.cost));
  set('cost-sub', stats?.rangeLabel || '');
  const bar = box.querySelector('[data-field="rate-bar"]');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, (t.cacheHitRate || 0) * 100)).toFixed(1)}%`;

  // 范围按钮高亮
  $$('#usage-page [data-range]').forEach((el) => {
    el.classList.toggle('btn-primary', el.dataset.range === String(usageRange));
  });

  // 统计新鲜度：服务端把统计结果缓存住了（默认 3 小时一次），所以这页的数字
  // 未必是"刚刚"的。必须把算出来的时刻摆出来 —— 否则用户会拿一个几小时前的
  // 成本数当成实时的，那比"慢"更糟。想立刻要最新的就点右边「刷新」。
  const fresh = box.querySelector('#usage-updated');
  if (fresh) {
    const at = Number(stats?.computedAt) || 0;
    const txt = at ? `数据更新于 ${fmtTime(at)}` : '';
    if (fresh.textContent !== txt) fresh.textContent = txt;
    fresh.title = '用量统计每 3 小时自动重算一次；点「刷新」立即重算。'
      + '页面顶部的「今日」概览是实时的，不受此缓存影响。';
  }

  // 单日/24小时 → 隐藏"按天"
  const daysBlock = box.querySelector('[data-block="days"]');
  if (daysBlock) daysBlock.style.display = (stats?.mode === 'days') ? '' : 'none';

  // 行数很多时（按模型常有几十行）默认只显示前 N 行，点"展开全部"再看全部。
  // 注意：后端不截断（保证求和一致），这里只是前端显示层面的折叠。
  const COLLAPSE_AT = 20;
  const fill = (name, list, build, opts = {}) => {
    const tbody = box.querySelector(`[data-table="${name}"] tbody`);
    if (!tbody) return;
    const wanted = list || [];
    const collapsed = Boolean(opts.collapsible) && wanted.length > COLLAPSE_AT
      && tbody.dataset.expanded !== '1';
    const shown = collapsed ? wanted.slice(0, COLLAPSE_AT) : wanted;
    const moreBtn = opts.expandBtn ? box.querySelector(opts.expandBtn) : null;
    if (moreBtn) {
      if (wanted.length > COLLAPSE_AT) {
        moreBtn.style.display = '';
        moreBtn.textContent = collapsed
          ? `展开全部（还有 ${wanted.length - COLLAPSE_AT} 行）`
          : '收起';
      } else {
        moreBtn.style.display = 'none';
      }
    }
    // 折叠起来的表格：把行数写进 summary，用户才知道值不值得展开
    const det = tbody.closest('details');
    const sumEl = det ? det.querySelector('summary') : null;
    if (sumEl) {
      const txt = wanted.length ? `数值表（${wanted.length} 行）` : '数值表（无记录）';
      if (sumEl.textContent !== txt) sumEl.textContent = txt;
    }
    if (!wanted.length) {
      if (tbody.dataset.empty !== '1') {
        tbody.innerHTML = '<tr><td colspan="7" class="muted">无</td></tr>';
        tbody.dataset.empty = '1';
      }
      return;
    }
    tbody.dataset.empty = '0';
    const html = shown.map(build).join('');
    if (tbody.dataset.sig !== html) { tbody.innerHTML = html; tbody.dataset.sig = html; }
  };

  fill('days', stats?.days, (d) => `
    <tr data-key="${esc(d.day)}">
      <td>${esc(d.day)}</td>
      <td class="r">${d.runs}</td>
      <td class="r">${fmtTok(d.promptTokens)}</td>
      <td class="r">${fmtTok(d.completionTokens)}</td>
      <td class="r">${fmtTok(d.cachedTokens)}</td>
      <td class="r">${((d.cacheHitRate || 0) * 100).toFixed(0)}%</td>
      <td class="r">${fmtYuan(d.cost)}</td>
    </tr>`);

  fill('chats', stats?.chats, (c) => `
    <tr data-key="${esc(c.key)}">
      <td>${esc(formatChatTitle(c.key, chatNameOf(c.key)))}</td>
      <td class="r">${c.runs}</td>
      <td class="r">${fmtTok(c.promptTokens)}</td>
      <td class="r">${fmtTok(c.completionTokens)}</td>
      <td class="r">${((c.cacheHitRate || 0) * 100).toFixed(0)}%</td>
      <td class="r">${fmtYuan(c.cost)}</td>
    </tr>`);

  // 模型与供应商分两列显示：同一个 id 走不同渠道是不同的"商品"，
  // 价格可能差很多（中转站加价、:free 版本等），必须能区分开。
  fill('models', stats?.models, (m) => `
    <tr data-key="${esc(m.key)}">
      <td>${esc(m.vendor ? `${m.vendor}：${m.model}` : (m.model ?? m.key))}</td>
      <td class="r">${m.runs}</td>
      <td class="r">${fmtTok(m.promptTokens)}</td>
      <td class="r">${fmtTok(m.completionTokens)}</td>
      <td class="r">${((m.cacheHitRate || 0) * 100).toFixed(0)}%</td>
      <td class="r">${fmtYuan(m.cost)}</td>
    </tr>`, { collapsible: true, expandBtn: '#models-expand' });

  // 图表指标按钮高亮
  $$('#usage-page [data-metric]').forEach((el) => {
    el.classList.toggle('btn-primary', el.dataset.metric === usageMetric());
  });

  // 三张图（按天折线 / 按会话条形 / 按模型条形）
  renderUsageCharts(stats, box);
}

/** 峰谷拆分条（弹窗外部上方展示；没用到分时段计价的模型则不显示）。 */
/**
 * 加载用量页。
 *
 * @param {boolean} force  true = 重建整个页面骨架（切换页签、切换时间范围、点刷新）；
 *                         false = 轮询刷新，只更新数值与表格行，不重建 DOM。
 *
 * ── 为什么要分开 ──
 * 轮询每 15 秒一次，如果每次都重建 DOM，用户正在看的行会被重新渲染、
 * 滚动位置也会丢。所以轮询走"只更新数值"这条路。
 *
 * ── 加载为什么快 ──
 * 1. 三个接口用 Promise.all **并行**请求（串行会慢 3 倍）
 * 2. 骨架屏**立即**显示，不等数据回来 —— 用户切过去马上看到布局，不会"黑一会"
 * 3. 竞态防护：请求期间用户可能切走或改了时间范围，回来时丢弃过期结果
 */
let usageLoadToken = 0;          // 每次加载递增，用于丢弃过期结果
let usageLastData = null;        // 上一次加载成功的数据：{ range, stats, st, prices }
                                 // 用于切回用量页时先立即画出旧内容，避免"黑一下"

/**
 * 统计请求 URL。
 *
 * hard=true（用户明确点了「刷新」）→ 带 force=1，服务端跳过 3 小时结果缓存当场重算。
 * 其余入口（轮询、SSE、切页签、切时间范围）一律走缓存 —— 服务端为了"点今日要等很久"
 * 已经把统计结果缓存住了，前端不该再用 force 把它顶掉，否则缓存等于不存在。
 * 这三者的区别要一直保持：**只有刷新按钮才代表"我现在就要最新的"。**
 */
function usageStatsUrl(range, hard = false) {
  return `/api/usage/stats?range=${encodeURIComponent(range)}${hard ? '&force=1' : ''}`;
}

async function loadUsageView({ force = false, hard = false } = {}) {
  const box = $('#usage-page');
  if (!box) return;

  // ── 轮询刷新：只更新数值，不重建 DOM ──
  if (!force) {
    try {
      const [stats, st] = await Promise.all([
        api(usageStatsUrl(usageRange, false), { timeoutMs: 15000 }),
        api('/api/status', { timeoutMs: 15000 })
      ]);
      // 用户可能已经切走页签了，那就别动了
      if (state.tab !== 'usage') return;
      state.usageStats = stats;
      // ⚠️ 价格不用再请求：启动时已加载进 state.modelPrices（/api/model-prices），
      //    更新时按需拉取即可。曾经这里请求了一个**不存在的** /api/usage/prices，
      //    404 会让整个 Promise.all reject → 用量页永远加载失败。
      updateUsagePage(stats, st, state.modelPrices || {});
    } catch (e) { /* 轮询失败静默，不打扰用户 */ }
    return;
  }

  // ── 强制重建 ──
  const token = ++usageLoadToken;
  const range = usageRange;

  // ★ 先用上一次的数据立即渲染（如果有的话），而不是先画骨架等网络。
  //   后端统计的冷启动实测约 200ms（要遍历全部会话文件），热数据只要 24ms；
  //   但缓存 TTL 只有 5 秒、轮询 4 秒一次，切回用量页时缓存经常已经过期，
  //   于是每次都要等那 200ms —— 表现就是"点过去黑一下"。
  //   有旧数据时直接先画出来（0ms 可见），再在后台拉新的覆盖。
  const cached = usageLastData && usageLastData.range === range ? usageLastData : null;
  if (cached) {
    state.usageStats = cached.stats;
    renderUsagePage(cached.stats, cached.st, cached.prices);
  } else {
    box.innerHTML = renderUsageSkeleton();
  }

  try {
    const [stats, st] = await Promise.all([
      api(usageStatsUrl(range, hard), { timeoutMs: 15000 }),
      api('/api/status', { timeoutMs: 15000 })
    ]);
    const prices = state.modelPrices || {};   // 启动时已加载，无需再请求
    // 竞态：期间用户切走了页签、或又点了别的时间范围 → 这次结果作废
    if (token !== usageLoadToken) return;
    if (state.tab !== 'usage' || usageRange !== range) return;

    state.usageStats = stats;
    usageLastData = { range, stats, st, prices };

    if (cached) {
      // 已有页面：只更新数值，不重建（避免打断用户的滚动/交互）
      updateUsagePage(stats, st, prices);
    } else {
      // ⚠️ renderUsagePage 不返回字符串 —— 它内部自己写 box.innerHTML、
      //    绑定事件、并调用 updateUsagePage 填数值。
      //    所以这里只能"直接调用"，不能再赋值（赋 undefined 会把页面清空）。
      renderUsagePage(stats, st, prices);
    }
  } catch (e) {
    if (token !== usageLoadToken) return;
    // 旧数据还在页面上就别用错误覆盖它（用户至少能看到上一次的数字）
    if (cached) return;
    // 曾经这里只有一行错误文案：请求 hang 死时（无超时时代）骨架屏永远转下去，
    // 用户只能重启。现在超时/失败都落到这张卡上，给一个明确的出路（R49）。
    box.innerHTML = `
      <div class="empty-hint">
        用量加载失败：${esc(e?.message || String(e))}<br/>
        <button class="btn btn-small" id="usage-retry-btn" style="margin-top:10px">重新加载</button>
      </div>`;
    $('#usage-retry-btn')?.addEventListener('click', () => loadUsageView({ force: true, hard: true }));
  }
}

function peakSplitHtml(sum) {
  if (!sum || !sum.hasPeakModel) return '';
  if (!(sum.peakCost > 0 || sum.offPeakCost > 0)) return '';
  const ratio = sum.peakRatio || 0;
  return `
    <div class="usage-peak">
      <div class="up-title">峰谷拆分</div>
      <div class="up-row">
        <span class="up-dot peak"></span>
        <span class="up-label">高峰时段</span>
        <span class="up-val">${fmtYuan(sum.peakCost)}</span>
        <span class="up-bar"><i style="width:${(ratio * 100).toFixed(1)}%"></i></span>
        <span class="up-pct">${(ratio * 100).toFixed(0)}% token</span>
      </div>
      <div class="up-row">
        <span class="up-dot off"></span>
        <span class="up-label">闲时</span>
        <span class="up-val">${fmtYuan(sum.offPeakCost)}</span>
        <span class="up-bar"><i class="off" style="width:${((1 - ratio) * 100).toFixed(1)}%"></i></span>
        <span class="up-pct">${((1 - ratio) * 100).toFixed(0)}% token</span>
      </div>
      <div class="up-hint">高峰 = 北京时间工作日 9:00-12:00、14:00-18:00；周末全天闲时。</div>
    </div>`;
}

/**
 * 点表格行 → 弹明细。
 * dim 决定可选的第二个维度：
 *   chat  → 按模型 / 按天
 *   model → 按会话 / 按天
 *   day   → 按模型 / 按会话
 */
function openUsageBreakdown(dim, key) {
  const tabs = {
    chat: [['model', '各模型'], ['day', '各天']],
    model: [['chat', '各群聊'], ['day', '各天']],
    day: [['model', '各模型'], ['chat', '各群聊']]
  }[dim] || [['model', '各模型']];

  const dimLabel = { chat: '会话', model: '模型', day: '日期' }[dim] || '';
  let activeBy = tabs[0][0];

  const overlay = modelModalShell({
    head: `明细：${dimLabel} ${esc(key)}`,
    body: `
      <div class="ub-wrap">
        <div class="ub-tabs" id="ub-tabs">${tabs.map(([v, l]) => `<button class="btn btn-small" data-by="${v}">${l}</button>`).join('')}</div>
        <div id="ub-peak"></div>
        <div class="ub-scroll">
          <table class="usage-table">
            <thead><tr><th id="ub-col">项目</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody id="ub-body"><tr><td colspan="6" class="muted">加载中…</td></tr></tbody>
          </table>
        </div>
      </div>`,
    foot: `<button class="btn" id="ub-close">关闭</button>`
  });

  const bodyEl = overlay.querySelector('#ub-body');
  const peakEl = overlay.querySelector('#ub-peak');
  const colEl = overlay.querySelector('#ub-col');

  async function load() {
    bodyEl.innerHTML = '<tr><td colspan="6" class="muted">加载中…</td></tr>';
    try {
      const r = await api(`/api/usage/breakdown?range=${encodeURIComponent(usageRange)}&dim=${dim}&key=${encodeURIComponent(key)}&by=${activeBy}`, { timeoutMs: 15000 });
      peakEl.innerHTML = peakSplitHtml(r.totals);
      colEl.textContent = { model: '模型', chat: '会话', day: '日期' }[activeBy] || '项目';
      bodyEl.innerHTML = (r.rows || []).length
        ? r.rows.map((x) => `
            <tr>
              <td>${esc(activeBy === 'chat'
                ? formatChatTitle(x.key, chatNameOf(x.key))
                : (x.vendor ? `${x.vendor}：${x.model}` : (x.model ?? x.key)))}</td>
              <td class="r">${x.runs}</td>
              <td class="r">${fmtTok(x.promptTokens)}</td>
              <td class="r">${fmtTok(x.completionTokens)}</td>
              <td class="r">${((x.cacheHitRate || 0) * 100).toFixed(0)}%</td>
              <td class="r">${fmtYuan(x.cost)}</td>
            </tr>`).join('')
        : '<tr><td colspan="6" class="muted">无数据</td></tr>';
    } catch (e) {
      bodyEl.innerHTML = `<tr><td colspan="6" class="muted">加载失败：${esc(e.message)}</td></tr>`;
    }
  }

  overlay.querySelectorAll('#ub-tabs [data-by]').forEach((el) => {
    el.addEventListener('click', () => {
      activeBy = el.dataset.by;
      overlay.querySelectorAll('#ub-tabs [data-by]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.by === activeBy));
      load();
    });
  });
  overlay.querySelector('#ub-close').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelectorAll('#ub-tabs [data-by]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.by === activeBy));
  load();
}
