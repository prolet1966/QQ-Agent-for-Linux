// voice-tts-skill —— LLM 型技能：语音合成（宿主 send_voice 语义 + GPT-SoVITS 软依赖 + 情绪自适应）
//
// 软依赖：GPT-SoVITS 本地服务（settings.baseUrl）。本机没装时工具如实报「TTS 服务不可用」，
//   绝不卡聊天（宿主纪律：语音是增强，不是主链路）。
//
// 清单 §4.3 的能力面（本文件全量实现）：
//   · 语音合成（零样本克隆）        → send_voice
//   · 多音色管理（扫描/平铺/切换）  → list_voices + voiceByRole + defaultVoice
//   · 采样参数（语速/温度/topK/topP/重复惩罚/分片间隔/…）→ settings 全量透传
//   · 自动语音（每条文字发言后跟发同段语音）→ autoVoice + after-tool 钩子
//   · 情绪自适应（双线性插值）      → emotionToVoiceParams（软依赖 bodystate.status）
//   · 语音缓存（上限可配 + 清理）   → cacheSize + tts_cache_clear
//   · 参数预览 / 体检              → tts.probe 能力 + panel.tts 面板

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// 数据根目录：必须与正在运行的那份进程完全一致（多实例下插件自己拼会算错根目录，
// 表现是「实例 #2 的数据写进 #1 的目录」，两个机器人互相污染且极难发现）。
// 复用核心导出，唯一真源 —— 官方 conversation-memory 插件同款做法。
import { DATA_DIR } from '../../src/config.js';

let cfg = () => ({});
let dataDir = null;
let api = null;
let cacheDir = null;

// ── 情绪 → 语音参数（双线性插值）─────────────────────────────────
// 四角锚点（唤醒度 arousal × 效价 valence）：安静平静 / 激动正向 / 激动负向 / 平静负向
const ANCHORS = {
  calm:    { speed: 1.0, pitch: 0,    vol: 0.8 },
  excited: { speed: 1.2, pitch: 1,    vol: 1.0 },   // 激动正向（开心/亢奋）
  angry:   { speed: 1.1, pitch: -0.5, vol: 1.1 },   // 激动负向（愤怒/烦躁）
  low:     { speed: 0.9, pitch: -1,   vol: 0.6 },   // 平静负向（低落/悲伤）
};

/** 情绪轴 → 语音参数（双线性插值，宿主 emotion-voice 语义）。arousal/valence 各 0~1。 */
export function emotionToVoiceParams(arousal, valence) {
  const a = Math.max(0, Math.min(1, Number(arousal) || 0.5));
  const v = Math.max(0, Math.min(1, Number(valence) || 0.5));
  const w_calm = (1 - a) * (1 - (1 - v));
  const w_exc = a * (1 - (1 - v));
  const w_low = (1 - a) * (1 - v);
  const w_ang = a * (1 - v);
  const wsum = w_calm + w_exc + w_low + w_ang || 1;
  const mix = (k) => ((ANCHORS.calm[k] * w_calm + ANCHORS.excited[k] * w_exc + ANCHORS.low[k] * w_low + ANCHORS.angry[k] * w_ang) / wsum);
  return {
    speedFactor: Math.round(mix('speed') * 100) / 100,
    pitchShift: Math.round(mix('pitch') * 100) / 100,
    volumeScale: Math.round(mix('vol') * 100) / 100,
    arousal, valence,
  };
}

// ── 多音色管理 ────────────────────────────────────────────────────
const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.aac']);

/** 扫描音色目录：每个音频文件 = 一个音色（名字取文件名去扩展名）。 */
export function scanVoices(dir) {
  const d = String(dir ?? '').trim();
  if (!d) return [];
  try {
    return fs.readdirSync(d)
      .filter((n) => AUDIO_EXT.has(path.extname(n).toLowerCase()))
      .sort()
      .map((n) => {
        const full = path.join(d, n);
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* 忽略 */ }
        return { name: path.basename(n, path.extname(n)), path: full, bytes: size };
      });
  } catch { return []; }
}

/** 选音色：显式指定 > 角色映射 > 默认 > 第一条。 */
export function pickVoice({ voices = [], explicit = '', role = '', byRole = {}, fallback = '' } = {}) {
  if (!voices.length) return null;
  const find = (n) => voices.find((v) => v.name === String(n ?? '').trim()) || null;
  return find(explicit) || (role && find(byRole[role])) || find(fallback) || voices[0];
}

// ── 缓存 ──────────────────────────────────────────────────────────
const cacheKeyOf = (text, params) => crypto.createHash('sha1')
  .update(String(text) + '|' + JSON.stringify(params)).digest('hex').slice(0, 20);

function ensureCache() {
  if (!cacheDir) cacheDir = path.join(dataDir || DATA_DIR, 'voice-tts', 'cache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* 已存在 */ }
  return cacheDir;
}

/** 缓存命中检查（同文本+同参数 = 同一份音频，不必重合成）。 */
function cacheLookup(key) {
  const dir = ensureCache();
  for (const ext of ['.wav', '.mp3', '.flac', '.ogg']) {
    const p = path.join(dir, key + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 写入缓存 + 按 cacheSize 上限淘汰最老的。 */
function cacheStore(key, buf, ext = '.wav') {
  const dir = ensureCache();
  const p = path.join(dir, key + ext);
  try { fs.writeFileSync(p, buf); } catch { return p; }
  const max = Math.max(0, Number(cfg().cacheSize) || 0);
  if (max > 0) {
    try {
      const files = fs.readdirSync(dir).map((n) => ({ n, p: path.join(dir, n) }))
        .map((x) => ({ ...x, t: (() => { try { return fs.statSync(x.p).mtimeMs; } catch { return 0; } })() }))
        .sort((a, b) => b.t - a.t);
      for (const f of files.slice(max)) { try { fs.unlinkSync(f.p); } catch { /* 忽略 */ } }
    } catch { /* 淘汰失败不影响主流程 */ }
  }
  return p;
}

/** 缓存统计（控制台面板用）。 */
export function cacheStats() {
  const dir = ensureCache();
  try {
    const files = fs.readdirSync(dir);
    let bytes = 0;
    for (const n of files) { try { bytes += fs.statSync(path.join(dir, n)).size; } catch { /* 忽略 */ } }
    return { count: files.length, bytes, dir };
  } catch { return { count: 0, bytes: 0, dir }; }
}

/** 清空缓存。 */
function cacheClear() {
  const dir = ensureCache();
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); n++; } catch { /* 忽略 */ } }
  } catch { /* 忽略 */ }
  return n;
}

// ── 组装 GPT-SoVITS 请求体（清单 §7 的 tts 全量设置）────────────────
export function buildTtsBody({ text, c = {}, voice = null, vp = null } = {}) {
  const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
  const body = {
    text: String(text ?? ''),
    // 采样参数（有就传，没配就不传 —— 让服务端用自己的默认，比塞一个瞎猜的值安全）
    speed_factor: num(c.speedFactor, vp?.speedFactor ?? 1),
    temperature: num(c.temperature, undefined),
    top_k: num(c.topK, undefined),
    top_p: num(c.topP, undefined),
    repetition_penalty: num(c.repetitionPenalty, undefined),
    sample_steps: num(c.sampleSteps, undefined),
    batch_size: num(c.batchSize, undefined),
    fragment_interval: num(c.fragmentInterval, undefined),
    seed: num(c.seed, undefined),
    text_lang: c.textLang || undefined,
    prompt_lang: c.promptLang || undefined,
    text_split_method: c.textSplitMethod || undefined,
    // 音色（参考音频 + 参考文本）：显式音色 > 设置里的固定参考
    ref_audio_path: voice?.path || c.refAudioPath || undefined,
    prompt_text: c.promptText || undefined,
    aux_ref_audio_paths: c.auxRefAudioPaths || undefined,
    gpt_weights_path: c.gptWeightsPath || undefined,
    sovits_weights_path: c.sovitsWeightsPath || undefined,
    media_type: 'wav',
  };
  // 去掉 undefined / 空串，别把 "undefined" 当字符串发出去
  for (const k of Object.keys(body)) {
    if (body[k] === undefined || body[k] === null || body[k] === '') delete body[k];
  }
  return body;
}

/** 体检：探 GPT-SoVITS 健康端点。 */
async function probe() {
  const c = cfg();
  const baseUrl = String(c.baseUrl ?? '').trim();
  if (!baseUrl) return { ok: false, reason: '未配置 baseUrl（本机无 GPT-SoVITS 时属正常降级）' };
  const url = baseUrl.replace(/\/+$/, '') + (c.healthPath || '/health');
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { ok: res.ok, reason: res.ok ? '在线' : ('HTTP ' + res.status), baseUrl };
  } catch (e) {
    return { ok: false, reason: '连不上：' + (e?.message ?? e), baseUrl };
  }
}

/** 合成一段语音 → 返回本地文件路径（走缓存）。 */
async function synthesize(text, { voiceName = '', role = '' } = {}) {
  const c = cfg();
  const baseUrl = String(c.baseUrl ?? '').trim();
  if (!baseUrl) return { ok: false, error: 'TTS 服务未配置（voice-tts-skill 的 settings.baseUrl 没填）。本机没装服务时这条功能不可用，属正常降级。' };
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, error: '要合成的话是空的' };
  const maxLen = Number(c.maxTextLen ?? 500);
  if (t.length > maxLen) return { ok: false, error: '文字太长（>' + maxLen + ' 字），拆短再合' };

  // 情绪自适应（软依赖 body-state；缺层时用中性 0.5/0.5 = 平静基线）
  let vp = null;
  if (c.emotionVoice !== false) {
    let arousal = 0.5, valence = 0.5;
    const statusFn = api?.capability?.('bodystate.status');
    if (statusFn) {
      try {
        const st = await statusFn({});
        if (st?.ok) {
          const emo = st.emotions || {};
          const posSum = ['happiness', 'joy', 'excitement', 'gratitude'].reduce((a, k) => a + (emo[k] || 0), 0);
          const negSum = ['anger', 'sadness', 'depression'].reduce((a, k) => a + (emo[k] || 0), 0);
          arousal = Math.max(0, Math.min(1, (posSum + negSum) / 60 + (st.axes?.energy ?? 0.5) * 0.3));
          valence = Math.max(0, Math.min(1, st.axes?.mood ?? 0.5));
        }
      } catch { /* 情绪层不可用 → 中性 */ }
    }
    vp = emotionToVoiceParams(arousal, valence);
  }

  const voices = scanVoices(c.voiceScanDir);
  const voice = pickVoice({ voices, explicit: voiceName, role, byRole: c.voiceByRole || {}, fallback: c.defaultVoice });
  const body = buildTtsBody({ text: t, c, voice, vp });

  // 缓存：同文本 + 同参数 = 同一份音频
  const key = cacheKeyOf(t, body);
  const hit = cacheLookup(key);
  if (hit) return { ok: true, path: hit, cached: true, voice: voice?.name || '', vp };

  try {
    const resp = await fetch(baseUrl.replace(/\/+$/, '') + '/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(c.timeoutMs ?? 60000)),
    });
    if (!resp.ok) return { ok: false, error: 'TTS 服务返回 ' + resp.status + '。检查 baseUrl / 服务是否起来。' };
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) return { ok: false, error: 'TTS 服务返回了空音频' };
    const p = cacheStore(key, buf, '.wav');
    return { ok: true, path: p, cached: false, bytes: buf.length, voice: voice?.name || '', vp };
  } catch (e) {
    return { ok: false, error: 'TTS 服务调用失败（' + (e?.message ?? e) + '）。本机 GPT-SoVITS 没起？属正常降级，改用文字回复。' };
  }
}

/** 走 sender 把音频发出去（不绕开限频/留档）。 */
async function sendVoice(ctx, filePath, label = '[语音]') {
  if (ctx?.sender?.sendMedia) {
    await ctx.sender.sendMedia(ctx.chatKey, [{ type: 'record', data: { file: filePath } }], { label });
    return true;
  }
  if (ctx?.sender?.sendVoice) { await ctx.sender.sendVoice(ctx.chatKey, filePath); return true; }
  return false;
}

export function setup(a) {
  api = a;
  cfg = a.config;
  api.log('voice-tts-skill 已加载（GPT-SoVITS 软依赖 + 情绪自适应 + 多音色 + 缓存；本机无服务降级跳过）');

  const ok = (d) => ({ content: typeof d === 'string' ? d : JSON.stringify(d, null, 2) });
  const err = (m) => ({ content: m, isError: true });

  api.registerTool({
    id: 'send_voice',
    name: '发语音',
    description: '把文字合成语音发到群里（GPT-SoVITS，自定义音色）。群友明确要「用语音说/发条语音」时用；普通回复不用语音。生成需等一会儿。',
    category: 'media',
    icon: '🎙️',
    defaultEnabled: false,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要合成的文字' },
        voice: { type: 'string', description: '可选：音色名（不填用默认；音色清单见 list_voices）' },
      },
      required: ['text'],
    },
    async execute(ctx, args) {
      try {
        const r = await synthesize(String(args.text ?? ''), { voiceName: String(args.voice ?? '') });
        if (!r.ok) return err(r.error);
        const sent = await sendVoice(ctx, r.path);
        if (!sent) return ok('语音已合成（' + (r.bytes ?? 0) + ' 字节），但当前 ctx 没有语音发送通道，文件在 ' + r.path);
        return ok('语音已发到群里' + (r.voice ? '（音色：' + r.voice + '）' : '')
          + (r.vp ? '，情绪参数：唤醒 ' + r.vp.arousal + ' / 效价 ' + r.vp.valence + ' → 语速×' + r.vp.speedFactor : '')
          + (r.cached ? '（命中缓存）' : '') + '。一句话告知即可。');
      } catch (e) { return err('发语音失败：' + (e?.message ?? e)); }
    },
  });

  api.registerTool({
    id: 'list_voices',
    name: '看音色',
    description: '列出本机可用的语音音色（扫描设置里的音色目录）。想知道有哪些音色、或换音色前先查一下时用。',
    category: 'media',
    icon: '🎚️',
    defaultEnabled: false,
    parameters: { type: 'object', properties: {} },
    async execute() {
      const c = cfg();
      const voices = scanVoices(c.voiceScanDir);
      if (!c.voiceScanDir) return err('没配音色目录（settings.voiceScanDir）。填上目录后这里会列出里面的音频文件。');
      if (!voices.length) return ok('音色目录里没有音频文件：' + c.voiceScanDir);
      return ok({ 目录: c.voiceScanDir, 数量: voices.length, 音色: voices.map((v) => v.name), 默认音色: c.defaultVoice || voices[0].name });
    },
  });

  api.registerTool({
    id: 'tts_cache_clear',
    name: '清语音缓存',
    description: '清空语音合成的本地缓存（合成过的音频文件）。管理员要求清理磁盘或语音占地方时用。',
    category: 'media',
    icon: '🧽',
    defaultEnabled: false,
    parameters: { type: 'object', properties: {} },
    async execute() {
      const n = cacheClear();
      return ok('已清掉 ' + n + ' 个语音缓存文件。');
    },
  });
}

/** 供其它技能/控制台调用的能力（避免它们直接读文件）。 */
export const providers = {
  'tts.probe': async () => probe(),
  'tts.preview': async ({ text, voice } = {}) => {
    const r = await synthesize(String(text ?? '你好'), { voiceName: String(voice ?? '') });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, path: r.path, cached: !!r.cached, voice: r.voice || '', bytes: r.bytes ?? null };
  },
  'tts.voices': async () => {
    const c = cfg();
    const voices = scanVoices(c.voiceScanDir);
    return { ok: true, dir: c.voiceScanDir || '', voices: voices.map((v) => ({ name: v.name, bytes: v.bytes })), defaultVoice: c.defaultVoice || '' };
  },
  /** 控制台「扩展」面板（只读）。panel. 前缀 = 核心放行的约定。 */
  'panel.tts': async () => {
    const c = cfg();
    const p = await probe();
    const voices = scanVoices(c.voiceScanDir);
    const cs = cacheStats();
    return {
      title: '语音合成',
      summary: [
        { label: 'GPT-SoVITS', value: p.ok ? '在线' : ('降级：' + (p.reason || '未配置')) },
        { label: '音色', value: voices.length ? (voices.length + ' 个' + (c.defaultVoice ? '（默认 ' + c.defaultVoice + '）' : '')) : '未配置目录' },
        { label: '自动语音', value: c.autoVoice === true ? '开（文字后跟发）' : '关' },
        { label: '情绪自适应', value: c.emotionVoice !== false ? '开' : '关' },
        { label: '缓存', value: cs.count + ' 个 / ' + (cs.bytes / 1024 / 1024).toFixed(1) + ' MB' + (c.cacheSize ? '（上限 ' + c.cacheSize + '）' : '') },
      ],
      sections: [
        { type: 'table', title: '可用音色', columns: ['音色', '大小'], rows: voices.slice(0, 20).map((v) => [v.name, (v.bytes / 1024).toFixed(0) + ' KB']) },
        { type: 'hint', text: voices.length ? '在「设置 → 插件 → 语音合成」里改默认音色、采样参数和缓存上限。' : '把参考音频（wav/mp3/flac）放进音色目录，这里就会列出来。' },
      ],
    };
  },
};

export function available() {
  const c = cfg();
  if (!c.baseUrl) return { ok: false, reason: '未配置 GPT-SoVITS baseUrl（本机无服务时正常降级）' };
  const n = scanVoices(c.voiceScanDir).length;
  return { ok: true, reason: 'TTS 服务已配置 ' + c.baseUrl + (n ? '，音色 ' + n + ' 个' : '') };
}

export function activate(ctx) {
  void ctx;
  dataDir = path.join(DATA_DIR, 'voice-tts');
  ensureCache();
}
export function deactivate(ctx) { void ctx; }
export function dispose() {}

// ── 自动语音（清单 §4.3：「每条文字发言后自动跟发同段语音」）────────
// 挂 after-tool：send_message 成功之后，把刚发出去的文字再合成一份语音发出去。
// 放在 after-tool 而不是自己拦工具，是因为这样**不改变**文字发送的任何行为
// （限频、分条、去重、留档照旧），失败也只是少一条语音。
export const hooks = {
  async 'after-tool'({ toolName, argsRaw, result } = {}) {
    try {
      const c = cfg();
      if (c.autoVoice !== true) return;
      if (!result || result.isError) return;
      const short = String(toolName || '').includes('__') ? String(toolName).slice(String(toolName).indexOf('__') + 2) : String(toolName || '');
      if (short !== 'send_message') return;
      if (!String(c.baseUrl ?? '').trim()) return;

      let args = argsRaw;
      if (typeof argsRaw === 'string') { try { args = JSON.parse(argsRaw); } catch { args = null; } }
      const msgs = Array.isArray(args?.messages) ? args.messages : (args?.message ? [args.message] : []);
      const text = msgs.map((m) => String(m ?? '')).filter(Boolean).join('，');
      if (!text || text.length > Number(c.maxTextLen ?? 500)) return;

      const r = await synthesize(text, {});
      if (!r.ok) { api?.log?.('voice-tts: 自动语音合成失败 ' + r.error); return; }
      // 自动语音没有 ctx（钩子不给），所以必须拿到一个发送通道：
      // 用 api.sender（核心注入的全局发送队列），没有就静默跳过。
      const sender = api?.sender;
      const chatKey = api?.chatKey;
      if (!sender || !chatKey) { api?.log?.('voice-tts: 自动语音跳过（没有可用的发送通道）'); return; }
      if (sender.sendMedia) {
        await sender.sendMedia(chatKey, [{ type: 'record', data: { file: r.path } }], { label: '[语音]' + text.slice(0, 20) });
      }
    } catch (e) {
      api?.log?.('voice-tts: 自动语音失败 ' + (e?.message ?? e));   // 钩子绝不抛
    }
  },
};
