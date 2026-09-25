// mg-config.js —— 记忆库配置（宿主 kb-config.js 的 memoryGrowth 段 + 独立库 qq_agent_memory）
export const DEFAULTS = {
  mongo: { uri: 'mongodb://127.0.0.1:27017', db: 'qq_agent_memory', serverSelectionTimeoutMs: 800, connectTimeoutMs: 800 },
  inject: false,
  extractionIntervalMs: 600000,
  minScore: 0.48,           // 语义空间实测：噪声上限 0.4621、命中下界 0.5086 → 0.48 卡空档
  simVector: 0.95,          // 语义空间自动合并只看向量（宿主第十四节阈值）
  simSuspect: 0.88,         // 存疑标记阈值
  simJaccard: 0.85,         // 词面双高门（哈希空间用；语义空间只看向量）
  reReviewAfter: 3,         // 被拒绝记忆提到 ≥3 次带 reopened 重提审
  archiveAfterDays: 0,      // 0 = 关（自动归档默认关，需人点头）
  autoApprove: { enabled: true, minConfidence: 0.7, minChars: 6, maxChars: 300, allowLowImportance: true, allowMediumRisk: false, sensitiveKinds: [] },
  semanticEmbedEnabled: true,
  semanticEmbedUrl: 'http://127.0.0.1:3917',
  tenant: { default: 'default', byChatKey: {} },
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

let cache = null;
let reader = null;
export function setConfigReader(fn) { reader = fn; cache = null; }

async function readHostConfig() {
  if (reader) { try { return await reader(); } catch { return null; } }
  try { const mod = await import('../../config.js'); if (mod.getConfig) return mod.getConfig(); } catch {}
  try {
    const fs = await import('node:fs');
    const f = process.env.MEMORY_GROWTH_CONFIG || (process.cwd() + '/data/config.json');
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { return null; }
}

export async function loadConfig(options = {}) {
  if (cache && !options.force) return cache;
  const host = await readHostConfig();
  const raw = isPlainObject(host?.memoryGrowth) ? host.memoryGrowth : {};
  // 连接串/库名从插件 settings 读（V0.3.1 由 manifest.settings 合并注入，宿主是 config.json 的 mongoUri 段）
  cache = deepMerge(DEFAULTS, raw);
  return cache;
}

export function getCfg() { return cache || deepMerge(DEFAULTS, {}); }

export function setCfg(patch) { cache = deepMerge(getCfg(), patch || {}); return cache; }

export function tenantFor(chatKey, cfgObj = getCfg()) {
  const key = String(chatKey ?? '');
  const map = cfgObj.tenant?.byChatKey;
  if (key && map && typeof map === 'object' && map[key]) return String(map[key]);
  return String(cfgObj.tenant?.default || 'default');
}
