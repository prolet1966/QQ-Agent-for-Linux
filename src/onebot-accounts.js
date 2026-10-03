// ── OneBot 账号发现：账号(UIN) → 端点(ws/http) 的权威映射 ──────────────────
//
// 为什么需要这个文件：
//   一个 SnowLuma 进程会**同时**给每个已登录账号各起一套 OneBot 服务
//   （Hook 检出几个 QQ 客户端进程，就加载几个账号）。实测本机三个账号：
//       2215188985 → HTTP 3000 / WS 3001
//       3496634588 → HTTP 3002 / WS 3003
//       2655669027 → HTTP 3004 / WS 3005
//   端口是 SnowLuma **自己分配**的（每账号 +2，按 Hook 发现顺序），不是固定绑定。
//
//   而 QQ Agent 的多实例端口公式是 `3001 + 实例号×100`（config.js），
//   与上面这套分配完全对不上 —— 实例 #2 会去连 3101，那里什么都没有。
//   于是"切到实例 #2"必然连不上，只能永远连 3001（也就是 Hook 里第一个账号）。
//
// 本模块的做法：**不猜端口，直接读 SnowLuma 自己写下的配置**
//   <snowluma>/config/onebot_<uin>.json 里 networks.httpServers / wsServers
//   就是该账号真实在用的 host/port/path/token。这是唯一权威来源，且离线可用
//   （文件永久保留，不表示账号当前在线）。
//
// 契约：本模块所有函数都不得抛异常 —— 读不到就返回空/ null，由调用方决定回退。
import fs from 'node:fs';
import path from 'node:path';

/** SnowLuma per-account OneBot 配置文件名的匹配（onebot_0.json 是空模板，排除）。 */
const ACCOUNT_FILE_RE = /^onebot_(\d+)\.json$/;

/** 从 networks 段里挑出"默认"那一条 —— 优先 name，其次第一条。 */
function pickServer(list) {
  const arr = Array.isArray(list) ? list.filter((s) => s && typeof s === 'object') : [];
  if (!arr.length) return null;
  return arr.find((s) => s.name === 'http-default' || s.name === 'ws-default') || arr[0];
}

/**
 * 解析单个账号配置文件 → 账号端点描述。
 *
 * @param {string} uin  账号 QQ 号（来自文件名）
 * @param {object} data onebot_<uin>.json 的内容
 * @returns {object|null} 没有任何网络段时返回 null
 */
export function parseAccountConfig(uin, data) {
  const http = pickServer(data?.networks?.httpServers);
  const ws = pickServer(data?.networks?.wsServers);
  if (!http && !ws) return null;

  return {
    uin: String(uin),
    host: String(ws?.host || http?.host || '127.0.0.1'),
    wsPort: Number(ws?.port) || 0,
    httpPort: Number(http?.port) || 0,
    wsPath: String(ws?.path || '/'),
    httpPath: String(http?.path || '/'),
    wsToken: String(ws?.accessToken ?? ''),
    httpToken: String(http?.accessToken ?? ''),
    // 该账号是否在 SnowLuma 里禁用了某条网络（数组里没有就是没开）
    hasWs: !!ws,
    hasHttp: !!http
  };
}

/**
 * 列出 SnowLuma 下所有账号的端点。
 *
 * 注意：**文件存在 ≠ 账号在线**。SnowLuma 会永久保留每个登录过的账号的配置。
 * 要判断在线请用 probeAccount()（会真的去打一次 OneBot HTTP）。
 *
 * @param {string} snowlumaDir SnowLuma 程序目录
 * @returns {Array<object>} 按端口升序；读不到目录时返回 []
 */
export function listOneBotAccounts(snowlumaDir) {
  const out = [];
  if (!snowlumaDir) return out;
  const cfgDir = path.join(String(snowlumaDir), 'config');

  let files = [];
  try {
    files = fs.readdirSync(cfgDir);
  } catch {
    return out;   // 目录不存在（SnowLuma 还没跑过）→ 空
  }

  for (const file of files) {
    const m = ACCOUNT_FILE_RE.exec(file);
    if (!m) continue;
    const uin = m[1];
    if (uin === '0') continue;   // 空模板
    try {
      const data = JSON.parse(fs.readFileSync(path.join(cfgDir, file), 'utf8'));
      const acct = parseAccountConfig(uin, data);
      if (acct) out.push({ ...acct, file });
    } catch { /* 单个文件坏了跳过，不影响其他账号 */ }
  }

  // 按 ws 端口升序：与 SnowLuma 的分配顺序一致，界面上顺序稳定
  out.sort((a, b) => (a.wsPort || a.httpPort) - (b.wsPort || b.httpPort));
  return out;
}

/** 按 uin 找账号；找不到返回 null。 */
export function findAccount(accounts, uin) {
  const want = String(uin ?? '').trim();
  if (!want) return null;
  return (accounts || []).find((a) => String(a.uin) === want) || null;
}

/** 拼 OneBot 端点 URL（path 为 '/' 时不重复尾斜杠）。 */
function endpointUrl(scheme, host, port, urlPath) {
  const p = String(urlPath || '/');
  const suffix = p === '/' ? '' : (p.startsWith('/') ? p : `/${p}`);
  return `${scheme}://${host}:${port}${suffix}`;
}

/**
 * 账号 → OneBot 客户端要用的连接参数。
 * 与 src/app.js 里 `new OneBotClient({ wsUrl, httpUrl, accessToken, httpToken })` 对齐。
 */
export function accountEndpoints(account) {
  if (!account) return null;
  const host = String(account.host || '127.0.0.1');
  const out = {};
  if (account.wsPort) out.wsUrl = endpointUrl('ws', host, account.wsPort, account.wsPath);
  if (account.httpPort) out.httpUrl = endpointUrl('http', host, account.httpPort, account.httpPath);
  // HTTP 令牌留空时沿用 WS 令牌（与 snowluma.httpAccessToken || accessToken 的既有语义一致）
  out.accessToken = account.wsToken || '';
  out.httpAccessToken = account.httpToken || account.wsToken || '';
  return out;
}

/**
 * 探测账号是否在线：打一次 OneBot HTTP 的 get_login_info。
 * 在线时顺带拿到昵称与真实 uin（配置里的文件名就是 uin，但以服务端返回为准）。
 *
 * @returns {Promise<{online:boolean, nickname?:string, userId?:string, error?:string}>}
 */
export async function probeAccount(account, { timeoutMs = 2500 } = {}) {
  if (!account?.httpPort) return { online: false, error: '该账号未启用 OneBot HTTP' };
  const host = String(account.host || '127.0.0.1');
  const url = endpointUrl('http', host, account.httpPort, account.httpPath).replace(/\/$/, '') + '/get_login_info';
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(account.httpToken ? { authorization: `Bearer ${account.httpToken}` } : {})
      },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!r.ok) return { online: false, error: `HTTP ${r.status}` };
    const body = await r.json().catch(() => null);
    if (!body || (body.status !== 'ok' && body.retcode !== 0)) {
      return { online: false, error: `retcode=${body?.retcode ?? '?'}` };
    }
    return {
      online: true,
      nickname: String(body.data?.nickname ?? ''),
      userId: String(body.data?.user_id ?? '')
    };
  } catch (e) {
    return { online: false, error: String(e?.message ?? e).slice(0, 80) };
  }
}

export default {
  parseAccountConfig,
  listOneBotAccounts,
  findAccount,
  accountEndpoints,
  probeAccount
};
