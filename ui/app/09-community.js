// 〔社区：提示/上传/发送配置/活跃设置/市场〕——M9 拆分第 10 段
'use strict';
/* ══════════════════════════════════════════════════════════════
   社区功能：意见收集 + 金句上传
   ══════════════════════════════════════════════════════════════
   数据流向：浏览器 → https://kondius.cn/qq-agent/api（作者自建的公开
   收件箱，静态站之外的一个小型接收服务）。不经过本地后端 ——
   本地后端只服务本机，碰不到作者的服务器；分发版用户也是这个地址
   （意见和金句本来就是发给作者看的）。
*/
const COMMUNITY_API = 'https://kondius.cn/qq-agent/api';

/** 统一的提示小模态框（替代 alert —— 原生对话框与 UI 风格割裂）。 */
function showNoticeModal(title, text) {
  const overlay = modelModalShell({
    head: title,
    body: `<div class="hint" style="font-size:13.5px;line-height:1.7">${esc(text)}</div>`,
    foot: `<button class="btn btn-primary" id="notice-ok">知道了</button>`
  });
  overlay.querySelector('#notice-ok').addEventListener('click', () => closeModelModal(overlay));
}

/**
 * 上传成功浮框（右上角）：不自动消失，只能手动关闭，带目标网址。
 * 意见收集 / 金句上传成功后调用。
 */
function showUploadToast(title, url, { onClose } = {}) {
  // 同类型只留一个（连着传两次不堆叠）
  document.querySelectorAll('.upload-toast').forEach((el) => el.remove());
  const el = document.createElement('div');
  el.className = 'upload-toast';
  el.innerHTML = `
    <div class="ut-head">
      <span class="ut-title">${esc(title)}</span>
      <button class="ut-close" type="button" aria-label="关闭" title="关闭">×</button>
    </div>
    <a class="ut-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
  document.body.appendChild(el);
  el.querySelector('.ut-close').addEventListener('click', () => { el.remove(); onClose?.(); });
}

/**
 * 「信息发送配置」模态框（2026-09-18 改版）：收纳
 * 防抖聚批窗口 / 批次间隔 / 并发会话数 / 失败重试次数 / 发送间隔与限流
 * + 从模型 API 移来的 温度 / 单次运行最大工具轮数 / 思考强度。
 * 按字数附加间隔 与 QQ 硬限制切分 已按需求删除（不再收集，旧配置忽略）。
 * 保存 = 直接 POST 对应 patch（api 三件套 + chat 节奏 + send 限流）。
 */
function openSendConfigModal() {
  const c = state.config || {};
  const overlay = modelModalShell({
    head: '信息发送配置',
    body: `
      <div class="field-row">
        <div class="field"><label>温度</label><input type="number" id="sc-temperature" step="0.1" min="0" max="2" value="${esc(c.api?.temperature ?? 0.8)}" /></div>
        <div class="field"><label>单次运行最大工具轮数</label><input type="number" id="sc-maxrounds" min="1" max="40" value="${esc(c.api?.maxRounds ?? 12)}" /></div>
      </div>
      <div class="field"><label>思考强度</label>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="sc-thinking-effort" style="max-width:220px">
            ${[
              ['off', '关（不思考，明确关闭）'],
              ['', '默认（跟随模型/网关）'],
              ['low', '低（快、省 token）'],
              ['medium', '中'],
              ['high', '高（慢、细致）']
            ].map(([v, l]) => {
              const eff = c.api?.thinkingEffort || '';
              const mode = c.api?.thinkingMode || 'auto';
              const sel = mode === 'off' ? 'off' : eff;
              return `<option value="${v}" ${sel === v ? 'selected' : ''}>${l}</option>`;
            }).join('')}
          </select>
        </div>
        <div class="hint">由「思考模式适配」插件落成各厂商参数；档位仅对应渠道生效。</div></div>
      <div class="field-row">
        <div class="field"><label>防抖聚批窗口（毫秒）</label><input type="number" id="sc-wakedelay" min="0" value="${esc(c.wakeDelayMs)}" /></div>
        <div class="field"><label>批次间隔（毫秒）</label><input type="number" id="sc-draindelay" min="0" value="${esc(c.drainDelayMs)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>同时处理几个会话</label><input type="number" id="sc-maxruns" min="1" max="8" value="${esc(c.maxConcurrentRuns)}" /></div>
        <div class="field"><label>失败自动重试次数</label><input type="number" id="sc-sessionretry" min="0" max="5" value="${esc(c.sessionRetryAttempts ?? 2)}" />
          <div class="hint">0 = 关闭。已发出过消息的会话绝不自动重试。</div></div>
      </div>
      <div class="field-row">
        <div class="field"><label>相邻消息最小间隔（毫秒）</label><input type="number" id="sc-mingap" min="200" value="${esc(c.send?.minGapMs ?? 1000)}" /></div>
        <div class="field"><label>最大间隔（毫秒）</label><input type="number" id="sc-maxgap" min="500" value="${esc(c.send?.maxGapMs ?? 3000)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>每分钟最多发送</label><input type="number" id="sc-maxpermin" min="1" value="${esc(c.send?.maxPerMinute ?? 80)}" /></div>
        <div class="field"><label>每小时最多发送</label><input type="number" id="sc-maxperhour" min="1" value="${esc(c.send?.maxPerHour ?? 500)}" /></div>
      </div>`,
    foot: `<button class="btn" id="sc-cancel">取消</button>
           <button class="btn btn-primary" id="sc-save">保存</button>`
  });
  overlay.querySelector('#sc-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#sc-save').addEventListener('click', async () => {
    const g = (id) => overlay.querySelector('#' + id)?.value ?? '';
    const effort = String(g('sc-thinking-effort')).trim();
    const patch = {
      api: {
        temperature: Math.min(2, Math.max(0, Number(g('sc-temperature')) || 0.8)),
        maxRounds: Math.min(40, Math.max(1, Number(g('sc-maxrounds')) || 12)),
        thinkingMode: effort === 'off' ? 'off' : (['low', 'medium', 'high'].includes(effort) ? 'on' : 'auto'),
        thinkingEffort: ['low', 'medium', 'high'].includes(effort) ? effort : ''
      },
      wakeDelayMs: Number(g('sc-wakedelay')) || 2000,
      drainDelayMs: Number(g('sc-draindelay')) || 1200,
      maxConcurrentRuns: Math.min(8, Math.max(1, Number(g('sc-maxruns')) || 2)),
      sessionRetryAttempts: Math.min(5, Math.max(0, Number(g('sc-sessionretry')) || 0)),
      send: {
        minGapMs: Number(g('sc-mingap')) || 1000,
        maxGapMs: Number(g('sc-maxgap')) || 3000,
        maxPerMinute: Number(g('sc-maxpermin')) || 80,
        maxPerHour: Number(g('sc-maxperhour')) || 500
        // byLengthMs / hardSplitAt 已按需求删除：不写 = deepMerge 保留旧值，
        // 运行端 sender.js 仍按旧值兜底（无碍）；想彻底清理可手删 config.json 字段。
      }
    };
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
      closeModelModal(overlay);
      loadSettings();
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
}

/**
 * 「活跃设置」模态框（2026-09-18 改版）：收纳
 * 响应档位整块 / 被召唤后持续参与 / 活跃期时长 / 峰谷切换 / 指令禁言。
 * 峰谷改版：双点滑条（高峰点 + 低谷点，高档=低谷 低档=高峰），
 * 低谷时段字段删除（高峰外=低谷）；预设改为 workbuddy / deepseek / 自定义。
 * 档位参数（各档条数+关键词表）收进内部「档位设置」子模态框。
 * 保存 = 直接 POST store/commandMute/chatActive patch。
 */
/**
 * 「活跃设置」模态框（2026-09-19 改版）：收纳
 * 响应档位整块 / 峰谷切换 / 指令禁言。
 *
 * 布局：左侧一条**竖向**档位滑条（1 档在下、4 档在上，轨道下蓝上黄渐变），
 *       右侧是开关与参数。统一/分群**共用同一条滑条** —— 分群模式下它编辑
 *       当前选中的群（群按钮列表选择，替代旧下拉框），从结构上消灭了
 *       "两套滑条 id + 按元素存在性猜象限"这一类 bug。
 * 峰谷：同一条滑条上两颗珠 —— 上面那颗（档位更高）= 低谷时段档位，
 *       下面那颗 = 高峰时段档位，互不交叉；两珠之间画一条半透明区间带。
 * 档位参数（各档条数 + 关键词表 + 被召唤后持续参与 + 活跃期时长）
 * 收进内部「档位设置」子模态框。
 * 保存 = 直接 POST store/commandMute patch（chatActive 由子模态框自己保存）。
 */
function openActiveConfigModal() {
  const clampNum = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fb; };
  const c = state.config || {};
  const st = c.store || {};
  const B = TIER_SLIDER_BANDS;
  const ps = st.peakSchedule || {};
  const unified0 = st.unifiedTier !== false;
  const peakOn0 = ps.enabled === true;
  const globalPos = sliderToTierUI_tierToSlider(st);

  // ── 草稿（闭包工作副本；保存时整体提交，取消即弃）──
  let dContextPos = globalPos;
  let dPeak = {
    start: String(ps.peak?.start || '09:00'),
    end: String(ps.peak?.end || '18:00'),
    peakPos: clampNum(ps.peak?.sliderPos, 10),     // 高峰（安静）档位点
    valleyPos: clampNum(ps.valley?.sliderPos, 100) // 低谷（活跃）档位点
  };
  // 分群两张图：拷贝时剔除 __ 开头的内部键（旧版 __preview 草稿残留一并清掉，不再随图往返）
  const stripInternal = (m) => Object.fromEntries(Object.entries(m || {}).filter(([k]) => !String(k).startsWith('__')));
  const dGroupPos = stripInternal(st.groupSliderPos);
  const dGroupPeak = stripInternal(st.groupPeakPos);
  let activeGid = '';

  // 峰谷时段字段 + 预设（峰谷开关控制显隐；DOM 常驻，切换开关不重建弹窗）
  const peakFieldsHtml = `
    <div id="ac-peak-fields" class="fold-sub${peakOn0 ? '' : ' folded'}"><div class="fold-sub-inner">
      <div class="field-row">
        <div class="field"><label>高峰时段（开始 ~ 结束，所有群共享）</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input type="time" id="cfg-peak-start" value="${esc(dPeak.start)}" />
            <span class="muted">~</span>
            <input type="time" id="cfg-peak-end" value="${esc(dPeak.end)}" />
          </div>
          <div class="hint">时段支持跨零点；高峰之外的时间一律视为低谷（用低谷档位）。</div></div>
        <div class="field"><label>预设方案</label>
          <select id="cfg-peak-preset">
            <option value="">— 选择预设 —</option>
            ${peakPresetOptions(ps).map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}
          </select>
          <div class="hint" id="peak-preset-hint" style="margin-top:4px">选预设自动填充时段与两个档位点（套用到当前编辑的滑条）。</div></div>
      </div>
      <div class="field"><button class="btn btn-small" id="peak-preset-save-btn" type="button">保存当前方案为「自定义」</button></div>
    </div></div>`;

  // 竖向四段刻度：滑条"1 档在下、4 档在上"，说明文字也按同向排列 ——
  // 低档位的描述在下、高档位的描述在上（与珠子位置一一对应，读起来不用翻转）。
  const tier0 = sliderToTierUI(peakOn0 ? dPeak.valleyPos : globalPos).tier;
  const peakTier0 = peakOn0 ? sliderToTierUI(dPeak.peakPos).tier : -1;
  const segHtml = (n, label, flex) => {
    const on = n === tier0 ? ' on' : '';
    const semi = peakOn0 && n === peakTier0 && n !== tier0 ? ' semi' : '';
    return `<span class="tier-seg seg${n}${on}${semi}" data-seg="${n}" style="flex:${flex}">${label}</span>`;
  };
  const scaleHtml = `
      <div class="tier-scale tier-scale-v" id="ac-tier-scale">
        ${segHtml(1, '1 · 仅艾特', B.tier1End)}
        ${segHtml(2, '2 · +关键词', B.tier2End - B.tier1End)}
        ${segHtml(3, '3 · +随机', B.tier3End - B.tier2End)}
        ${segHtml(4, '4 · 全响应', 100 - B.tier3End)}
      </div>`;

  const overlay = modelModalShell({
    head: '活跃设置',
    body: `
      <div class="ac-body">
        <div class="ac-left">
          <div class="hint ac-target" id="ac-target"></div>
          <div class="ac-slider-row">
            <div class="vslider2" id="ac-slider" data-dual="${peakOn0 ? '1' : '0'}"></div>
            ${scaleHtml}
          </div>
          <div class="hint" id="ac-tier-note" style="text-align:center;max-width:180px"></div>
        </div>
        <div class="ac-right">
          <div class="checkbox-row"><input type="checkbox" class="sw" id="ac-unifiedtier" ${unified0 ? 'checked' : ''} />
            <label for="ac-unifiedtier">统一设置全部响应档位（关掉就能给每个白名单群聊单独拖档位）</label></div>
          <div class="checkbox-row"><input type="checkbox" class="sw" id="ac-peak-enabled" ${peakOn0 ? 'checked' : ''} />
            <label for="ac-peak-enabled">启用峰谷切换（高峰时段用高峰档，其余时间用低谷档）</label></div>
          ${peakFieldsHtml}
          <div class="field"><button class="btn" id="ac-tier-params-btn">⚙ 档位设置（各档条数 / 关键词表 / 活跃期）</button></div>
          <div id="ac-group-area"${unified0 ? ' style="display:none"' : ''}>
            <div class="field"><label>选择要单独设置的群聊（来自白名单，点击切换）</label>
              <div class="ac-group-buttons" id="ac-group-buttons"></div></div>
            <div style="margin-top:6px">
              <button class="btn btn-small btn-danger" id="tier-group-clear-btn" type="button">清除所选群的单独设置</button>
            </div>
          </div>
          <h3 class="usage-h3" style="margin-top:10px">指令禁言</h3>
          <div class="field-row">
            <div class="field"><label>禁言指令（需与 @机器人 同条消息）</label>
              <input type="text" id="ac-cmdmute-command" value="${esc(c.commandMute?.command || '/安静')}" placeholder="如 /安静" /></div>
            <div class="field"><label>禁言时长（分钟，0 = 直到手动解除）</label>
              <input type="number" id="ac-cmdmute-duration" min="0" value="${esc(Number(c.commandMute?.durationMin ?? 30))}" /></div>
          </div>
          <div class="checkbox-row"><input type="checkbox" class="sw" id="ac-cmdmute-enabled" ${c.commandMute?.enabled !== false ? 'checked' : ''} />
            <label for="ac-cmdmute-enabled">启用指令禁言</label></div>
        </div>
      </div>`,
    foot: `<button class="btn" id="ac-cancel">取消</button>
           <button class="btn btn-primary" id="ac-save">保存</button>`
  });

  const chkUnified = overlay.querySelector('#ac-unifiedtier');
  const chkPeak = overlay.querySelector('#ac-peak-enabled');
  const noteEl = overlay.querySelector('#ac-tier-note');
  const targetEl = overlay.querySelector('#ac-target');

  // ── 自定义竖向滑条（指针驱动，单/双珠同轨道）──
  // 值的真正持有者是下面的草稿变量（dContextPos / dPeak / dGroup*），
  // 滑条只是"把草稿画出来 + 让用户改草稿"的视图。
  const vsl = createVSlider({
    mount: overlay.querySelector('#ac-slider'),
    dual: peakOn0,
    low: peakOn0 ? dPeak.valleyPos : globalPos,
    high: dPeak.peakPos,
    onChange: ({ low, high }) => {
      const unified = chkUnified?.checked !== false;
      const peakOn = chkPeak?.checked === true;
      if (peakOn) {
        if (unified) { dPeak.peakPos = high; dPeak.valleyPos = low; }
        else if (activeGid) dGroupPeak[activeGid] = { peak: high, valley: low };
      } else {
        if (unified) dContextPos = low;
        else if (activeGid) dGroupPos[activeGid] = low;
      }
      refreshAfterValueChange(peakOn);
    }
  });
  activeVSlider = vsl;
  // 弹窗关闭（取消/保存/Esc/点遮罩都走 closeModelModal → overlay.remove()）时
  // 摘掉 window 级 pointer 监听：观察 overlay 从 DOM 摘除的一瞬。
  const mo = new MutationObserver(() => {
    if (!overlay.isConnected) {
      if (activeVSlider === vsl) activeVSlider = null;
      vsl?.destroy();
      mo.disconnect();
    }
  });
  mo.observe(document.body, { childList: true });

  const allowGroupIds = () => (c.allow?.groups || []).map(String);
  const extraGroupIds = () => [...Object.keys(dGroupPos), ...Object.keys(dGroupPeak)]
    .filter((id) => !id.startsWith('__') && !allowGroupIds().includes(id));

  // ── 群按钮列表（替代旧下拉框）──
  function renderGroupButtons() {
    const box = overlay.querySelector('#ac-group-buttons');
    if (!box) return;
    const allowIds = allowGroupIds();
    const extraIds = extraGroupIds();
    const ids = [...allowIds, ...extraIds];
    box.innerHTML = ids.length
      ? ids.map((id) => {
        const title = formatChatTitle(`group:${id}`, chatNameOf(`group:${id}`));
        const hasOwn = dGroupPos[id] !== undefined || dGroupPeak[id] !== undefined;
        return `<button type="button" class="ac-group-btn${id === activeGid ? ' active' : ''}" data-gid="${esc(id)}">`
          + `${esc(title)}${hasOwn ? '<span class="ac-dot" title="该群有单独设置"></span>' : ''}`
          + `${extraIds.includes(id) ? '<span class="muted">（已不在白名单）</span>' : ''}</button>`;
      }).join('')
      : '<div class="hint">（白名单为空——先在「白名单」设置里添加群聊，再回来分群设置）</div>';
  }
  overlay.querySelector('#ac-group-buttons')?.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.ac-group-btn');
    if (!btn) return;
    activeGid = String(btn.dataset?.gid || '');
    renderGroupButtons();
    syncSliderUI();
  });
  overlay.querySelector('#tier-group-clear-btn')?.addEventListener('click', () => {
    if (!activeGid) return;
    delete dGroupPos[activeGid];
    delete dGroupPeak[activeGid];
    renderGroupButtons();
    syncSliderUI();
  });

  // ── 刻度 / 说明 ──
  function syncScale(tier, peakTier) {
    overlay.querySelectorAll('#ac-tier-scale .tier-seg').forEach((el) => {
      const n = Number(el.dataset.seg);
      el.classList.toggle('on', n === tier);
      el.classList.toggle('semi', peakTier >= 1 && n === peakTier && n !== tier);
    });
  }
  function setNote(html) { if (noteEl) noteEl.innerHTML = html; }

  /** 当前象限该读哪组值（分群未单独设置 → 跟随全局）。 */
  function currentTargets() {
    const unified = chkUnified?.checked !== false;
    const peakOn = chkPeak?.checked === true;
    if (unified) return peakOn ? { hi: dPeak.peakPos, lo: dPeak.valleyPos } : { single: dContextPos };
    if (peakOn) {
      const gp = activeGid ? dGroupPeak[activeGid] : null;
      return gp ? { hi: clampNum(gp.peak, dPeak.peakPos), lo: clampNum(gp.valley, dPeak.valleyPos) } : { hi: dPeak.peakPos, lo: dPeak.valleyPos };
    }
    const gp = activeGid ? dGroupPos[activeGid] : undefined;
    return { single: (gp !== undefined && gp !== null) ? clampNum(gp, dContextPos) : dContextPos };
  }

  /** 把当前象限的值装回滑条 + 刷新刻度/说明/目标提示（外部装值，不写草稿）。 */
  function syncSliderUI() {
    const unified = chkUnified?.checked !== false;
    const peakOn = chkPeak?.checked === true;
    if (targetEl) {
      targetEl.textContent = unified
        ? (peakOn ? '当前编辑：全局峰谷双点' : '当前编辑：全局档位')
        : (activeGid ? `当前编辑：${formatChatTitle('group:' + activeGid, chatNameOf('group:' + activeGid))}` : '当前编辑：（未选择群）');
    }
    if (!vsl) return;
    const none = !unified && !activeGid;   // 分群模式但白名单为空：滑条只读
    vsl.setDisabled(none);
    vsl.setDual(peakOn);
    const t = currentTargets();
    if (peakOn) {
      vsl.setValues(t.lo, t.hi);
      syncScale(sliderToTierUI(t.lo).tier, sliderToTierUI(t.hi).tier);
      setNote(`高峰：${sliderDescText(t.hi)}<br>低谷：${sliderDescText(t.lo)}`);
    } else {
      vsl.setValues(t.single, t.single);
      syncScale(sliderToTierUI(t.single).tier, -1);
      setNote(sliderDesc(t.single));
    }
  }

  /** 值变化后的联动刷新（滑条已是新值，只刷刻度/说明/群按钮小圆点）。 */
  function refreshAfterValueChange(peakOn) {
    const v = vsl?.values || { low: 0, high: 0 };
    if (peakOn) {
      syncScale(sliderToTierUI(v.low).tier, sliderToTierUI(v.high).tier);
      setNote(`高峰：${sliderDescText(v.high)}<br>低谷：${sliderDescText(v.low)}`);
    } else {
      syncScale(sliderToTierUI(v.low).tier, -1);
      setNote(sliderDesc(v.low));
    }
    renderGroupButtons();   // "有单独设置"的小圆点可能变了
  }

  /** 开关切换：只切显隐 + 重载滑条值，不重建弹窗。 */
  function applyQuadrantUI() {
    const unified = chkUnified?.checked !== false;
    const peakOn = chkPeak?.checked === true;
    const fields = overlay.querySelector('#ac-peak-fields');
    // 折叠（CSS grid 1fr↔0fr 动画）而不是 display:none：平滑收起/展开
    if (fields) fields.classList.toggle('folded', !peakOn);
    const garea = overlay.querySelector('#ac-group-area');
    if (garea) garea.style.display = unified ? 'none' : '';
    if (!unified && !activeGid) {
      const ids = [...allowGroupIds(), ...extraGroupIds()];
      activeGid = ids[0] || '';   // 自动选中第一个群，滑条立刻有编辑对象
    }
    renderGroupButtons();
    syncSliderUI();
  }
  chkUnified?.addEventListener('change', applyQuadrantUI);
  chkPeak?.addEventListener('change', applyQuadrantUI);

  // 预设套用：写当前在场的滑条（applyPeakPreset 设值后派发 input，联动自动刷新）
  const peakPreset = overlay.querySelector('#cfg-peak-preset');
  if (peakPreset) peakPreset.addEventListener('change', () => {
    if (peakPreset.value) applyPeakPreset(peakPreset.value);
    peakPreset.value = '';
  });

  // 保存「自定义」预设（读当前滑条上的值）
  const peakSaveBtn = overlay.querySelector('#peak-preset-save-btn');
  if (peakSaveBtn) peakSaveBtn.addEventListener('click', async () => {
    const s = overlay.querySelector('#cfg-peak-start')?.value || '09:00';
    const e = overlay.querySelector('#cfg-peak-end')?.value || '18:00';
    const v = vsl?.values || { low: 100, high: 10 };
    const cu = {
      peak: { start: s, end: e, sliderPos: v.high },
      valley: { start: s, end: s, sliderPos: v.low }
    };
    try {
      const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ store: { peakSchedule: { custom: cu } } }) });
      if (r?.config) state.config = r.config;
      const hint = overlay.querySelector('#peak-preset-hint');
      if (hint) hint.textContent = `已保存「自定义」（峰 ${s}~${e} @${cu.peak.sliderPos} / 其余 @${cu.valley.sliderPos}）`;
    } catch (e2) {
      alert(`保存自定义失败：${e2.message}`);
    }
  });

  // 档位参数子模态框（各档条数 + 关键词表 + 被召唤后持续参与 + 活跃期时长）
  overlay.querySelector('#ac-tier-params-btn')?.addEventListener('click', () => {
    const cNow = state.config || {};
    const stNow = cNow.store || {};
    // 行式布局：档位名 + 数字框（窄）+ 说明同一行，扫一眼就能对上（2026-09-19 调整）。
    const tpRow = (id, label, value, hint) => `
      <div class="tp-row">
        <span class="tp-name">${label}</span>
        <input type="number" id="${id}" min="0" max="500" value="${esc(value)}" class="tp-num" />
        <span class="tp-hint">${hint}</span>
      </div>`;
    const sub = modelModalShell({
      head: '档位设置（各档条数 / 关键词表 / 活跃期）',
      body: `
        <h4 class="tp-h">各档位读取的已读历史条数（发未读 + N 条已读）</h4>
        ${tpRow('tp-atcount', '① 被艾特', stNow.atCount ?? 20, '任何档位下被艾特都会响应')}
        ${tpRow('tp-kwcount', '② 命中关键词', stNow.keywordCount ?? 15, '命中下方关键词表时')}
        ${tpRow('tp-randcount', '③ 随机命中', stNow.randomCount ?? 8, '随机档掷中时')}
        ${tpRow('tp-allcount', '④ 其余情况', stNow.allCount ?? 80, '4 档全响应的上限')}
        <div class="field"><label>② 的关键词表（每行一个，不区分大小写）</label>
          <textarea id="tp-keywords" rows="4" placeholder="小鲸鱼&#10;bot">${esc((stNow.keywords || []).join('\n'))}</textarea></div>
        <h3 class="usage-h3" style="margin-top:12px">被召唤后持续参与</h3>
        <div class="checkbox-row"><input type="checkbox" class="sw" id="tp-chatactive" ${cNow.chatActive?.enabled === true ? 'checked' : ''} />
          <label for="tp-chatactive">被召唤后可持续参与话题（1/2/3 档触发时生效）</label></div>
        <div class="field"><label>活跃期最长持续（分钟，到期自动潜水）</label>
          <input type="number" id="tp-chatactive-ttl" min="1" max="240" value="${esc(Number(cNow.chatActive?.ttlMinutes ?? 30))}" style="max-width:160px" /></div>`,
      foot: `<button class="btn" id="tp-cancel">取消</button>
             <button class="btn btn-primary" id="tp-save">保存</button>`
    });
    sub.querySelector('#tp-cancel').addEventListener('click', () => closeModelModal(sub));
    sub.querySelector('#tp-save').addEventListener('click', async () => {
      const patch = {
        store: {
          atCount: clampInt(sub.querySelector('#tp-atcount')?.value, 1, 500, 20),
          keywordCount: clampInt(sub.querySelector('#tp-kwcount')?.value, 1, 500, 15),
          keywords: String(sub.querySelector('#tp-keywords')?.value || '').split('\n').map((x) => x.trim()).filter(Boolean),
          randomCount: clampInt(sub.querySelector('#tp-randcount')?.value, 1, 500, 8),
          allCount: clampInt(sub.querySelector('#tp-allcount')?.value, 1, 500, 80)
        },
        chatActive: {
          ...(cNow.chatActive || {}),
          enabled: sub.querySelector('#tp-chatactive')?.checked === true,
          ttlMinutes: Math.min(240, Math.max(1, Number(sub.querySelector('#tp-chatactive-ttl')?.value) || 30))
        }
      };
      try {
        const r = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
        if (r?.config) state.config = r.config;   // 回写：主弹窗期间再开子弹窗能看到刚保存的值
        closeModelModal(sub);
        const hintEl = overlay.querySelector('#ac-tier-note');
        if (hintEl) hintEl.innerHTML = '档位参数已保存 ✓';
      } catch (e) {
        alert(`保存档位参数失败：${e.message}`);
      }
    });
  });

  // 初始装填（刻度/说明/群按钮/滑条值）
  applyQuadrantUI();

  overlay.querySelector('#ac-cancel')?.addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#ac-save')?.addEventListener('click', async () => {
    const g = (id) => overlay.querySelector('#' + id)?.value ?? '';
    const chkv = (id, fb) => overlay.querySelector('#' + id)?.checked ?? fb;
    const unifiedSave = chkv('ac-unifiedtier', unified0);
    const peakOnSave = chkv('ac-peak-enabled', peakOn0);
    const storePatch = { unifiedTier: unifiedSave };
    if (peakOnSave) {
      // 峰谷开：存双点；contextSliderPos 同步写低谷值，保证之后关峰谷不跳档
      storePatch.contextSliderPos = dPeak.valleyPos;
      storePatch.peakSchedule = {
        ...ps, enabled: true,
        peak: { start: g('cfg-peak-start') || dPeak.start, end: g('cfg-peak-end') || dPeak.end, sliderPos: dPeak.peakPos },
        valley: { start: g('cfg-peak-start') || dPeak.start, end: g('cfg-peak-start') || dPeak.start, sliderPos: dPeak.valleyPos }
      };
    } else {
      storePatch.contextSliderPos = dContextPos;
      storePatch.peakSchedule = { ...ps, enabled: false };
    }
    // 分群两张图整体替换（__ 开头内部键已在装填时剔除，不会写回配置）
    storePatch.groupSliderPos = { __replace__: dGroupPos };
    storePatch.groupPeakPos = { __replace__: dGroupPeak };
    const patch = {
      store: storePatch,
      commandMute: {
        ...(c.commandMute || {}),
        enabled: chkv('ac-cmdmute-enabled', c.commandMute?.enabled !== false),
        command: String(g('ac-cmdmute-command')).trim() || '/安静',
        durationMin: Math.max(0, Number(g('ac-cmdmute-duration')) || 0)
      }
    };
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
      closeModelModal(overlay);
      loadSettings();
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
}

/**
 * 「创建技能 / 创建插件」引导模态框（技能页与插件页标题旁的 ＋ 按钮）。
 *
 * 定位：**引导**而不是代写 —— 控制台无法安全地往磁盘写任意代码，这个弹窗
 * 把用户带到正确的三样东西上：项目自带的脚手架脚本、开发文档、AI 桌面工具
 * 工作流。技能（LLM 型）与插件（确定性型）的文档路径不同，按 kind 切换。
 */
/* ═══ 社区市场：添加模态框 + 上传流程 + 口令安装 ═══
   2026-09-19 新增。所有网络请求走本地后端代理（/api/market/*），
   浏览器不直连官网（CORS 边界 + 凭据不进前端 localStorage）。 */

/** 拉本地已保存的账号凭据列表（{username, savedAt}）。 */
async function fetchMarketAccounts() {
  try {
    const r = await api('/api/market/accounts');
    return r.accounts || [];
  } catch { return []; }
}

/* ═══ 本地导入：把 zip / 文件夹拖进来就装 ═══════════════════════════════════
   2026-09-21 新增。之前装东西只有两条路：市场口令、自己写代码 ——
   别人塞给你的一个 zip、你自己备份的技能文件夹，都得手工找到 skills/ 目录
   再点刷新。现在支持拖进页面直接装（或点按钮选）。

   两条取内容的路子：
     · Electron 里：拖放的 File 能反查出磁盘真实路径（webUtils.getPathForFile），
       只把路径发给后端 —— 大文件夹不用在前端读成字节。
     · 浏览器/远程打开：拿不到路径，退化为读 zip 的 base64 上传。
   落地、校验、重扫全部在后端 /api/skills/import，前端不碰文件系统。 */

/**
 * 把一个 File 变成后端能吃的入参。
 * @returns {Promise<{ paths?: string[], zipBase64?: string, zipName?: string }>}
 */
async function modulePayloadFromFile(file) {
  const bridge = window.qqaDesktop;
  if (bridge && typeof bridge.pathForFile === 'function') {
    try {
      const r = await bridge.pathForFile(file);
      if (r?.ok && r.path) return { paths: [r.path] };
    } catch { /* 反查失败（沙箱/旧版）→ 走下面的 base64 退路 */ }
  }
  // 退路：只在 zip 时可用（文件夹在浏览器里读不出目录结构，明确报出来）
  if (!/\.zip$/i.test(file.name || '')) {
    throw new Error(`「${file.name}」不是 zip 包；文件夹请在使用桌面端时直接拖进来`);
  }
  const buf = await file.arrayBuffer();
  if (buf.byteLength > 8 * 1024 * 1024) throw new Error(`「${file.name}」超过 8MB 上限`);
  let binary = '';
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return { zipBase64: btoa(binary), zipName: file.name };
}

/**
 * 导入一批 File（拖放或文件选择框来的），装完自动刷新两个页签。
 * @param {'skill'|'plugin'} kind 默认落点（真类型由包内容决定）
 * @param {FileList|File[]} files
 * @param {(text:string)=>void} [onProgress]
 */
async function importModuleFiles(kind, files, onProgress) {
  const list = Array.from(files || []);
  if (!list.length) return null;
  const say = (t) => { if (typeof onProgress === 'function') onProgress(t); };
  const installed = [];
  const errors = [];
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    say(`正在读取 ${i + 1}/${list.length}：${file.name || ''}…`);
    try {
      const payload = await modulePayloadFromFile(file);
      const r = await api('/api/skills/import', {
        method: 'POST',
        body: JSON.stringify({ kind, ...payload })
      });
      if (r?.skills) state.skills = r.skills;
      if (r?.summary) state.skillsSummary = r.summary;
      for (const it of r?.installed || []) installed.push(it);
      for (const e of r?.errors || []) errors.push(e);
    } catch (e) {
      errors.push({ source: file.name || '(未命名)', error: String(e?.message ?? e) });
    }
  }
  // 装完立刻重扫两个页签：包里可能是 plugin.json 而被归到另一页
  if (installed.length) {
    say('正在刷新列表…');
    await loadModulePage('skill', { rescan: true }).catch(() => {});
    await loadModulePage('plugin', { rescan: true }).catch(() => {});
  }
  return { installed, errors };
}

/** 导入结果的汇总文案（用于提示框）。 */
function describeImportResult({ installed, errors }) {
  const lines = [];
  for (const it of installed || []) {
    lines.push(`${it.kind === 'plugin' ? '插件' : '技能'}「${it.id}」已装好（${it.files} 个文件）`);
  }
  for (const e of errors || []) lines.push(`${e.source}：${e.error}`);
  return lines.join('\n');
}

/**
 * 「导入本地文件」按钮：优先走原生对话框（能选文件夹），
 * 桌面桥不可用时退回 <input type="file">。
 */
function pickAndImportModules(kind) {
  const bridge = window.qqaDesktop;
  if (bridge && typeof bridge.pickModuleFiles === 'function') {
    return pickWithDesktopBridge(kind, bridge);
  }
  // 浏览器/远程：只能选 zip（文件夹选不了，说明清楚）
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const files = input.files;
      input.remove();
      resolve(importModuleFiles(kind, files));
    });
    // 现代浏览器没有可靠的"取消"事件，靠下一次任意点击清理掉这个隐藏 input
    window.addEventListener('pointerdown', function cleanup() {
      window.removeEventListener('pointerdown', cleanup);
      if (document.body.contains(input)) input.remove();
    });
    input.click();
  });
}

/** 原生对话框路径（Electron）：拿到的是路径数组，逐个交给后端导入。 */
async function pickWithDesktopBridge(kind, bridge) {
  const picked = await bridge.pickModuleFiles();
  if (!picked?.ok) return null;                       // 用户取消
  const installed = [];
  const errors = [];
  for (const p of picked.paths || []) {
    const name = String(p).split(/[\\/]/).pop() || p;
    try {
      const r = await api('/api/skills/import', {
        method: 'POST',
        body: JSON.stringify({ kind, paths: [p] })
      });
      if (r?.skills) state.skills = r.skills;
      if (r?.summary) state.skillsSummary = r.summary;
      for (const it of r?.installed || []) installed.push(it);
      for (const e of r?.errors || []) errors.push(e);
    } catch (e) {
      errors.push({ source: name, error: String(e?.message ?? e) });
    }
  }
  if (installed.length) {
    await loadModulePage('skill', { rescan: true }).catch(() => {});
    await loadModulePage('plugin', { rescan: true }).catch(() => {});
  }
  return { installed, errors };
}

/**
 * 「添加技能 / 添加插件」入口模态框：上下两个大按钮。
 * 上面 = 去市场（口令安装），悬停文案「捞点好货」；
 * 下面 = 自己造（原创建引导），悬停文案「我去牛逼」。
 */
function openAddModuleModal(kind) {
  const isSkill = kind === 'skill';
  const name = isSkill ? '技能' : '插件';
  // 双市场：技能页开 skill-market，插件页开 plugin-market（线上两个独立页面）
  const marketUrl = `https://www.kondius.cn/qq-agent/${isSkill ? 'skill-market' : 'plugin-market'}/`;
  const overlay = modelModalShell({
    head: `添加${name}`,
    body: `
      <div class="hint" style="margin-bottom:12px">三种来路：从市场捞现成的、把 zip 或文件夹丢进来、或者自己造一个。<span class="muted">（也可以直接把文件拖到${name}页里，会自动装）</span></div>
      <div class="addmod-stack">
        <button class="addmod-big" id="addmod-market">
          <span class="addmod-label">看看${name}市场</span>
          <span class="addmod-hover-label">捞点好货</span>
        </button>
        <button class="addmod-big addmod-import" id="addmod-import">
          <span class="addmod-label">导入本地文件</span>
          <span class="addmod-hover-label">zip 或文件夹</span>
        </button>
        <button class="addmod-big addmod-diy" id="addmod-diy">
          <span class="addmod-label">自己造个${name}</span>
          <span class="addmod-hover-label">我去牛逼</span>
        </button>
      </div>`,
    foot: `<button class="btn" id="addmod-cancel">算了</button>`
  });
  overlay.querySelector('#addmod-market')?.addEventListener('click', () => {
    closeModelModal(overlay);
    window.open(marketUrl, '_blank', 'noopener');
    openInstallCodeModal();
  });
  overlay.querySelector('#addmod-import')?.addEventListener('click', async () => {
    closeModelModal(overlay);
    const r = await pickAndImportModules(kind);
    if (!r) return;                                   // 用户取消了选择
    const text = describeImportResult(r) || '没有可导入的内容';
    showNoticeModal(r.installed?.length ? '导入完成' : '导入失败', text);
  });
  overlay.querySelector('#addmod-diy')?.addEventListener('click', () => {
    closeModelModal(overlay);
    openCreateModuleGuide(kind);
  });
  overlay.querySelector('#addmod-cancel')?.addEventListener('click', () => closeModelModal(overlay));
  return overlay;
}

/**
 * 把一页（技能页 / 插件页）整块变成放置区：文件拖进来即装。
 *
 * 为什么绑在整页容器上而不是卡片网格里：空列表时也要能拖（那时还没有网格），
 * 而且"随便往这页一扔就行"比"必须瞄准某个小方块"好操作得多。
 * 高亮态挂在容器上的 .module-drop-hot，离开/放下即撤。
 */
function bindModuleDropZone(kind, boxEl) {
  if (!boxEl || boxEl.dataset.dropBound === '1') return;
  boxEl.dataset.dropBound = '1';
  let depth = 0;   // dragenter/leave 会在子元素间冒泡，用计数抵消，避免闪烁

  const setHot = (on) => boxEl.classList.toggle('module-drop-hot', on);

  boxEl.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    depth++;
    setHot(true);
  });
  boxEl.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    // 必须 preventDefault 才允许 drop；不带文件（拖选中的文字）不高亮
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setHot(true);
  });
  boxEl.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) setHot(false);
  });
  boxEl.addEventListener('drop', async (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    depth = 0;
    setHot(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    const r = await importModuleFiles(kind, files);
    if (!r) return;
    const text = describeImportResult(r) || '没有可导入的内容';
    showNoticeModal(r.installed?.length ? '导入完成' : '导入失败', text);
  });
}

/**
 * 口令安装模态框：逐行输入口令，失焦校验；
 * 「就这些吧」批量下载解压到对应目录（类型由服务器决定）。
 */
function openInstallCodeModal() {
  let codeRows = [];   // [{ code, status: 'idle'|'checking'|'ok'|'bad', entry }]
  const overlay = modelModalShell({
    head: '口令安装',
    body: `
      <div class="hint" style="margin-bottom:10px">
        在市场页找到想要的技能/插件，点「复制口令！」，把得到的口令填进来。
        每行一个；填完一行会自动校验。输完点「就这些吧」批量安装。
        <span class="muted">（技能口令和插件口令都行 —— 类型由服务器决定，会装进各自的页签）</span>
      </div>
      <div id="ic-rows"></div>
      <div class="hint" id="ic-status" style="margin-top:10px"></div>`,
    foot: `
      <button class="btn btn-primary" id="ic-confirm">就这些吧</button>
      <button class="btn" id="ic-cancel">算了算了</button>`
  });
  const rowsBox = overlay.querySelector('#ic-rows');
  const statusBox = overlay.querySelector('#ic-status');

  const renderRows = () => {
    rowsBox.innerHTML = codeRows.map((r, i) => {
      const cls = r.status === 'ok' ? ' ok' : (r.status === 'bad' ? ' bad' : (r.status === 'checking' ? ' checking' : ''));
      const dim = r.status === 'ok' ? ' dim' : (r.status === 'bad' ? '' : '');
      const badge = r.status === 'ok'
        ? `<span class="ic-check">✅</span><span class="ic-meta">${esc(r.entry?.name || '')}<span class="muted"> · ${esc(r.entry?.author || '')} · ${r.entry?.type === 'plugin' ? '插件' : '技能'}</span></span>`
        : '';
      return `<div class="ic-row${cls}${dim}">
        <input type="text" class="ic-input" data-idx="${i}" value="${esc(r.code)}"
          placeholder="${r.status === 'ok' ? '已匹配' : '输入 6 位口令'}"
          autocomplete="off" spellcheck="false" ${r.status === 'ok' ? 'readonly' : ''} />
        <button class="ic-del" data-idx="${i}" title="删除这行" aria-label="删除第 ${i + 1} 行">🗑</button>
        ${badge}
      </div>`;
    }).join('');
    // 绑定输入：失焦且有内容 → 触发校验 + 追加新行
    rowsBox.querySelectorAll('.ic-input').forEach((inp) => {
      inp.addEventListener('blur', async () => {
        const idx = Number(inp.dataset.idx);
        const code = inp.value.trim().toUpperCase();
        if (!code) return;
        if (codeRows[idx]?.code === code && codeRows[idx]?.status === 'ok') return;
        codeRows[idx] = { code, status: 'checking', entry: null };
        renderRows();
        try {
          const r = await api('/api/market/verify', { method: 'POST', body: JSON.stringify({ codes: [code] }) });
          const hit = (r.results || [])[0];
          if (codeRows[idx]?.code !== code) return;   // 期间被删/改过，丢弃结果
          if (hit?.ok) {
            codeRows[idx] = { code, status: 'ok', entry: hit };
            // 失焦且有内容 → 下一行出现（只在没有空行时追加）
            if (!codeRows.some((x) => !x.code)) codeRows.push({ code: '', status: 'idle', entry: null });
          } else {
            codeRows[idx] = { code, status: 'bad', entry: null };
          }
        } catch (e) {
          if (codeRows[idx]?.code === code) codeRows[idx] = { code, status: 'bad', entry: null };
          statusBox.textContent = `校验失败：${e?.message || e}`;
        }
        renderRows();
      });
    });
    rowsBox.querySelectorAll('.ic-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        codeRows.splice(Number(btn.dataset.idx), 1);
        if (!codeRows.length) codeRows.push({ code: '', status: 'idle', entry: null });
        renderRows();
      });
    });
  };
  codeRows.push({ code: '', status: 'idle', entry: null });
  renderRows();

  overlay.querySelector('#ic-cancel')?.addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#ic-confirm')?.addEventListener('click', async () => {
    const btn = overlay.querySelector('#ic-confirm');
    const ready = codeRows.filter((r) => r.status === 'ok' && r.entry);
    if (!ready.length) {
      statusBox.textContent = '还没有成功对接的口令（先把口令填对，等它变绿带 ✅）。';
      return;
    }
    btn.disabled = true;
    let installed = 0;
    const notes = [];
    for (const r of ready) {
      statusBox.textContent = `正在安装 ${installed + 1}/${ready.length}：${r.entry?.name || r.code}…`;
      try {
        const res = await api('/api/market/install', {
          method: 'POST',
          body: JSON.stringify({ code: r.code, entry: r.entry })
        });
        installed++;
        notes.push(`${res.kind === 'plugin' ? '插件' : '技能'} ${res.id} 已安装`);
      } catch (e) {
        notes.push(`${r.entry?.name || r.code} 安装失败：${e?.message || e}`);
      }
    }
    statusBox.textContent = installed
      ? `安装完成：${installed} 个。${notes.join('；')}`
      : `全部失败。${notes.join('；')}`;
    btn.disabled = false;
    if (installed) {
      // 刷新两个页签（安装的类型可能在另一页）
      await loadModulePage('skill', { rescan: true }).catch(() => {});
      await loadModulePage('plugin', { rescan: true }).catch(() => {});
      setTimeout(() => closeModelModal(overlay), 1200);
    }
  });
  return overlay;
}

/**
 * 上传流程模态框（点卡片 ⬆ 钮进入）：
 *   第一步：无凭据 → 登录/注册；第二步：有凭据 → 列表选择；
 *   第三步：填展示名/简介 → 后端确认 id → 打包上传 → 待审核提示。
 */
async function openMarketUploadModal(kind, moduleId) {
  const isSkill = kind === 'skill';
  const name = isSkill ? '技能' : '插件';
  const s = (state.skills || []).find((x) => x.id === moduleId);
  const displayName0 = s?.name || moduleId;
  const desc0 = s?.description || '';

  const overlay = modelModalShell({
    head: `上传${name}到市场：${moduleId}`,
    body: `<div class="hint">正在读取本地账号…</div>`,
    foot: ''
  });
  const setBody = (html, foot = '') => {
    overlay.querySelector('.model-modal-body').innerHTML = html;
    const footBox = overlay.querySelector('.model-modal-foot');
    if (footBox) footBox.innerHTML = foot;
  };

  // ── 第一步：登录/注册（无凭据时） ──
  const renderLoginStep = (mode = 'login') => {
    const isLogin = mode === 'login';
    setBody(`
      <div class="hint" style="margin-bottom:10px">
        本机还没有 QQ Agent 账号凭据。上传${name}需要先登录（登录一次后会记住，以后不用再登）。
      </div>
      <div class="field"><label>登录 ID${isLogin ? '' : '（3~24 位，字母/数字/下划线）'}</label>
        <input type="text" id="mu-username" autocomplete="username" placeholder="如 kondius" /></div>
      ${isLogin ? '' : `
      <div class="field"><label>展示用户名（市场里显示的名字）</label>
        <input type="text" id="mu-displayname" maxlength="24" placeholder="如 康仔" /></div>`}
      <div class="field"><label>${isLogin ? '密码' : '设置密码（6~72 位）'}</label>
        <input type="password" id="mu-password" autocomplete="current-password" /></div>
      ${isLogin ? '' : `
      <div class="field"><label>确认密码</label>
        <input type="password" id="mu-password2" autocomplete="new-password" /></div>`}
      <div class="hint" id="mu-login-msg" style="min-height:18px"></div>
      <div class="hint" style="margin-top:6px">
        没有账号？<a href="https://www.kondius.cn/qq-agent/skill-market/" target="_blank" rel="noopener">前往官网注册</a>，
        或直接<span class="link" id="mu-switch-mode">${isLogin ? '在这里注册' : '在这里登录'}</span>。
      </div>`,
      `<button class="btn btn-primary" id="mu-login-go">${isLogin ? '登录' : '注册并登录'}</button>
       <button class="btn" id="mu-login-cancel">取消</button>`);
    const doLogin = async () => {
      const loginId = overlay.querySelector('#mu-username')?.value.trim() || '';
      const displayName = overlay.querySelector('#mu-displayname')?.value.trim() || '';
      const password = overlay.querySelector('#mu-password')?.value || '';
      const password2 = overlay.querySelector('#mu-password2')?.value || '';
      const msg = overlay.querySelector('#mu-login-msg');
      if (!loginId || !password) { msg.textContent = '登录 ID 和密码都要填'; return; }
      if (!isLogin) {
        if (!displayName) { msg.textContent = '展示用户名不能为空'; return; }
        if (password !== password2) { msg.textContent = '两次输入的密码不一致'; return; }
      }
      const go = overlay.querySelector('#mu-login-go');
      go.disabled = true;
      msg.textContent = isLogin ? '正在登录…' : '正在注册…';
      try {
        const payload = isLogin
          ? { loginId, password, mode: 'login' }
          : { loginId, displayName, password, mode: 'register' };
        await api('/api/market/login', { method: 'POST', body: JSON.stringify(payload) });
        msg.textContent = isLogin ? '登录成功' : '注册成功';
        await renderAccountPick();   // 进入第二步
      } catch (e) {
        msg.textContent = `${e?.message || e}`;
        go.disabled = false;
      }
    };
    overlay.querySelector('#mu-login-go')?.addEventListener('click', doLogin);
    overlay.querySelector('#mu-password')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && isLogin) doLogin();
    });
    overlay.querySelector('#mu-password2')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });
    overlay.querySelector('#mu-login-cancel')?.addEventListener('click', () => closeModelModal(overlay));
    overlay.querySelector('#mu-switch-mode')?.addEventListener('click', () => renderLoginStep(isLogin ? 'register' : 'login'));
  };

  // ── 第二步：选择账号 ──
  const renderAccountPick = async () => {
    const accounts = await fetchMarketAccounts();
    if (!accounts.length) { renderLoginStep(); return; }
    setBody(`
      <div class="hint" style="margin-bottom:10px">本机保存了这些账号，用哪个上传？</div>
      ${accounts.map((a) => `
        <button class="account-pick" data-username="${esc(a.username)}">
          <span class="ap-name">${esc(a.username)}</span>
          <span class="muted">保存于 ${fmtTime(a.savedAt)}</span>
        </button>`).join('')}
      <div class="hint" style="margin-top:8px">
        <span class="link" id="mu-use-other">使用其它账号密码登录（新增一个）</span>
        ${accounts.length > 1 ? ' · ' : ''}
        <span class="link" id="mu-remove-one" style="${accounts.length > 1 ? '' : 'display:none'}">移除一个保存的账号</span>
      </div>`);
    overlay.querySelectorAll('.account-pick').forEach((btn) => {
      btn.addEventListener('click', () => renderPublishStep(btn.dataset.username));
    });
    overlay.querySelector('#mu-use-other')?.addEventListener('click', () => renderLoginStep());
    overlay.querySelector('#mu-remove-one')?.addEventListener('click', async () => {
      const accounts2 = await fetchMarketAccounts();
      if (accounts2.length <= 1) return;
      const who = prompt(`要移除哪个账号？\n${accounts2.map((a, i) => `${i + 1}. ${a.username}`).join('\n')}\n（输入序号或用户名）`);
      if (!who) return;
      const target = /^\d+$/.test(who.trim()) ? accounts2[Number(who.trim()) - 1]?.username : who.trim();
      if (!target || !accounts2.some((a) => a.username === target)) { alert('没找到这个账号'); return; }
      await api('/api/market/logout', { method: 'POST', body: JSON.stringify({ username: target }) });
      await renderAccountPick();
    });
  };

  // ── 第三步：填信息 + 确认上传 ──
  const renderPublishStep = (accountUsername) => {
    setBody(`
      <div class="hint" style="margin-bottom:10px">
        以 <b>${esc(accountUsername)}</b> 的名义上传 <b>${esc(moduleId)}</b>。如果市场上已存在同 id 的条目，上传会被拒绝（换一个 id 再试）。
      </div>
      <div class="field"><label>展示名</label>
        <input type="text" id="mu-name" value="${esc(displayName0)}" maxlength="60" /></div>
      <div class="field field--wide"><label>简介</label>
        <textarea id="mu-desc" rows="3" maxlength="500">${esc(desc0)}</textarea></div>
      <div class="hint" id="mu-pub-msg" style="min-height:18px"></div>
      <div class="hint" style="margin-top:6px">
        ⚠️ 打包上传的是 <code>${isSkill ? 'skills' : 'plugins'}/${esc(moduleId)}/</code> 整个目录。
        请先确认里面没有 API Key、Cookie 等私密信息 —— 审核通过后所有人都能下载。
      </div>`,
      `<button class="btn btn-primary" id="mu-pub-go">打包上传</button>
       <button class="btn" id="mu-pub-cancel">取消</button>`);
    overlay.querySelector('#mu-pub-cancel')?.addEventListener('click', () => closeModelModal(overlay));
    overlay.querySelector('#mu-pub-go')?.addEventListener('click', async () => {
      const go = overlay.querySelector('#mu-pub-go');
      const msg = overlay.querySelector('#mu-pub-msg');
      const displayName = overlay.querySelector('#mu-name')?.value.trim() || '';
      const description = overlay.querySelector('#mu-desc')?.value.trim() || '';
      if (!displayName) { msg.textContent = '展示名不能为空'; return; }
      go.disabled = true;
      msg.textContent = '正在打包并上传…';
      try {
        await api('/api/market/publish', {
          method: 'POST',
          body: JSON.stringify({ kind, id: moduleId, displayName, description, accountUsername })
        });
        setBody(`
          <div class="hint" style="margin:8px 0">
            ✅ 上传完成！<b>${esc(moduleId)}</b> 已进入<b>待审核</b>状态 ——
            审核通过后才会出现在市场，并生成「复制口令！」按钮。
          </div>
          <div class="hint">可以关闭这个窗口，或去 <a href="https://www.kondius.cn/qq-agent/skill-market/" target="_blank" rel="noopener">市场页面</a> 看看进展。</div>`,
          `<button class="btn" id="mu-done">知道了</button>`);
        overlay.querySelector('#mu-done')?.addEventListener('click', () => closeModelModal(overlay));
      } catch (e) {
        // 409（id 重复）等服务端错误直接显示人话文案
        msg.textContent = `${e?.message || e}`;
        go.disabled = false;
      }
    });
  };

  // 入口分流
  const accounts = await fetchMarketAccounts();
  if (accounts.length) await renderAccountPick();
  else renderLoginStep();
  return overlay;
}

/**
 * 「自己造个技能/插件」引导（2026-09-19 零门槛版）。
 *
 * 面向完全非技术人员：没有命令行、不用找文件夹、不用懂"放进目录"。
 * 全部工作交给一段**复制出去的提示词**：用户把它粘进任意 AI 桌面工具
 * （ZCode / WorkBuddy / Qoder / DeepSeek Harness…），AI 会自己——
 *   ① 找到项目里的开发文档并读懂
 *   ② 通过提问确认用户想要什么、并判定该做成技能还是插件（多数人分不清）
 *   ③ 按文档规范生成 skill.json/plugin.json + index.js
 *   ④ 直接把文件写进 skills/<id>/ 或 plugins/<id>/（热重载自动生效）
 *
 * 提示词里写死了"三步自检"（类型判定 → 文档路径 → 落盘位置），
 * 用户不需要理解其中任何一个术语。
 */
/**
 * 从 /api/status 的 dataDir 推导项目根目录。
 * dataDir 形如 <根>/data 或 <根>/data-2（第二实例）——去掉末尾的 data 段。
 * 拿不到（status 未加载等）返回空串，提示词里走"询问用户"兜底。
 */
function detectProjectRoot() {
  const dir = String(state.status?.dataDir || '');
  if (!dir) return '';
  const norm = dir.replace(/[\\/]+$/, '');
  const m = /[\\/]data(-\d+)?$/i.exec(norm);
  return m ? norm.slice(0, m.index) : norm;
}

function buildModuleCreationPrompt(kind) {
  const isSkill = kind === 'skill';
  // 引导 AI 从"用户点的是技能页还是插件页"出发，但**允许 AI 推翻**——
  // 用户多数分不清两型，点错入口是常态；判定权交给读完了文档的 AI。
  const entryHint = isSkill
    ? '用户是从「技能」页点进来的（他大概率想要一个技能，但也可能点错了，需要你判定）'
    : '用户是从「插件」页点进来的（他大概率想要一个插件，但也可能点错了，需要你判定）';
  // 项目根：拿到了就直接给 AI 绝对路径（省掉 AI 全盘摸索）；拿不到就让 AI 问。
  const root = detectProjectRoot();
  const locateBlock = root
    ? `这个项目就安装在我电脑的这个文件夹里（直接用，不用再找）：
${root}
文档在它下面的 doc/extend_development/ 里，技能/插件目录分别是它下面的 skills/ 和 plugins/。`
    : `先问我一句"QQ Agent 装在哪个文件夹"（我不知道的话，就找桌面或开始菜单里的「QQ Agent」快捷方式 → 右键 → 打开文件所在位置）。拿到项目文件夹后再继续。`;
  return `我电脑上有一个叫「QQ Agent」的 QQ 机器人项目，我想给它加一个新功能，但我不会写代码。请你帮我从头到尾做完，包括把文件放到位。下面是给你的完整工作说明：

【第零步：定位项目】
${locateBlock}

【第一步：先读懂文档】
读取项目里 doc/extend_development/ 目录下的这些文档：
- skill-development.md（技能开发规范）
- plugin-development.md（插件开发规范）
- skill-reference.md（API 完整参考，必读）
- 如果要操作 QQ 本身（查群成员、禁言、发文件等），还要读 snowluma-capabilities.md
先读完再动手。文档里写全了格式要求、API 用法和常见的坑，不按文档做的产物会静默失效（不报错、就是没反应）。

【第二步：搞清楚我要什么】
${entryHint}。
"技能"和"插件"是两种不同的东西（文档第 0 节有判定方法），大多数人分不清，所以：
- 先问清楚我想要这个功能做什么、什么时候触发、要不要机器人"动脑子"判断；
- 然后按文档的判定方法决定做成技能（skills/ 目录）还是插件（plugins/ 目录），并告诉我你的判定和理由；
- 我说不上来的时候，用文档里的"三问判断法"引导我。

【第三步：生成并落盘】
确定类型后：
1. 按对应文档的规范，生成完整可运行的文件（技能是 skills/<id>/skill.json + index.js，插件是 plugins/<id>/plugin.json + index.js）；
2. <id> 用一个简短的小写英文标识（如 my-weather），不要用中文；
3. 把文件直接写到项目对应的目录里去（技能 → skills/<id>/，插件 → plugins/<id>/）。这个项目开着热重载，文件落盘后会自动加载，不需要我重启或刷新；
4. 写完后告诉我：生成了什么、放在哪、回到 QQ Agent 的「技能」或「插件」页签应该看到什么。

【如果出了问题】
生成后如果 QQ Agent 控制台的技能/插件页显示加载失败，把页面上显示的错误原因原样发给我，我来贴给你修（文档里有常见失败对照表）。

现在开始：先简短地问我"你想让机器人学会什么"，然后按上面的流程走完全程。不要让我做任何技术操作。`;
}

function openCreateModuleGuide(kind) {
  const isSkill = kind === 'skill';
  const name = isSkill ? '技能' : '插件';
  const prompt = buildModuleCreationPrompt(kind);
  const overlay = modelModalShell({
    head: `自己造个${name}`,
    body: `
      <div class="hint" style="margin-bottom:12px">
        不会写代码？没问题。把下面这段提示词复制出来，粘贴到<b>任何</b>一个 AI 桌面工具里
        （ZCode、WorkBuddy、Qoder、DeepSeek Harness 之类的都行），
        然后告诉它你想要什么功能——它会问清楚需求、读文档、把做好的${name}直接放进项目里，
        你回到这个页面点「刷新」就能看到。<b>全程不需要你碰任何文件夹。</b>
      </div>
      <pre class="guide-code" id="cmg-prompt" style="max-height:220px;overflow:auto;user-select:all;white-space:pre-wrap;word-break:break-all">${esc(prompt)}</pre>
      <div class="hint" id="cmg-copied" style="min-height:18px;color:var(--green)"></div>`,
    foot: `<button class="btn btn-primary" id="cmg-copy">📋 一键复制提示词</button>
           <button class="btn" id="cmg-close">关闭</button>`
  });
  overlay.querySelector('#cmg-copy')?.addEventListener('click', async () => {
    // clipboard API 在 Electron 里稳；失败回落到选中文本让用户 Ctrl+C
    let ok = false;
    try {
      await navigator.clipboard.writeText(prompt);
      ok = true;
    } catch {
      const pre = overlay.querySelector('#cmg-prompt');
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        ok = document.execCommand?.('copy') || false;
      }
    }
    const tip = overlay.querySelector('#cmg-copied');
    if (tip) tip.textContent = ok
      ? '✅ 已复制！现在打开你的 AI 工具（ZCode / WorkBuddy / Qoder…）直接粘贴发送。'
      : '复制失败——请手动选中上方文本框里的全部内容按 Ctrl+C 复制。';
  });
  overlay.querySelector('#cmg-close')?.addEventListener('click', () => closeModelModal(overlay));
}