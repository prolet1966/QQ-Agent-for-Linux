// ── 对端实例联动（server.peer）—— P0：只读状态互通 ──────────────────────────
// 用途：同一台机器上的多开实例（见 docs/multi-instance.md）互相"看得见"。
// 本模块只做一件事：按 server.peer 配置周期 GET 对端的 /api/status，
// 白名单透传几个只读字段，通过现有 SSE 通道（emit('peer-status')）推给前端。
// 设计文档：docs/peer-relay-design.md（方案 A，P0/P1；方案 B/C 另立议题）。
//
// 安全边界（写代码时逐条落实了）：
//   · 对端地址只允许本机回环（http://127.0.0.1:port），防配置里的恶意地址变 SSRF 出口；
//   · 对端返回体只透传白名单字段，任何带密钥/原始配置的块一律丢弃；
//   · 对端令牌 server.peer.token 只进请求头，从不进本模块的任何返回值；
//     sanitizeConfig 侧已把 peer.token 一并脱敏（见 SECRET_KEY_PATTERN 的 token），
//     /api/config 不会把它回传给浏览器。
'use strict';

const CONSOLE_BASE_PORT = 3210;   // 与 src/profile.js#portOffset() 语义一致：N → 100N

/**
 * 实例号 → 控制台端口偏移（dataDir/端口推导与本实例的进程序列完全同源）。
 * 直接写 100*N，不复用 profile.js 的 portOffset() —— 那个读的是**当前进程**的
 * QQ_AGENT_PROFILE，而这里要推导的是**对端实例号**，两者不该混。
 */
function portOffsetFor(profileId) {
  const n = Number(profileId);
  return Number.isInteger(n) && n > 0 ? n * 100 : 0;
}

/** 只认本机回环主机名（含环回地址全段 127.x）。 */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  // 带端口进来的（如 "127.0.0.1:3410" 或 IPv6 "[::1]:3410"）一律不认 —— URL 解析后
  // hostname 不会带端口，走到这说明校验点不对。
  if (h.includes(':') && !h.startsWith('[')) {
    // IPv6 字面量（无端口形式）
    return h === '::1';
  }
  const m = /^127(\.\d{1,3}){3}$/.exec(h);
  if (m) return h.split('.').every((n) => Number(n) <= 255);
  return false;
}

/**
 * 解析对端目标。返回 null = 未启用；返回 { valid:false, error } = 配置非法；
 * 返回 { valid:true, ... } = 可直接用于探测的归一化目标。
 */
export function resolvePeerTarget(config) {
  const peer = config?.server?.peer;
  if (!peer || !peer.enabled) return null;

  const profileId = String(peer.profile ?? '').trim();
  if (!/^\d+$/.test(profileId)) {
    return { enabled: true, valid: false, error: 'server.peer.profile 必须是实例号（如 "2"）。留空时按 httpUrl 需显式指定。' };
  }
  const n = Number(profileId);
  const offset = portOffsetFor(profileId);

  const httpUrl = (peer.httpUrl && String(peer.httpUrl).trim())
    || `http://127.0.0.1:${CONSOLE_BASE_PORT + offset}`;
  const wsUrl = (peer.wsUrl && String(peer.wsUrl).trim())
    || `ws://127.0.0.1:${3001 + offset}`;   // 占位：当前版本只用 httpUrl 探测
  const dataDir = (peer.dataDir && String(peer.dataDir).trim())
    || '';   // 调用方如需展示再按平台规则补（见 docs/multi-instance.md 端口对照表）

  let u;
  try {
    u = new URL(httpUrl);
  } catch {
    return { enabled: true, valid: false, error: `server.peer.httpUrl 不是合法 URL：${httpUrl}` };
  }
  if (u.protocol !== 'http:' || !isLoopbackHost(u.hostname)) {
    return { enabled: true, valid: false, error: `server.peer.httpUrl 只允许本机回环地址（http://127.0.0.1:端口）：${httpUrl}` };
  }

  return {
    enabled: true,
    valid: true,
    name: (peer.name && String(peer.name).trim()) || `实例 #${n}`,
    profile: String(n),
    profileId: n,
    dataDir,
    port: u.port || String(CONSOLE_BASE_PORT + offset),
    httpUrl,
    wsUrl,
    token: String(peer.token ?? ''),
    // pollMs 由下一轮调度读取（支持热改），这里只做钳制
    pollMs: Math.max(2000, Number(peer.pollMs) || 15000),
    timeoutMs: Math.max(500, Number(peer.timeoutMs) || 4000)
  };
}

/** 对端 /api/status → 只透传白名单字段（不透传 usage/cost/配置/任何密钥块）。 */
export function sanitizePeerStatus(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const onebot = raw.onebot || {};
  const orch = raw.orchestrator || {};
  return {
    onebot: {
      connected: !!onebot.connected,
      user: onebot.self
        ? { userId: String(onebot.self.userId ?? ''), nickname: String(onebot.self.nickname ?? '') }
        : null
    },
    snowlumaRunning: !!raw.snowluma?.running,
    // 对端绑定的 QQ 账号：切换器要显示"对端实例在替哪个号干活"。
    // 只透传账号号本身（不含任何令牌），与其余白名单字段同级别的非敏感信息。
    account: String(raw.snowluma?.account || ''),
    orchestrator: {
      paused: !!orch.paused,
      model: orch.model ? String(orch.model) : '',
      running: Array.isArray(orch.running) ? orch.running.length : 0,
      activeSessions: Array.isArray(orch.activeSessions) ? orch.activeSessions.length : 0
    },
    dataDir: raw.dataDir ? String(raw.dataDir) : ''
  };
}

/**
 * 对端监测器：start() 后立即探一次，之后按 server.peer.pollMs 自调度（setTimeout 链，
 * 支持热改 pollMs）。每次探测（成功或失败）都 emit('peer-status', latest)。
 * latest 也可经 /api/status 的 peer 字段同步给常规轮询的 UI。
 */
export function createPeerMonitor({ getConfig, emit, log }) {
  let timer = null;
  let latest = null;

  const probe = async () => {
    let cfg;
    try { cfg = getConfig(); } catch (e) { log?.('[peer] getConfig 失败：', e?.message ?? e); return; }

    const target = resolvePeerTarget(cfg);
    if (!target) {
      latest = { configured: false, at: Date.now() };
      emit?.('peer-status', latest);
      return;
    }
    if (target.valid === false) {
      log?.('[peer] 配置非法：', target.error);
      latest = { configured: true, valid: false, error: target.error, at: Date.now() };
      emit?.('peer-status', latest);
      return;
    }

    // 防自探测：对端公式端口恰好与本实例 server.port 相同（主实例手改过端口、
    // profile 用错等）时，"探测对端"其实是在探自己，界面只会显示"我是我的对端"。
    const ownPort = Number(cfg.server?.port) || CONSOLE_BASE_PORT;
    if (String(ownPort) === target.port) {
      latest = {
        configured: true,
        valid: false,
        error: `对端端口 ${target.port} 与本实例 server.port 相同 —— 要么把对端 httpUrl 显式指到真实端口，要么给本实例换个端口（QQ_AGENT_PORT / server.port）`,
        at: Date.now()
      };
      emit?.('peer-status', latest);
      return;
    }

    try {
      const headers = target.token ? { 'x-console-token': target.token } : {};
      const r = await fetch(`${target.httpUrl}/api/status`, {
        headers,
        signal: AbortSignal.timeout(target.timeoutMs)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json().catch(() => { throw new Error('响应不是 JSON'); });
      latest = {
        configured: true,
        ok: true,
        valid: true,
        at: Date.now(),
        status: sanitizePeerStatus(body),
        error: null
      };
    } catch (e) {
      latest = {
        configured: true,
        ok: false,
        valid: true,
        at: Date.now(),
        status: null,
        error: String(e?.message ?? e).slice(0, 200)
      };
    }
    emit?.('peer-status', latest);
  };

  const loop = async () => {
    await probe();
    let pollMs = 15000;
    try {
      const p = getConfig()?.server?.peer;
      if (p && p.pollMs) pollMs = Math.max(2000, Number(p.pollMs) || 15000);
    } catch { /* 默认值兜底 */ }
    timer = setTimeout(loop, pollMs);
    timer.unref?.();
  };

  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  return {
    start() {
      cancel();
      loop();
    },
    stop() { cancel(); },
    snapshot() { return latest; }
  };
}