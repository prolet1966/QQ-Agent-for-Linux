// 〔SnowLuma 页签〕——M9 拆分第 4 段
'use strict';
// ── SnowLuma 独立页签 ──
/**
 * 只刷新 SnowLuma 的日志区（不重建整个页面）。
 * SSE 每来一条新日志就调一次 —— 如果这里重建整页，
 * 用户正在看的日志会被反复重绘，滚动位置也保不住。
 */
async function refreshSnowlumaLogs() {
  const box = $('#snowluma-page');
  if (!box) return;
  // ⚠️ 必须按 id 取，不能 querySelector('.snowluma-logs-view') —— 页面上有 2~3 个日志面板
  //    （QQ 内核 / SnowLuma / 应用日志），取第一个会把 SnowLuma 的日志写进别的框里。
  const pre = box.querySelector('#sl-logs-view');
  if (!pre) return;                       // 页面还没渲染过，等下次整页刷新
  try {
    const logs = await api('/api/snowluma/logs');
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';
    // ⚠️ 先记贴底状态再换内容：新日志追加在底部，scrollTop 不变 = 阅读位置不变；
    //    只有用户本来就贴底才跟随到底，往上翻历史时绝不把他拽回去。
    //    滚动容器是 <pre> 自己（overflow-y:auto），不是 parentElement —— 之前滚错了对象。
    const wasAtBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
    pre.textContent = logText;
    // 空态类跟着走：居中提示态必须及时摘掉，否则来日志后会因为 align-items:center 被裁掉顶部
    pre.classList.toggle('is-empty', logText === '暂无日志');
    if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
  } catch { /* 刷新失败静默，不影响主流程 */ }
}

async function loadSnowlumaPage({ quiet = false } = {}) {
  // ── 骨架先行：进页签时 4 个接口要跑一瞬（/api/status 偶尔几百 ms），
  // 之前这段时间 #snowluma-page 是空的 → 整页只剩黑色背景 = 用户说的"黑屏"。
  // 骨架只在页面还没有正式内容时铺（quiet 轮询不动它，避免闪烁）。
  const boxEarly = $('#snowluma-page');
  if (boxEarly && !boxEarly.querySelector('.snowluma-page-card') && !boxEarly.querySelector('.snowluma-error-card')) {
    boxEarly.innerHTML = `
      <div class="snowluma-page-card">
        <h2>SnowLuma（OneBot 网关）</h2>
        <div class="sk-block">${'<div class="sk-row"></div>'.repeat(8)}</div>
        <div class="hint" style="margin-top:10px">正在读取 SnowLuma 状态…</div>
      </div>`;
  }
  try {
    // ⚠️ 之前是 Promise.all 裸跑：任何一个接口挂了（比如 /api/qq-portable/logs
    // 返回 500）整个 await 抛错被外层 catch 吞掉 → 页面永远停在骨架/空白。
    // 现在每个接口各自兜底，日志类失败给空数据；状态失败单独出错误卡 + 重试。
    const [status, logs, qqLogs, appLogsData] = await Promise.all([
      api('/api/status').catch(() => null),
      api('/api/snowluma/logs').catch(() => ({ logs: [] })),
      api('/api/qq-portable/logs').catch(() => ({ logs: [] })),
      api('/api/logs?limit=200').catch(() => ({ logs: [], level: 'info' }))
    ]);
    const box = $('#snowluma-page');
    if (!box) return;
    if (!status) {
      box.innerHTML = `
        <div class="snowluma-page-card snowluma-error-card">
          <h2>SnowLuma（OneBot 网关）</h2>
          <div class="empty-hint">⚠️ 状态读取失败（后端没有应答）。检查服务是否在运行，然后重试。</div>
          <button class="btn btn-small" id="sl-error-retry-btn" style="margin-top:10px">重试</button>
        </div>`;
      $('#sl-error-retry-btn')?.addEventListener('click', () => loadSnowlumaPage());
      return;
    }
    const s = status;
    const running = !!(s.snowluma?.running);
    const onebotConnected = !!s.onebot?.connected;
    const dir = s.snowluma?.dir || '';
    const embedded = !!s.snowluma?.embedded;
    const pid = s.snowluma?.pid ?? null;
    const webuiUrl = s.snowluma?.webuiUrl || '';
    // 便携 QQ 状态
    const qq = s.qqPortable || {};
    const qqReady = !!qq.ready;
    const qqRunning = !!qq.running;
    const qqPid = qq.pid ?? null;
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';
    const qqLogText = (qqLogs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';
    // 应用日志（logger 的内存环形缓冲）
    const appLogs = appLogsData.logs || [];
    const appLogLevel = appLogsData.level || 'info';
    const appLogText = appLogs.map((e) => {
      const t = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
      const lv = String(e.level || 'info').toUpperCase().padEnd(5);
      return `[${t}] [${lv}] [${e.module || '-'}] ${e.text}`;
    }).join('\n') || '暂无日志';

    // 整页重建前记住日志滚动位置：SSE/轮询触发的 quiet 重建会重置 DOM，
    // 不补偿的话用户往下翻日志会被弹回顶部（Kondius 实测：划两下就蹦上去）
    const oldPre = box.querySelector('#sl-logs-view');
    const prevScroll = oldPre
      ? { top: oldPre.scrollTop, atBottom: oldPre.scrollTop + oldPre.clientHeight >= oldPre.scrollHeight - 40 }
      : null;
    const oldAppPre = box.querySelector('#app-logs-view');
    const prevAppScroll = oldAppPre
      ? { top: oldAppPre.scrollTop, atBottom: oldAppPre.scrollTop + oldAppPre.clientHeight >= oldAppPre.scrollHeight - 40 }
      : null;

    // 总体状态：三层（QQ 内核 → SnowLuma → OneBot）任一层断了机器人都不会回消息，
    // 所以页头给一个"一句话结论"，细节留给下面的状态块。
    const overall = onebotConnected ? 'ok' : ((qqRunning || running) ? 'warn' : 'off');
    const overallText = overall === 'ok' ? '机器人工作中' : (overall === 'warn' ? '部分就绪' : '未启动');

    box.innerHTML = `
      <div class="snowluma-page-card">
        <div class="sl-head">
          <div class="sl-head-main">
            <h2>SnowLuma（OneBot 网关）</h2>
            <div class="sl-head-sub">QQ 内核 → SnowLuma → OneBot，三层全部就绪机器人才会回消息</div>
          </div>
          <span class="sl-chip is-${overall}"><span class="sl-chip-dot"></span>${overallText}</span>
        </div>

        <!-- 一键启动区域（核心入口）：连接成功后就收起来，不再占版面 -->
        ${!onebotConnected ? `
        <div class="sl-quick quick-start-section">
          <div class="sl-quick-head">
            <span class="sl-quick-title">快速启动</span>
            <span class="sl-quick-step">按顺序自动完成：启动 QQ → 启动 SnowLuma → 连接 OneBot</span>
          </div>
          <div class="sl-quick-body muted">
            ${!qqReady ? '便携 QQ 未安装，请先运行 <code>npm run setup</code>' :
              !qqRunning ? '点击下面按钮，自动完成：启动 QQ → 启动 SnowLuma → 连接 OneBot' :
              !running ? 'QQ 已运行，点击启动 SnowLuma 并连接' :
              'SnowLuma 已运行，等待 OneBot 连接…'}
          </div>
          <div class="sl-quick-actions">
            <button class="btn btn-primary" id="quick-start-btn" ${!qqReady ? 'disabled' : ''}>
              ${!qqReady ? '请先运行 npm run setup' :
                !qqRunning ? '一键启动（QQ + SnowLuma）' :
                !running ? '启动 SnowLuma' :
                '等待连接…'}
            </button>
            <span id="quick-start-hint" class="sl-hint"></span>
          </div>
        </div>` : ''}

        <!-- 运行状态：三层各一块，比一长串文字行好扫 -->
        <div class="sl-section">
          <div class="sl-section-title">运行状态</div>
          <div class="sl-tiles">
            <div class="sl-tile ${qqRunning ? 'is-on' : ''}">
              <div class="sl-tile-head">
                <span class="dot ${qqRunning ? 'dot-on' : 'dot-off'}"></span>
                <span class="sl-tile-name">QQ 内核</span>
              </div>
              <div class="sl-tile-value">${qqRunning ? '运行中' : (qqReady ? '未启动' : '未安装')}${qqPid ? `<em>pid ${qqPid}</em>` : ''}</div>
              <div class="sl-tile-foot" title="${esc(qq.dir || '')}">${qqReady ? esc(qq.dir || '未找到便携 QQ 目录') : '需先运行 npm run setup 安装便携 QQ'}</div>
            </div>

            <div class="sl-tile ${running ? 'is-on' : ''}">
              <div class="sl-tile-head">
                <span class="dot ${running ? 'dot-on' : 'dot-off'}"></span>
                <span class="sl-tile-name">SnowLuma</span>
              </div>
              <div class="sl-tile-value">${running ? '运行中' : '未运行'}${pid ? `<em>pid ${pid}</em>` : ''}</div>
              <div class="sl-tile-foot" title="${esc(dir || '')}">${embedded ? '内置模式（随 QQ Agent 退出）' : (running ? '独立模式' : (dir ? esc(dir) : '未找到项目内 snowluma/ 文件夹'))}</div>
              <div class="sl-tile-foot">${webuiUrl
                ? `<button class="sl-link-btn" id="sl-open-webui-btn" title="在浏览器中打开 SnowLuma 控制台">${esc(webuiUrl)} ↗</button>`
                : '<span class="sl-tile-none">WebUI 启动后自动识别</span>'}</div>
            </div>

            <div class="sl-tile ${onebotConnected ? 'is-on' : ''}">
              <div class="sl-tile-head">
                <span class="dot ${onebotConnected ? 'dot-on' : 'dot-off'}"></span>
                <span class="sl-tile-name">OneBot 连接</span>
              </div>
              <div class="sl-tile-value">${onebotConnected ? '已连接' : '未连接'}${s.onebot?.self ? `<em>${esc(s.onebot.self.nickname)}</em>` : ''}</div>
              <div class="sl-tile-foot">${onebotConnected
                ? 'WebSocket 通道正常，可收发群消息'
                : (s.onebot?.error ? esc(`WS：${s.onebot.error}`) : '等待协议端上报连接')}</div>
            </div>
          </div>
        </div>

        <!-- 操作：按"内核 / 协议端"分组，危险动作是红按钮，次要动作是小白按钮 -->
        <div class="sl-section">
          <div class="sl-section-title">操作</div>
          <div class="sl-actions-row">
            <span class="sl-actions-label">QQ 内核</span>
            <div class="snowluma-actions">
              <button class="btn btn-small" id="qq-start-btn" ${!qqReady || qqRunning ? 'disabled' : ''}>${qqRunning ? '已运行' : '单独启动 QQ'}</button>
              <button class="btn btn-small btn-danger" id="qq-stop-btn" ${!qqRunning ? 'disabled' : ''}>关闭 QQ</button>
              <span id="qq-hint" class="sl-hint"></span>
            </div>
          </div>
          <div class="sl-actions-row">
            <span class="sl-actions-label">协议端</span>
            <div class="snowluma-actions">
              <!-- 只有"可点"时才给 primary：已运行时它是 disabled，留蓝色会跟 QQ 那行的灰按钮不一致 -->
              <button class="btn btn-small${running ? '' : ' btn-primary'}" id="sl-start-btn" ${running ? 'disabled' : ''}>${running ? '已运行' : '启动 SnowLuma'}</button>
              <button class="btn btn-small btn-danger" id="sl-stop-btn" ${running ? '' : 'disabled'}>关闭 SnowLuma</button>
              <button class="btn btn-small" id="sl-refresh-btn">刷新状态</button>
              <button class="btn btn-small" id="sl-open-folder-btn">打开文件夹</button>
              <span id="sl-hint" class="sl-hint"></span>
            </div>
          </div>
        </div>

        <!-- 日志：三条独立面板，各带标题栏。空日志居中提示，不再是"一大片黑框"。
             应用日志：logger.js 的内存环形缓冲 + data/logs/ 落盘文件。 -->
        <div class="sl-section">
          <div class="sl-section-title">日志</div>

          ${qqLogText !== '暂无日志' ? `
          <div class="sl-panel">
            <div class="sl-panel-head">
              <span class="sl-panel-title">QQ 内核日志</span>
              <span class="sl-panel-meta">最近 ${(qqLogs.logs || []).length} 行</span>
            </div>
            <pre class="snowluma-logs-view sl-log-short">${esc(qqLogText)}</pre>
          </div>` : ''}

          <div class="sl-panel">
            <div class="sl-panel-head">
              <span class="sl-panel-title">运行日志</span>
              <span class="sl-panel-meta">SnowLuma 输出 · 仅保留最近 500 行</span>
            </div>
            <pre class="snowluma-logs-view${logText === '暂无日志' ? ' is-empty' : ''}" id="sl-logs-view">${esc(logText)}</pre>
          </div>

          <div class="sl-panel">
            <div class="sl-panel-head">
              <span class="sl-panel-title">应用日志</span>
              <span class="sl-panel-meta">最近 ${appLogs.length} 条 · 同时落盘 data/logs/</span>
              <span class="sl-panel-tools">
                <label class="sl-level" for="app-log-level">
                  <span>落盘级别</span>
                  <select id="app-log-level" title="低于该级别的日志不写入磁盘">
                    ${['debug', 'info', 'warn', 'error'].map((v) =>
                      `<option value="${v}" ${appLogLevel === v ? 'selected' : ''}>${v}</option>`).join('')}
                  </select>
                </label>
                <button class="btn btn-small" id="app-logs-refresh-btn" title="重新拉取最近日志">刷新</button>
              </span>
            </div>
            <pre class="snowluma-logs-view${appLogs.length ? '' : ' is-empty'}" id="app-logs-view">${esc(appLogText)}</pre>
          </div>
        </div>
      </div>`;

    // 恢复日志滚动：贴底跟随新日志；否则回到原阅读位置；首次渲染贴底
    const newPre = box.querySelector('#sl-logs-view');
    if (newPre) newPre.scrollTop = prevScroll ? (prevScroll.atBottom ? newPre.scrollHeight : prevScroll.top) : newPre.scrollHeight;
    const newAppPre = box.querySelector('#app-logs-view');
    if (newAppPre) newAppPre.scrollTop = prevAppScroll ? (prevAppScroll.atBottom ? newAppPre.scrollHeight : prevAppScroll.top) : newAppPre.scrollHeight;

    // ── 应用日志：级别切换 + 手动刷新 ──
    const appLevelSel = $('#app-log-level');
    if (appLevelSel) {
      appLevelSel.addEventListener('change', async () => {
        try {
          const r = await api('/api/logs/level', { method: 'POST', body: JSON.stringify({ level: appLevelSel.value }) });
          if (r && r.level) appLevelSel.value = r.level;
          loadSnowlumaPage({ quiet: true });
        } catch (e) {
          alert(`设置日志级别失败：${e.message}`);
        }
      });
    }
    const appLogsRefreshBtn = $('#app-logs-refresh-btn');
    if (appLogsRefreshBtn) appLogsRefreshBtn.addEventListener('click', () => loadSnowlumaPage());

    // ── 一键启动按钮事件 ──
    const quickStartBtn = $('#quick-start-btn');
    if (quickStartBtn) quickStartBtn.addEventListener('click', async () => {
      const btn = $('#quick-start-btn');
      const hint = $('#quick-start-hint');
      btn.disabled = true;
      hint.textContent = '';

      try {
        // 步骤 1：启动便携 QQ（如果未运行）
        if (!qqRunning) {
          btn.textContent = '启动 QQ 中…';
          hint.textContent = '请在弹出的 QQ 窗口扫码登录';
          const r = await api('/api/qq-portable/launch', { method: 'POST', body: '{}' });
          if (!r.ok && !r.alreadyRunning) {
            hint.textContent = `QQ 启动失败：${r.error}`;
            btn.disabled = false;
            btn.textContent = '一键启动（QQ + SnowLuma）';
            return;
          }
          // 等 3 秒让 QQ 完全启动
          await new Promise((r) => setTimeout(r, 3000));
        }

        // 步骤 2：启动 SnowLuma（如果未运行）
        if (!running) {
          btn.textContent = '启动 SnowLuma 中…';
          hint.textContent = '正在启动协议端…';
          const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
          if (!r.ok && !r.alreadyRunning) {
            hint.textContent = `SnowLuma 启动失败：${r.error}`;
            btn.disabled = false;
            btn.textContent = '一键启动（QQ + SnowLuma）';
            return;
          }
        }

        // 步骤 3：等待 OneBot 连接
        btn.textContent = '等待 OneBot 连接…';
        hint.textContent = '首次登录可能需要几秒到几十秒';

        // 轮询检查连接状态（最多 30 秒）
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const s = await api('/api/status');
          if (s.onebot?.connected) {
            hint.textContent = '✅ 已连接！机器人开始工作';
            btn.textContent = '已连接 ✓';
            setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
            return;
          }
        }
        hint.textContent = '连接超时，请检查日志或手动刷新';
        btn.disabled = false;
        btn.textContent = '重试';
      } catch (e) {
        hint.textContent = `启动失败：${e.message}`;
        btn.disabled = false;
        btn.textContent = '一键启动（QQ + SnowLuma）';
      }
    });

    // ── 便携 QQ 按钮事件 ──
    const qqStartBtn = $('#qq-start-btn');
    if (qqStartBtn) qqStartBtn.addEventListener('click', async () => {
      const btn = $('#qq-start-btn');
      btn.disabled = true; btn.textContent = '启动中…';
      $('#qq-hint').textContent = '';
      try {
        const r = await api('/api/qq-portable/launch', { method: 'POST', body: '{}' });
        $('#qq-hint').textContent = r.alreadyRunning ? '便携 QQ 已在运行 ✓' : (r.ok ? '已启动，请在弹出的 QQ 窗口扫码登录' : `启动失败：${r.error}`);
      } catch (e) {
        $('#qq-hint').textContent = `启动失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
    });
    const qqStopBtn = $('#qq-stop-btn');
    if (qqStopBtn) qqStopBtn.addEventListener('click', async () => {
      const btn = $('#qq-stop-btn');
      btn.disabled = true; btn.textContent = '关闭中…';
      $('#qq-hint').textContent = '';
      try {
        const r = await api('/api/qq-portable/stop', { method: 'POST', body: '{}' });
        $('#qq-hint').textContent = r.ok ? '已请求关闭便携 QQ' : `关闭失败：${r.error}`;
      } catch (e) {
        $('#qq-hint').textContent = `关闭失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
    });

    $('#sl-start-btn').addEventListener('click', async () => {
      const btn = $('#sl-start-btn');
      btn.disabled = true; btn.textContent = '启动中…';
      $('#sl-hint').textContent = '';
      try {
        const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
        $('#sl-hint').textContent = r.alreadyRunning ? 'SnowLuma 已经在运行 ✓' : (r.ok ? '已启动，日志见下方。首次 QQ 登录需要几秒到几十秒。' : `启动失败：${r.error}`);
      } catch (e) {
        $('#sl-hint').textContent = `启动失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
    });
    $('#sl-stop-btn').addEventListener('click', async () => {
      const btn = $('#sl-stop-btn');
      btn.disabled = true; btn.textContent = '关闭中…';
      $('#sl-hint').textContent = '';
      try {
        await api('/api/snowluma/stop', { method: 'POST', body: '{}' });
        $('#sl-hint').textContent = '已请求关闭 SnowLuma。';
      } catch (e) {
        $('#sl-hint').textContent = `关闭失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
    });
    $('#sl-refresh-btn').addEventListener('click', () => loadSnowlumaPage());
    $('#sl-open-folder-btn').addEventListener('click', async () => {
      try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
      catch (e) { $('#sl-hint').textContent = `失败：${e.message}`; }
    });
    const webuiBtn = $('#sl-open-webui-btn');
    if (webuiBtn) webuiBtn.addEventListener('click', async () => {
      try {
        const r = await api('/api/snowluma/open-webui', { method: 'POST', body: '{}' });
        if (!r.ok) $('#sl-hint').textContent = r.error;
      } catch (e) {
        $('#sl-hint').textContent = `打开失败：${e.message}`;
      }
    });
  } catch (e) {
    if (!quiet) console.error(e);
  }
}
