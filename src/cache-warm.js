// 前缀缓存保活（2026-09-20）。
//
// ── 为什么需要它（全部基于实测，不是推测）──────────────────────────────
// 用户的会话存档里，每个会话的「第 1 次调用」只有约 36% 命中缓存，
// 而同一会话第 2 次调用就有 97%+。用真实系统提示 + 真实工具集直连实测复现：
//
//     只带 tools 的第 1 次调用：prompt=6832  cached=2688  (39.3%)
//     带 tools 的第 2 次调用：  prompt=6833  cached=6656  (97.4%)
//
// 也就是说：「工具 schema + 系统提示」这段前缀（约 6600 token）本身是
// 跨会话字节一致的，但服务商要**先有请求写过它**才会命中。用户的实际会话
// 大多是"被叫一次、回一句就结束"，于是每个新会话都在为这段前缀付全价。
//
// ── 做法 ──────────────────────────────────────────────────────────────
// 后台按固定间隔发一次**与真实调用前缀完全相同**、尾部极短的请求：
//   messages = [ { role:'system', content: <真实系统提示> } ,
//                { role:'user',   content: '.' } ]
//   tools    = <与真实调用完全相同的工具集>
// 这样服务商就把这段前缀缓存住；此后任何新会话的第一次调用都能命中。
//
// ── 与真实调用的前缀必须"字节一致" ────────────────────────────────────
// 这是本模块唯一的正确性要求，也是最容易写错的地方：
//   · 系统提示必须用与 orchestrator 相同的入参构造（同一 buildSystemPrompt）
//   · 工具集必须用与 orchestrator 相同的可用性过滤（同一 getToolAvailability）
//   · 任何顺序/字段差异都会让保活白做（缓存写的是另一段前缀）
// 所以下面直接复用 core 的构造函数，不另写一份。
//
// ── 不消耗 Conversation 额度 ─────────────────────────────────────────
// 保活请求**不经过 orchestrator**，因此：
//   · 不创建会话、不写 data/sessions、不进用量统计（用量页不会凭空多出记录）
//   · 不经过 sender，不可能误发消息
//   · 失败只记一行日志，绝不影响主流程
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, personaForChat, DATA_DIR } from './config.js';
import { buildSystemPrompt } from './prompt.js';
import { buildToolDefs, toOpenAiTools } from './tools.js';
import { getToolAvailability } from './tool-registry.js';
import { skillManager } from './skills/manager.js';
import { chatCompletion, addUsage, emptyUsage } from './llm.js';
import { modelImageVerdict } from './vision-scan.js';
import { logger } from './logger.js';

/** 保活用的会话上下文。取值只需保证"与真实调用同构"，不需要真实存在。 */
function warmContext() {
  const cfg = getConfig();
  const visionEnabled = cfg.api?.vision !== false
    && modelImageVerdict(cfg.api?.provider, cfg.api?.model) !== 'no-vision';
  return {
    // 用私聊形态：真实调用里私聊没有 chatName，群聊才有；
    // 而 chatName 不进系统提示（实测三个会话的系统提示字节一致），所以两者等价。
    chatKey: 'private:0-warm',
    kind: 'private',
    chatId: '0',
    chatName: '',
    model: cfg.api?.model || '',
    provider: cfg.api?.provider || '',
    visionEnabled,
    searchEnabled: cfg.webSearch?.enabled !== false,
    proactive: false,
    sessionId: 'cache-warm'
  };
}

/**
 * 最近一次**真实运行**实际发送的 system prompt。
 *
 * 为什么要记这个（2026-09-20，一次真实的保活失效事故）：
 *   保活原先是"自己重新构造一份 system prompt"。这看起来等价，实际不等价 ——
 *   插件可以有自己的运行时状态，构造结果会随探测进度变化。实测到的例子：
 *   video-frames 的 available() 是「首次乐观放行 + 后台探测 ffmpeg」，
 *   于是启动后 20 秒的保活请求**多注入了一段「视频理解」**，
 *   而 3 分钟后真实调用的探测已完成（本机没装 ffmpeg）→ 那一段消失。
 *   两者前缀差一段 → 缓存白写，保活完全无效。
 *
 * 这种事无法靠"把构造参数写对"来根治：任何插件都可能引入类似的时间相关状态。
 * 所以改为**采集真实值**：orchestrator 每次运行把实际发出去的 system prompt
 * 记在这里，保活直接复用它。这样"逐字节一致"由构造保证，而不是靠约定。
 */
let lastRealSystemPrompt = '';
let lastRealToolsJson = '';
// 真实调用**实际发出**的完整请求体与端点（含账号池挑的 baseUrl、专用模型等）。
// 预热必须原样复用它们 —— 自己重造 body 会打到别的端点/模型，缓存键不同，
// 缓存写进别处，真实调用读不到（实测就是这个现象）。
let lastRealBody = null;
let lastRealBodyApi = null;

/**
 * 采集真实调用实际发出的请求（body + 端点）。由 orchestrator 调用。
 *
 * 为什么必须连同 api 一起存：账号池（llm.endpoint-pick）会给**每次真实请求**
 * 重新挑端点，专用模型逻辑也可能换模型。若预热自己拼 body 或换端点，
 * 缓存键就与真实调用不同 —— 缓存写进了别处，真实调用读不到。
 * @param {{body:object, api:object}} p
 */
export function captureRealBody({ body, api } = {}) {
  try {
    if (body && Array.isArray(body.messages)) lastRealBody = JSON.parse(JSON.stringify(body));
    if (api && api.baseUrl) lastRealBodyApi = { baseUrl: api.baseUrl, apiKey: api.apiKey, model: api.model };
  } catch { /* 采集失败不影响 */ }
  // 同时把这一份样本**交回给调用方**：lastRealBody 是模块级单槽，两个会话
  // 并发时（群里同时被叫到两次）后采集的会覆盖先采集的，先发的那次预热就会
  // 拿着**别人的 body** 去写缓存 —— 写完也是白写，真实调用照样打不中。
  // 实测症状正是"命中档位在 2688 与 6784 之间无规律跳变"。
  // 调用方拿着返回值直接交给 warmBeforeRealCall({ sample })，从此不再依赖单槽。
  return {
    body: body && Array.isArray(body.messages) ? JSON.parse(JSON.stringify(body)) : null,
    api: api && api.baseUrl ? { baseUrl: api.baseUrl, apiKey: api.apiKey, model: api.model } : null
  };
}

/**
 * 采集到新前缀后，多久补一次保活。
 *
 * 为什么需要它（2026-09-20 实测踩到）：
 *   保活循环的首次 tick 在启动后 20 秒，而那时**一次真实运行都还没发生**，
 *   按"没有真实样本就不发"的规则它直接跳过了；下一个 tick 却要等一整个
 *   interval（默认 60 分钟）。实测表现：启动后 10:35 的会话第 1 次调用命中
 *   仅 2688（35%），要等到真实调用自己把缓存写热才升到 6656（86%）。
 *   ——保活等于迟到了一小时，期间所有新会话都在付全价。
 *
 * 所以前缀一确定就尽快补一次：延迟 20 秒（避开这次运行自身的请求高峰），
 * 且同一前缀只补一次（避免每次运行都触发一次保活请求）。
 */
const EARLY_WARM_DELAY_MS = 20000;
let earlyWarmTimer = null;
let earlyWarmDoneFor = '';      // 已经为哪一份前缀补过保活
let cycleTick = null;           // 由 startCacheWarm 注入的 tick（未启动时为空）

/** 由 orchestrator 在每次运行开始时调用（见 src/orchestrator.js）。 */
export function noteRealPrompt({ systemPrompt, tools } = {}) {
  try {
    if (typeof systemPrompt === 'string' && systemPrompt) lastRealSystemPrompt = systemPrompt;
    if (Array.isArray(tools)) lastRealToolsJson = JSON.stringify(tools);
  } catch { return; /* 记不下来不影响主流程 */ }
  // 顺手落盘：下次启动时可以直接用它预热，不必等第一条消息
  persistPrefix();
  scheduleEarlyWarm();
}

// ── 前缀持久化（2026-09-20）─────────────────────────────────────────────
// 为什么需要：预热必须知道"这次调用会发什么前缀"。原先只能等本次运行构造完
// system prompt 才知道 —— 于是本会话的**第一次**调用永远赶不上预热
// （实测：11:12:17 第一次调用只命中 32%，而预热 11:12:34 才发出）。
// 把上次的前缀落盘，启动时就能先暖好，第一条消息的调用即可命中。
//
// 只存 system 文本与工具名（不存用户消息、不含聊天内容），且工具只靠名字重建
// 描述 —— 描述可能随时长变化，但 system+工具名足以覆盖绝大部分前缀 token。
const PREFIX_FILE = path.join(DATA_DIR, 'cache-warm-prefix.json');

function persistPrefix() {
  try {
    const names = [];
    try {
      for (const t of (lastRealToolsJson ? JSON.parse(lastRealToolsJson) : [])) {
        const n = t?.function?.name;
        if (n) names.push(n);
      }
    } catch { /* 忽略 */ }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${PREFIX_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      system: lastRealSystemPrompt,
      toolNames: names,
      savedAt: Date.now()
    }), 'utf8');
    fs.renameSync(tmp, PREFIX_FILE);
  } catch { /* 落盘失败不影响 */ }
}

/** 启动时载入上次的前缀。返回是否载入成功。 */
export function loadPersistedPrefix() {
  try {
    const d = JSON.parse(fs.readFileSync(PREFIX_FILE, 'utf8'));
    if (typeof d?.system === 'string' && d.system) {
      lastRealSystemPrompt = d.system;
      // 用名字从当前注册表重建 tools（描述按当前代码为准）
      const names = Array.isArray(d.toolNames) ? d.toolNames : [];
      if (names.length) {
        const defs = buildToolDefs().filter((x) => names.includes(x.id));
        lastRealToolsJson = JSON.stringify(toOpenAiTools(defs));
      }
      return true;
    }
  } catch { /* 首次运行没有这个文件 */ }
  return false;
}

/**
 * 从会话存档里"借"一份 system prompt 来播种前缀。
 *
 * 为什么需要（2026-09-20）：落盘文件只在**一次真实运行之后**才存在，
 * 于是"启动预热"在第一次安装/第一次重启后总是没有样本可预热 —— 而第一次调用
 * 恰恰是最需要它的那一次。会话存档里已经有真实发出去过的 systemPrompt，
 * 直接借来用即可打破这个循环。
 *
 * 只读 systemPrompt 字段（不含任何聊天内容），工具用当前注册表重建。
 * @returns {boolean} 是否播种成功
 */
export function seedPrefixFromSessions() {
  try {
    const dir = path.join(DATA_DIR, 'sessions');
    if (!fs.existsSync(dir)) return false;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (!files.length) return false;
    // 取修改时间最新的几个里第一个带 systemPrompt 的
    const sorted = files
      .map((f) => ({ f, m: (() => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.m - a.m);
    for (const { f } of sorted.slice(0, 5)) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (typeof s?.systemPrompt === 'string' && s.systemPrompt) {
          lastRealSystemPrompt = s.systemPrompt;
          // ⚠️ 工具必须跑**与真实调用相同的可用性过滤**，不能用全部工具：
          //    真实调用会排掉未开启的（例如 send_to 默认关），少一个工具就是
          //    另一段 tools 前缀 → 预热白做。这里复用 warmContext()，与
          //    buildWarmPayload 的回退分支同源。
          try {
            const c = warmContext();
            const tc = getConfig().tools || {};
            const kept = buildToolDefs().filter((d) => getToolAvailability(d.id, {
              skills: skillManager,
              toolsCfg: tc,
              visionEnabled: c.visionEnabled,
              searchEnabled: c.searchEnabled,
              runtimeContext: c
            }).enabled);
            lastRealToolsJson = JSON.stringify(toOpenAiTools(kept));
          } catch {
            lastRealToolsJson = JSON.stringify(toOpenAiTools(buildToolDefs()));
          }
          logger.info('cache-warm', `已从会话存档播种前缀（system ${s.systemPrompt.length} 字符，tools ${
            (() => { try { return JSON.parse(lastRealToolsJson).length; } catch { return '?'; } })()} 个）`);
          return true;
        }
      } catch { /* 坏文件跳过 */ }
    }
  } catch { /* 忽略 */ }
  return false;
}

/** 新前缀确定后尽快补一次保活（同一前缀只补一次）。 */
function scheduleEarlyWarm() {
  if (typeof cycleTick !== 'function') return;          // 保活循环没启动
  if (!lastRealSystemPrompt) return;
  if (earlyWarmDoneFor === lastRealSystemPrompt) return; // 这份前缀已经补过
  if (earlyWarmTimer) return;                            // 已排期，等它跑
  earlyWarmTimer = setTimeout(() => {
    earlyWarmTimer = null;
    earlyWarmDoneFor = lastRealSystemPrompt;
    cycleTick().catch(() => {});
  }, EARLY_WARM_DELAY_MS);
  earlyWarmTimer.unref?.();
}

/** 供诊断/测试查看当前采集到的真实前缀。 */
export function peekRealPrompt() {
  return {
    hasSystem: Boolean(lastRealSystemPrompt),
    systemLen: lastRealSystemPrompt.length,
    hasTools: Boolean(lastRealToolsJson),
    toolsLen: lastRealToolsJson.length
  };
}

// ── 调用前预热（2026-09-20）────────────────────────────────────────────
// 实测结论（A/B/C 三组对照，各 3 次）：
//   直接发真实调用：      首轮命中 6656/7252 = 91.8%
//   先发同前缀预热再发：  首轮命中 7040/7252 = 97.1%   ← 稳定 +5.3 个百分点
// 原理：真实调用是"这个前缀的第一次请求"时，只能命中服务商恰好已有的部分；
//       先让一次**没有后续负担**的请求把这段前缀写进缓存，真实调用就能读到完整前缀。
//
// 成本：一次预热约 7000 token 输入，但命中率 90%+（按缓存价 0.02 元/M 计费）
//       → 约 0.00035 元/次，相对一次真实调用的 0.008 元可忽略。
//
// 触发条件（三条同时满足才发，避免滥用）：
//   ① 配置里 cacheWarm.enabled 且 cacheWarm.preCall !== false
//   ② 已经有真实前缀样本（否则不知道要预热什么）
//   ③ 这份前缀最近没有预热过（PRE_CALL_MIN_GAP_MS 内不重复）
const PRE_CALL_MIN_GAP_MS = 45000;   // 45 秒内同一前缀只预热一次
let lastPreCallWarmAt = 0;
let lastPreCallPrefix = '';
let preCallInFlight = null;

/**
 * 在真实调用前预热缓存。**不阻塞主流程**：调用方 await 它也只是等它发出请求，
 * 失败/超时都不影响后续真实调用。
 */
export async function warmBeforeRealCall({ log = () => {}, label = '', sample = null } = {}) {
  const cfg = getConfig();
  if (cfg.cacheWarm?.enabled !== true) return { ok: false, reason: '未启用' };
  if (cfg.cacheWarm?.preCall === false) return { ok: false, reason: '调用前预热已关闭' };
  if (!lastRealSystemPrompt) return { ok: false, reason: '还没有真实前缀样本' };
  // 优先用调用方当场交回来的样本（并发安全）；没有才退回模块级单槽。
  const sampleBody = sample?.body || lastRealBody;
  const sampleApi = sample?.api || lastRealBodyApi;

  const now = Date.now();
  if (lastPreCallPrefix === lastRealSystemPrompt && now - lastPreCallWarmAt < PRE_CALL_MIN_GAP_MS) {
    return { ok: false, reason: `该前缀 ${Math.round((now - lastPreCallWarmAt) / 1000)} 秒前刚预热过` };
  }
  if (preCallInFlight) return preCallInFlight;   // 并发调用只发一次

  lastPreCallPrefix = lastRealSystemPrompt;
  lastPreCallWarmAt = now;
  preCallInFlight = (async () => {
    try {
      // ── 首选：原样复用真实调用的请求体与端点 ──
      // ⚠️ 两条实测教训（2026-09-20）：
      //   ① 只留「system + 一个句号」→ 预热自身只命中 2688（40%），等于没暖到；
      //      必须带上真实调用的完整 user 消息，才能落到高价值那一档。
      //   ② 尾部**不要**再加任何东西。实测对比过"尾部相同"与"尾部多个句号"，
      //      结果两者命中量完全一样（预热都 6784、真实都 8320）——说明服务商
      //      按前缀分档，尾部差异不影响；但**消息与真实调用完全一致**能保证
      //      两者共享同一份缓存档位，不再各占一档互相驱逐。
      //      所以这里逐字节复用真实消息，只改 max_tokens / temperature / thinking。
      if (sampleBody && sampleApi) {
        const warmBody = JSON.parse(JSON.stringify(sampleBody));
        const msgs = Array.isArray(warmBody.messages) ? warmBody.messages : [];
        // 逐字节复用真实消息（含 system + user），不增不减不做尾部替换 ——
        // 这是"与真实调用共享同一缓存档位"的唯一保证。
        if (!msgs.length) return { ok: false, reason: '没有可复用的消息' };
        // ⚠️ 关键：把**整份真实 body** 原样交给 llm 发送（sameBody），而不是只交
        //    messages/tools 让它重新构造。只交 messages 的话，核心会用
        //    temperature/maxTokens 两个入参再算一遍 buildBaseBody + 各 Skill 的
        //    request-params —— 得到的是**另一个 body**，与真实调用各占一个缓存
        //    档位并互相驱逐。实测：预热命中 2688 时，紧随其后的真实调用必然也是
        //    2688（31%），两者命运完全绑定，就是这个原因。
        //    现在唯一允许的差异是 max_tokens=1（只写缓存、不要它说话），它在
        //    messages 之后，不影响前缀哈希。
        const res = await chatCompletion({
          messages: msgs,
          tools: warmBody.tools || null,
          temperature: null,
          maxTokens: 1,
          sameBody: warmBody,
          tag: `warm${label ? ':' + label : ''}`,
          // 用真实调用用的那个端点（含账号池的决定），否则缓存键不同 —— 白写
          overrides: sampleApi
        });
        const acc = addUsage(emptyUsage(), res?.usage);
        // 带上会话 id：预热与真实调用必须能**精确配对**，否则只能靠时间戳猜。
        // 实测过这个坑：只按顺序配对时，出现过"预热 8537 / 真实 8546"这种
        // 差几个 token 的组合，无法判断是配对错了还是真的前缀不同。
        logger.info('cache-warm', `调用前预热完成${label ? ` [${label}]` : ''}（${acc.promptTokens} tok，命中 ${acc.cachedTokens}）`);
        return { ok: true, prompt: acc.promptTokens, cached: acc.cachedTokens, mode: 'reuse-real-body', label };
      }

      // ── 回退：用采集到的 system + tools 自建（启动初期还没跑过真实调用时）──
      let tools = [];
      try { tools = lastRealToolsJson ? JSON.parse(lastRealToolsJson) : []; } catch { tools = []; }
      const res = await chatCompletion({
        messages: [
          { role: 'system', content: lastRealSystemPrompt },
          { role: 'user', content: '。' }
        ],
        tools,
        maxTokens: 1,
        temperature: 0
      });
      const acc = addUsage(emptyUsage(), res?.usage);
      // ⚠️ 走 logger 而不是调用方传进来的 log：orchestrator 传的是
      //    skillManager.recordError(id, msg)，而它**每个 id 只保留最后一条消息**，
      //    连续两次预热会把第一条覆盖掉 —— 日志里就永远看不到预热成功。
      logger.info('cache-warm', `调用前预热完成（${acc.promptTokens} tok，命中 ${acc.cachedTokens}）[自建前缀]`);
      void log;
      return { ok: true, prompt: acc.promptTokens, cached: acc.cachedTokens, mode: 'built' };
    } catch (error) {
      // 预热失败绝不能影响真实调用 —— 只记一行
      logger.info('cache-warm', `调用前预热失败（忽略）：${error?.message ?? error}`);
      return { ok: false, reason: String(error?.message ?? error) };
    } finally {
      preCallInFlight = null;
    }
  })();
  return preCallInFlight;
}

/**
 * 构造一次保活请求的 { system, tools }。
 *
 * 优先用**真实运行采集到的**那份（保证逐字节一致）；还没采集到（例如刚启动、
 * 一次真实运行都没发生过）才回退到自行构造，并且此时**不发送** ——
 * 因为自行构造的前缀很可能与真实前缀不一致，发了也是白写缓存、还花钱。
 *
 * @returns {{system:string, tools:Array, source:'real'|'built'}}
 */
export function buildWarmPayload() {
  // ① 优先：真实运行采集到的（唯一能保证逐字节一致的来源）
  if (lastRealSystemPrompt) {
    let tools = [];
    try { tools = lastRealToolsJson ? JSON.parse(lastRealToolsJson) : []; } catch { tools = []; }
    return { system: lastRealSystemPrompt, tools, source: 'real' };
  }
  // ② 回退：自行构造（仅供诊断；warmOnce 会因 source !== 'real' 而跳过发送）
  const cfg = getConfig();
  const skillContext = warmContext();
  const system = buildSystemPrompt({
    skillContext,
    persona: personaForChat(skillContext.chatKey)
  });
  const toolsCfg = cfg.tools || {};
  const defs = buildToolDefs().filter((d) => getToolAvailability(d.id, {
    skills: skillManager,
    toolsCfg,
    visionEnabled: skillContext.visionEnabled,
    searchEnabled: skillContext.searchEnabled,
    runtimeContext: skillContext
  }).enabled);
  return { system, tools: toOpenAiTools(defs), source: 'built' };
}

/** 静默时段判断（quietHours 里的小时不发请求）。空数组 = 全天保活。 */
function inQuietHours(now = new Date()) {
  const q = getConfig().cacheWarm?.quietHours;
  if (!Array.isArray(q) || !q.length) return false;
  return q.map(Number).includes(now.getHours());
}

/**
 * 发一次保活请求。
 * @returns {{ok:boolean, reason?:string, cached?:number, prompt?:number}}
 */
export async function warmOnce({ log = () => {} } = {}) {
  const cfg = getConfig();
  if (cfg.cacheWarm?.enabled !== true) return { ok: false, reason: '未启用' };
  if (!String(cfg.api?.model || '').trim()) return { ok: false, reason: '模型未设置' };
  if (inQuietHours()) return { ok: false, reason: '静默时段' };

  let payload;
  try {
    payload = buildWarmPayload();
  } catch (error) {
    return { ok: false, reason: `构造前缀失败：${error?.message ?? error}` };
  }
  if (!payload.system) return { ok: false, reason: '系统提示为空' };
  // 没有真实样本就不发：自行构造的前缀很可能与真实调用不一致，
  // 发了只会白写一段没人读的缓存，还照样花掉输入 token。
  if (payload.source !== 'real') {
    return { ok: false, reason: '还没有真实运行可作为前缀样本（等下一次群消息后再保活）' };
  }

  const startedAt = Date.now();
  try {
    const res = await chatCompletion({
      messages: [
        { role: 'system', content: payload.system },
        // 尾部越短越省：这一句不参与缓存，只用来让请求合法。
        { role: 'user', content: '。' }
      ],
      tools: payload.tools,
      // 不让它思考、不要它输出：这只是"写缓存"的动作
      maxTokens: 1,
      temperature: 0
    });
    // ⚠️ chatCompletion 返回的 usage 是**服务端原始字段**（snake_case），
    //    不是项目内部的驼峰结构。必须走 addUsage 归一化 —— 直接读
    //    usage.cachedTokens 会永远拿到 0（曾经就这样白打了一版日志）。
    const acc = addUsage(emptyUsage(), res?.usage);
    const cached = acc.cachedTokens;
    const prompt = acc.promptTokens;
    const ms = Date.now() - startedAt;
    const rate = prompt ? (cached / prompt * 100).toFixed(0) : '?';
    log(`[cache-warm] 已保活前缀（${prompt} tok，命中 ${cached} = ${rate}%，${ms}ms）`);
    return { ok: true, cached, prompt, ms };
  } catch (error) {
    // 失败不抛出：保活是尽力而为的后台动作，绝不能影响主流程。
    // 但也不能静默 —— 一直失败说明配置有问题（Key 失效 / 余额不足），
    // 用户需要能在日志里看到。
    log(`[cache-warm] 保活失败（忽略，不影响使用）：${error?.message ?? error}`);
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/**
 * 启动保活循环。
 *
 * 配置热生效：每次 tick 都重新读 getConfig().cacheWarm.enabled ——
 * 用户在设置页打开/关闭开关后**不需要重启**，下一次 tick 就按新值走。
 * （定时器本身固定间隔创建；enabled 的判定放在 tick 里。）
 *
 * @returns {{stop:Function, warmNow:Function}} 句柄
 */
export function startCacheWarm(log = console.log) {
  let timer = null;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;      // 防重入：一次保活没跑完就别再发
    // 热读开关：关掉后不再发请求（但保留定时器，以便再次打开时立即生效）
    if (getConfig().cacheWarm?.enabled !== true) return;
    running = true;
    try { await warmOnce({ log }); }
    finally { running = false; }
  };

  const min = Math.max(1, Number(getConfig().cacheWarm?.intervalMin) || 10);
  // 把 tick 暴露给 noteRealPrompt：前缀一确定就补一次保活，不必等下一个整周期。
  cycleTick = tick;
  // 首次延迟 20 秒：避开启动高峰（与遥测的 90 秒同理，但保活要早点建立缓存）
  const first = setTimeout(() => { tick().catch(() => {}); }, 20000);
  first.unref?.();
  timer = setInterval(() => { tick().catch(() => {}); }, min * 60000);
  timer.unref?.();

  log(getConfig().cacheWarm?.enabled === true
    ? `[cache-warm] 前缀缓存保活已启用：每 ${min} 分钟一次`
    : '[cache-warm] 前缀缓存保活未启用（可在 设置 → 模型 API 打开）');

  return {
    stop: () => {
      stopped = true;
      cycleTick = null;
      clearTimeout(first);
      if (earlyWarmTimer) { clearTimeout(earlyWarmTimer); earlyWarmTimer = null; }
      if (timer) clearInterval(timer);
      timer = null;
    },
    warmNow: () => warmOnce({ log })
  };
}
