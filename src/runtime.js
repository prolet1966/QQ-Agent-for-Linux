// Server defaults are merged before saved configuration; environment overrides
// are evaluated separately and must never be written back to config.json.
import net from 'node:net';

export const isServerMode = () => process.env.QQ_AGENT_MODE === 'server';
export function runtimeDefaults() {
  if (!isServerMode()) return {};
  const small = (process.env.QQ_AGENT_PRESET || 'server-2c2g') === 'server-2c2g';
  return {
    server: { bindHost: '0.0.0.0', strictPort: true, auth: true, maxSseClients: 8, desktopProxy: false },
    extensions: { hotReload: false },
    background: { telemetry: false, usageWarm: false, priceFeed: false, mongoAutoStart: false, cacheWarm: false },
    store: { backend: 'auto' },
    snowluma: { mode: 'local', autoLaunch: false, independent: true },
    ...(small ? {
      maxConcurrentRuns: 1, maxPendingChats: 32,
      api: { videoMode: 'off' }, proactive: { enabled: false },
      resources: { incomingQueue: 512, incomingConcurrency: 1, sendQueuePerChat: 64, maxOnebotPayloadMB: 4,
        memoryCacheChats: 32, usageCacheSessions: 256, mediaConcurrency: 1, mediaMaxBytesMB: 8,
        localMedia: false, mediaCacheMB: 64, mediaCacheTtlMs: 86400000 },
      memory: { consolidateEnabled: false },
    } : {}),
  };
}

export function applyEnvironment(config) {
  const out = structuredClone(config);
  const env = process.env;
  if (env.QQ_AGENT_PORT !== undefined) {
    const n = Number(env.QQ_AGENT_PORT);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('QQ_AGENT_PORT 必须在 1–65535 之间');
    out.server.port = n;
  }
  if (env.QQ_AGENT_BIND_HOST) out.server.bindHost = env.QQ_AGENT_BIND_HOST;
  if (env.QQ_AGENT_PUBLIC_HOST) out.server.publicHost = env.QQ_AGENT_PUBLIC_HOST;
  if (env.QQ_AGENT_ALLOWED_ORIGINS !== undefined) out.server.allowedOrigins = env.QQ_AGENT_ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  if (env.QQ_AGENT_ONEBOT_WS_URL) out.snowluma.wsUrl = env.QQ_AGENT_ONEBOT_WS_URL;
  if (env.QQ_AGENT_ONEBOT_HTTP_URL) out.snowluma.httpUrl = env.QQ_AGENT_ONEBOT_HTTP_URL;
  if (env.QQ_AGENT_ONEBOT_TOKEN !== undefined) out.snowluma.accessToken = env.QQ_AGENT_ONEBOT_TOKEN;
  if (env.QQ_AGENT_ONEBOT_HTTP_TOKEN !== undefined) out.snowluma.httpAccessToken = env.QQ_AGENT_ONEBOT_HTTP_TOKEN;
  if (env.QQ_AGENT_PROTOCOL_MODE) out.snowluma.mode = env.QQ_AGENT_PROTOCOL_MODE;
  if (env.QQ_AGENT_API_KEY !== undefined) out.api.apiKey = env.QQ_AGENT_API_KEY;
  if (!['local', 'external'].includes(out.snowluma.mode || 'local')) throw new Error('协议端模式必须是 local 或 external');
  if (isServerMode()) { out.server.auth = true; out.server.strictPort = true; }
  return out;
}

export function sameOriginAllowed(req, config) {
  const host = String(req.headers.host || '').toLowerCase();
  const scheme = req.socket.encrypted ? 'https:' : 'http:';
  let current;
  try { current = new URL(`${scheme}//${host}`); } catch { return false; }
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const explicit = String(config.server?.publicHost || '').toLowerCase();
  const origins = config.server?.allowedOrigins || [];
  if (!loopback && host !== explicit && !origins.includes(current.origin)) return false;
  for (const key of ['origin', 'referer']) {
    if (!req.headers[key]) continue;
    try { if (new URL(req.headers[key]).origin !== current.origin) return false; } catch { return false; }
  }
  return req.headers['sec-fetch-site'] !== 'cross-site';
}

export function protocolEndpoint(raw) {
  try {
    const url = new URL(raw);
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol)) return null;
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (['wss:', 'https:'].includes(url.protocol) ? 443 : 80)) };
  } catch { return null; }
}

export function isLoopbackAddress(host) {
  return host === 'localhost' || host === '::1' || (net.isIP(host) === 4 && host.startsWith('127.'));
}
