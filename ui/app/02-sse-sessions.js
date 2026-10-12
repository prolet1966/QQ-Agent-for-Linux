// 〔SSE / 会话视图〕——M9 拆分第 3 段
'use strict';
// SSE bursts share one refresh pass. A second burst waits until the first pass settles.
const SSE_REFRESH_DELAY_MS = 300;
let sseRefreshTimer = null;
let sseRefreshFlags = {};
let sseRefreshScope = null;
let sseFollowSelection = 0;
let sseRefreshInflight = null;
const sseTaskInflight = new Map();
function currentSessionScope() { return state.activeInst || null; }
function scheduleSSERefresh(flags = {}) {
  const scope = currentSessionScope();
  if (sseRefreshScope !== scope) { sseRefreshFlags = {}; sseRefreshScope = scope; }
  if (flags.follow && !sseRefreshFlags.follow) sseFollowSelection = sessionSelectionRevision;
  for (const [key, enabled] of Object.entries(flags)) if (enabled) sseRefreshFlags[key] = true;
  if (sseRefreshTimer || sseRefreshInflight) return;
  sseRefreshTimer = setTimeout(flushSSERefresh, SSE_REFRESH_DELAY_MS);
}
function sharedSSETask(key, action) {
  if (sseTaskInflight.has(key)) return sseTaskInflight.get(key);
  const promise = Promise.resolve().then(action).catch((error) => console.warn('[控制台刷新]', error?.message || error))
    .finally(() => { if (sseTaskInflight.get(key) === promise) sseTaskInflight.delete(key); });
  sseTaskInflight.set(key, promise); return promise;
}
async function flushSSERefresh() {
  sseRefreshTimer = null;
  if (sseRefreshInflight) return;
  const flags = sseRefreshFlags, scope = sseRefreshScope, followSelection = sseFollowSelection; sseRefreshFlags = {};
  if (scope !== currentSessionScope()) return;
  const pass = (async () => {
    const jobs = [];
    if (flags.sessions) jobs.push(loadSessions({ quiet: true, refreshDetail: false }).then(() => {
      if (scope !== currentSessionScope()) return;
      if (flags.follow && state.autoFollowRunning && followSelection === sessionSelectionRevision) {
        const active = state.sessions.find((s) => s.status === 'waiting' || s.status === 'running');
        if (active && active.id !== state.currentSessionId) return selectSession(active.id);
      }
    }));
    if (flags.detail && state.currentSessionId) jobs.push(loadSessionDetail(state.currentSessionId, { quiet: true }));
    if (flags.status) jobs.push(sharedSSETask('status', refreshStatus));
    if (flags.chats && state.tab === 'chats') jobs.push(sharedSSETask('chats', () => loadChats({ quiet: true })));
    if (flags.snowluma && state.tab === 'snowluma') jobs.push(sharedSSETask('snowluma', () => loadSnowlumaPage({ quiet: true })));
    else if (flags.logs && appReady && (state.tab === 'snowluma' || state.tab === 'settings')) jobs.push(sharedSSETask('snowluma-logs', refreshSnowlumaLogs));
    await Promise.all(jobs);
  })();
  sseRefreshInflight = pass;
  try { await pass; } finally { if (sseRefreshInflight === pass) sseRefreshInflight = null; if (Object.keys(sseRefreshFlags).length && !sseRefreshTimer) sseRefreshTimer = setTimeout(flushSSERefresh, SSE_REFRESH_DELAY_MS); }
}
// ── SSE ──
function connectSSE() {
  // 预览模式：没有真实事件源，会话由 00-preview.js 的模拟器推进；
  // EventSource 连不上会无限重连刷屏，直接短路。
  if (state.preview) return;
  const es = new EventSource('/api/events');
  es.addEventListener('session-start', () => {
    if (isPeerView()) return;   // 统一控制台：查看对端时不混入本机会话事件
    sessionSummaryRevision++;
    scheduleSSERefresh({ sessions: true, status: true, follow: true });
  });
  es.addEventListener('session-update', (ev) => {
    if (isPeerView()) return;   // 统一控制台：查看对端时不混入本机会话事件
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    const id = data.sessionId;
    if (!id) return;
    if (data.refresh) {
      sessionSummaryRevision++;
      if (id === state.currentSessionId) sessionDetailRevision++;
      scheduleSSERefresh({ sessions: true, detail: id === state.currentSessionId });
      return;
    }
    // SSE 事件本身携带完整会话快照：patch 立即进 state，渲染走合批（见上）
    const patch = {
      id,
      chatKey: data.chatKey || '',
      status: data.status,
      waitUntil: data.waitUntil ?? null,
      activity: data.activity || '',
      webSearchCount: data.webSearchCount || 0,
      rounds: data.rounds || 0,
      usage: data.usage || null,
      messages: data.messages || [],
      triggerSummary: data.triggerSummary ?? '',
      startedAt: data.startedAt ?? 0
    };
    // sent/finishReason 等收尾字段：后端给了才进 patch。
    // 不能无脑写 null —— pending 合并时 null 会把之前已有的值冲掉。
    if (Array.isArray(data.sent)) patch.sent = data.sent;
    if (data.finishReason !== undefined) patch.finishReason = data.finishReason;
    if (data.error !== undefined) patch.error = data.error;
    if (data.endedAt !== undefined) patch.endedAt = data.endedAt;
    const existing = state.sessions.find((s) => s.id === id);
    sessionSummaryRevision++;
    if (id === state.currentSessionId) sessionDetailRevision++;
    if (existing) {
      Object.assign(existing, patch);
    } else {
      state.sessions.unshift({ ...patch, trigger: data.trigger || '', triggerSummary: data.triggerSummary || '', startedAt: data.startedAt ?? Date.now() });
      state.sessionTotal = Math.max(Number(state.sessionTotal) || 0, state.sessions.length);
    }
    // 详情 patch 合并暂存，渲染合批到每帧一次（不再来一条事件全量重建一次）
    pendingSessionDetail.set(id, { ...pendingSessionDetail.get(id), ...patch });
    scheduleSessionRender();
  });
  es.addEventListener('session-end', (ev) => {
    if (isPeerView()) return;   // 统一控制台：查看对端时不混入本机会话事件
    let data = {};
    try { data = JSON.parse(ev.data); } catch { /* 数据坏了也照常刷列表 */ }
    sessionSummaryRevision++;
    scheduleSSERefresh({ sessions: true, chats: true, status: true });
    // ⚠️ 会话刚结束必须主动重拉一次详情：轮询只刷 running/waiting 的会话，
    //    最终态（sent / finishReason / error）之后再也不来 —— 不重拉的话，
    //    "已发送到 QQ"徽标和收尾状态只能等用户手动刷新才出现。
    const id = data.sessionId;
    if (id && id === state.currentSessionId) {
      pendingSessionDetail.delete(id);   // 丢弃残留的过期 patch，防止把刚拉的最终态回闪成旧值
      sessionDetailRevision++;
      scheduleSSERefresh({ detail: true });
    }
  });
  es.addEventListener('chat-update', () => {
    scheduleSSERefresh({ chats: true, status: true });
  });
  es.addEventListener('memory-update', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch { data = { phase: 'refresh' }; }
    const phase = data.phase || '';
    const chatKey = data.chatKey || '';

    // 状态一律记进 state（不依赖当前 DOM），这样切走页签再切回也能恢复显示。
    // 原先只操作 DOM 且 tab 不对就 return，导致切回来完全看不出整理是否还在跑。
    if (phase === 'consolidate-start') {
      if (chatKey) state.consolidating[chatKey] = { startedAt: Date.now() };
    } else if (phase === 'consolidate-done') {
      if (chatKey) delete state.consolidating[chatKey];
      if (chatKey) state.consolidateResult[chatKey] = { note: data.note || '整理完成', at: Date.now() };
    } else if (phase === 'consolidate-error') {
      if (chatKey) delete state.consolidating[chatKey];
      if (chatKey) {
        state.consolidateResult[chatKey] = { note: `整理失败：${data.error || '未知错误'}`, at: Date.now(), failed: true };
      }
    }

    // 只有停在记忆页时才操作 DOM / 刷新列表
    if (state.tab !== 'memory') return;

    if (phase === 'consolidate-start') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = true;
      if (status) status.textContent = '整理中…';
      renderMemoryList();
    } else if (phase === 'consolidate-done') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = false;
      if (status) status.textContent = data.note || '整理完成';
      loadMemoryView();
    } else if (phase === 'consolidate-error') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = false;
      if (status) status.textContent = `整理失败：${data.error || '未知错误'}`;
      renderMemoryList();
    } else {
      loadMemoryView();
    }
  });
  es.addEventListener('onebot-status', () => {
    scheduleSSERefresh({ status: true, snowluma: true });
  });
  es.addEventListener('status', () => scheduleSSERefresh({ status: true }));
  es.addEventListener('peer-status', (ev) => {
    let d = {};
    try { d = JSON.parse(ev.data || '{}'); } catch { /* 坏数据跳过本条，不断流 */ }
    state.peer = d || null;
    paintPeerStatus(state.peer);
  });
  es.addEventListener('snowluma-status', () => scheduleSSERefresh({ status: true, snowluma: true }));
  es.addEventListener('qq-portable-status', () => scheduleSSERefresh({ status: true, snowluma: true }));
  es.addEventListener('qq-portable-log', () => scheduleSSERefresh({ snowluma: true }));
  es.addEventListener('snowluma-log', (ev) => {
    let d = {};
    try { d = JSON.parse(ev.data); } catch { /* 坏数据跳过本条，不断流 */ }
    if (!appReady && d?.text) {
      setLoadingStatus(d.text);
    }
    if (appReady && (state.tab === 'snowluma' || state.tab === 'settings')) {
      scheduleSSERefresh({ logs: true });
    }
  });
  es.addEventListener('feedback', (ev) => {
    let d = {};
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.level === 'error') console.warn('[agent 反馈]', d.message);
  });
  // 视觉能力扫描进度：POST /api/vision/scan 是异步的（202），完成后靠这个事件告诉前端。
  // 此前后端会 emit 但全项目没有任何监听者，扫描结果只能在重载页面后才看得到。
  es.addEventListener('vision-scan', async (ev) => {
    let d = {};
    try { d = JSON.parse(ev.data); } catch { /* ignore */ }
    // 2026-09-19（M9 清理）：扫描入口搬到「模型配置」弹窗（mc-vision-hint 承接进度）。
    const hint = $('#mc-vision-hint');
    if (hint) {
      if (d.phase === 'start') hint.textContent = '扫描中…（会真实请求每个模型，请稍候）';
      else if (d.phase === 'done') hint.textContent = `完成：${d.total ?? 0} 个模型`;
      else if (d.phase === 'error') hint.textContent = `失败：${d.error || '未知错误'}`;
    }
    if (d.phase === 'done' || d.phase === 'error') {
      try {
        const v = await api('/api/vision/results');
        state.visionResults = v.results || {};
        state.visionScanning = !!v.scanning;
        if (state.tab === 'settings') renderSettings();
      } catch { /* 拉结果失败就保持现状 */ }
    }
  });
  es.onerror = () => { /* EventSource 自动重连 */ };
}

// ── 会话视图 ──
let sessionListInflight = null;
let sessionSummaryRevision = 0;
let sessionDetailRevision = 0;
let sessionSelectionRevision = 0;
const sessionDetailInflight = new Map();
const SESSION_FETCH_PAGE = 100;
const SESSION_FETCH_MAX = 500;
function loadSessions({ quiet = false, refreshDetail = true } = {}) {
  const scope = currentSessionScope();
  if (sessionListInflight?.scope === scope) return sessionListInflight.promise;
  const revision = sessionSummaryRevision;
  // Keep the entire already-loaded prefix. Each HTTP page respects the server's 500-row limit.
  const wanted = Math.max(SESSION_FETCH_PAGE, (state.sessions || []).length);
  const request = { scope, promise: null };
  request.promise = (async () => {
    try {
      const sessions = [], seen = new Set(); let offset = 0, total = Infinity;
      while (sessions.length < wanted && offset < total) {
        const limit = Math.min(SESSION_FETCH_MAX, wanted - sessions.length);
        const data = await api(`/api/sessions?limit=${limit}&offset=${offset}`);
        if (scope !== currentSessionScope()) return;
        const page = Array.isArray(data.sessions) ? data.sessions : [];
        total = Number.isFinite(Number(data.count)) ? Math.max(0, Number(data.count)) : offset + page.length;
        for (const s of page) if (!seen.has(s.id)) { seen.add(s.id); sessions.push(s); }
        offset += page.length; if (!page.length) break;
      }
      if (revision !== sessionSummaryRevision) { scheduleSSERefresh({ sessions: true }); return; }
      state.sessions = sessions; state.sessionTotal = Number.isFinite(total) ? total : sessions.length;
      renderSessionList();
      if (state.autoFollowRunning && !state.currentSessionId) { const active = sessions.find((s) => s.status === 'waiting' || s.status === 'running'); if (active) await selectSession(active.id); }
      else if (refreshDetail && state.currentSessionId) { const cur = sessions.find((s) => s.id === state.currentSessionId); if (cur && (cur.status === 'running' || cur.status === 'waiting')) await loadSessionDetail(cur.id, { quiet: true }); }
    } catch (error) { if (!quiet && scope === currentSessionScope()) console.error(error); }
    finally { if (sessionListInflight === request) sessionListInflight = null; }
  })();
  sessionListInflight = request; return request.promise;
}

async function loadMoreSessions() {
  const scope = currentSessionScope();
  if (state.sessionPageLoading) return;
  state.sessionPageLoading = true;
  try {
    if (sessionListInflight?.scope === scope) await sessionListInflight.promise;
    if (scope !== currentSessionScope()) return;
    const all = state.sessions || [];
    if (state.sessionLimit >= all.length && all.length < (state.sessionTotal || 0)) {
      const revision = sessionSummaryRevision, offset = all.length;
      const request = { scope, promise: null };
      request.promise = api(`/api/sessions?limit=${SESSION_FETCH_PAGE}&offset=${offset}`).then((page) => {
        if (scope !== currentSessionScope()) return;
        if (revision !== sessionSummaryRevision) { scheduleSSERefresh({ sessions: true }); return; }
        const seen = new Set(state.sessions.map((s) => s.id));
        state.sessions.push(...(page.sessions || []).filter((s) => !seen.has(s.id)));
        state.sessionTotal = page.count ?? state.sessionTotal;
      }).finally(() => { if (sessionListInflight === request) sessionListInflight = null; });
      sessionListInflight = request; await request.promise;
    }
    if (scope !== currentSessionScope()) return;
    if (state.sessionLimit < state.sessions.length) state.sessionLimit = Math.min(state.sessions.length, state.sessionLimit + SESSION_PAGE);
    renderSessionList();
  } catch (error) { if (scope === currentSessionScope()) console.warn('[会话分页]', error?.message || error); }
  finally { state.sessionPageLoading = false; }
}

// 会话列表定时刷新：只要停在会话页，就持续更新列表（运行中会话也会轮询详情）
// 间隔取自配置的 ui.refreshMs（设置页「界面刷新间隔」）；此前这里硬编码 4000，
// 配置项从未被读取 —— 用户改了完全没效果。
let listPoller = null;
function refreshIntervalMs() {
  const n = Number(state.config?.ui?.refreshMs);
  // 兜底值必须与后端 DEFAULT_CONFIG.ui.refreshMs 一致（15000），
  // 否则"拿不到配置"时前端按 4 秒轮询、后端默认 15 秒，两边对不上。
  return Number.isFinite(n) && n >= 1000 ? n : 15000;
}

/**
 * 状态栏轮询。用 setTimeout 自续期而不是 setInterval：
 * 每一轮都重新读 ui.refreshMs，用户在设置页改「界面刷新间隔」后立刻生效，
 * 不必刷新页面（此前这里是 setInterval(..., 15000) 写死的，改了设置不生效）。
 */
let statusPollTimer = null;
function startStatusPoller() {
  if (statusPollTimer) { clearTimeout(statusPollTimer); statusPollTimer = null; }
  const tick = async () => {
    try { await refreshStatus(); } catch { /* 单次失败不中断轮询 */ }
    statusPollTimer = setTimeout(tick, refreshIntervalMs());
  };
  statusPollTimer = setTimeout(tick, refreshIntervalMs());
}
/**
 * 给滚动容器挂"滚到底部就加载更多"的监听。
 *
 * 要点：
 *   1. 节流必须带"尾随调用"：曾经是被节流的事件直接丢弃 —— 快速滚动时
 *      事件密集，"抵达底部"那一下几乎总是落在 120ms 窗口内被扔掉，
 *      用户停手后又不会再有新事件 → 加载永远不触发，表现为
 *      "滚得快会滚不下去，像撞墙"。现在窗口内的事件会留下一个尾随定时器，
 *      停手后最多 120ms 内补一次检查。
 *   2. 距底部 <400px 就触发（曾经是 100px）：快速甩滚时惯性大，
 *      100px 的提前量太小，内容还没加载出来人已经撞底了。
 *   3. 交给 onLoadMore 自己判断是否真有更多数据；没有就直接返回，避免空转重渲染
 */
function attachScrollLoader(elId, onLoadMore) {
  const el = document.getElementById(elId);
  if (!el) return;

  // ⚠️ 防重复绑定：这个函数会被多次调用（渲染一次调一次），
  //    曾经没做防护，结果加载 N 批就挂了 N 个监听器 ——
  //    滚一次会同时触发 N 次 onLoadMore，一次跳好几批，
  //    而且每个监听器各有自己的 last 变量，120ms 节流形同虚设。
  //    这里把状态存在元素自身上，重复调用直接复用。
  if (el.__scrollLoader) {
    el.__scrollLoader.onLoadMore = onLoadMore;   // 只更新回调，不重复挂监听
    return;
  }
  const stateLoader = { last: 0, pending: null, onLoadMore };
  el.__scrollLoader = stateLoader;

  const THROTTLE_MS = 120;
  const NEAR_BOTTOM_PX = 400;
  const check = () => {
    stateLoader.last = Date.now();
    // scrollTop + 可视高度 >= 总高度 - 400 就认为快到底了
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX) stateLoader.onLoadMore();
  };

  el.addEventListener('scroll', () => {
    const elapsed = Date.now() - stateLoader.last;
    if (elapsed >= THROTTLE_MS) {
      // 窗口外的正常事件：立即处理；有尾随定时器就取消（避免重复检查）
      if (stateLoader.pending) { clearTimeout(stateLoader.pending); stateLoader.pending = null; }
      check();
    } else if (!stateLoader.pending) {
      // 窗口内被节流的事件：不丢，留一个尾随调用 —— 停手后补做最后一次检查
      stateLoader.pending = setTimeout(() => { stateLoader.pending = null; check(); }, THROTTLE_MS - elapsed);
    }
  }, { passive: true });
}

/** 会话列表：滚到底部再加载 SESSION_PAGE 条。 */
function initSessionScrollLoader() {
  attachScrollLoader('session-list', loadMoreSessions);
}

/**
 * 存档页消息列表：滚到底部再追加 CHAT_MSG_MORE 条。
 *
 * ⚠️ 监听目标是 #chat-detail —— 它自带 .detail-pane 类（overflow-y:auto），
 *   是真正滚动的容器。曾经在它内部又套了一层 .archive-scroll 想做内层滚动，
 *   结果内层没有高度基准、被内容撑开，滚动事件全发生在外层，
 *   导致监听挂空、"继续滚动没反应"。现在只保留一层滚动容器。
 *
 * ⚠️ 加载更多只走"追加"（appendChatMessageRows）：
 *   曾经这里调 updateChatMessagesBody(true)，每批都要全量 sort + 全量
 *   innerHTML 重建（行数越滚越多），还有 scrollTop 补偿把视口"吸"在底部
 *   → 连锁触发下一批加载 → 主线程被反复长阻塞，
 *   表现为"滑到临界线继续向下滚动反应迟钝"。
 */
function initChatScrollLoader() {
  attachScrollLoader('chat-detail', () => loadMoreChatMessages());
}

function startListPoller() {
  if (listPoller) clearInterval(listPoller);
  listPoller = setInterval(() => {
    // 页面不可见（最小化/被遮挡）时跳过用量页轮询：大数据下 stats 重算
    // 即便有缓存也要几百毫秒，后台一直跑是纯浪费。会话/存档等轻页签不受影响。
    const skipUsage = document.hidden;
    if (state.tab === 'sessions') loadSessions({ quiet: true });
    if (state.tab === 'chats') loadChats({ quiet: true });
    if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true });
    if (state.tab === 'usage' && !skipUsage) loadUsageView();   // 无 force：只更新数值，不重建 DOM
    if (state.tab === 'settings') refreshStatus();
  }, refreshIntervalMs());
  // 从后台切回：立刻刷一次用量（刚才跳过的补上），数字不会"停在过去"
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.tab === 'usage') loadUsageView();
  });
}
startListPoller();

/* ── 该群的回复频率（= 人设里的「参与度」档位）──
   口径与后端 src/config.js#personaForChat 完全一致：**分群人设优先，没单独设就跟随全局**。
   ⚠️ 键格式必须两种都认：UI 保存时可能写 `group:123`，也可能只写 `123`
   （后端注释里记着这个坑：只认一种 → 存了却永不生效）。所以先按 chatKey 查、再按纯 id 查。
   展示成"标签语言"的小胶囊（淡底 + 同色字 + 无描边），跟状态徽标同一族；
   ❌ 不要做成按钮（有描边）——它只是信息，不是控件。 */
const REPLY_FREQ_LABEL = { low: '安静型', medium: '普通群友', high: '活跃型' };
const REPLY_FREQ_DESC = {
  low: '很少主动搭话，只在被 @ 或明显需要时才回',
  medium: '跟普通群友一样，聊到就接两句',
  high: '活跃，群里热闹时会主动插话'
};
function replyFreqOf(chatKey) {
  const cfg = state.config || {};
  const id = String(chatKey || '').split(':')[1] || '';
  const perChat = cfg.personaByChat || {};
  const conf = perChat[String(chatKey)] || (id ? perChat[id] : null) || {};
  const level = conf.participation || cfg.persona?.participation || 'medium';
  const perChatOwn = Boolean(conf.participation);
  const label = REPLY_FREQ_LABEL[level] || REPLY_FREQ_LABEL.medium;
  return {
    level, label, perChatOwn,
    tip: `回复频率：${label}（${REPLY_FREQ_DESC[level] || ''}）· ${perChatOwn ? '本群单独设置' : '跟随全局设置'}`
  };
}
/** 回复频率胶囊的 HTML（列表卡片与详情头共用，保证两处长得一样） */
function replyFreqChip(chatKey) {
  const f = replyFreqOf(chatKey);
  return `<span class="session-freq freq-${esc(f.level)}" title="${esc(f.tip)}">${esc(f.label)}</span>`;
}

function renderSessionList() {
  const box = $('#session-items');
  state.seenSessionIds = state.seenSessionIds || new Set();
  // 分页：一次只渲染 sessionLimit 条，滚到底部再加载下一批（见 SESSION_PAGE 常量）。
  // 会话可能积累到几百条，全量渲染会让列表变卡。
  state.sessionLimit = Math.max(SESSION_PAGE, Number(state.sessionLimit) || SESSION_PAGE);
  const all = state.sessions || [];
  const shown = all.slice(0, state.sessionLimit);
  const total = Math.max(all.length, Number(state.sessionTotal) || 0);
  const rest = total - shown.length;
  box.innerHTML = shown.map((s) => {
    const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
    const waitHtml = s.status === 'waiting' && s.waitUntil
      ? `<span class="session-wait" data-until="${Number(s.waitUntil)}">等待中 · ${fmtWaitRemain(Number(s.waitUntil))}</span>`
      : '';
    const activityHtml = s.status === 'running' && s.activity
      ? `<span class="session-activity">${esc(s.activity)}</span>`
      : '';
    // 统计行（token / 缓存命中率 / 轮数 / 搜索）：**单独占一行**，不再和状态挤同一行 ——
    // 之前七八个元素全塞进一行，窄侧栏下 flex 会把状态徽标压成竖排（运/行/中）、
    // 数字被断成两行，观感很臃肿。
    const cacheRate = fmtCacheRate(s.usage);   // 这一轮会话的缓存命中率（无数据时为空串）
    const toolCalls = countToolCalls(s);       // 工具调用次数（0 时不显示，跟「搜」保持一致的克制）
    const statParts = [s.usage ? fmtTokens(s.usage.totalTokens) : '-'];
    if (cacheRate) statParts.push(`<span class="cache-rate" title="本轮 prompt 命中前缀缓存的比例">${cacheRate}</span>`);
    statParts.push(`${s.rounds || 0} 轮`);
    if (toolCalls > 0) statParts.push(`<span class="tool-calls" title="本轮一共调用了 ${toolCalls} 次工具">工具 ${toolCalls}</span>`);
    if (Number(s.webSearchCount) > 0) statParts.push(`搜 ${s.webSearchCount}`);
    const statsText = s.status !== 'waiting' ? statParts.join(' · ') : '';
    const isNew = !state.seenSessionIds.has(s.id);
    // 失败会话的重试按钮：只有 error 状态且没发出过消息的才显示
    // （已发言的重试会导致群里重复内容，后端同样会拒绝）
    const retryHtml = s.status === 'error' && !(s.sent && s.sent.length)
      ? `<button class="btn btn-small session-retry-btn" data-id="${esc(s.id)}" title="把这条会话的触发消息翻回未读并重新处理">重试</button>`
      : '';
    // 运行中/等待中会话的中止按钮：运行中在下一轮请求前安全收尾，等待中直接干净消失
    const abortHtml = (s.status === 'running' || s.status === 'waiting')
      ? `<button class="btn btn-small btn-danger session-abort-btn" data-id="${esc(s.id)}" title="中止这次处理（已发出的消息不受影响）">中止</button>`
      : '';
    // 动作按钮统一靠右（状态/活动在左），不跟状态徽标抢宽度
    const actsHtml = (retryHtml || abortHtml)
      ? `<span class="session-meta-acts">${retryHtml}${abortHtml}</span>`
      : '';
    // 统计行统一**排在运行状态的下方**（用户要求：状态一行、数据一行，别混在一行里）
    return `
      <div class="session-item ${s.id === state.currentSessionId ? 'selected' : ''} ${s.status === 'waiting' ? 'session-waiting-row' : ''} ${isNew ? 'new-item' : ''}" data-id="${s.id}">
        <div class="session-title">
          <!-- 标题行改成固定三列后群名列变窄（~121px），长群名会被省略号截断 ——
               补 title 让鼠标悬停仍能看全名（tooltip.js 已全局接管 title，不会出黄块）。 -->
          <span class="session-chat" title="${esc(chatName)}">${esc(chatName)}</span>
          ${replyFreqChip(s.chatKey)}
          <span class="session-time">${fmtTime(s.startedAt)}</span>
        </div>
        <div class="session-trigger">${esc(s.trigger || '')}</div>
        <div class="session-meta">
          <span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
          ${waitHtml}
          ${activityHtml}
          ${actsHtml}
        </div>
        ${statsText ? `<div class="session-stats">${statsText}</div>` : ''}
      </div>`;
  }).join('');
  // 底部提示：还有多少条没显示 / 已全部显示
  const more = $('#session-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更多（还有 ${rest} 条）`
      : (all.length > SESSION_PAGE ? `已显示全部 ${total} 条` : '');
  }
  // 头部显示总数（已显示 / 总数），便于确认分页是否真的加载完了
  const cnt = $('#session-count');
  if (cnt) {
    cnt.textContent = total ? `${shown.length}/${total}` : '';
  }
  for (const s of state.sessions) state.seenSessionIds.add(s.id);
  $$('.session-item', box).forEach((el) => {
    el.addEventListener('click', () => selectSession(el.dataset.id));
  });
  // 失败会自动重试一次的 api 封装（用于"偶发 failed to fetch"的点击类操作：
  // 中止/重试等）。后端在收尾时会做同步落盘（大会话 JSON 写盘可达几百毫秒），
  // 期间其它请求会在 TCP 队列里排队；偶发的连接抖动/瞬间拒绝会以
  // TypeError: Failed to fetch 冒出来 —— 这类瞬态失败重试一次几乎必成。
  // 只重试网络层失败（TypeError），HTTP 4xx/5xx 是服务器的明确答复，不重试。
  async function apiWithRetry(path, options = {}, retries = 1) {
    try {
      return await api(path, options);
    } catch (err) {
      const transient = err instanceof TypeError || /failed to fetch|network|load failed/i.test(String(err?.message || ''));
      if (!transient || retries <= 0) throw err;
      await new Promise((r) => setTimeout(r, 350));
      return apiWithRetry(path, options, retries - 1);
    }
  }

  // 失败会话的「重试」：把触发消息翻回未读并重新处理。
  // stopPropagation：点了重试就别选中这条会话（用户意图是重跑，不是看详情）
  $$('.session-retry-btn', box).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = '重试中…';
      try {
        const r = await apiWithRetry(`/api/sessions/${encodeURIComponent(btn.dataset.id)}/retry`, {
          method: 'POST',
          body: '{}'
        });
        if (!r.ok) throw new Error(r.error || '无法重试');
        // 新会话由唤醒流程创建；列表靠 SSE/轮询刷新，这里立即拉一次
        await loadSessions({ quiet: true });
      } catch (err) {
        alert(`重试失败：${err.message}`);
        btn.disabled = false;
        btn.textContent = '重试';
      }
    });
  });
  // 运行中/等待中的「中止」：请求后端安全收尾这条会话。
  // 中止是"尽快别再继续"，不是立即截断 —— 后端在下一轮 LLM 请求前收尾，
  // 已发出的消息不受影响。列表刷新靠 SSE/轮询，这里立即拉一次。
  $$('.session-abort-btn', box).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = '中止中…';
      try {
        const r = await apiWithRetry(`/api/sessions/${encodeURIComponent(btn.dataset.id)}/abort`, {
          method: 'POST',
          body: '{}'
        });
        if (!r.ok) throw new Error(r.error || '无法中止');
        await loadSessions({ quiet: true });
      } catch (err) {
        alert(`中止失败：${err.message}`);
        btn.disabled = false;
        btn.textContent = '中止';
      }
    });
  });
  // 等待中会话的剩余时间按 0.1s 本地刷新（不重新拉列表）
  if ($$('.session-wait[data-until]', box).length) startWaitTicker();
}

function fmtWaitRemain(untilMs) {
  const remain = Math.max(0, Number(untilMs) - Date.now());
  return `${(remain / 1000).toFixed(1)}s`;
}

let waitTicker = null;
function startWaitTicker() {
  if (waitTicker) return;
  waitTicker = setInterval(() => {
    const els = $$('.session-wait[data-until]');
    if (!els.length) {
      clearInterval(waitTicker);
      waitTicker = null;
      return;
    }
    for (const el of els) {
      const until = Number(el.dataset.until);
      const remain = until - Date.now();
      el.textContent = remain > 0 ? `等待中 · ${(remain / 1000).toFixed(1)}s` : '等待中 · 启动…';
    }
  }, 100);
}

async function selectSession(id) {
  sessionSelectionRevision++; sessionDetailRevision++;
  pendingSessionDetail.clear();
  state.currentSessionId = id;
  state.sessionDetail = null;
  lastDetailFp = null;
  renderSessionList();
  $('#session-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadSessionDetail(id);
}

// 上次渲染会话详情的指纹：内容没变就不重渲染（轮询期间避免闪烁与滚动重置）
let lastDetailFp = null;

function loadSessionDetail(id, { quiet = false, offset = null } = {}) {
  const scope = currentSessionScope(), selection = sessionSelectionRevision, revision = sessionDetailRevision;
  const pageOffset = offset ?? (state.sessionDetail?.id === id ? state.sessionDetail.detailPage?.offset : 0) ?? 0;
  const existing = sessionDetailInflight.get(id);
  if (existing && existing.scope === scope && existing.selection === selection && existing.offset === pageOffset) return existing.promise;
  const request = { scope, selection, offset: pageOffset, promise: null };
  request.promise = (async () => {
    try {
      const s = await api(`/api/sessions/${encodeURIComponent(id)}${pageOffset ? `?offset=${pageOffset}&limit=100` : ''}`);
      if (scope !== currentSessionScope() || selection !== sessionSelectionRevision || state.currentSessionId !== id) return;
      if (sessionDetailInflight.get(id) !== request) return;
      if (revision !== sessionDetailRevision) { scheduleSSERefresh({ detail: true }); return; }
      state.sessionDetail = s;
      if (state.tab === 'sessions') renderSessionDetail(s);
    } catch (error) {
      if (!quiet && scope === currentSessionScope() && selection === sessionSelectionRevision && state.currentSessionId === id && sessionDetailInflight.get(id) === request) {
        $('#session-detail').innerHTML = `<div class="empty-hint">加载失败：${esc(error.message)}${isPeerView() ? '' : `<br><a href="${sessionArchiveUrl(id)}" download>下载完整会话档案</a>`}</div>`;
      }
    } finally { if (sessionDetailInflight.get(id) === request) sessionDetailInflight.delete(id); }
  })();
  sessionDetailInflight.set(id, request); return request.promise;
}

function sessionArchiveUrl(id) {
  return `/api/sessions/${encodeURIComponent(id)}/download`;
}

function renderSessionDetail(s) {
  const detail = $('#session-detail');
  if (!detail) return;
  // 内容没变（轮询/SSE 重复推送）→ 完全不动 DOM，保住滚动位置和展开状态
  // json 模式切换也要触发重渲染
  const fp = `${s.id}|${s.status}|${s.rounds || 0}|${(s.messages || []).length}|${(s.sent || []).length}|${s.detailPage?.offset ?? 0}|${s.detailPage?.total ?? 0}|${s.error ? 1 : 0}|${s.activity || ''}|${state.sessionJsonMode === s.id ? 'json' : 'ui'}`;
  if (lastDetailFp === fp) return;
  const firstRender = lastDetailFp === null;
  lastDetailFp = fp;

  // 保留用户的阅读位置；仅当用户本来就贴着底部时才跟随新内容（聊天式）
  const wasAtBottom = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 48;
  const keepScroll = detail.scrollTop;
  const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
  const statusBadge = `<span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`;
  const usage = s.usage || {};
  // 这一轮会话的缓存命中率（显示在总 token 后面 —— 用户要求）
  const cacheRate = fmtCacheRate(usage);

  const html = [];
  const canDelete = s.status !== 'running';   // 运行中的会话不能删（usage 还在累加）
  html.push(`
    <div class="detail-header">
      <h2>${esc(chatName)} ${replyFreqChip(s.chatKey)} ${statusBadge}
        <button class="btn btn-small" id="json-mode-btn" style="margin-left:10px">JSON 模式</button>
        ${canDelete ? `<button class="btn btn-small btn-danger" id="session-delete-btn" style="margin-left:6px" title="删除这条会话记录">删除</button>` : ''}
      </h2>
      <div class="sub">
        <span>触发：${esc(s.triggerSummary || (s.trigger === 'proactive' ? '主动机会' : '-'))}</span>
        <span>开始 ${fmtClock(s.startedAt)}${s.endedAt ? ` · 结束 ${fmtClock(s.endedAt)}` : ' · 进行中'}</span>
        <span>模型 ${esc(s.model || '-')}</span>
        <span>${usage.calls || 0} 次调用 · ${fmtTokens(usage.promptTokens)} 入 / ${fmtTokens(usage.completionTokens)} 出 / ${fmtTokens(usage.totalTokens)} 总${cacheRate ? ` · <span class="cache-rate" title="本轮 prompt 命中前缀缓存的比例">${cacheRate}</span>` : ''}</span>
        <span>${s.rounds || 0} 轮</span>
        <span>工具调用 ${countToolCalls(s)} 次</span>
        <span>联网搜索 ${Number(s.webSearchCount) || 0} 次</span>
      </div>
    </div>`);

  if (s.detailPage) {
    const page = s.detailPage;
    html.push(`<div class="sub" style="margin:12px 0">
      过程记录 ${page.returned ? page.offset + 1 : 0}–${page.offset + page.returned} / ${page.total} 条
      ${page.offset ? '<button class="btn btn-small" id="session-detail-first">回到开头</button>' : ''}
      ${page.hasMore ? '<button class="btn btn-small" id="session-detail-more">查看后续记录</button>' : ''}
      ${isPeerView() ? '' : `<a href="${sessionArchiveUrl(s.id)}" download>下载完整档案</a>`}
      ${page.truncated ? '<span> · 部分长内容已缩短，完整内容保存在下载档案中。</span>' : ''}
    </div>`);
  }

  const jsonMode = state.sessionJsonMode === s.id;
  if (jsonMode) {
    // JSON 模式：原模原样展示输入给模型的内容 + 模型返回的原始内容
    const raw = {
      sessionId: s.id,
      chatKey: s.chatKey,
      model: s.model || '',
      systemPrompt: s.systemPrompt || '',
      userPrompt: s.userPrompt || '',
      inputMessages: (s.inputMessages || []).map((m) => ({ role: m.role, content: m.content })),
      llmMessages: (s.messages || []).filter((m) => m.role === 'assistant').map((m) => ({
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls ?? null,
        raw: m.raw ?? null
      })),
      toolResults: (s.messages || []).filter((m) => m.toolCall).map((m) => ({
        toolCall: m.toolCall
      })),
      sent: s.sent || [],
      usage: s.usage || null,
      status: s.status,
      error: s.error ?? null
    };
    html.push(`
      <details class="collapsible" open>
        <summary>JSON 模式（模型输入/输出的原始内容）</summary>
        <div class="coll-body" style="max-height:none">${esc(JSON.stringify(raw, null, 2))}</div>
      </details>`);
  } else {
    if (s.systemPrompt) {
      html.push(`
        <details class="collapsible">
          <summary>系统提示（${s.systemPrompt.length} 字符，每次运行重发）</summary>
          <div class="coll-body">${esc(s.systemPrompt)}</div>
        </details>`);
    }
    if (s.userPrompt) {
      html.push(`
        <details class="collapsible" open>
          <summary>本次输入（${s.userPrompt.length} 字符 —— 零对话历史，全部来自 JSON 存档）</summary>
          <div class="coll-body">${esc(s.userPrompt)}</div>
        </details>`);
    }
  }

  html.push('<div class="msg-flow">');
  if (!jsonMode) {
    for (const item of s.messages || []) {
      if (item.toolCall) {
        html.push(`
          <div class="tool-card-flow ${item.toolCall.isError ? 'tool-error' : ''}">
            <div class="tool-head"><span class="tool-name-flow">${esc(item.toolCall.name)}</span></div>
            <div class="tool-args">${esc(JSON.stringify(item.toolCall.args, null, 1))}</div>
            <div class="tool-result ${item.toolCall.isError ? 'is-error' : ''}">${esc(item.toolCall.result)}</div>
          </div>`);
      } else if (item.toolImages) {
        html.push(`
          <div class="tool-card-flow">
            <div class="tool-head"><span class="tool-name-flow">${esc(item.toolImages.tool)}</span>
            <span class="muted">→ ${item.toolImages.count} 张图片已作为图像输入注入模型</span></div>
          </div>`);
      } else if (item.role === 'assistant') {
        const text = typeof item.content === 'string' ? item.content : '';
        if (item.tool_calls && item.tool_calls.length && !text.trim()) continue; // 纯工具调用轮，卡片已展示
        html.push(`
          <div class="bubble bubble-assistant">
            <div class="asr-label">思考（不发送）</div>
            ${esc(text || '（无文本输出，仅调用工具）')}
          </div>`);
      }
    }
    // 发出的消息
    for (const sent of s.sent || []) {
      html.push(`
        <div class="sent-badge">
          <div class="asr-label">已发送到 QQ${sent.at ? ` · ${esc(sent.at)}` : ''}</div>
          ${esc(sent.text)}
        </div>`);
    }
  }
  if (s.error) html.push(`<div class="session-error">${esc(s.error)}</div>`);
  if (s.finishReason) html.push(`<div class="bubble bubble-user">finish：${esc(s.finishReason)}</div>`);
  html.push('</div>');

  // 折叠面板的展开状态也要保留（否则每次刷新"系统提示"都被折回去）
  const openStates = new Map();
  detail.querySelectorAll('details.collapsible').forEach((d, i) => openStates.set(i, d.open));
  detail.innerHTML = html.join('');
  detail.querySelectorAll('details.collapsible').forEach((d, i) => { if (openStates.has(i)) d.open = openStates.get(i); });
  const moreDetail = $('#session-detail-more');
  if (moreDetail) moreDetail.addEventListener('click', async () => {
    moreDetail.disabled = true;
    await loadSessionDetail(s.id, { offset: s.detailPage.nextOffset });
  });
  const firstDetail = $('#session-detail-first');
  if (firstDetail) firstDetail.addEventListener('click', () => loadSessionDetail(s.id, { offset: 0 }));
  const jsonBtn = $('#json-mode-btn');
  if (jsonBtn) jsonBtn.addEventListener('click', () => {
    state.sessionJsonMode = state.sessionJsonMode === s.id ? null : s.id;
    lastDetailFp = null;   // 强制重渲染
    renderSessionDetail(s);
  });
  // 删除这条会话记录
  const delBtn = $('#session-delete-btn');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm(`确定删除这条会话记录？\n\n触发：${s.triggerSummary || '-'}\n时间：${fmtClock(s.startedAt)}\n\n删除后不可恢复（不影响用量统计的历史数据）。`)) return;
    try {
      await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
      state.currentSessionId = null;
      state.sessions = (state.sessions || []).filter((x) => x.id !== s.id);
      $('#session-detail').innerHTML = '<div class="empty-hint">← 选择左侧会话查看完整过程</div>';
      renderSessionList();
      loadSessions({ quiet: true });
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
  if (firstRender || (s.status === 'running' && wasAtBottom)) {
    detail.scrollTop = detail.scrollHeight;      // 首次打开 / 贴底跟随新内容
  } else {
    detail.scrollTop = keepScroll;               // 保留阅读位置
  }
  // 说明：此处原先有一段"运行中每 2s 自递归拉详情"的兜底轮询，已移除。
  // 原因：renderSessionDetail 会被 SSE 事件和 4s 主轮询反复调用，每次都新起一个
  // setTimeout 且从不取消旧的，切换/高频刷新时 timer 会不断累积；
  // 而下面的 4s 主轮询（loadSessions）已经会对 running/waiting 的会话刷新详情，
  // 功能完全覆盖，2s 递归属于纯重复请求。
}
