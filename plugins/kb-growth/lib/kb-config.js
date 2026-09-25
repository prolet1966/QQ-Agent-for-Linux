// kb-config.js —— 配置默认值（从宿主 kb-config.js 照搬 DEFAULTS，独立于宿主 config.js）
export const DEFAULTS = {
  enabled: true,
  admin: { writeQq: ['10001'], maxContentChars: 4000, maxChunksPerWrite: 12, maxImagesPerWrite: 8, maxImageBytes: 8388608 },
  mongo: { uri: 'mongodb://127.0.0.1:27017', db: 'qq_agent_kb', serverSelectionTimeoutMs: 800, connectTimeoutMs: 800, maxPoolSize: 4, cooldownMs: 5000, requireIndexes: false },
  tenant: { default: 'default', byChatKey: {} },
  retrieve: { enabled: true, timeoutMs: 200, topK: 5, candidateLimit: 120, minConfidence: 0.70, hardMinConfidence: 0.58, vectorWeight: 0.62, keywordWeight: 0.38, maxLift: 0.5, maxContextChars: 2600 },
  fallback: { enabled: true, timeoutMs: 3000, maxResults: 4, ingestResults: true },
  queue: { maxSize: 500, flushIntervalMs: 300, flushBatch: 50, maxAttempts: 4, retryBaseMs: 400, enqueueDedupeMs: 600000, deadLetterFile: 'data/kb-growth/dead-letter.jsonl' },
  worker: { enabled: true, intervalMs: 1500, batchSize: 4, concurrency: 2, leaseMs: 60000, maxAttempts: 3, retryBackoffMs: 2000, reclaimIntervalMs: 30000, fetchContent: false, minContentChars: 48, maxContentChars: 20000 },
  dedupe: { urlHash: true, contentHash: true, ann: true, annThreshold: 0.95, annCandidateLimit: 200, annLookbackDays: 90 },
  promote: { autoApproveTrustLevels: ['high'], autoApproveConfidence: 0.75, requireManualForSensitive: true, sensitiveTopics: ['medical', 'legal', 'finance'], chunkSize: 420, chunkOverlap: 80, maxChunks: 40, chunkTtlDays: 180, candidateTtlDays: 30 },
  embed: { provider: 'local-hash', dim: 256, remote: { baseUrl: '', model: '', apiKey: '', timeoutMs: 4000 } },
  audit: { enabled: true, ttlDays: 30, flushIntervalMs: 1000, maxBuffer: 500, debug: false },
  sourceTrust: { allow: [], deny: [], defaultLevel: 'unknown' },
  log: { verbose: false },
};

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

let reader = null;
let cache = null;
export function setConfigReader(fn) { reader = fn; cache = null; }

export function applyEnvOverrides(cfgObj) {
  const env = process.env || {};
  const out = JSON.parse(JSON.stringify(cfgObj));
  if (env.KB_GROWTH_ENABLED != null) out.enabled = env.KB_GROWTH_ENABLED !== '0' && env.KB_GROWTH_ENABLED !== 'false';
  if (env.KB_GROWTH_MONGO_URI) out.mongo.uri = env.KB_GROWTH_MONGO_URI;
  if (env.KB_GROWTH_DB) out.mongo.db = env.KB_GROWTH_DB;
  if (env.KB_GROWTH_TENANT) out.tenant.default = env.KB_GROWTH_TENANT;
  if (env.KB_GROWTH_RETRIEVE_TIMEOUT_MS) out.retrieve.timeoutMs = Number(env.KB_GROWTH_RETRIEVE_TIMEOUT_MS);
  if (env.KB_GROWTH_SEARCH_TIMEOUT_MS) out.fallback.timeoutMs = Number(env.KB_GROWTH_SEARCH_TIMEOUT_MS);
  if (env.KB_GROWTH_WORKER === '0') out.worker.enabled = false;
  if (env.KB_GROWTH_VERBOSE === '1') out.log.verbose = true;
  return out;
}

async function readHostConfig() {
  if (reader) { try { return await reader(); } catch { return null; } }
  try { const mod = await import('../../config.js'); if (mod.getConfig) return mod.getConfig(); } catch {}
  try {
    const fs = await import('node:fs');
    const f = process.env.KB_GROWTH_CONFIG || (process.cwd() + '/data/config.json');
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { return null; }
}

export async function loadConfig(options = {}) {
  if (cache && !options.force) return cache;
  const host = await readHostConfig();
  const raw = isPlainObject(host?.kbGrowth) ? host.kbGrowth : {};
  cache = applyEnvOverrides(deepMerge(DEFAULTS, raw));
  return cache;
}

export function getCfg() { return cache || applyEnvOverrides(deepMerge(DEFAULTS, {})); }

export function setCfg(patch) { cache = applyEnvOverrides(deepMerge(getCfg(), patch || {})); return cache; }

export function paths() { return { root: process.cwd(), data: process.cwd() + '/data' }; }

export function resolvePath(p, fallbackName = 'kb-growth') {
  const raw = String(p ?? '').trim();
  const { data, root } = paths();
  if (!raw) return data + '/' + fallbackName;
  if (p.startsWith('/')) return raw;
  const normalized = raw.replace(/^[.]/, '');
  if (normalized.startsWith('data/')) return root + '/' + normalized;
  return data + '/' + raw;
}

export function tenantFor(chatKey, cfgObj = getCfg()) {
  const key = String(chatKey ?? '');
  const map = cfgObj.tenant?.byChatKey;
  if (key && map && typeof map === 'object' && map[key]) return String(map[key]);
  return String(cfgObj.tenant?.default || 'default');
}
