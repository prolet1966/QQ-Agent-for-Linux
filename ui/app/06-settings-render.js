// 〔设置渲染 / 模型目录 / 技能插件页〕——M9 拆分第 7 段
'use strict';
// ── 模型目录（多提供商；面板式选择 + 图片输入能力徽标） ──
function visionBadge(providerId, model) {
  const r = (state.visionResults || {})[`${providerId}|||${model}`];
  const src = r?.source === 'docs' ? '官方资料' : (r?.source === 'probe' ? '在线探测' : '');
  const show = state.config?.ui?.showVision !== false;
  const t = (cls, text) => `<span class="vbadge ${cls}" style="${show ? '' : 'display:none'}" title="${esc((src ? `【${src}】` : '') + (r?.note || ''))}">${text}</span>`;
  if (!r) return t('unk', '未检测');
  if (r.verdict === 'vision') return t('ok', '支持图片输入');
  if (r.verdict === 'no-vision') return t('no', '不支持图片输入');
  return t('unk', '无法判定');
}

// ── 两栏悬停下拉：左供应商 / 右模型 ──
function visionVerdictOf(providerId, model) {
  return (state.visionResults || {})[`${providerId}|||${model}`]?.verdict;
}

// 说明：这里曾经有一个 bindModelDdDismiss()，目标是 #model-dd / #model-pick-btn，
// 但真正的模型选择控件 id 是 #cfg-model-pick / #cfg-model（记忆页是 #cfg-mem-model-pick），
// 那两个 id 全项目从未被创建过 —— 函数也从未被调用，属于纯死代码，已删除。
// 若将来需要一个"点击外部/Esc 收起目录"的通用行为，请在 modelModalShell 里统一实现。




function renderSettingsSidebar() {
  const s = state.status;
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  // ── 分区合并（移植旧版）──
  // 9 项菜单太长，找东西靠扫两遍。按"用户脑子里的任务"合并成 5 项：
  //   模型与搜索（api+search）/ 人设与记忆（persona+memory）/ 聊天（allow+chat）/
  //   运行环境（onebot+desktop）/ 工具与技能（tools）。
  // 合并页 = 两个渲染函数直接字符串拼接（各自内部逻辑一行未动）。敢拼的前提：
  // 两两表单的元素 id 无交集（api∩search、persona∩memory、allow∩chat、onebot∩desktop
  // 全为空集），不会出现 getElementById 取错元素。
  // ⚠️ 被并掉的 id（search / memory / chat / onebot）不再出现在菜单里，但 saveConfig
  //    仍按这些 id 收集字段 —— 条件已放宽到合并后的宿主 id（见 08-modals.js saveConfig），
  //    否则合并页里另一半表单不会被保存（静默丢配置）。
  // 2026-09-20 二次重排：原「运行环境」(desktop) 一页塞了 OneBot 连接 + 桌面端 +
  //    界面 + 数据管理四类互不相关的内容，长滚动里主题混杂。拆成两页：
  //    「连接与启动」(onebot) = 机器人怎么连上 QQ；「界面与应用」(app) = 软件本身
  //    （主题/刷新/预览 → 自启/托盘 → 数据 → 更新）。'desktop' 保留为兼容别名。
  //    2026-09-21：页签名从「应用与界面」改为「**界面与应用**」，并同步把区块顺序调成
  //    界面 → 桌面端（按使用频率：主题是这页最常改的；自启/托盘装完设一次就基本不动）。
  const menu = [
    ['api', '模型与搜索'],
    ['persona', '人设与记忆'],
    ['allow', '聊天'],
    ['tools', '工具与技能'],
    ['onebot', '连接与启动'],
    ['app', '界面与应用']
  ];
  sidebar.innerHTML = `
    <div class="settings-runstate">
      <div class="rs-title">机器人运行状态</div>
      <div class="rs-row"><span class="dot ${s?.onebot?.connected ? 'dot-on' : 'dot-off'}"></span><span>${s?.onebot?.connected ? '运行中' : '未就绪'}</span></div>
      <div class="rs-row muted">${state.paused ? '⏸ 已暂停' : (s?.orchestrator?.model ? `模型：${esc(s.orchestrator.model)}` : '模型：未设置')}</div>
    </div>
    <div class="settings-menu">
      ${menu.map(([id, label]) => `<button class="settings-menu-item ${state.settingsSection === id ? 'active' : ''}" data-section="${id}">${label}${id === 'app' && updateAvailable ? '<span class="update-dot" title="发现新版本"></span>' : ''}</button>`).join('')}
      <!-- 滑动高亮条：切分区时平滑滑到当前项（首次定位不加过渡） -->
      <span class="settings-menu-ind" aria-hidden="true"></span>
    </div>`;
  moveMenuInd(sidebar, false);
  sidebar.querySelectorAll('.settings-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.section === state.settingsSection) return;
      // 切区块 = 整页表单重建：先把防抖窗口内挂起的保存发出，
      // 否则刚输入的内容直接被重渲染吹掉（与切页签同一条防线）。
      flushSettingsSaves();
      state.settingsSection = el.dataset.section;
      // 只切换 active 类（不重建侧栏）→ 指示条平滑滑动、悬停态不闪断
      sidebar.querySelectorAll('.settings-menu-item').forEach((b) => b.classList.toggle('active', b === el));
      moveMenuInd(sidebar, true);
      renderSettings();
      // 分区切换的入场过渡：Web Animations API，播完自动释放（不留合成层）
      $('#settings-form')?.animate(
        [
          { opacity: 0, transform: 'translateY(7px)' },
          { opacity: 1, transform: 'none' }
        ],
        { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
      );
    });
  });
}

/** 把菜单滑动指示条对齐到当前 active 项。
 *  animate=false 用于定位；但若记住了上一次的位置（menuIndPrevTop），
 *  即使是重建后的首次定位也从旧位置滑过去 —— 否则切换时挂起的自动保存
 *  完成后会重建侧栏，指示条瞬移，滑动动画被打断。 */
let menuIndPrevTop = null;
function moveMenuInd(sidebar, animate) {
  const ind = sidebar.querySelector('.settings-menu-ind');
  const act = sidebar.querySelector('.settings-menu-item.active');
  if (!ind) return;
  if (!act) { ind.style.opacity = '0'; menuIndPrevTop = null; return; }
  ind.style.opacity = '1';
  const top = act.offsetTop;
  const h = act.offsetHeight;
  const slide = menuIndPrevTop != null && Math.abs(menuIndPrevTop - top) > 2;
  if (slide) {
    ind.classList.add('no-anim');
    ind.style.top = menuIndPrevTop + 'px';
    ind.style.height = h + 'px';
    void ind.offsetHeight;   // 强制回流：让起点先生效，再开过渡
    ind.classList.remove('no-anim');
  }
  ind.style.top = top + 'px';
  ind.style.height = h + 'px';
  menuIndPrevTop = top;
}

function renderSettings() {
  // 渲染守卫：自动保存进行中（表单正在被读取 / state.config 即将被覆盖）时
  // 不允许重建表单 DOM —— 会吹掉用户正在输入的未保存内容。
  // 拦下的请求由 endSettingsGuard() 在保存完成后补放。
  if (settingsGuard.pending > 0) {
    settingsGuard.needRerender = true;
    return;
  }
  // 焦点保护（2026-09-19 修"文本框偶发点不进/失焦"）：守卫只护住"保存进行中"的
  // 窗口，但守卫之外仍有一批异步重渲染（群名补底 / 视觉扫描完成 / 技能开关保存 /
  // 守卫补放的延迟渲染）会在用户打字途中重建 innerHTML —— 焦点、光标位置、
  // 未落盘的输入值全部被吹掉。这里在重建前后做"焦点与选区快照恢复"：
  //   ① 记下正在聚焦的输入框 id + 光标位置 + 当前值；
  //   ② 重建后按 id 找回元素，把值写回（渲染用的是 state.config，可能还没
  //      带上防抖窗口内的输入），恢复焦点与光标。
  const box = $('#settings-form');
  const focusSnap = (() => {
    const el = document.activeElement;
    if (!box || !el || el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') return null;
    if (el.type === 'checkbox' || el.type === 'radio' || !box.contains(el)) return null;
    return {
      id: el.id,
      selStart: el.selectionStart ?? null,
      selEnd: el.selectionEnd ?? null,
      value: el.value
    };
  })();
  const c = state.config;
  renderSettingsSidebar();
  box.innerHTML = `
    ${renderSettingsSection(c)}`;
  bindSettingsEvents(c);
  if (focusSnap?.id) {
    const back = box.querySelector('#' + focusSnap.id);
    if (back && (back.tagName === 'INPUT' || back.tagName === 'TEXTAREA')) {
      try {
        back.value = focusSnap.value;   // 覆盖渲染值：防抖窗口内的输入不被回滚
        if (focusSnap.selStart != null) back.setSelectionRange(focusSnap.selStart, focusSnap.selEnd ?? focusSnap.selStart);
        back.focus({ preventScroll: true });
      } catch { /* 恢复失败不致命 */ }
    }
  }
  // 群名补底（一次性）：分群按钮/活跃设置下拉第一次渲染时 state.chats 可能还没到
  // （switchTab 只在列表为空时才拉）。这里发现为空就补拉，到达后重渲染一次。
  if (!(state.chats || []).length && !renderSettings.__chatsFetch) {
    renderSettings.__chatsFetch = true;
    api('/api/chats').then((d) => {
      if ((d.chats || []).length && state.tab === 'settings') renderSettings();
    }).catch(() => {}).finally(() => { renderSettings.__chatsFetch = false; });
  }
}

function renderSettingsSection(c) {
  const sec = state.settingsSection || 'api';
  // 合并页 = 两个渲染函数直接字符串拼接（各自内部逻辑一行未动），
  // 各段自带的 <h3> 分组标题照常渲染，长页里仍能看出"这一段是什么"。
  // 2026-09-21 重排「模型与搜索」：按使用习惯分三组、组间用虚线分隔 ——
  //   ① 模型（主模型 → 备选模型）② 搜索（搜索服务 → 添加自定义服务[折叠]）③ 成本（成本核算 → 前缀缓存）
  // 原先的顺序是 模型 → 备选 → 成本 → 缓存 → 搜索 → 添加搜索，主题来回横跳，
  // 且「当前模型单价」卡被"前缀缓存"截断、成了无标题孤儿块。
  const sections = {
    api: () => renderApiSection(c) + renderSearchSection(c) + renderModelCostSection(c),
    persona: () => renderPersonaSection(c) + renderMemorySettingsSection(c),
    allow: () => renderAllowSection(c) + renderChatSection(c),
    desktop: () => renderOnebotSection(c) + renderDesktopSection(c),   // 兼容别名 → 旧 state 恢复
    onebot: () => renderOnebotSection(c),
    app: () => renderDesktopSection(c),
    tools: () => renderToolsSection(c)
  };
  const render = sections[sec] || sections.api;
  return `
    ${render()}`;
}
function renderApiSection(c) {
  const currentProvider = (state.providers || []).find((p) => p.id === c.api.provider);
  const currentModelDisplay = (currentProvider?.modelNames || {})[c.api.model] || c.api.model;
  // 专用模型的显示名：跨提供商选择时也能读出目录名（找不到就显示裸 id）
  const displayOf = (modelId) => {
    const m = String(modelId || '').trim();
    if (!m) return '';
    for (const p of (state.providers || [])) {
      if ((p.modelNames || {})[m]) return `${p.modelNames[m]}`;
    }
    return m;
  };
  const visionModelDisplay = displayOf(c.api.visionModel);
  const videoModelDisplay = displayOf(c.api.videoModel);
  return `
    <h3 id="settings-api">模型 API</h3>
    <div class="field">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="open-model-config-btn">⚙ 模型配置</button>
        <button class="btn" id="open-model-manage-btn">🗂 模型管理</button>
      </div>
      <div class="hint" id="provider-hint" style="margin-top:6px">${currentProvider ? `当前：${esc(currentProvider.displayName)} · ${esc(c.api.model || '未选模型')} @ ${esc(currentProvider.baseURL)}${currentProvider.hasKey ? ' · 已保存 API Key（不显示）' : ' · 未保存 API Key'}` : '尚未选择模型'}</div>
      <div class="hint" id="model-vision-hint" style="margin-top:6px"></div>
      <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
      <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
      <input type="hidden" id="cfg-baseurl-value" value="${esc(c.api.baseUrl)}" />
    </div>

    <h3>备选模型（故障自动降级）</h3>
    <div class="hint" style="margin-bottom:6px">主模型在重试后仍失败时，按顺序逐个用备选模型重试，直到成功。留空则不启用降级。</div>
    <div id="fallback-model-rows"></div>
    <div style="display:flex;gap:8px;margin-top:6px">
      <button class="btn btn-small" id="add-fallback-row-btn">＋ 添加备选模型</button>
    </div>
    <div class="settings-divider"></div>`;
}

/* ── 「账」这一组（渲染顺序排在最后）──
   为什么把成本核算 / 当前单价 / 批量编辑 / 前缀缓存放在一起、且排在搜索之后：
     1) 原先「当前模型单价」卡片和「批量自定义价格编辑」被「前缀缓存」隔开，
        成了**没有标题的孤儿块**（挂在"前缀缓存"名下），成本信息被切成两半；
     2) 按使用习惯：先配"机器人靠什么思考 / 靠什么查资料"（模型组 → 搜索组），
        配完才关心"花多少钱"（成本组）。价格/缓存都是低频查看项，压到最后。
   id 一个没改，saveConfig 与各处绑定照旧按 id 取值。 */
function renderModelCostSection(c) {
  return `
    <h3>成本核算</h3>

    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-useofficialprice" ${c.api.useOfficialPrice !== false ? 'checked' : ''} />
      <label for="cfg-useofficialprice">用内置官方价格表估算（按模型 id 自动匹配；走中转站请关掉）</label></div>

    <div id="price-sub" class="fold-sub${c.api.useOfficialPrice === false ? ' folded' : ''}"><div class="fold-sub-inner">
      <div class="field" style="margin-top:6px"><label>远程价格表</label>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="muted">官网统一价格表</span>
          <button class="btn btn-small" id="price-feed-refresh-btn" title="从官网拉取最新价格表">拉取价格表</button>
        </div>
        <div class="hint" id="price-feed-status" style="margin-top:4px"></div>
      </div>
    </div></div>

    <!-- 当前模型的价格卡片：切换模型时内容跟着变。
         紧跟在"价格从哪来"之后 —— 价格来源 → 这个模型多少钱 → 批量改价，读起来是一条线。 -->
    <div class="price-card" id="model-price-card">
      <div class="pc-head">
        <span class="pc-title">当前模型单价</span>
        <span class="pc-model" id="pc-model">${esc(c.api.model || '（未选择模型）')}</span>
      </div>
      <div class="pc-rows">
        <div class="pc-row"><span class="pc-label">输入</span>
          <input type="number" id="cfg-price-in" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">输出</span>
          <input type="number" id="cfg-price-out" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">缓存命中</span>
          <input type="number" id="cfg-price-cached" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
      </div>
      <div class="pc-note" id="pc-note"></div>
    </div>

    <div style="display:flex;gap:8px;margin:8px 0">
      <button class="btn btn-small" id="batch-price-btn">批量自定义价格编辑</button>
      <span class="muted" style="font-size:12px;align-self:center">为多个模型分别设定单价</span>
    </div>

    <h3>前缀缓存</h3>
    <div class="hint" style="margin-bottom:6px">
      每次新会话的第一次调用，都要为「工具 schema + 系统提示」这段固定前缀付全价
      （实测约占单次请求的 36%）。打开保活后，程序会在后台定期用这段前缀发一次极短的
      请求，让服务商把它留在缓存里，之后新会话的第一次调用即可命中。
    </div>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-cachewarm" ${c.cacheWarm?.enabled === true ? 'checked' : ''} />
      <label for="cfg-cachewarm">开启前缀缓存保活（会在后台定期联网，默认关闭）</label></div>
    <div id="cachewarm-sub" class="fold-sub${c.cacheWarm?.enabled === true ? '' : ' folded'}"><div class="fold-sub-inner">
      <div class="field" style="margin-top:6px;max-width:280px"><label>保活间隔（分钟）</label>
        <input type="number" id="cfg-cachewarm-interval" min="1" max="1440" value="${Number(c.cacheWarm?.intervalMin) || 10}" />
        <div class="hint" style="margin-top:4px">
          取值取决于服务商的缓存存活时间。间隔过长缓存已过期 = 白做；过短则多花保活请求本身的钱。
          建议从 10 分钟起，逐档放大并观察新会话第一次调用的 cached 是否仍然很高。
        </div>
      </div>
    </div></div>`;
}


function renderSearchSection(c) {
  // 每个提供方区块的初始显隐都要跟当前 provider 一致
  const prov = String(c.webSearch?.provider || 'bing');
  // 自定义搜索提供商列表（可多个），用于动态生成下拉框选项
  const customProvs = Array.isArray(c.webSearch?.providers) ? c.webSearch.providers : [];
  return `
    <h3 id="settings-search">搜索服务</h3>
    <div class="hint" style="margin-bottom:12px">
      当前提供方：${prov === 'bing' ? 'Bing 网页解析' : prov === 'deepseek' ? 'DeepSeek 原生搜索' : prov === 'zhipu' ? '智谱 Web Search' : prov === 'bocha' ? '博查 AI Search' : prov === 'baidu' ? '百度千帆 AI Search' : prov === 'metaso' ? '秘塔 AI 搜索' : '自定义'}
      ${(() => {
        // 当前提供方已保存的 Key 状态（与模型 API 页同款提示口径）
        const keyState = {
          deepseek: c.webSearch?.deepseek?.hasApiKey,
          zhipu: c.webSearch?.zhipu?.hasApiKey,
          bocha: c.webSearch?.bocha?.hasApiKey,
          baidu: c.webSearch?.baidu?.hasApiKey,
          metaso: c.webSearch?.metaso?.hasApiKey
        }[prov];
        if (prov === 'bing') return ' · 无需 API Key';
        if (prov?.startsWith('custom:')) return '';
        return keyState ? ' · 已保存 API Key（不显示）' : ' · 未保存 API Key';
      })()}
    </div>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-websearch" ${c.webSearch?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-websearch">联网搜索：启用 web_search / web_fetch 工具</label></div>
    <div id="websearch-sub" class="fold-sub${c.webSearch?.enabled === false ? ' folded' : ''}"><div class="fold-sub-inner">
    <div class="field"><label>搜索提供方</label>
      <select id="cfg-searchprovider">
        <option value="bing" ${prov === 'bing' ? 'selected' : ''}>Bing 网页解析</option>
        <option value="deepseek" ${prov === 'deepseek' ? 'selected' : ''}>DeepSeek 原生搜索</option>
        <option value="zhipu" ${prov === 'zhipu' ? 'selected' : ''}>智谱 Web Search</option>
        <option value="bocha" ${prov === 'bocha' ? 'selected' : ''}>博查 AI Search</option>
        <option value="baidu" ${prov === 'baidu' ? 'selected' : ''}>百度千帆 AI Search</option>
        <option value="metaso" ${prov === 'metaso' ? 'selected' : ''}>秘塔 AI 搜索</option>
        ${customProvs.map((p) => `<option value="custom:${esc(p.id)}" ${prov === `custom:${p.id}` ? 'selected' : ''}>${esc(p.name || p.baseUrl)}（自定义 · ${p.type === 'bing' ? '网页解析' : 'JSON 接口'}）</option>`).join('')}
      </select></div>
    <div class="field" id="custom-provider-manage" style="margin-top:14px;${prov.startsWith('custom:') ? '' : 'display:none'}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <button class="btn btn-small" id="test-search-provider-btn">测试这个搜索服务</button>
        <button class="btn btn-small btn-danger" id="del-search-provider-btn">删除这个搜索服务</button>
        <span id="search-provider-action-hint" class="muted" style="font-size:12px"></span>
      </div>
      <label>API Key${(() => {
        const cp = customProvs.find((p) => `custom:${p.id}` === prov);
        return cp?.hasApiKey ? '（已保存，可查看/替换/清除）' : '（未保存；多数自建服务留空即可）';
      })()}</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-custom-sp-key" value="${esc(customProvs.find((p) => `custom:${p.id}` === prov)?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-custom-sp-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-custom-sp-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div>
    </div>
    <div class="field" id="bing-search-fields" style="${prov === 'bing' ? '' : 'display:none'}"><label>搜索地址（高级：可替换为兼容 Bing 结果格式的引擎）</label><input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" /></div>
    <div class="field-row" id="deepseek-search-fields" style="${prov === 'deepseek' ? '' : 'display:none'}">
      <div class="field"><label>DeepSeek 搜索 API Key（留空用环境变量 DEEPSEEK_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-ds-searchkey" value="${esc(c.webSearch?.deepseek?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-ds-searchkey-toggle" type="button">显示</button>
          <button class="btn btn-small btn-danger" id="cfg-ds-searchkey-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
        </div></div>
      <div class="field"><label>模型</label><input type="text" id="cfg-ds-searchmodel" value="${esc(c.webSearch?.deepseek?.model || 'deepseek-chat')}" /></div>
    </div>
    <div class="field-row" id="zhipu-search-fields" style="${prov === 'zhipu' ? '' : 'display:none'}">
      <div class="field"><label>智谱 API Key（留空用环境变量 ZHIPU_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-zhipu-key" value="${esc(c.webSearch?.zhipu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-zhipu-key-toggle" type="button">显示</button>
          <button class="btn btn-small btn-danger" id="cfg-zhipu-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
        </div></div>
      <div class="field"><label>搜索引擎</label>
        <select id="cfg-zhipu-engine">
          <option value="search_std" ${c.webSearch?.zhipu?.engine === 'search_std' ? 'selected' : ''}>基础版 ¥0.01/次</option>
          <option value="search_pro" ${c.webSearch?.zhipu?.engine === 'search_pro' ? 'selected' : ''}>高级版 ¥0.03/次</option>
          <option value="search_pro_sogou" ${c.webSearch?.zhipu?.engine === 'search_pro_sogou' ? 'selected' : ''}>搜狗版 ¥0.05/次</option>
          <option value="search_pro_quark" ${c.webSearch?.zhipu?.engine === 'search_pro_quark' ? 'selected' : ''}>夸克版 ¥0.05/次</option>
        </select></div>
    </div>
    <div class="field" id="bocha-search-fields" style="${prov === 'bocha' ? '' : 'display:none'}">
      <label>博查 API Key</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-bocha-key" value="${esc(c.webSearch?.bocha?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-bocha-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-bocha-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div></div>
    <div class="field" id="baidu-search-fields" style="${prov === 'baidu' ? '' : 'display:none'}">
      <label>百度千帆 API Key（留空用环境变量 BAIDU_SEARCH_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-baidu-key" value="${esc(c.webSearch?.baidu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-baidu-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-baidu-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div></div>
    <div class="field" id="metaso-search-fields" style="${prov === 'metaso' ? '' : 'display:none'}">
      <label>秘塔 API Key（可选，留空用官方免费额度 / 环境变量 METASO_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-metaso-key" value="${esc(c.webSearch?.metaso?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-metaso-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-metaso-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div></div>
    </div></div>

    <!-- 添加自定义搜索服务：与「模型配置」同款的"入口按钮 → 专门弹窗"形态
         （2026-09-21 用户要求：折叠的 <details> 看着不像能点）。一次性动作不铺页面；
         表单整体搬进 openAddSearchProviderModal()（08-modals.js），字段 id 原样保留
         （new-sp-* / add-search-provider-btn / add-search-provider-hint，只是挪了家），
         添加成功后弹窗自动关闭并 loadSettings() 重渲染（新服务已自动选中）。 -->
    <!-- margin-top:14px 与 R35 按钮间隔规范一致：上方自定义服务的 URL 输入框
         （#custom-provider-manage 末尾）与本按钮原来贴死，用户 R38 要求留空隙。 -->
    <div class="field" id="add-search-provider-box" style="margin-top:14px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="open-add-search-provider-btn">⚙ 添加自定义搜索服务</button>
      </div>
      <div class="hint" style="margin-top:6px">自建 SearXNG / JSON 搜索接口 / Bing 兼容页都可接入；点按钮在弹窗里配置，添加后自动选中。</div>
    </div>

    <!-- 组边界：虚线分隔「搜索（能力）」与「成本（账）」两个大组。
         同组内的 h3 只靠自带下边框分隔，虚线留给跨组。 -->
    <div class="settings-divider"></div>
  `;
}

function renderMemorySettingsSection(c) {
  const mem = c.memory || {};
  const providers = state.providers || [];
  const useChat = mem.useChatModel !== false;
  const selP = providers.find((p) => p.id === mem.provider);
  const currentDisplay = selP ? `${selP.displayName || selP.id} · ${mem.model || '未选模型'}` : (mem.model || '未选模型');
  return `
    <h3 id="settings-memory">记忆整理</h3>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-mem-consolidate" ${mem.consolidateEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-consolidate">启用记忆自动整理</label></div>
    <div id="mem-sub" class="fold-sub${mem.consolidateEnabled === false ? ' folded' : ''}"><div class="fold-sub-inner">
      <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-mem-usechat" ${useChat ? 'checked' : ''} />
        <label for="cfg-mem-usechat">使用与聊天机器人相同的模型</label></div>
      <!-- 反向：勾上「用主模型」就不需要选专用模型 → 折叠；取消勾选才展开 -->
      <div id="mem-model-box" class="fold-sub${useChat ? ' folded' : ''}"><div class="fold-sub-inner">
        <div class="field"><label>记忆整理模型（点击选择）</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="cfg-mem-model-pick" readonly placeholder="点击选择模型" value="${esc(currentDisplay)}" style="flex:1;cursor:pointer" />
          </div>
          <div class="hint" id="mem-model-hint">${selP ? `当前：${esc(selP.displayName)} @ ${esc(selP.baseURL)}` : '尚未选择专用模型'}</div>
          <input type="hidden" id="cfg-mem-provider" value="${esc(mem.provider || '')}" />
          <input type="hidden" id="cfg-mem-model" value="${esc(mem.model || '')}" />
        </div>
      </div></div>
      <div class="field"><label>整理冷却时间（毫秒）</label><input type="number" id="cfg-mem-interval" min="1800000" step="600000" value="${esc(mem.consolidateMinIntervalMs ?? 21600000)}" /></div>
      <div class="hint">条数超过阈值且距上次整理超过该冷却时间后，才会在运行结束后后台整理。默认 6 小时（21600000 毫秒）。</div>
    </div></div>`;
}

function renderPersonaSection(c) {
  // 统一人设开关：开启（默认）= 所有用同一套全局人设（下方完整编辑器）；
  // 关闭 = 每个白名单会话一个按钮，点开模态框单独编辑（personaByChat）。
  const unified = c.personaUnified !== false;
  const perChat = c.personaByChat || {};
  const allowIds = [
    ...(c.allow?.groups || []).map((g) => `group:${g}`),
    ...(c.allow?.private || []).map((p) => `private:${p}`)
  ].map(String);
  const extraIds = Object.keys(perChat).filter((id) => !allowIds.includes(id));
  const chatIds = [...allowIds, ...extraIds];

  // 统一人设模式：只给**摘要卡 + 编辑入口**，不再把三个大文本框铺在页面上
  // （角色设定 360 + 附加规则 100 + 系统提示覆盖 120 ≈ 607px，占本页 2/3 高度；
  //  而这三样平时只看不改）。编辑走人设弹窗，弹窗自己 POST 保存。
  //  ⚠️ 字段撤出页面后，saveConfig 的 persona 分支靠 `val(sel, fallback)` 回落到
  //     当前配置值 —— 不会把弹窗刚存的值覆盖成空（已确认 val 的兜底语义）。
  //  ⚠️ 这里**不能**沿用页面上的 #cfg-roletext 等 id：会和弹窗里的 #gp-* 并存冲突。
  const PARTICIPATION_LABEL = { low: '安静型', medium: '普通群友', high: '活跃型' };
  const roleText = String(c.persona.roleText || '').trim();
  const rolePreview = roleText
    ? esc(roleText.length > 96 ? `${roleText.slice(0, 96)}…` : roleText)
    : '（未设置角色设定，机器人会用内置默认提示词）';
  const personaSummary = `
    <div class="persona-summary">
      <div class="ps-row"><span class="ps-label">机器人名字</span><span class="ps-value">${esc(c.persona.botName || '（未设置）')}</span></div>
      <div class="ps-row"><span class="ps-label">群内展示名</span><span class="ps-value">${c.persona.selfNickname ? esc(c.persona.selfNickname) : '<span class="ps-none">未设置（用 QQ 昵称）</span>'}</span></div>
      <div class="ps-row"><span class="ps-label">参与度</span><span class="ps-value">${PARTICIPATION_LABEL[c.persona.participation] || esc(c.persona.participation || '普通群友')}</span></div>
      <div class="ps-row ps-row-text"><span class="ps-label">角色设定</span><span class="ps-value ps-text">${rolePreview}</span></div>
    </div>
    <div class="ps-badges">
      ${c.persona.customRules ? '<span class="ps-badge">已设置管理员附加规则</span>' : ''}
      <!-- ⚠️ 覆盖系统提示词是危险设置（会让内置安全规则/工具协议失效），
           摘要卡上必须显式提示，不能让它静静藏在弹窗里被忘记 -->
      ${c.persona.systemPromptOverride ? '<span class="ps-badge ps-badge-warn">⚠️ 已覆盖系统提示词</span>' : ''}
      ${(!roleText && !c.persona.customRules && !c.persona.systemPromptOverride) ? '<span class="ps-badge ps-badge-none">尚未配置角色设定</span>' : ''}
    </div>
    <div class="field" style="margin-top:12px">
      <button class="btn" id="open-persona-editor-btn">⚙ 编辑人设</button>
      <span class="hint" style="margin-left:10px">名字 / 展示名 / 参与度 / 角色设定 / 附加规则 / 系统提示词覆盖都在这里改</span>
    </div>`;

  // 页面只放摘要卡：选择人设 / 添加人设 / 删除自定义人设 也一并收进弹窗
  // （页面上那套 `#cfg-persona-pick` 控件的存在意义就是"把模板填进下面的角色设定框"，
  //  框都搬进弹窗了，留在页面上就成了点不动的空控件）。
  const unifiedEditor = personaSummary;

  // 分会话模式：按钮网格（白名单 ∪ 已配置过的会话）
  const chatButtons = chatIds.map((chatKey) => {
    const conf = perChat[chatKey] || {};
    const hasCustom = Boolean(conf.roleText || conf.participation || conf.customRules || conf.systemPromptOverride);
    const title = formatChatTitle(chatKey, extraIds.includes(chatKey) ? '' : chatNameOf(chatKey));
    return `
      <button class="btn persona-chat-btn ${hasCustom ? 'has-custom' : ''}" data-chat="${esc(chatKey)}" title="${esc(title)}的人设">
        ${esc(title)}${hasCustom ? ' ●' : ''}
      </button>`;
  }).join('');

  return `
    <h3>人设</h3>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-persona-unified" ${unified ? 'checked' : ''} />
      <label for="cfg-persona-unified">为所有的群聊/私聊使用同一个人设</label></div>
    <div class="hint" style="margin-bottom:12px">${unified
      ? '所有会话共用下方这一套人设。'
      : '每个会话独立人设：点按对应按钮弹窗编辑（● = 已配置独立人设；未配置的跟随全局人设的字段）。机器人名字/群内展示名是账号身份，只能全局设置。'}</div>
    <div id="persona-unified-box" style="${unified ? '' : 'display:none'}">
      ${unifiedEditor}
    </div>
    <div id="persona-perchat-box" style="${unified ? 'display:none' : ''}">
      <div class="field" style="margin-bottom:10px">
        <button class="btn" id="open-global-persona-btn">⚙ 全局人设设置（未单独配置的会话用这套）</button>
      </div>
      <div class="persona-chat-grid">${chatButtons || '<div class="hint">（白名单为空——先在「聊天白名单」里添加群聊/私聊）</div>'}</div>
    </div>

    <!-- 组边界：人设（机器人是谁）↔ 记忆整理（机器人怎么记事）用虚线分开 -->
    <div class="settings-divider"></div>`;
}

/**
 * 「全局人设设置」模态框（2026-09-18）：统一人设关闭（分群模式）时，
 * persona 主编辑器不在场 —— 没有独立人设的会话跟随的全局字段就没了编辑入口。
 * 这里弹出同款字段（选择人设 / 参与度 / 角色设定 / 附加规则 / 系统提示覆盖 /
 * 机器人名字 / 群内展示名），保存直接 POST /api/config 的 persona 补丁。
 */
/**
 * 人设编辑弹窗（统一/分群两种模式共用同一个弹窗）。
 *   统一人设模式：它就是"人设设置"本体 —— 页面上只留摘要卡 + 入口按钮（原来三个大
 *   文本框铺在页面上占 607px，是该页 2/3 高度）。
 *   分群模式：它管"未单独配置的会话所跟随的全局字段"。
 * ⚠️ 字段用 `#gp-*` 前缀，**故意不与页面的 `#cfg-*` 重名** —— 同名 id 会让
 *    `$('#id')` 抓到先出现的那个，自动保存链从此读错元素。保存走自己的 POST。
 */
function openGlobalPersonaModal() {
  const c = state.config || {};
  const per = c.persona || {};
  const unified = c.personaUnified !== false;
  const overlay = modelModalShell({
    head: unified ? '人设设置' : '全局人设设置',
    body: `
      <div class="field" style="margin-bottom:8px">
        <label>选择人设</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="gp-pick" readonly placeholder="点击选择人设" value="${esc(Object.values(state.personaTemplates || {}).find((p) => p.text === (per.roleText || ''))?.name || '')}" style="flex:1;cursor:pointer" />
          <button class="btn btn-small" id="gp-new-btn">＋ 添加人设</button>
          <!-- 删除自定义人设：原来只在页面上的选择器旁边，选择器收进弹窗后必须跟过来，
               否则「删除自定义人设」这个功能就彻底没有入口了 -->
          <button class="btn btn-small btn-danger hidden" id="gp-del-btn">删除当前自定义人设</button>
        </div>
        <span class="hint" id="gp-hint"></span>
      </div>
      <div class="field-row">
        <div class="field"><label>机器人名字</label><input type="text" id="gp-botname" value="${esc(per.botName || '')}" /></div>
        <div class="field"><label>群内展示名（可选）</label><input type="text" id="gp-selfnick" value="${esc(per.selfNickname || '')}" /></div>
        <div class="field"><label>参与度</label>
          <select id="gp-participation">
            <option value="low" ${per.participation === 'low' ? 'selected' : ''}>安静型</option>
            <option value="medium" ${per.participation === 'medium' ? 'selected' : ''}>普通群友</option>
            <option value="high" ${per.participation === 'high' ? 'selected' : ''}>活跃型</option>
          </select></div>
      </div>
      <div class="field"><label>角色设定</label>
        <textarea id="gp-roletext" class="persona-role-text" style="min-height:180px" placeholder="例如：你是运维群里的老油条……">${esc(per.roleText || '')}</textarea></div>
      <div class="field"><label>管理员附加规则（可选，追加到系统提示）</label>
        <textarea id="gp-customrules" class="persona-role-text" style="min-height:80px">${esc(per.customRules || '')}</textarea></div>
      <div class="field"><label>系统提示词覆盖（高级 · 可选）</label>
        <textarea id="gp-sysprompt" class="persona-role-text" style="min-height:80px" placeholder="留空 = 使用内置默认系统提示词">${esc(per.systemPromptOverride || '')}</textarea></div>
      <div class="hint" style="margin-top:6px">${unified
        ? '所有群聊/私聊共用这一套人设。'
        : '未配置独立人设的群聊/私聊全部使用这套全局字段。'}</div>`,
    foot: `<button class="btn" id="gp-cancel">取消</button>
           <button class="btn btn-primary" id="gp-save">保存</button>`
  });

  // 选择人设 / 添加人设：都复用共享弹窗，但**填回本弹窗的 gp-* 字段**
  // （不传 target 的话会填到设置页的 cfg-* 里，而这个弹窗里根本看不到效果）
  const gpTarget = { roleSel: '#gp-roletext', rulesSel: '#gp-customrules', pickSel: '#gp-pick', hintSel: '#gp-hint' };
  const gpHint = overlay.querySelector('#gp-hint');
  const gpRole = overlay.querySelector('#gp-roletext');
  const gpRules = overlay.querySelector('#gp-customrules');
  overlay.querySelector('#gp-pick').addEventListener('click', () => openPersonaPicker(gpTarget));
  overlay.querySelector('#gp-new-btn').addEventListener('click', () => openPersonaCreateModal(gpTarget));

  // 删除自定义人设：当前角色设定命中某个 custom_ 模板时才可删（内置人设不给删）。
  // 靠 roleEl 的 input 事件同步显隐 —— openPersonaPicker 改完值会派发一次，
  // 所以从选择器里挑一个自定义人设后按钮会自己出现。
  const gpDel = overlay.querySelector('#gp-del-btn');
  const syncGpDel = () => {
    const hit = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === gpRole.value);
    const id = hit ? hit[0] : '';
    gpDel.classList.toggle('hidden', !id.startsWith('custom_'));
    gpDel.dataset.personaId = id;
  };
  syncGpDel();
  gpRole.addEventListener('input', syncGpDel);
  gpDel.addEventListener('click', async () => {
    const id = gpDel.dataset.personaId || '';
    const tpl = state.personaTemplates[id];
    if (!id.startsWith('custom_') || !tpl) return;
    if (!confirm(`确定删除自定义人设「${tpl.name}」？`)) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
      // 删掉后角色设定回落到内置默认（与页面版行为一致）。
      // 只改弹窗内的字段，真正落盘靠「保存」—— 弹窗是"改完再存"的模型，
      // 混进页面的自动保存链反而会被 loadSettings 重渲染吹掉。
      const fallback = state.personaTemplates.xiaojingyu;
      gpRole.value = fallback?.text || '';
      gpRules.value = '';
      overlay.querySelector('#gp-pick').value = fallback?.name || '';
      await loadSettings();            // 刷新模板列表（人设选择器读的就是它）
      syncGpDel();
      gpHint.textContent = `人设「${tpl.name}」已删除，角色设定回落到内置默认；点「保存」生效。`;
    } catch (e) {
      gpHint.textContent = `删除失败：${e.message}`;
    }
  });

  overlay.querySelector('#gp-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#gp-save').addEventListener('click', async () => {
    const patch = {
      persona: {
        ...(c.persona || {}),
        botName: overlay.querySelector('#gp-botname').value.trim() || '小鲸鱼',
        selfNickname: overlay.querySelector('#gp-selfnick').value.trim(),
        participation: overlay.querySelector('#gp-participation').value,
        roleText: overlay.querySelector('#gp-roletext').value.trim(),
        customRules: overlay.querySelector('#gp-customrules').value.trim(),
        systemPromptOverride: overlay.querySelector('#gp-sysprompt').value.trim()
      }
    };
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
      closeModelModal(overlay);
      loadSettings();
    } catch (e) {
      alert(`保存人设失败：${e.message}`);
    }
  });
}

/**
 * 分会话人设编辑模态框：与统一编辑器同款字段（人设选择/添加/机器人名字沿用全局说明/参与度/
 * 角色设定/附加规则/系统提示词覆盖）。保存按钮直接 POST /api/config 落盘
 * （personaByChat 整体 __replace__），不经过表单自动保存链。
 */
function openPerChatPersonaModal(chatKey) {
  const conf = (state.config?.personaByChat || {})[chatKey] || {};
  const chatName = formatChatTitle(chatKey, chatNameOf(chatKey));
  const overlay = modelModalShell({
    head: `${chatName} 的独立人设`,
    body: `
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input type="text" id="pcp-pick" readonly placeholder="点击选择人设" value="${esc(conf.roleText ? (Object.values(state.personaTemplates || {}).find((p) => p.text === conf.roleText)?.name || '自定义') : '')}" style="flex:1;cursor:pointer" />
        <button class="btn btn-small" id="pcp-new-btn">＋ 添加人设</button>
      </div>
      <span class="hint" id="pcp-hint" style="display:block;margin-bottom:8px"></span>
      <div class="field"><label>参与度（留空跟随全局）</label>
        <select id="pcp-participation">
          <option value="" ${!conf.participation ? 'selected' : ''}>跟随全局</option>
          <option value="low" ${conf.participation === 'low' ? 'selected' : ''}>安静型</option>
          <option value="medium" ${conf.participation === 'medium' ? 'selected' : ''}>普通群友</option>
          <option value="high" ${conf.participation === 'high' ? 'selected' : ''}>活跃型</option>
        </select></div>
      <div class="field"><label>角色设定（留空跟随全局）</label>
        <textarea id="pcp-roletext" class="persona-role-text" style="min-height:180px" placeholder="留空 = 用全局人设的角色设定">${esc(conf.roleText || '')}</textarea></div>
      <div class="field"><label>管理员附加规则（可选）</label>
        <textarea id="pcp-customrules" style="min-height:80px" placeholder="可选：追加到系统提示的规则（留空 = 用全局）">${esc(conf.customRules || '')}</textarea></div>
      <div class="field"><label>系统提示词覆盖（高级 · 可选）</label>
        <textarea id="pcp-sysprompt" style="min-height:80px" placeholder="可选：整体替换系统提示（留空 = 用全局）">${esc(conf.systemPromptOverride || '')}</textarea></div>
      <div class="hint" style="margin-top:6px">机器人名字/群内展示名不按会话变化（账号身份，改了会与 @ 判定对不上），在统一人设里设置。</div>`,
    foot: `<button class="btn" id="pcp-clear">清空独立人设</button>
           <button class="btn" id="pcp-cancel">取消</button>
           <button class="btn btn-primary" id="pcp-save">保存</button>`
  });

  // 选择人设 / 添加人设：统一走共享弹窗，**填回本弹窗的 pcp-* 字段**。
  // 原来这里自己抄了一份选择器、并且「添加人设」调用的是不带 target 的
  // openPersonaCreateModal() —— 那会把新模板填进设置页的 #cfg-roletext，
  // 而分群模式下页面根本没有那个框（弹窗里看不到任何反应）。
  const pcpTarget = { roleSel: '#pcp-roletext', rulesSel: '#pcp-customrules', pickSel: '#pcp-pick', hintSel: '#pcp-hint' };
  overlay.querySelector('#pcp-pick').addEventListener('click', () => openPersonaPicker(pcpTarget));
  overlay.querySelector('#pcp-new-btn').addEventListener('click', () => openPersonaCreateModal(pcpTarget));

  // 直接 POST 落盘：不走"写隐藏 JSON + 等表单链保存"的老路。
  // 老路的两个坑（2026-09-17 用户实测）：
  //   1. modal 挂在 body 下、不在 #settings-form 内，dispatchEvent(change) 冒泡
  //      到不了 form 的委托监听 —— 从来没触发过自动保存；
  //   2. 就算触发了，随后的 loadSettings() 重建表单 DOM，隐藏 input 被重渲染成
  //      GET 回来的旧值，用户刚写的条目被无声丢弃 → 重开 modal 一片空白。
  const saveToMap = async (entry) => {
    const current = state.config?.personaByChat || {};
    const next = { ...current };
    if (entry) next[chatKey] = entry; else delete next[chatKey];
    try {
      const r = await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ personaByChat: { __replace__: next } })
      });
      if (r?.config) state.config = r.config;
    } catch (e) {
      alert(`保存独立人设失败：${e?.message || e}`);
      throw e;
    }
  };

  overlay.querySelector('#pcp-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#pcp-clear').addEventListener('click', async () => {
    try { await saveToMap(null); } catch { return; }
    closeModelModal(overlay);
    renderSettings();   // 只刷人设区块（按钮上的 ● 标记），不整页重拉 7 个接口
  });
  overlay.querySelector('#pcp-save').addEventListener('click', async () => {
    const roleText = overlay.querySelector('#pcp-roletext').value.trim();
    const participation = overlay.querySelector('#pcp-participation').value;
    const customRules = overlay.querySelector('#pcp-customrules').value.trim();
    const sysPrompt = overlay.querySelector('#pcp-sysprompt').value.trim();
    if (!roleText && !participation && !customRules && !sysPrompt) {
      try { await saveToMap(null); } catch { return; }   // 全空 = 清除独立人设
    } else {
      const entry = {};
      if (roleText) entry.roleText = roleText;
      if (participation) entry.participation = participation;
      if (customRules) entry.customRules = customRules;
      if (sysPrompt) entry.systemPromptOverride = sysPrompt;
      try { await saveToMap(entry); } catch { return; }
    }
    closeModelModal(overlay);
    renderSettings();
  });
}

function renderAllowSection(c) {
  return `
    <h3 id="settings-allow">聊天白名单</h3>
    <div class="hint" style="margin-bottom:10px">白名单为空时机器人不会在任何群聊/私聊内运行。</div>
    <div class="field"><label>从 QQ 账号直接勾选</label>
      <div style="display:flex;gap:8px">
        <button class="btn btn-small" id="pick-groups-btn">选择群</button>
        <button class="btn btn-small" id="pick-friends-btn">选择好友</button>
        <span id="pick-result" class="muted" style="align-self:center"></span>
      </div></div>
    <div class="field-row">
      <div class="field"><label>允许的群号（逗号分隔）</label><input type="text" id="cfg-allowgroups" value="${esc((c.allow.groups || []).join(','))}" /></div>
      <div class="field"><label>允许的 QQ（逗号分隔）</label><input type="text" id="cfg-allowprivate" value="${esc((c.allow.private || []).join(','))}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-allowallwhenempty" ${c.allowAllWhenEmpty === true ? 'checked' : ''} />
      <label for="cfg-allowallwhenempty">白名单留空时允许所有会话</label></div>
    <div class="hint">说明：勾选后，若上方两个列表都为空，机器人会在<b>所有</b>群聊和私聊中运行；只要填了任意一项，就只按名单过滤。</div>
    <div class="hint" style="margin-top:8px">按会话的独立人设在「人设」页签配置（关闭"统一人设"后出现）。</div>

    <!-- 屏蔽名单紧跟白名单（2026-09-21 重排）：两者是"让谁参与"的一体两面
         （准入 ↔ 拒绝），openBlocklistModal 的提示语本身就是"先去「白名单」页签
         添加群聊，再来屏蔽群员"。原先它排在 运行节奏 / 主动开话题 / 表情包 之后，
         被三个功能块隔开，读起来像两件不相干的事。 -->
    <h3>屏蔽名单</h3>
    <div class="field">
      <button class="btn btn-small" id="blocklist-btn">管理屏蔽名单</button>
      <div class="hint" style="margin-top:6px">全局名单保存在 QQ Agent 云端，所有安装实例共享；云端暂时不可用时使用本地缓存。群级名单仍只对当前实例生效。</div>
    </div>

    <!-- 组边界：虚线分隔「管谁（准入）」与「怎么说话（行为）」两个大组 -->
    <div class="settings-divider"></div>`;
}

// 表情包积极程度档位：[值, 显示名]
const STICKER_LEVELS = [
  [0, '0 · 不鼓励（只在很贴切时偶尔用）'],
  [1, '1 · 偶尔（合适时配一张）'],
  [2, '2 · 较积极（优先考虑配图）'],
  [3, '3 · 很积极（表情包爱好者）']
];

// 读取历史档位：名称与说明（档位制，累积生效）
/** 把输入钳制到 [min,max]，非法值退回 fallback。 */
/**
 * 取会话的群名（群聊才有）。
 * 群名由后端 /api/chats 附带（走 OneBot get_group_info，带缓存与超时保护），
 * 拿不到就返回空串 —— 调用方会自动退回只显示群号。
 */
function chatNameOf(chatKey) {
  const c = (state.chats || []).find((x) => x.key === chatKey);
  return String(c?.chatName || '').trim();
}

/**
 * 会话标题：群名（群号） / 群 群号 / 私聊 号
 * 拿到群名时显示"群名（群号）"，既好认又能确认身份；拿不到就退回原来的"群 群号"。
 */
function formatChatTitle(chatKey, name = '') {
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return name ? `${name}（${m[1]}）` : `群 ${m[1]}`;
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return name ? `${name}（${p[1]}）` : `私聊 ${p[1]}`;
  return String(chatKey || '');
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/*
 * 滑条换算（前端显示用）。
 *
 * 换算逻辑来自 /vendor/tier-slider.js（与 src/tier-slider.js 同一份镜像）。
 * 后端保存配置时会用它**重新权威换算**档位与概率，前端这里只负责界面即时反馈。
 * 下面的 sliderToTierUI / sliderToTierUI_tierToSlider 是对共享函数的薄封装，
 * 保持既有调用点签名不变。
 */
function sliderToTierUI(pos) {
  return sliderToTier(pos);
}

/** 已保存配置 → 滑条位置（优先用存下来的位置，老配置没有就从 tier/概率反推）。 */
function sliderToTierUI_tierToSlider(st) {
  const saved = Number(st?.contextSliderPos);
  if (Number.isFinite(saved)) return Math.min(100, Math.max(0, saved));
  return tierToSlider(st?.contextTier, st?.randomPercent);
}

/** 滑条位置 → 一句话说明（给用户的即时反馈）。 */
function sliderDesc(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 1) return '<b>1 档 · 仅艾特</b>：只有被 @ 时才响应，其余消息标记已读、不调模型（最省）';
  if (tier === 2) return '<b>2 档 · +关键词</b>：被 @ 或命中关键词时响应';
  // 3 档概率展示必须与后端判定同源：resolveContextTier 用 Math.random()*100 与
  // randomPercent 比较（即"骰子值 < 阈值"），滑条换算出的 randomPercent 就是这个阈值。
  // 之前这里展示的是 sliderToTier 的 randomPercent 四舍五入值，而后端在保存时会
  // 重新权威换算一次 —— 两边都来自同一公式，但旧版 desc 里取整方式不同导致偶发不一致，
  // 现在统一保留一位小数（与 sliderToTier 一致）。
  if (tier === 3) return `<b>3 档 · +随机</b>：被 @ / 关键词必响应；此外每批普通消息有 <b>${randomPercent}%</b> 概率响应`;
  return '<b>4 档 · 全响应</b>：任何消息都响应，且艾特/关键词/随机的判定全部失效';
}

const TIER_NAME = { 1: '仅艾特', 2: '+关键词', 3: '+随机', 4: '全响应' };

/** 滑条位置 → 纯文本档位名（无 HTML 标签，供双点滑条说明文字使用）。 */
function sliderDescText(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 3) return `3 档 · +随机（${randomPercent}%）`;
  return `${tier} 档 · ${TIER_NAME[tier]}`;
}
const TIER_HINT = {
  1: '只有被 @ 时才响应，其余消息标记已读、不调模型（最省 token）',
  2: '在 1 档基础上，命中关键词也响应',
  3: '在 2 档基础上，再按概率随机响应一些消息',
  4: '任何消息都响应（改造前的行为，最费 token）'
};

function renderChatSection(c) {
  const st = c.store || {};
  // 响应档位/峰谷/指令禁言已移入「活跃设置」模态框（openActiveConfigModal），
  // 本区块只剩 主动话题/表情包 两个短块 + 两个收纳入口按钮。
  // （屏蔽名单 2026-09-21 已上移到 renderAllowSection，跟白名单作伴）
return `
    <h3>运行节奏</h3>
    <div class="field" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <button class="btn" id="open-send-config-btn">📨 信息发送配置</button>
      <button class="btn" id="open-active-config-btn">⚡ 活跃设置</button>
    </div>
    <div class="hint" style="margin-bottom:12px">节奏与发送保护、响应档位、峰谷、禁言等细节设置收纳进上面两个弹窗。</div>

    <h3>主动开话题</h3>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-proactive" ${c.proactive.enabled ? 'checked' : ''} />
      <label for="cfg-proactive">冷场时按概率主动开话题</label></div>
    <div id="proactive-sub" class="fold-sub${c.proactive.enabled ? '' : ' folded'}"><div class="fold-sub-inner">
      <div class="field-row">
        <div class="field"><label>检查间隔下限（毫秒）</label><input type="number" id="cfg-pro-min" min="60000" value="${esc(c.proactive.checkIntervalMinMs)}" /></div>
        <div class="field"><label>检查间隔上限（毫秒）</label><input type="number" id="cfg-pro-max" min="120000" value="${esc(c.proactive.checkIntervalMaxMs)}" /></div>
        <div class="field"><label>触发概率 0~1</label><input type="number" id="cfg-pro-prob" step="0.05" min="0" max="1" value="${esc(c.proactive.probability)}" /></div>
      </div>
    </div></div>

    <h3>表情包</h3>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-sticker" ${c.sticker.enabled ? 'checked' : ''} />
      <label for="cfg-sticker">启用表情包（收藏表情同步 + 发送工具）</label></div>

    <div id="sticker-sub" class="fold-sub${c.sticker.enabled ? '' : ' folded'}"><div class="fold-sub-inner">
      <div class="field">
        <label>发表情包的积极程度</label>
        <select id="cfg-sticker-encourage">
          ${STICKER_LEVELS.map(([v, label], i) =>
            `<option value="${v}" ${Number(c.sticker?.encourage ?? 1) === v ? 'selected' : ''}>${esc(label)}</option>`
          ).join('')}
        </select>
        <div class="hint">
          这是"引导"不是"强制"，模型仍会自行判断什么时机合适。
        </div>
      </div>

      <div class="field">
        <label>提示词里列举的表情包数量（1~50）</label>
        <input type="number" id="cfg-sticker-promptmax" min="1" max="50" value="${esc(Number(c.sticker?.promptMaxStickers) || 10)}" />
        <div class="hint">
          每次唤醒时，系统会把收藏表里最多这么多个表情包列进提示词供模型挑选。
          列得越多模型选择越丰富，但 token 成本也越高；收藏很多时适当调大，收藏少或想省 token 就调小。
        </div>
      </div>
    </div></div>`;
}

function renderDesktopSection(c) {
  return `
    <!-- 2026-09-21 重排：界面 提到桌面端之前（按使用频率 —— 主题是这页最常改的，
         自启/托盘装完设一次基本不动）；页签名同步改成「界面与应用」。
         分组：界面 + 桌面端 = "软件长什么样、怎么表现"；数据管理 + 版本更新 = "维护"，
         两组之间用虚线分开（同组内只用 h3 自带下边框）。 -->
    <h3>界面</h3>
    <div class="field"><label>主题</label>
      <div class="theme-picker" id="theme-picker">
        ${['dark', 'light', 'system', '?'].map((t) => `
          <div class="theme-option${getThemePref() === t ? ' on' : ''}" data-theme-opt="${t}" role="button" tabindex="0">
            <span class="t-ico">${THEME_ICON[t]}</span>
            <span>${THEME_LABEL[t]}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-showvision" ${c.ui?.showVision !== false ? 'checked' : ''} />
      <label for="cfg-showvision">模型目录显示“支持图片输入/不支持图片输入”徽标</label></div>
    <!-- 预览演示模式：原先在顶栏的 #preview-btn 已删，入口收进这里（滑动开关）。
         它不是配置项（不写 config），只切换 URL 的 #preview 哈希后重载整个界面。 -->
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-previewmode" ${state.preview ? 'checked' : ''} />
      <label for="cfg-previewmode">预览演示模式（用模拟数据展示消息与用量页，不影响真实机器人）</label></div>
    <div class="field"><label>界面刷新间隔（毫秒）</label><input type="number" id="cfg-refreshms" min="1000" step="1000" value="${esc(c.ui?.refreshMs ?? 15000)}" /></div>

    <!-- 外观个性化（R40）：颜色 / 底色 / 不透明度 / 背景图。
         同在「界面」组里（都是"软件长什么样"），所以只用 h3 自带下边框、不加虚线。 -->
    <h3>外观个性化</h3>
    <div class="field"><label>强调色（按钮、链接、选中态的那一抹颜色）</label>
      <div class="swatch-row" id="accent-swatches">
        ${ACCENT_PRESETS.map(([hex, name]) => `
          <span class="swatch${String(c.ui?.accent || '').toLowerCase() === hex ? ' on' : ''}"
                data-accent="${hex}" title="${esc(name)} ${hex}" role="button" tabindex="0"
                style="--sw:${hex}"></span>`).join('')}
        <span class="swatch swatch-reset${c.ui?.accent ? '' : ' on'}" data-accent="" title="跟随主题（默认）" role="button" tabindex="0">跟随主题</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <input type="color" id="cfg-accent" value="${esc(isHexColor(c.ui?.accent) ? c.ui.accent : (c.ui?.accent ? '#5b8cff' : '#5b8cff'))}" style="width:44px;height:28px;padding:0" />
        <input type="text" id="cfg-accent-hex" value="${esc(c.ui?.accent || '')}" placeholder="#5b8cff（留空=跟随主题）" style="width:180px" />
      </div>
    </div>
    <div class="field"><label>界面底色（窗口最底层的颜色）</label>
      <div class="swatch-row" id="bg-swatches">
        ${BG_PRESETS.map(([hex, name]) => `
          <span class="swatch${String(c.ui?.bgColor || '').toLowerCase() === hex ? ' on' : ''}"
                data-bg="${hex}" title="${esc(name)} ${hex}" role="button" tabindex="0"
                style="--sw:${hex}"></span>`).join('')}
        <span class="swatch swatch-reset${c.ui?.bgColor ? '' : ' on'}" data-bg="" title="跟随主题（默认）" role="button" tabindex="0">跟随主题</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <input type="color" id="cfg-bgcolor" value="${esc(isHexColor(c.ui?.bgColor) ? c.ui.bgColor : '#0e1013')}" style="width:44px;height:28px;padding:0" />
        <input type="text" id="cfg-bgcolor-hex" value="${esc(c.ui?.bgColor || '')}" placeholder="#0e1013（留空=跟随主题）" style="width:180px" />
      </div>
    </div>
    <div class="field"><label>底色不透明度：<b id="framealpha-val">${clampInt(c.ui?.frameAlpha, 30, 100, 100)}</b>%</label>
      <input type="range" id="cfg-framealpha" min="30" max="100" step="1" value="${clampInt(c.ui?.frameAlpha, 30, 100, 100)}" style="width:260px" />
      <div class="hint">调低后窗口底色变半透明：能透出下面的背景图；没有背景图时直接透出桌面。</div>
    </div>
    <div class="field"><label>背景图</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-small" id="cfg-bg-pick" type="button">🖼 选择图片</button>
        <!-- 清除（R50）：没有背景图时禁用 —— 可点但点了只是把空值再写一遍，
             视觉上一枚"能点的危险按钮"摆在"没有东西可清"的地方也很违和 -->
        <button class="btn btn-small btn-danger" id="cfg-bg-clear" type="button" ${c.ui?.bgImage ? '' : 'disabled'} title="${c.ui?.bgImage ? '移除当前背景图' : '还没有设置背景图'}">清除</button>
        <select id="cfg-bgfit" style="width:120px">
          ${[['cover', '铺满裁剪'], ['contain', '完整显示'], ['repeat', '平铺']].map(([v, t]) => `<option value="${v}" ${String(c.ui?.bgFit || 'cover') === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="margin-top:8px"><label>背景图暗化：<b id="bgdim-val">${clampInt(c.ui?.bgDim, 0, 85, 0)}</b>%</label>
        <input type="range" id="cfg-bgdim" min="0" max="85" step="1" value="${clampInt(c.ui?.bgDim, 0, 85, 0)}" style="width:260px" /></div>
      <div class="hint" id="cfg-bg-hint">${c.ui?.bgImage ? `已设置：${esc(c.ui.bgImage)}（图片已复制到数据目录，换电脑不会丢）` : '未设置。选好图片后，把上面的「底色不透明度」调低就能看到它。'}</div>
    </div>
    <div class="field"><label>整窗不透明度：<b id="winopacity-val">${clampInt(c.ui?.winOpacity, 30, 100, 100)}</b>%</label>
      <input type="range" id="cfg-winopacity" min="30" max="100" step="1" value="${clampInt(c.ui?.winOpacity, 30, 100, 100)}" style="width:260px" />
      <div class="hint">整个窗口（含文字）一起变淡，适合长期挂在一边偷看群消息。仅桌面端生效。</div>
    </div>
    <div class="field">
      <button class="btn btn-small" id="cfg-uicustom-reset" type="button">↺ 外观恢复默认</button>
      <span class="hint" id="cfg-uicustom-hint" style="margin-left:8px"></span>
    </div>
    <!-- 自由布局（R51）：拖动分隔条调宽 / 拖拽页签排序 / 面板拖成浮层。
         这里放说明、**显式保存**（R67）与复位入口。 -->
    <div class="field"><label>界面排布</label>
      <div class="hint" style="margin-top:0">
        拖动左右两栏之间的分隔条可调整宽度（双击复位）；顶部页签可按住拖动重排顺序；
        面板拖离原位会变成浮层，可放到窗口任意位置。
        排布会自动保存，下次打开保持原样 —— 想确认存下来的就是眼前这一版，点「保存当前排布」。
      </div>
      <div style="margin-top:8px">
        <button class="btn btn-small btn-primary" id="cfg-layout-save" type="button">💾 保存当前排布</button>
        <button class="btn btn-small" id="cfg-layout-reset" type="button" style="margin-left:6px">↺ 排布恢复默认</button>
        <span class="hint" id="cfg-layout-hint" style="margin-left:8px"></span>
      </div>
    </div>

    <h3>桌面端</h3>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-autostart" ${c.server?.autoStart ? 'checked' : ''} />
      <label for="cfg-autostart">开机自启</label></div>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-closetray" ${c.server?.closeToTray !== false ? 'checked' : ''} />
      <label for="cfg-closetray">点关闭时最小化到托盘</label></div>

    <div class="settings-divider"></div>
    <h3>数据管理</h3>
    <div class="field"><label>用户数据目录</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-datadir" readonly value="${esc(state.dataDir || '（加载中…）')}" style="flex:1" />
        <button class="btn btn-small" id="open-datadir-btn">打开文件夹</button>
      </div>
      <div class="hint">所有用户数据（配置、聊天记录、记忆、表情包）都存在这个目录里。删除后重启应用即为初始形态。</div>
    </div>
    <div class="field">
      <button class="btn btn-danger" id="reset-data-btn">重置为初始形态</button>
      <span class="hint" id="reset-data-hint" style="margin-left:10px"></span>
      <div class="hint" style="margin-top:6px">⚠️ 此操作会删除所有用户数据（配置、聊天记录、记忆、表情包），不可恢复。建议先备份。</div>
    </div>
    <h3>版本更新</h3>
    <div class="field"><label>当前版本 <b id="update-current">…</b><span id="update-status-text">${updateAvailable ? '<b style="color:var(--orange)">；发现新版本</b>' : '；检查线上是否有新版本'}</span></label>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn btn-small" id="check-update-btn">检查更新</button>
        <span class="hint" id="update-hint" style="margin:0"></span>
      </div></div>`;
}

function renderOnebotSection(c) {
  return `
    <h3 id="settings-onebot">OneBot（SnowLuma）</h3>
    <div class="hint" style="margin-bottom:10px">SnowLuma 的启动、关闭与日志已移动到顶部「SnowLuma」页签。此处只保留连接配置。</div>
    <div class="field"><label>SnowLuma 程序目录（留空 = 自动使用项目内 snowluma/ 文件夹）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-snowlumadir" value="${esc(c.snowluma.dir || '')}" style="flex:1" />
        <button class="btn btn-small" id="open-snowluma-btn">打开文件夹</button>
      </div>
      <div class="hint" id="snowluma-hint"></div></div>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-snowlumalaunch" ${c.snowluma.autoLaunch ? 'checked' : ''} />
      <label for="cfg-snowlumalaunch">QQ Agent 启动时自动拉起 SnowLuma（未运行时）</label></div>
    <div class="field-row">
      <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="cfg-wsurl" value="${esc(c.snowluma.wsUrl)}" /></div>
      <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="cfg-httpurl" value="${esc(c.snowluma.httpUrl)}" /></div>
      <div class="field"><label>WebSocket 令牌</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-obtoken" value="${esc(c.snowluma?.hasAccessToken ? '******' : '')}" placeholder="输入新令牌可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-obtoken-toggle" type="button">显示</button>
        </div></div>
      <div class="field"><label>HTTP 令牌（与 WS 不同时填；SnowLuma 默认分开）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-obhttptoken" value="${esc(c.snowluma?.hasHttpAccessToken ? '******' : '')}" placeholder="输入新令牌可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-obhttptoken-toggle" type="button">显示</button>
        </div></div>
    </div>
    <div class="hint">改完 OneBot 地址需要重启应用生效；模型/人设/白名单即时生效。</div>`;
}

/**
 * 刷新 Skill 状态（后端判定结果）。
 * 单独抽出来是因为开关切换后需要立即重取，而不是等下一次 loadSettings。
 */
/**
 * 拉取技能/插件列表（内存态）。**不含磁盘重扫** —— 想让新放入的目录
 * 被看到，走 rescanSkills()。
 */
async function loadSkillsStatus() {
  try {
    const data = await api('/api/skills');
    state.skills = data.skills || [];
    state.skillsSummary = data.summary || {};
    state.uninstalledSkills = data.uninstalled || [];
  } catch {
    /* 取不到就保持原值，不覆盖成空列表造成"条目都不见了"的假象 */
  }
}

/**
 * 重扫磁盘并刷新列表：技能/插件页「刷新」按钮的完整动作。
 * 之前刷新只重读内存注册表，后台文件监听一旦丢事件（目录删除重建、
 * 网络盘、杀毒软件），放进去的新插件无论点多少次刷新都看不到。
 * 现在先 POST /api/skills/reload 让后端真正重扫；接口不可用时退回
 * 普通列表拉取（不比旧行为差）。
 */
async function rescanSkills({ quiet = false } = {}) {
  try {
    const r = await api('/api/skills/reload', { method: 'POST' });
    if (r && r.skills) {
      state.skills = r.skills;
      state.skillsSummary = r.summary || {};
      // 重扫接口的响应没有 uninstalled 字段，补拉一次（很轻，还能顺带拿脱敏配置）
      await loadSkillsStatus();
      if (!quiet && r.failed?.length) {
        console.warn('[skill] 本次重扫失败条目：', r.failed);
      }
      return r;
    }
  } catch (e) {
    console.warn('[skill] 重扫请求失败：', e?.message || e);
  }
  await loadSkillsStatus();
  return null;
}

/**
 * 技能设置弹窗。
 *
 * 为什么把设置放在技能自己的弹窗里（而不是塞进设置页）：
 *   · 这些字段**只对这个技能有意义** —— 分散在全局设置页里，用户根本对不上号
 *   · 技能页本来就该是"这个技能能配什么"的唯一入口
 *   · 开关和设置放在一起，改完立刻能看到状态徽章变化
 *
 * 表单**完全按 manifest 的 configSchema 渲染**，前端不硬编码任何字段名 ——
 * 加一个新技能、加一个字段，这里一行都不用改。
 * 支持的 type：boolean（复选框）/ number（数字输入）/ enum（下拉）/ string（文本框）
 * 另外 secret: true 的字段用密码框，且留空 = 不修改（后端也按同一约定处理）。
 */
/**
 * 生成技能设置弹窗的 HTML（**纯函数**，不碰 DOM）。
 *
 * 拆出来的唯一目的是可测：这次改动的重点是视觉层级
 * （名字用等宽大字、介绍用正文小字、模态框加宽），
 * 埋在 DOM 操作里就只能靠肉眼看，改坏了没人发现。
 *
 * @returns {{ html: string } | { error: string }}
 */
function renderSkillSettingsModal(skill) {
  if (!skill) return { error: '技能不存在' };
  const skillId = skill.id;
  const schema = skill.configSchema || {};
  const values = skill.settings || {};
  // internal 字段（列表/对象类）不渲染成表单输入 —— 它们由专用界面管理。
  // 但仍然要在弹窗里列出来并说明去哪改，否则用户会以为"这个设置根本不存在"。
  const allKeys = Object.keys(schema);
  const internalKeys = allKeys.filter((k) => schema[k]?.type === 'internal');
  const keys = allKeys.filter((k) => schema[k]?.type !== 'internal');
  if (!allKeys.length) return { error: '这个技能没有可配置项' };

  const fieldHtml = (key) => {
    const d = schema[key] || {};
    const v = values[key] ?? d.default ?? '';
    const label = esc(d.label || key);
    const hint = d.description ? `<div class="hint">${esc(d.description)}</div>` : '';
    const id = `skset-${esc(skillId)}-${esc(key)}`;
    // secret：用密码框 + 占位符提示"留空不改"，避免把脱敏值当明文回填
    const isSecret = d.secret === true;
    // 长文本字段跨整行：窄列里换行会碎成一条，读起来很累
    const isWide = d.type === 'string' && (d.multiline === true || String(d.description || '').length > 60);
    const cls = 'field' + (isWide ? ' field--wide' : '');
    let input;
    if (d.type === 'boolean') {
      // 整行做成可点区域：单摆一个小复选框在宽弹窗里像没渲染完
      input = `<label class="skill-toggle-row">
        <input type="checkbox" class="sw" id="${id}" data-key="${esc(key)}" data-type="boolean" ${v ? 'checked' : ''} />
        <span class="st-text">${v ? '已开启' : '已关闭'}</span>
      </label>`;
    } else if (d.type === 'number') {
      input = `<input type="number" id="${id}" data-key="${esc(key)}" data-type="number" value="${esc(v)}" step="any" />`;
    } else if (d.type === 'enum' && Array.isArray(d.values)) {
      // 枚举渲染成下拉：值写错会让技能行为异常，下拉从根上避免手抖
      input = `<select id="${id}" data-key="${esc(key)}" data-type="enum">${
        d.values.map((x) => `<option value="${esc(x)}" ${String(v) === String(x) ? 'selected' : ''}>${esc(x)}</option>`).join('')
      }</select>`;
    } else {
      input = `<input type="${isSecret ? 'password' : 'text'}" id="${id}" data-key="${esc(key)}" data-type="string" value="${isSecret ? '' : esc(v)}" placeholder="${isSecret ? (v ? '已设置（留空 = 不修改）' : '未设置') : ''}" autocomplete="off" />`;
    }
    return `<div class="${cls}"><label>${label}${d.secret ? ' 🔒' : ''}</label>${input}${hint}</div>`;
  };

  return { html: `<div class="modal skill-modal" role="dialog" aria-modal="true" aria-label="${esc(skill.name)} 设置">
    <div class="skill-modal__head">
      <div class="skill-modal__titles">
        <div class="skill-modal__name">
          ${esc(skill.name)}
          <span class="skill-modal__ver">v${esc(skill.version || '')}</span>
        </div>
        <div class="skill-modal__id">${esc(skillId)}</div>
        <div class="skill-modal__desc">${esc(skill.description || '（这个技能没有写介绍）')}</div>
      </div>
      <button class="icon-btn" id="skset-x" title="关闭" aria-label="关闭">✕</button>
    </div>
    <div class="skill-modal__body">
      <div class="skill-modal__note">
        共 <b>${keys.length}</b> 项设置 · 保存在 <code>config.skills['${esc(skillId)}']</code>，只有这个技能会读到它们。
      </div>
      <div class="skill-form">${keys.map(fieldHtml).join('')}</div>
      ${internalKeys.length ? `<div class="skill-modal__internal">
        <div class="skill-modal__internal-head">以下设置不在这里改</div>
        ${internalKeys.map((k) => `<div class="skill-modal__internal-item"><b>${esc(schema[k].label || k)}</b><br />${esc(schema[k].description || '')}</div>`).join('')}
      </div>` : ''}
    </div>
    <div class="skill-modal__foot">
      <!-- 上传到市场：从卡片上收进来（卡片只留开关 + 设置，低频动作不常驻） -->
      <button class="btn btn-small" id="skset-upload" title="把这个条目发布到社区市场">上传到市场</button>
      <span class="skill-modal__foot-tip">改动即时生效，无需重启</span>
      <span class="spacer"></span>
      <button class="btn btn-small" id="skset-cancel">取消</button>
      <button class="btn btn-primary" id="skset-save">保存</button>
    </div>
  </div>` };
}

/** 打开某个技能的设置弹窗。 */
function openSkillSettings(skillId) {
  const skill = (state.skills || []).find((x) => x.id === skillId);
  if (!skill) return;
  const built = renderSkillSettingsModal(skill);
  if (built.error) { alert(built.error); return; }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = built.html;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#skset-x').addEventListener('click', close);
  overlay.querySelector('#skset-cancel').addEventListener('click', close);
  // 上传到市场：带上条目类型（kind 为 null = 自定义目录，按技能处理）
  overlay.querySelector('#skset-upload')?.addEventListener('click', () => {
    openMarketUploadModal(skill.kind || 'skill', skillId);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  // Esc 关闭：弹窗大了以后鼠标要移很远，键盘出口是必需的
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  overlay.setAttribute('tabindex', '-1');
  overlay.focus();

  // 复选框旁边的"已开启/已关闭"文字要跟着变，否则看不出当前状态
  overlay.querySelectorAll('input[type="checkbox"][data-type="boolean"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const span = cb.parentElement?.querySelector('.st-text');
      if (span) span.textContent = cb.checked ? '已开启' : '已关闭';
    });
  });

  overlay.querySelector('#skset-save').addEventListener('click', async () => {
    const settings = {};
    overlay.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const type = el.dataset.type;
      if (type === 'boolean') settings[key] = el.checked;
      else if (type === 'number') {
        const n = Number(el.value);
        // 空值/非数字：不提交这个键，让后端保留原值（而不是写进一个 NaN）
        if (el.value.trim() !== '' && Number.isFinite(n)) settings[key] = n;
      } else if (type === 'enum') settings[key] = el.value;
      else settings[key] = el.value;   // secret 留空 → 后端按"不修改"处理
    });
    try {
      const r = await api(`/api/skills/${encodeURIComponent(skillId)}`, {
        method: 'POST',
        body: JSON.stringify({ settings })
      });
      const idx = (state.skills || []).findIndex((x) => x.id === skillId);
      if (idx >= 0 && r.skill) {
        // 后端返回的是 status 视图；把设置与 schema 合并回去，避免卡片丢掉这两项
        state.skills[idx] = { ...state.skills[idx], ...r.skill, settings: r.settings || {}, configSchema: state.skills[idx].configSchema };
      }
      if (r.config) state.config = r.config;
      await loadSkillsStatus();
      // 两页都重绘：设置弹窗可能从技能页或插件页打开，
      // 而改动会同时影响状态徽章。重绘代价可忽略（每页最多十来张卡片）。
      renderModulePage('skill');
      renderModulePage('plugin');
      close();
    } catch (err) {
      alert(`保存失败：${err.message}`);
    }
  });
}

/**
 * 扩展页（技能 / 插件）
 *
 * 两型在**代码里完全同构**（同一条加载器、同一套清单字段、同一个开关），
 * 唯一的区别是"谁决定何时执行"：
 *   skill  （LLM 型）  —— 注册工具，模型看了 description 自己决定调不调
 *   plugin （确定性型）—— 提供能力/钩子，核心代码按能力名确定性调用，必然执行
 *
 * 这件事对使用者太重要了（决定"这个功能会不会被模型忽略"），所以拆成两个页签，
 * 但渲染逻辑共用一份 —— 否则两页的卡片、分组、开关行为迟早会分叉。
 *
 * ⚠️ 状态一律用后端 /api/skills 的判定结果，前端**不自己推断**能不能用 ——
 * 否则又会出现"界面说能用、实际不生效"的两套口径。
 */
const MODULE_KINDS = {
  skill: {
    kind: 'skill',
    tab: 'skills',
    boxSel: '#skills-page',
    title: '技能（Skill）',
    dir: 'skills/',
    emptyHint: `还没加载到任何技能。<br />LLM 型技能放在项目的 <code>skills/&lt;id&gt;/</code> 目录，需要 <code>skill.json</code> + <code>index.js</code>。`,
    lead: `技能是 <b>LLM 型</b>扩展：它们注册工具进模型的 function 列表，<b>用不用、什么时候用由模型自己判断</b>。<br />
      所以技能不会"一定生效" —— 模型可能一直不调用它。需要"条件满足必跑"的功能，应该做成插件（见旁边的「插件」页签）。`,
    setupTitle: '新增技能',
    setupHint: `在 <code>skills/&lt;id&gt;/</code> 放 <code>skill.json</code> + <code>index.js</code>，
      导出 <code>setup(api)</code> 并在里面 <code>api.registerTool({...})</code>。
      热重载默认开启，保存即生效。完整规范见 <code>doc/extend_development/skill-development.md</code>。`
  },
  plugin: {
    kind: 'plugin',
    tab: 'plugins',
    boxSel: '#plugins-page',
    title: '插件（Plugin）',
    dir: 'plugins/',
    emptyHint: `还没加载到任何插件。<br />确定性型插件放在项目的 <code>plugins/&lt;id&gt;/</code> 目录，需要 <code>plugin.json</code> + <code>index.js</code>。`,
    lead: `插件是 <b>确定性型</b>扩展：它们提供<b>能力</b>（<code>providers</code>）或<b>钩子</b>（<code>hooks</code>），
      由核心代码按能力名确定性调用 —— <b>条件满足就一定会执行，不经过 LLM，模型想忽略也忽略不掉</b>。<br />
      代价是它不能"看情况发挥"：什么时候触发必须在代码里写死。需要模型理解意图的功能，应该做成技能（见旁边的「技能」页签）。`,
    setupTitle: '新增插件',
    setupHint: `在 <code>plugins/&lt;id&gt;/</code> 放 <code>plugin.json</code> + <code>index.js</code>，
      导出 <code>setup(api)</code>，并用 <code>export const providers = {...}</code> 或 <code>export const hooks = {...}</code> 声明扩展点。
      热重载默认开启，保存即生效。完整规范见 <code>doc/extend_development/plugin-development.md</code>。`
  }
};

/* ══════════════════════════════════════════════════════════════
   卡片顺序（用户拖拽排序，2026-09-20）
   ══════════════════════════════════════════════════════════════
   两层持久化，和主题一个套路：
     1. localStorage —— 拖完立即生效，不等接口
     2. 后端 config.ui.moduleOrder.{skill|plugin} —— 换设备/重装后还在
   没排过序（取不到任何顺序）就保持后端给的原顺序，不做任何重排。
*/
function moduleOrderKey(kind) { return `qqa-module-order-${kind}`; }

/** 取本页顺序（id 数组）；没排过返回 null。 */
function readModuleOrder(kind) {
  try {
    const raw = localStorage.getItem(moduleOrderKey(kind));
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    }
  } catch { /* 隐私模式下可能不可用 */ }
  const fromCfg = state.config?.ui?.moduleOrder?.[kind];
  return Array.isArray(fromCfg) ? fromCfg : null;
}

/** 按保存的顺序重排条目；没排过的 / 新装的条目按原相对顺序落在最后。 */
function applyModuleOrder(items, kind) {
  const ord = readModuleOrder(kind);
  if (!ord || !ord.length) return items;
  const pos = new Map();
  ord.forEach((id, i) => { if (!pos.has(id)) pos.set(id, i); });
  return items.slice().sort((a, b) => {
    const pa = pos.has(a.id) ? pos.get(a.id) : Number.MAX_SAFE_INTEGER;
    const pb = pos.has(b.id) ? pos.get(b.id) : Number.MAX_SAFE_INTEGER;
    return pa - pb;   // 同为"没排过"时 sort 稳定 → 保持后端原顺序
  });
}

/** 把 grid 里现在的顺序落盘（本地 + 后端，后端失败静默）。 */
function saveModuleOrder(kind, grid) {
  const ids = [...grid.querySelectorAll('.mcard[data-skill-id]')].map((el) => el.dataset.skillId);
  if (!ids.length) return;
  const key = moduleOrderKey(kind);
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* 忽略 */ }
  const ui = { ...(state.config?.ui || {}) };
  const next = { ...(ui.moduleOrder || {}), [kind]: ids };
  ui.moduleOrder = next;
  if (state.config) state.config.ui = ui;   // 让紧接着的重渲染直接用新顺序
  api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { moduleOrder: next } }) })
    .catch(() => { /* 后端不可达时静默：localStorage 已经生效 */ });
}

/**
 * 给一页的卡片装上拖拽排序。
 *
 * 用 Pointer Events 手动实现（2026-09-20 晚，替换 HTML5 DnD）。旧 DnD 方案两个
 * 体验问题：
 *   1. 拖动时浏览器自带"半透明快照"（drag image）跟着光标走 —— 用户看到
 *      两个标签（"留下拖动的标签"）；
 *   2. 让位是"插入式"的：拖卡与目标之间的所有卡整体平移一格 —— 用户预期
 *      是"和目标卡直接互换"。
 * 新交互：
 *   · 按住卡片左缘 26px 热区（手柄列）移动 ≥5px 才算拖起 —— 点卡片仍是开关；
 *   · 拖起：克隆一张浮层卡跟手（微倾斜 + 大投影），原卡淡出占位；
 *   · 悬停到另一张卡上：**只交换这两张** —— 目标卡 180ms 滑到拖卡原槽位，
 *     其余卡片纹丝不动（目标不变时过渡只跑一次，丝滑不抖）；
 *   · 松手：一次性提交 DOM 顺序并持久化（localStorage + 后端）。
 */
function setupCardDrag(scope, kind) {
  const grid = scope.querySelector('.module-grid');
  if (!grid) return;
  let drag = null;   // { el, clone, cards, slots, fromIdx, toIdx, started, startX, startY }

  const beginDrag = () => {
    const el = drag.el;
    const cards = [...grid.querySelectorAll('.mcard')];
    const slots = cards.map((c) => c.getBoundingClientRect());
    const r = slots[cards.indexOf(el)];
    const clone = el.cloneNode(true);
    clone.classList.add('mcard-ghost');
    clone.style.left = r.left + 'px';
    clone.style.top = r.top + 'px';
    clone.style.width = r.width + 'px';
    clone.style.height = r.height + 'px';
    // ⚠️ 抬起效果（rotate + scale，见 .mcard-ghost）默认绕**中心**变换，会把抓取点
    // 从指针下挪走（实测约漂移 11px，卡片越大越明显）。把变换原点设为抓取点，
    // 卡片就绕"手指按住的那一点"倾斜放大 —— 指针始终钉在按下时的位置。
    clone.style.transformOrigin = `${drag.offX}px ${drag.offY}px`;
    document.body.appendChild(clone);
    el.classList.add('mcard-src');
    for (const c of cards) if (c !== el) c.classList.add('mcard-shifting');
    Object.assign(drag, { started: true, cards, slots, fromIdx: cards.indexOf(el), toIdx: -1, clone });
    grid.classList.add('mdrag-active');
    document.body.style.cursor = 'grabbing';
  };

  /** 与悬停卡互换：目标卡滑到拖卡原槽位，其余不动。idx=-1 = 未悬停，复位。 */
  const swapTo = (idx) => {
    if (idx === drag.toIdx) return;
    if (drag.toIdx >= 0) drag.cards[drag.toIdx].style.transform = '';
    drag.toIdx = idx;
    if (idx >= 0 && idx !== drag.fromIdx) {
      const r = drag.slots[idx];
      const o = drag.slots[drag.fromIdx];
      const dx = Math.round(o.left - r.left);
      const dy = Math.round(o.top - r.top);
      drag.cards[idx].style.transform = (dx || dy) ? `translate(${dx}px, ${dy}px)` : '';
    }
  };

  const endDrag = (commit) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    document.body.style.cursor = '';
    grid.classList.remove('mdrag-active');
    d.clone?.remove();
    d.el.classList.remove('mcard-src');
    if (!d.started) return;   // 没超过 5px 阈值 = 普通点击，交给 click 事件
    if (commit && d.toIdx >= 0 && d.toIdx !== d.fromIdx) {
      const order = [...d.cards];
      order[d.fromIdx] = d.cards[d.toIdx];
      order[d.toIdx] = d.cards[d.fromIdx];
      for (const c of order) grid.appendChild(c);
    }
    for (const c of d.cards) { c.classList.remove('mcard-shifting'); c.style.transform = ''; }
    saveModuleOrder(kind, grid);
  };

  grid.querySelectorAll('.mcard').forEach((cardEl) => {
    cardEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, label, a, textarea, select')) return;
      const r = cardEl.getBoundingClientRect();
      // 热区：卡片左缘 26px（手柄列 + 余量）。整卡可点（点一下切开关），
      // 不能整卡都算拖拽，否则开关点不准。
      if (e.clientX - r.left > 26) return;
      // offX/offY = 抓取点相对卡片左上角的偏移：拖起来后浮层卡按这个偏移跟手，
      // 指针始终停在你按下的那个位置上（曾经是中心对齐，一拖起卡片就"跳"到
      // 鼠标正下方，手感像被甩了一下——2026-09-20 用户反馈）。
      drag = {
        el: cardEl, startX: e.clientX, startY: e.clientY,
        offX: e.clientX - r.left, offY: e.clientY - r.top, started: false
      };
    });
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
      beginDrag();
    }
    // 浮层卡跟手：按按下时的抓取偏移走（指针停在你按的那个点上，不居中吸附）
    drag.clone.style.left = Math.round(e.clientX - drag.offX) + 'px';
    drag.clone.style.top = Math.round(e.clientY - drag.offY) + 'px';
    // 悬停到哪张卡 → 与它互换。
    // ⚠️ 不能拿「指针点」判定：从上往下拖会路过中间的卡，擦个边就误触发互换，
    //    被擦过的卡猛地滑上来又弹回去 —— 用户说的"意义不明的动画"就是它。
    //    改用**浮层卡与槽位的重叠面积**判定，并且带**回滞**（2026-09-21）：
    //    接管新目标要 >50%，但已接管的目标要等重叠 <30% 才放手。只有一条阈值时，
    //    拖卡悬在目标槽位边缘（重叠在 50% 附近）+ 鼠标轻微上下修正，会让下方卡
    //    反复"顶上去→滑回来"（用户反馈的"一小段上弹然后滑下来"）—— 30~50% 的
    //    回滞带把这个抖动整个吸收掉：一旦顶上去，只要还压着 3 成就不松手。
    const gr = drag.clone.getBoundingClientRect();
    /** 拖卡与第 i 个槽位的重叠面积占该槽位的比例 */
    const fracOf = (i) => {
      const s = drag.slots[i];
      const ox = Math.min(gr.right, s.right) - Math.max(gr.left, s.left);
      const oy = Math.min(gr.bottom, s.bottom) - Math.max(gr.top, s.top);
      return (ox <= 0 || oy <= 0) ? 0 : (ox * oy) / (s.width * s.height);
    };
    let best = -1;
    let bestArea = 0;
    for (let i = 0; i < drag.slots.length; i++) {
      if (i === drag.fromIdx) continue;
      const s = drag.slots[i];
      const ox = Math.min(gr.right, s.right) - Math.max(gr.left, s.left);
      const oy = Math.min(gr.bottom, s.bottom) - Math.max(gr.top, s.top);
      if (ox <= 0 || oy <= 0) continue;
      const area = ox * oy;
      if (area > bestArea) { bestArea = area; best = i; }
    }
    let hit = -1;
    if (drag.toIdx >= 0 && drag.toIdx !== drag.fromIdx) {
      // 已有目标：黏住，重叠掉到 30% 以下才放手
      if (fracOf(drag.toIdx) >= 0.3) hit = drag.toIdx;
      else if (best >= 0 && fracOf(best) >= 0.5) hit = best;
    } else if (best >= 0) {
      if (fracOf(best) >= 0.5) hit = best;   // 擦边（<半张卡）不算
    }
    swapTo(hit);
  });
  window.addEventListener('pointerup', () => endDrag(true));
  window.addEventListener('pointercancel', () => endDrag(false));
}

async function loadModulePage(kind, { rescan = false } = {}) {
  const meta = MODULE_KINDS[kind];
  if (!meta) return;
  const box = $(meta.boxSel);
  if (!box) return;
  box.innerHTML = renderModuleSkeleton(meta);
  if (rescan) await rescanSkills({ quiet: true });
  else await loadSkillsStatus();
  // 技能页右侧有提示词预览：先拉预览再渲染，避免首屏占位闪一下
  // （带上 GET /api/config 的最新状态，避免用旧缓存拼预览）
  if (kind === 'skill') await refreshPromptPreview(state.config || {});
  renderModulePage(kind);
}

function renderModuleSkeleton(meta) {
  return `<div class="usage-wrap">
    <div class="usage-head"><h2>${esc(meta.title)}</h2></div>
    <div class="sk-block">${'<div class="sk-row"></div>'.repeat(5)}</div>
  </div>`;
}

/**
 * 渲染一页（技能或插件）。
 *
 * @param {'skill'|'plugin'} kind 只渲染该类型；另一类的条目**完全不进这一页**
 */
function renderModulePage(kind) {
  const meta = MODULE_KINDS[kind];
  if (!meta) return '';
  const box = $(meta.boxSel);
  const all = state.skills || [];
  // 只留本页该管的类型。
  // ⚠️ kind 为 null（自定义根目录，如测试用的临时目录）时归入**技能页**而不是丢弃 ——
  // "界面上凭空少了一个条目"比"归错页"难排查得多（用户刚刚就踩过这个坑）。
  // 卡片上会标「目录未识别」提示作者去确认放置位置。
  const items = all.filter((s) => s.kind === meta.kind || (s.kind == null && meta.kind === 'skill'));

  // 统计按本页条目现算：后端 summary 是全量的，直接用会把另一类也算进来
  const mine = {
    total: items.length,
    active: items.filter((s) => s.active).length,
    off: items.filter((s) => s.loaded && !s.enabled).length,
    broken: items.filter((s) => !s.loaded).length
  };

  if (!items.length) {
    const emptyHtml = `<div class="usage-wrap">
      <div class="usage-head"><h2>${esc(meta.title)}</h2>
        <div class="usage-days">
          <button class="btn btn-small" id="${esc(meta.tab)}-create-btn">＋ 添加${meta.kind === 'skill' ? '技能' : '插件'}</button>
          <button class="btn btn-small" id="${esc(meta.tab)}-refresh-btn">刷新</button>
        </div></div>
      <div class="empty-hint">${meta.emptyHint}</div>
      <div class="hint" style="margin-top:10px">${meta.lead}</div>
      <div class="hint" style="margin-top:10px"><b>把 zip 包或整个文件夹直接拖到这一页就能装</b>，也可以点上面「＋ 添加${meta.kind === 'skill' ? '技能' : '插件'}」选「导入本地文件」。</div>
    </div>`;
    if (box) box.innerHTML = emptyHtml;
    bindModulePageEvents(kind);
    return emptyHtml;
  }

  // ── 半宽卡片 + 拖拽排序（2026-09-20 改版）──
  // 上一版是「一整行大卡 + 按分类分组」：一屏放不下几个，翻很久。
  // 现在：取消分类（分类图标/标签一并去掉），一屏两列半宽卡；
  // 顺序由用户按住左侧手柄拖动决定，存 config.ui.moduleOrder + localStorage。
  // 卡左条颜色表达状态（绿=生效 / 灰=已关 / 红=加载失败 / 黄=依赖未就绪）。
  // 设置钮图标（2026-09-20 换版）：用户点名要「齿轮」造型（线性 outline 风格）。
  // 上一版用的滑块图标被换掉；这颗齿是 8 齿 + 中轴双圈，stroke 线性，
  // 与顶栏自绘窗口按钮同一套图标语言（fill:none / stroke:currentColor 由 CSS 提供）。
  const GEAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="3.2"/>'
    + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
    + '</svg>';
  // 拖动手柄：两列三点，纯线条点阵（不用 ⠿ 文本字形，各平台字体不一致）
  const GRIP_SVG = '<svg viewBox="0 0 8 16" aria-hidden="true">'
    + '<circle class="dt" cx="2.2" cy="3.5" r="1.05"/>'
    + '<circle class="dt" cx="5.8" cy="3.5" r="1.05"/>'
    + '<circle class="dt" cx="2.2" cy="8" r="1.05"/>'
    + '<circle class="dt" cx="5.8" cy="8" r="1.05"/>'
    + '<circle class="dt" cx="2.2" cy="12.5" r="1.05"/>'
    + '<circle class="dt" cx="5.8" cy="12.5" r="1.05"/>'
    + '</svg>';
  // 删除钮：小垃圾桶（feather trash-2 造型：盖线 + 提手 + 桶身 + 两条竖线），
  // 与齿轮同一套线性图标语言（fill:none / stroke:currentColor 由 CSS 提供）。
  const TRASH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M3 6h18"/>'
    + '<path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>'
    + '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'
    + '<path d="M10 11v6"/>'
    + '<path d="M14 11v6"/>'
    + '</svg>';
  const card = (s) => {
    const loadedOk = s.loaded;
    const active = loadedOk && s.enabled && s.active;
    // 状态类名：驱动卡片边框/底色（CSS 里 .mcard-* 定义）
    const stateCls = !loadedOk ? 'mcard-broken' : (!s.enabled ? 'mcard-off' : (active ? 'mcard-on' : 'mcard-dep'));
    const stateTitle = !loadedOk ? `加载失败：${s.loadError || '原因未知'}`
      : (!s.enabled ? '已关闭（点击开启）'
        : (active ? '生效中（点击关闭）' : `已启用但依赖未就绪：${s.reason || (s.missingRequires || []).join('、') || '原因未知'}`));
    const stateText = !loadedOk ? '加载失败' : (!s.enabled ? '已关闭' : (active ? '生效中' : '依赖未就绪'));
    const allFields = Object.keys(s.configSchema || {});
    const settingsBtn = allFields.length
      ? `<button class="mcard-gear" data-skill-id="${esc(s.id)}" title="设置（${allFields.length} 项）" aria-label="打开 ${esc(s.name)} 的设置">${GEAR_SVG}</button>`
      : '';
    // 删除钮：从磁盘移除这个 Skill/插件的整个目录（不可逆）。
    // 图标按钮的点击会 stopPropagation，不会触发整卡开关。
    const kindLabel = (s.kind || kind) === 'plugin' ? '插件' : '技能';
    const delBtn = `<button class="mcard-del" data-skill-id="${esc(s.id)}" data-skill-name="${esc(s.name)}" data-skill-kind="${esc(s.kind || kind || '')}" title="删除${kindLabel}（从磁盘移除整个文件夹，不可恢复）" aria-label="删除 ${esc(s.name)}">${TRASH_SVG}</button>`;
    return `
    <div class="mcard mcard-big mcard-half ${stateCls}" data-skill-id="${esc(s.id)}" role="button" tabindex="0" title="${esc(stateTitle)}">
      <span class="mcard-grip" title="按住拖动排序" aria-label="拖动 ${esc(s.name)} 排序" role="button" tabindex="-1">${GRIP_SVG}</span>
      <div class="mcard-info">
        <div class="mcard-title-line">
          <span class="mcard-name">${esc(s.name)}</span>
          <span class="skill-card__ver">v${esc(s.version)}</span>
          <span class="mcard-state">${stateText}</span>
        </div>
        <div class="mcard-desc">${esc(s.description || '（没有写介绍）')}</div>
        <div class="mcard-dir">${esc(s.dir || '')}</div>
      </div>
      <div class="mcard-acts">
        ${settingsBtn}
        ${delBtn}
        <label class="mcard-sw" title="${esc(stateTitle)}">
          <input type="checkbox" class="sw" data-skill-toggle="${esc(s.id)}" ${s.enabled ? 'checked' : ''} ${!loadedOk ? 'disabled' : ''} />
        </label>
      </div>
      ${!loadedOk && s.loadError ? `<span class="mcard-err">${esc(String(s.loadError).slice(0, 120))}</span>` : ''}
    </div>`;
  };

  // ── 页面级左右分栏（技能页；插件页无预览整页两列卡）──
  // 左半边：标题/说明/卡片，全部随滚动；右半边：整块提示词预览，
  // 独立滚动、钉在原地不随页面动。
  // 分类分组已取消：全部条目平铺进**一个** grid（两列），顺序 = 用户拖出来的顺序。
  const ordered = applyModuleOrder(items, kind);
  const grid = `
    <div class="module-grid">
      ${ordered.map(card).join('')}
    </div>`;

  // 尾注：技能页最有用的信息是"它有哪些工具"（模型看到的就是这些），
  // 插件页最有用的信息是"它提供哪些能力"（核心按名字找的就是这些）。
  const toolsOfMine = items.flatMap((s) => s.toolIds || []);
  const capsOfMine = [...new Set(items.flatMap((s) => s.capabilities || []))].sort();
  const footer = kind === 'skill'
    ? `<h3 class="usage-h3">这一页的技能共注册 ${toolsOfMine.length} 个工具</h3>
    <div class="hint" style="margin-bottom:6px">这些工具会被放进发给模型的 function 列表 —— 模型只能看到工具，看不到技能本身。</div>
    <div class="tool-meta" style="gap:6px">${toolsOfMine.map((t) => `<span class="tool-dep">${esc(t)}</span>`).join('') || '<span class="muted">（没有注册任何工具）</span>'}</div>`
    : `<h3 class="usage-h3">这一页的插件共提供 ${capsOfMine.length} 个能力</h3>
    <div class="hint" style="margin-bottom:6px">核心模块按这些能力名找提供者，不依赖具体插件名 —— 所以换实现不用改核心代码。</div>
    <div class="tool-meta" style="gap:6px">${capsOfMine.map((c) => `<span class="tool-dep">${esc(c)}</span>`).join('') || '<span class="muted">（没有声明任何能力）</span>'}</div>`;

  // 已配置但未安装的残留配置段：删目录后 config.skills.<id> 还留着。
  // 只在技能页展示一次（两页共用 state，插件页不重复渲染）；
  // 一键清理走 POST /api/skills/cleanup，后端会再次校验"确实未安装"。
  const uninstalledHtml = (kind === 'skill' && (state.uninstalledSkills || []).length)
    ? `<h3 class="usage-h3">已配置但未安装（${state.uninstalledSkills.length}）</h3>
      <div class="hint" style="margin-bottom:6px">这些条目在配置里留着开关/设置，但 <code>skills/</code> 与 <code>plugins/</code> 目录里已经没有对应的文件夹。重装同名插件会自动恢复这些设置；确认不要了可以清理掉。</div>
      <div class="tool-meta" style="gap:6px;margin-bottom:8px">
        ${state.uninstalledSkills.map((u) => `<span class="tool-dep">${esc(u.id)}${u.enabled ? '' : '（已关）'}${u.hasSettings ? ' · 有设置' : ''}</span>`).join('')}
      </div>
      <button class="btn btn-small" id="skills-cleanup-btn">清理这些残留配置</button>`
    : '';

  const html = `<div class="module-split">
    <div class="module-split-left">
      <div class="usage-wrap">
        <div class="usage-head">
          <h2>${esc(meta.title)}</h2>
          <div class="usage-days">
            <span class="uc-tag" title="生效中 / 这一页的总数">${mine.active} / ${mine.total} 生效</span>
            <button class="btn btn-small" id="${esc(meta.tab)}-create-btn">＋ 添加${meta.kind === 'skill' ? '技能' : '插件'}</button>
            <button class="btn btn-small" id="${esc(meta.tab)}-refresh-btn">刷新</button>
          </div>
        </div>
        <div class="hint" style="margin-bottom:14px">
          ${meta.lead}<br />
          开关只有这一处 —— 关闭后它注册的工具、提供的能力、提示词片段和请求改写会**同时**失效。
          不可用时下面会直接写明原因（未启用 / 缺依赖 / 模型不支持 / 加载失败）。
          卡片顺序可以自己排：按住左侧的点阵手柄拖到想要的位置，顺序会记住。<br />
          <b>装新的：把 zip 包或整个文件夹直接拖到这一页</b>（或点右上角「＋ 添加${meta.kind === 'skill' ? '技能' : '插件'}」→ 导入本地文件）。
        </div>
        ${grid}
        ${footer}
        ${uninstalledHtml}
        <h3 class="usage-h3">${esc(meta.setupTitle)}</h3>
        <div class="hint">${meta.setupHint}</div>
      </div>
    </div>
    ${kind === 'skill' ? `
    <div class="module-split-right">
      <div class="prompt-preview-card module-preview-card">
        <div class="prompt-preview-title">📝 完整提示词预览</div>
        <div class="prompt-preview-hint">按当前的插件/技能/工具开关实时组装（没开的不会出现）：</div>
        <pre class="prompt-preview-content">${esc(renderPromptPreviewText())}</pre>
      </div>
    </div>` : ''}
  </div>`;

  if (box) box.innerHTML = html;
  bindModulePageEvents(kind);
  return html;
}

/** 供渲染测试按名取用的两个入口（render-test 会逐个执行这些函数）。 */
function renderSkillsPage() { return renderModulePage('skill'); }
function renderPluginsPage() { return renderModulePage('plugin'); }

function bindModulePageEvents(kind) {
  const meta = MODULE_KINDS[kind];
  if (!meta) return;
  const boxEl = $(meta.boxSel);
  // 整页放置区：把 zip / 文件夹拖进来直接装（绑在容器上，页面重渲染不会丢）
  bindModuleDropZone(kind, boxEl);
  $(`#${meta.tab}-refresh-btn`)?.addEventListener('click', () => loadModulePage(kind, { rescan: true }));
  // 「添加技能/插件」：两个去处 —— 市场口令安装 / 自己造（2026-09-19 改版）。
  $(`#${meta.tab}-create-btn`)?.addEventListener('click', () => openAddModuleModal(kind));
  // 残留配置清理（只在技能页渲染，按钮也只在这一页出现）
  $('#skills-cleanup-btn')?.addEventListener('click', async () => {
    const btn = $('#skills-cleanup-btn');
    if (!btn || !state.uninstalledSkills?.length) return;
    const ids = state.uninstalledSkills.map((u) => u.id);
    if (!confirm(`清理 ${ids.length} 个未安装条目的配置（${ids.join('、')}）？\n清理后重装同名插件将恢复默认设置。`)) return;
    btn.disabled = true;
    try {
      const r = await api('/api/skills/cleanup', { method: 'POST', body: JSON.stringify({ ids }) });
      if (r.config) state.config = r.config;
      await loadModulePage('skill');
    } catch (e) {
      alert(`清理失败：${e?.message || e}`);
      btn.disabled = false;
    }
  });
  // 注意这里是 $$ （返回数组）不是 $（返回单个元素）：
  // 卡片可能有多个，用 $ 会拿到一个元素然后 .forEach 报错。
  // ⚠️ 绑定范围必须限定在**本页容器内**：两个页面同时存在于 DOM 里（只是 view 切换显隐），
  // 用全局 $$ 会把另一页的卡片也绑一遍 —— 同一个开关被绑两次，一次切换会发两个请求。
  const scope = $(meta.boxSel);
  if (!scope) return;
  scope.querySelectorAll('.skill-settings-btn, .mcard-gear').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();   // 齿轮在卡片内部，点它不能触发整卡开关
      openSkillSettings(btn.dataset.skillId);
    });
  });
  // 删除：垃圾桶钮 → 二次确认 → DELETE /api/skills/<id>（后端删目录 + 热重扫）。
  // click 与 keydown 都要 stopPropagation：否则点它 / 在上面回车会顺带触发整卡开关。
  scope.querySelectorAll('.mcard-del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.skillId;
      const name = btn.dataset.skillName || id;
      const isPlugin = btn.dataset.skillKind === 'plugin';
      const kindLabel = isPlugin ? '插件' : '技能';
      const dirLabel = isPlugin ? 'plugins' : 'skills';
      if (!confirm(`确定删除${kindLabel}「${name}」吗？\n\n它会从磁盘上被整体移除（删除 ${dirLabel}/ 下的整个文件夹），此操作不可恢复。`)) return;
      btn.disabled = true;
      try {
        const r = await api(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (r.config) state.config = r.config;
        await loadSkillsStatus();
        renderModulePage(kind);
      } catch (err) {
        alert(`删除失败：${err?.message || err}`);
        btn.disabled = false;
      }
    });
    btn.addEventListener('keydown', (e) => e.stopPropagation());
  });
  // 上传到市场：入口已收进「设置」弹窗（卡片上不再放 ⬆ 钮）。
  // ── 切换启停：点滑块开关 或 点卡片其余区域（保留旧习惯）。
  // 两者共用同一条请求链；开关上的 click 会 stopPropagation，避免卡片再触发一次。
  const toggleModule = async (id, next, busyEl) => {
    const cur = (state.skills || []).find((s) => s.id === id);
    if (!cur || !cur.loaded) return;   // 加载失败的条目切不动
    busyEl.style.pointerEvents = 'none';
    if (busyEl instanceof HTMLInputElement) busyEl.dataset.pending = '1';
    try {
      const r = await api(`/api/skills/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: JSON.stringify({ enabled: next })
      });
      const idx = (state.skills || []).findIndex((s) => s.id === id);
      if (idx >= 0 && r.skill) state.skills[idx] = r.skill;
      if (r.config) state.config = r.config;
      await loadSkillsStatus();
      renderModulePage(kind);
    } catch (err) {
      alert(`切换失败：${err.message}`);
      busyEl.style.pointerEvents = '';
      if (busyEl instanceof HTMLInputElement) delete busyEl.dataset.pending;
    }
  };
  scope.querySelectorAll('input[data-skill-toggle]').forEach((sw) => {
    // label 一并拦下：点 label 的 click 目标是 label 本身，不拦会冒泡成"整卡开关"
    sw.closest('.mcard-sw')?.addEventListener('click', (e) => e.stopPropagation());
    sw.addEventListener('change', () => toggleModule(sw.dataset.skillToggle, sw.checked, sw));
  });
  // 键盘可达：Enter/Space 同样触发（role=button + tabindex=0）。
  scope.querySelectorAll('.mcard').forEach((cardEl) => {
    const toggle = () => {
      const sw = cardEl.querySelector('input[data-skill-toggle]');
      if (sw && !sw.disabled && !sw.dataset.pending) toggleModule(cardEl.dataset.skillId, !sw.checked, cardEl);
    };
    cardEl.addEventListener('click', toggle);
    cardEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
  // 拖拽排序：放在最后 —— 它要读 grid 里最终的卡片顺序
  setupCardDrag(scope, kind);
}

// 工具分类的顺序与名字提到模块级：buildToolCategoryHTML（局部刷新共用）
// 和 renderToolsSection（整页渲染）必须读到同一份定义。
const TOOL_CATEGORY_ORDER = ['messaging', 'sticker', 'query', 'memory', 'web', 'system'];
const TOOL_CATEGORY_NAMES = {
  messaging: '💬 消息发送',
  sticker: '😀 表情管理',
  query: '🔍 消息查询',
  memory: '🧠 记忆系统',
  web: '🌐 联网搜索',
  system: '⚙️ 系统反馈'
};

/**
 * 生成单个分类块（.tool-category）的 HTML。整页渲染与局部刷新共用这一份：
 * 07-settings-events.js 的 refreshToolCategory 在分类总开关/折叠展开时只替换
 * 这一个块（整页 innerHTML 重建在软件渲染下是肉眼可见的闪烁），
 * 两处渲染不同源就会出现"点一下开关 DOM 结构变样"的怪象。
 */
function buildToolCategoryHTML(cat) {
  const c = state.config;
  const toolsCfg = c.tools || {};
  const tools = state.toolRegistry || [];
  const catTools = tools.filter((t) => t.category === cat);
  if (!catTools.length) return '';
  // 分类总开关：关 = 整类工具全部停用（后端本来就按 categories[cat] 拦，
  // 这里补的是**视觉**：子开关要跟着显示成关、且不可拨，而不是"开着却没生效"）。
  const catEnabled = toolsCfg.categories?.[cat] !== false;
  const expandedCategories = state.expandedToolCategories || new Set(['messaging']);
  const isExpanded = expandedCategories.has(cat);

  const toolCards = isExpanded ? catTools.map((t) => {
    const enabled = toolsCfg.overrides?.[t.id] ?? t.defaultEnabled ?? true;
    const disabledByDep = (t.requiresVision && c.api?.vision === false) || (t.requiresSearch && c.webSearch?.enabled === false);
    // 功能名字 + 一句话概括
    const funcName = t.id.split(':').pop(); // 去掉插件前缀
    const summary = t.description.split('。')[0] + '。'; // 第一句话
    // send_to 的开关就是「跨会话发送」本身（tools.crossChatSend）：
    // 开关收编进消息发送分类，用户在工具卡上直接控制，不再单独设全局勾选框。
    const isSendTo = t.id === 'send_to';
    const ownChecked = isSendTo ? (toolsCfg.crossChatSend === true) : enabled;
    // 实际生效 = 自己开着 **且** 分类总开关开着；总开关关时子开关显示关 + disabled
    const checked = catEnabled && ownChecked;
    return `
        <div class="tool-card ${checked ? 'enabled' : 'disabled'} ${disabledByDep ? 'dep-disabled' : ''}" data-tool-id="${t.id}">
          <div class="tool-header">
            <span class="tool-switch-wrap">
              <label class="tool-switch">
                <input type="checkbox" class="tool-checkbox sw" data-tool-id="${t.id}" ${isSendTo ? 'data-cross-chat="1"' : ''} ${checked ? 'checked' : ''} ${(!catEnabled || (disabledByDep && !isSendTo)) ? 'disabled' : ''} />
              </label>
            </span>
            <span class="tool-icon">${t.icon}</span>
            <div class="tool-title">
              <div class="tool-name">${esc(funcName)}</div>
              <div class="tool-summary">${esc(summary)}</div>
            </div>
          </div>
          <div class="tool-meta">
            ${t.requiresVision ? '<span class="tool-dep">需要视觉模型</span>' : ''}
            ${t.requiresSearch ? '<span class="tool-dep">需要搜索服务</span>' : ''}
            ${disabledByDep ? '<span class="tool-dep-warn">依赖未满足</span>' : ''}
            ${isSendTo ? '<span class="tool-dep">目标须在白名单内</span>' : ''}
          </div>
        </div>`;
  }).join('') : '';

  return `
      <div class="tool-category ${isExpanded ? 'expanded' : 'collapsed'}" data-category="${cat}">
        <div class="tool-category-header" data-category="${cat}">
          <span class="tool-category-arrow">${isExpanded ? '▼' : '▶'}</span>
          <label class="tool-category-toggle" onclick="event.stopPropagation()">
            <input type="checkbox" class="category-checkbox sw" data-category="${cat}" ${catEnabled ? 'checked' : ''} />
            <span class="tool-category-name">${TOOL_CATEGORY_NAMES[cat] || cat}</span>
            <span class="tool-category-count">${catTools.length} 个工具</span>
          </label>
        </div>
        ${isExpanded ? `<div class="tool-list">${toolCards}</div>` : ''}
      </div>`;
}

function renderToolsSection(c) {
  // 按分类分组（只用来决定哪些分类要渲染；块内逻辑在 buildToolCategoryHTML）
  const tools = state.toolRegistry || [];
  const toolsCfg = c.tools || {};
  const categories = TOOL_CATEGORY_ORDER;

  const categoryCards = categories.map((cat) => buildToolCategoryHTML(cat)).join('');

  // 完整提示词预览（文本统一走 renderPromptPreviewText，见其注释）

  // 页面级左右分栏：左=标题/开关/工具卡（随滚动），右=整块预览（钉住）。
  // 标题与说明全部在左半边，不进右栏。
  return `
    <div class="module-split">
      <div class="module-split-left">
        <h3 id="settings-tools">工具与技能</h3>
        <div class="hint" style="margin-bottom:16px">
          勾选启用机器人可调用的工具。禁用后模型将无法使用该功能。
          ${toolsCfg.enabled === false ? '<span style="color:var(--red)">⚠️ 全局开关已关闭，所有工具均不可用</span>' : ''}
        </div>
        <div class="field">
          <label class="tool-global-toggle">
            <input type="checkbox" class="sw" id="cfg-tools-enabled" ${toolsCfg.enabled !== false ? 'checked' : ''} />
            <span>启用工具系统（关闭后机器人只能看不能做任何操作）</span>
          </label>
        </div>
        <div class="tool-actions" style="margin-bottom:16px;display:flex;gap:8px">
          <button class="btn btn-small" id="tools-enable-all">全部启用</button>
          <button class="btn btn-small" id="tools-disable-all">全部禁用</button>
          <button class="btn btn-small" id="tools-reset">恢复默认</button>
        </div>
        ${categoryCards}
      </div>
      <div class="module-split-right">
        <div class="prompt-preview-card tools-preview-card">
          <div class="prompt-preview-title">📝 完整提示词预览</div>
          <div class="prompt-preview-hint">按当前的插件/技能/工具开关实时组装（没开的不会出现）：</div>
          <pre class="prompt-preview-content">${esc(renderPromptPreviewText())}</pre>
        </div>
      </div>
    </div>`;
}

/**
 * 完整提示词预览文本（设置-工具与技能 & 技能页右侧共用同一份）。
 * 数据来自 GET /api/prompt-preview —— 后端用运行时同一套
 * buildSystemPrompt + getToolAvailability 组装，按当前启停状态实时反映；
 * 前端不再自己拼（曾经前端复制了一份静态模板，永远是"全启用"的样子，
 * 与实际发送的提示词越漂越远）。
 * 后端返回结果缓存在 state.promptPreview；render* 渲染时同步取，
 * 开关变动后由 refreshPromptPreview() 异步拉新并原地更新 DOM。
 */
function renderPromptPreviewText() {
  const d = state.promptPreview;
  if (!d || typeof d.systemPrompt !== 'string') return '（正在加载提示词预览…）';
  const tools = d.tools || [];
  const toolLines = tools.length
    ? tools.map((t) => `- ${t.id}：${t.description}`).join('\n')
    : '（当前没有可用工具）';
  return `${d.systemPrompt}\n\n【本次可用工具清单（function calling）】\n${toolLines}`;
}

/**
 * 拉取/刷新提示词预览。
 * 实时性设计（2026-09-17）：预览读的是**后端活配置**（getConfig），而设置的
 * 自动保存有 600ms 防抖 —— 直接刷看到的是旧状态。所以本函数可带 overrides
 * （与配置同结构的临时补丁）：请求发给 /api/prompt-preview，后端先深合并补丁
 * 再组装（不落盘），预览即刻反映刚点的开关，不用等自动保存落地。
 */
async function refreshPromptPreview(overrides = null) {
  try {
    // 空对象不附 body（GET 语义）——没有补丁就按后端活配置组装
    const hasOverrides = overrides && Object.keys(overrides).length > 0;
    const d = await api('/api/prompt-preview', hasOverrides ? {
      method: 'POST',
      body: JSON.stringify(overrides)
    } : {});
    state.promptPreview = d;
  } catch {
    state.promptPreview = null;
  }
  // 两处预览 DOM（设置-工具页 / 技能页右侧）都原地换文本，不整页重渲染
  $$('.prompt-preview-content').forEach((pre) => {
    pre.textContent = renderPromptPreviewText();
  });
}
