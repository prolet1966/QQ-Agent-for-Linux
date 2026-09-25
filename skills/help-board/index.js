// 指令一览面板 —— /help 时把所有插件的能力汇总成一张图发到群里。
//
// ── 面板上到底列什么 ────────────────────────────────────────────────────
//   光列"注册的工具"是不完整的。这个系统里其实有三类东西，
//   而群友不看文档根本发现不了后两类：
//
//   ① 指令（工具）—— listTools() 能拿到，模型可主动调用。
//      但只知道名字没用，得知道**怎么说**才会触发。
//      → 从清单的 prompt.when / prompt.examples 里挖触发话术，标在每条下面。
//
//   ② 自动功能（没有指令）—— 只声明了 capabilities 的插件，
//      比如 media-download（发 B站/抖音链接自动下载）、speech-to-text（语音转文字）、
//      red-packet-radar（红包雷达）。它们压根不注册工具，listTools() 里永远查不到，
//      但确实是机器人"会干的事"。
//      → 单独一个「自动生效」区，并标明当前是否已启用。
//
//   ③ 未启用的插件 —— 装了但没开，开了才有。也标出来，省得以为没有。
//
// ── "图"怎么来 ────────────────────────────────────────────────────────
//   项目里没有任何图像库（sharp/canvas/jimp 都没装），但它是 Electron 应用：
//   主进程开一个隐藏 BrowserWindow 加载 HTML，用 Chromium 把中文排好版，
//   再 capturePage 截图成 PNG —— 中文渲染、自动换行、emoji 全都白拿。
//   拿不到 Electron（或截图失败）时降级为文字列表，保证 /help 永远有回应。
//
// ── 想给别的插件补"怎么说" ──────────────────────────────────────────────
//   新格式插件的清单里没有 prompt.when，自动挖不出来。这时改本插件**自己的**
//   配置文件即可（不碰别人的文件）：<DATA_DIR>/skills/help-board/triggers.json
//      { "weather-alert": { "when": "问台风/暴雨预警", "examples": ["台风预警"] } }
//   键可以是插件 id（对该插件全部指令生效），也可以是完整工具 id
//   （形如 weather-alert__weather_alert，只对这一条生效）。
//
// ⚠️ 全程只读：import 核心模块 + 扫描 skills/ plugins/ 目录，不写任何已有文件。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { listTools } from '../../src/tool-registry.js';
import { DATA_DIR } from '../../src/config.js';

let cfg = () => ({});
let log = () => {};

/** 项目根目录（本文件在 <ROOT>/skills/help-board/ 下）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 本插件的数据目录：截图与触发词配置都放这里，多实例不会互相覆盖。 */
const OUT_DIR = path.join(DATA_DIR, 'skills', 'help-board');
const TRIGGER_FILE = path.join(OUT_DIR, 'triggers.json');

/** 没有图标的"自动功能"按能力前缀猜一个 icon。 */
const CAP_ICONS = [
  [/^media\.transcribe$/, '🎙️'],
  [/^media\.download$/, '🔗'],
  [/^media\./, '🎬'],
  [/^video\./, '🎞️'],
  [/^memory\./, '🧠'],
  [/^image\./, '🖼️'],
  [/^sticker\./, '😀'],
  [/^message\.owner/, '👑'],
  [/^message\./, '💬'],
  [/^(llm|reply|model)\./, '⚙️']
];

/** 纯基建、群友感知不到的插件，默认不出现在面板里（可在设置里改）。 */
const DEFAULT_PASSIVE_EXCLUDE = [
  'ban-state', 'image-compat', 'thinking-adapters', 'reply-safety',
  'account-pool', 'speaker-identity', 'conversation-memory'
];

// ── 纯函数（便于测试） ────────────────────────────────────────────────────

/** HTML 转义：说明是自由文本，直接拼进 HTML 会被标签/引号搞坏。 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 说明文字压缩到一句：先按句号/分号切，再按字数硬截。 */
export function shorten(desc, max = 42) {
  const s = String(desc ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const first = (s.split(/[。；;！!？?]/).find((x) => x.trim()) || s).trim();
  const lim = Math.max(6, Number(max) || 42);
  return first.length > lim ? `${first.slice(0, lim)}…` : first;
}

/**
 * 扫描 skills/ 与 plugins/ 的全部清单。
 * → Map<id, {id,name,dir,description,capabilities,toolIds,prompt,enabledByDefault}>
 */
export function loadManifests(root = ROOT) {
  const map = new Map();
  for (const dir of ['skills', 'plugins']) {
    const base = path.join(root, dir);
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;                                   // 目录不存在（打包场景）→ 跳过
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      for (const file of ['skill.json', 'plugin.json']) {
        let raw = null;
        try {
          raw = JSON.parse(fs.readFileSync(path.join(base, e.name, file), 'utf8'));
        } catch {
          continue;                               // 换下一个文件名继续试
        }
        if (!raw?.id) continue;
        const prompt = raw.prompt ?? {};
        map.set(String(raw.id), {
          id: String(raw.id),
          name: String(raw.name || raw.id),
          dir,
          folder: e.name,
          description: String(raw.description ?? ''),
          capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.map(String) : [],
          toolIds: Array.isArray(raw.tools) ? raw.tools.map((t) => String(t?.id ?? '')).filter(Boolean) : [],
          prompt: {
            when: typeof prompt.when === 'string' ? prompt.when : '',
            examples: Array.isArray(prompt.examples) ? prompt.examples.map(String) : [],
            hasSections: Array.isArray(prompt.sections) && prompt.sections.length > 0
          },
          enabledByDefault: raw.enabledByDefault !== false
        });
        break;
      }
    }
  }
  return map;
}

/** 老版本兼容：只要 id -> 显示名。 */
export function loadSkillNames(root = ROOT) {
  const map = new Map();
  for (const m of loadManifests(root).values()) map.set(m.id, m.name);
  return map;
}

/** "当用户问天气、气温…时" → "问天气、气温…"。给群友看的要像人话。 */
export function cleanWhen(s) {
  let t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t.replace(/^当(用户|你|有人)?/, '').replace(/^如果/, '');
  t = t.replace(/(的时候|时)$/, '');
  return t.trim();
}

/** 从清单里挖"怎么说"：触发条件 + 示例话术。 */
export function extractTriggers(manifest) {
  const p = manifest?.prompt ?? {};
  return {
    when: cleanWhen(p.when),
    examples: (p.examples || []).map((x) => String(x).trim()).filter(Boolean)
  };
}

/** 合并两处触发信息：手动配置优先，清单兜底。 */
export function mergeTriggers(manual, fromManifest) {
  const when = String(manual?.when ?? '') || String(fromManifest?.when ?? '');
  const ex = Array.isArray(manual?.examples)
    ? manual.examples.map(String).filter(Boolean)
    : (fromManifest?.examples ?? []);
  return { when: String(when).trim(), examples: ex };
}

/** 读取手动补充的触发词配置（本插件自己的文件，不是别人的清单）。 */
export function loadTriggerOverrides(file = TRIGGER_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('_')) continue;            // _说明 之类的是注释键
      if (!v || typeof v !== 'object') continue;
      out[k] = {
        when: String(v.when ?? '').trim(),
        examples: Array.isArray(v.examples) ? v.examples.map(String).filter(Boolean) : []
      };
    }
    return out;
  } catch {
    return {};                                   // 没这个文件很正常
  }
}

/** 首次运行时放一份带例子的模板，方便用户照着给别的插件补触发词。 */
export function seedTriggerFile(file = TRIGGER_FILE, force = false) {
  if (!force && fs.existsSync(file)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sample = {
      '_说明': '给任意插件补一句「怎么说」：键可以是插件 id（weather-alert，对该插件全部指令生效），也可以是完整工具 id（weather-alert__weather_alert，只对这一条生效）。examples 留空数组表示只显示 when。键以 _ 开头的是注释，不会被读取。删掉本文件不影响运行。',
      'check-in': { 'when': '说「打卡」', 'examples': ['打卡', '签到'] },
      'weather-alert': { 'when': '问台风 / 寒潮 / 暴雨 / 高温预警', 'examples': ['台风预警', '本地有预警吗'] },
      'keyword-reply': { 'when': '消息里出现设置里配好的关键词', 'examples': [] },
      'image-generate': { 'when': '让我画张图、来张图', 'examples': ['画一只在太空喝咖啡的猫', '来张赛博朋克城市'] },
      'random-image': { 'when': '要二次元图 / 随机图', 'examples': ['来张二次元图', '随机来几张'] },
      'reverse-image': { 'when': '问一张图是谁、出自哪', 'examples': ['这图出自哪里', '查一下这个表情'] },
      'knowledge-memes': { 'when': '冒出新梗、想存点东西', 'examples': ['记个梗：xxx', '这个梗记一下'] },
      'memory-recall': { 'when': '提起很久以前聊过的事', 'examples': ['上次我们聊的那个…', '你还记得吗'] }
    };
    fs.writeFileSync(file, `${JSON.stringify(sample, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 把已注册的工具按所属插件分组，并挂上"怎么说"。
 * 纯函数，便于测试。
 */
export function buildGroups(tools, manifests = new Map(), opts = {}) {
  const {
    includeBuiltin = true,
    exclude = [],
    maxDescLen = 42,
    maxTriggers = 2,
    triggerLen = 18,
    overrides = {},
    iconById = {}
  } = opts;

  const groups = new Map();
  for (const t of tools || []) {
    const sid = String(t?.skillId ?? '');
    if (exclude.includes(sid)) continue;
    if (!sid && !includeBuiltin) continue;
    const key = sid || '__builtin__';
    if (!groups.has(key)) {
      const m = manifests.get(sid);
      groups.set(key, {
        skillId: sid,
        skillName: sid ? (m?.name || sid) : '内置功能',
        items: []
      });
    }
    const g = groups.get(key);
    const m = manifests.get(sid);
    // 触发词查找顺序：完整工具 id（精确到一条）→ 插件 id（该插件全部指令共用）
    const manual = overrides[String(t.id)] || overrides[sid] || null;
    const merged = mergeTriggers(manual, extractTriggers(m));
    g.items.push({
      id: String(t?.id ?? ''),
      icon: String(t?.icon ?? '🔧') || '🔧',
      name: String(t?.name ?? t?.id ?? ''),
      desc: shorten(t?.description, maxDescLen),
      when: shorten(merged.when, triggerLen + 12),
      examples: merged.examples.slice(0, Math.max(0, Number(maxTriggers) || 0))
        .map((x) => shorten(x, triggerLen))
    });
  }

  // 同一张卡里多条指令共用一套触发词时，只在第一条下面显示，避免重复刷屏
  for (const g of groups.values()) {
    if (g.items.length < 2) continue;
    const sig = (i) => `${i.when}|${i.examples.join('|')}`;
    if (!g.items.every((i) => sig(i) === sig(g.items[0]) && sig(i))) continue;
    for (let k = 1; k < g.items.length; k += 1) {
      g.items[k].when = '';
      g.items[k].examples = [];
    }
  }
  return [...groups.values()];
}

/**
 * 收集"没有指令、但会自己触发"的插件 —— listTools() 里永远查不到的那一批。
 * 纯函数，便于测试。
 */
export function collectPassive(manifests = new Map(), hasTools = new Set(), opts = {}) {
  const {
    exclude = DEFAULT_PASSIVE_EXCLUDE,
    include = [],
    maxDescLen = 42,
    iconOverrides = {}
  } = opts;
  const out = [];
  for (const m of manifests.values()) {
    if (hasTools.has(m.id)) continue;             // 有指令的已经进第一区了
    if (exclude.includes(m.id) && !include.includes(m.id)) continue;
    // 既不声明能力、也没有任何提示词/说明的，多半是空壳目录，跳过
    if (!m.capabilities.length && !m.prompt.hasSections && !m.description) continue;
    const cap = m.capabilities[0] ?? '';
    const hit = CAP_ICONS.find(([re]) => re.test(cap));
    out.push({
      id: m.id,
      icon: iconOverrides[m.id] || (hit ? hit[1] : '⚙️'),
      name: m.name,
      desc: shorten(m.description, maxDescLen),
      capabilities: m.capabilities,
      enabledByDefault: m.enabledByDefault
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/** 生成面板 HTML（浅色卡片，两列网格；QQ 聊天背景是浅色，比深色耐看）。 */
export function buildBoardHtml(opts = {}) {
  const {
    title = '功能指令一览',
    subtitle = '',
    groups = [],
    passive = [],
    width = 760,
    showState = true
  } = opts;
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  const trigHtml = (i) => {
    if (!i.when && !i.examples.length) return '';
    const bits = [];
    if (i.when) bits.push(`<span class="tw"><i>说</i>${escapeHtml(i.when)}</span>`);
    for (const ex of i.examples) bits.push(`<span class="tq">“${escapeHtml(ex)}”</span>`);
    return `<div class="trg">${bits.join('')}</div>`;
  };

  const cards = groups.map((g) => `
    <section class="card">
      <h2>${escapeHtml(g.skillName)}<span class="cnt">${g.items.length}</span></h2>
      <ul>${g.items.map((i) => `
        <li>
          <span class="ic">${escapeHtml(i.icon)}</span>
          <div class="txt"><b>${escapeHtml(i.name)}</b>${i.desc ? `<span class="d">${escapeHtml(i.desc)}</span>` : ''}${trigHtml(i)}</div>
        </li>`).join('')}
      </ul>
    </section>`).join('');

  const passiveCards = passive.map((p) => `
    <section class="card auto">
      <h2>${escapeHtml(p.icon)} ${escapeHtml(p.name)}${showState ? `<span class="st ${p.active === false ? 'off' : 'on'}">${p.active === false ? '未启用' : '已启用'}</span>` : ''}</h2>
      <p class="d">${escapeHtml(p.desc || '满足条件时自动生效，不需要下指令。')}</p>
    </section>`).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: ${width}px; background: #f4f6fb; font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif; color: #1f2430; }
  .wrap { padding: 26px 26px 20px; }
  .head { background: linear-gradient(135deg, #4a7cff, #6f5bff); border-radius: 16px; padding: 20px 24px; color: #fff; margin-bottom: 18px; }
  .head h1 { font-size: 26px; font-weight: 700; letter-spacing: 1px; }
  .head p { margin-top: 6px; font-size: 14px; opacity: .9; }
  .sec { font-size: 15px; font-weight: 700; color: #2b3350; margin: 4px 0 10px; display: flex; align-items: center; gap: 8px; }
  .sec em { font-style: normal; font-size: 12px; font-weight: 400; color: #8b93ad; }
  .sec.mt { margin-top: 20px; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .card { background: #fff; border-radius: 14px; padding: 14px 16px; box-shadow: 0 2px 10px rgba(31,36,48,.07); }
  .card h2 { font-size: 16px; color: #2b3350; display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .cnt { font-size: 12px; font-weight: 400; color: #fff; background: #8b93ad; border-radius: 10px; padding: 1px 8px; }
  ul { list-style: none; }
  li { display: flex; gap: 9px; padding: 6px 0; border-top: 1px dashed #e8ebf3; }
  li:first-child { border-top: none; }
  .ic { font-size: 16px; line-height: 1.4; }
  .txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .txt b { font-size: 14px; font-weight: 600; color: #232a3d; }
  .txt .d { font-size: 12px; color: #7b8499; line-height: 1.45; word-break: break-all; }
  .trg { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
  .tw, .tq { font-size: 11px; line-height: 1.5; border-radius: 6px; padding: 1px 7px; color: #4a7cff; background: #eef3ff; }
  .tw i { font-style: normal; opacity: .65; margin-right: 4px; }
  .tq { color: #2f8f6b; background: #eaf7f1; }
  .card.auto { background: #fffaf0; border: 1px dashed #f0d9a8; }
  .card.auto .d { font-size: 12px; color: #8a7a5c; line-height: 1.5; }
  .st { font-size: 11px; font-weight: 400; border-radius: 10px; padding: 1px 8px; }
  .st.on { color: #2f8f6b; background: #e6f6ee; }
  .st.off { color: #a08b7a; background: #f3ece2; }
  .foot { margin-top: 16px; text-align: center; font-size: 12px; color: #98a0b3; }
</style></head>
<body><div class="wrap">
  <div class="head"><h1>${escapeHtml(title)}</h1><p>${groups.length} 个插件 · ${total} 条指令${passive.length ? ` · ${passive.length} 项自动功能` : ''}</p></div>
  ${groups.length ? `<div class="sec">可以这样使唤我 <em>照着下面这些话说就行</em></div>
  <div class="grid">${cards}</div>` : ''}
  ${passive.length ? `<div class="sec mt">不用你下指令，自己会跑 <em>条件满足就触发，有些需要去设置里开启</em></div>
  <div class="grid">${passiveCards}</div>` : ''}
  <div class="foot">${escapeHtml(subtitle)}</div>
</div></body></html>`;
}

/** 纯文字版列表（截图不可用时用）。 */
export function buildText(opts = {}) {
  const { groups = [], passive = [], subtitle = '', showState = true } = opts;
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const lines = [];
  for (const g of groups) {
    const parts = g.items.map((i) => {
      const t = [i.when, ...i.examples].filter(Boolean).join('；');
      return t ? `${i.name}（${t}）` : i.name;
    });
    lines.push(`【${g.skillName}】${parts.join('、')}`);
  }
  for (const p of passive) {
    const st = showState ? (p.active === false ? '（未启用）' : '') : '';
    lines.push(`【自动】${p.name}${st}：${p.desc}`);
  }
  return `功能指令一览（${groups.length} 个插件 / ${total} 条指令${passive.length ? ` / ${passive.length} 项自动功能` : ''}）：\n${lines.join('\n')}${subtitle ? `\n${subtitle}` : ''}`;
}

// ── 截图（Electron）──────────────────────────────────────────────────────

/**
 * 用 Electron 的隐藏窗口把 HTML 渲染成 PNG Buffer。
 * 拿不到 Electron 或中途出错一律抛错 —— 由调用方决定降级。
 */
async function renderPng(html, width) {
  const req = createRequire(import.meta.url);
  let electron = null;
  try {
    electron = req('electron');
  } catch (error) {
    throw new Error(`当前进程不是 Electron 主进程，无法渲染图片（${error?.message ?? error}）`);
  }
  const { BrowserWindow } = electron;
  if (!BrowserWindow) throw new Error('Electron 未提供 BrowserWindow');

  const w = Math.max(480, Number(width) || 760);
  // 两种窗口配置各试一次：不同 Electron 版本对"隐藏窗口能否截图"支持并不一致
  // （有的版本 offscreen 才画得出来，有的版本开了 offscreen 反而是白图）。
  const attempts = [{ offscreen: false }, { offscreen: true }];
  let lastError = null;

  for (const pref of attempts) {
    let win = null;
    try {
      win = new BrowserWindow({
        show: false,
        width: w,
        height: 600,
        backgroundColor: '#f4f6fb',
        webPreferences: { ...pref, backgroundThrottling: false }
      });
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('渲染超时')), 15000));
      const buf = await Promise.race([
        (async () => {
          await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
          const h = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
          win.setSize(w, Math.min(Math.max(Number(h) || 600, 200), 6000));
          await new Promise((r) => setTimeout(r, 150));   // 给重排一点时间
          const img = await win.webContents.capturePage();
          return img.toPNG();
        })(),
        timeout
      ]);
      // 过小的 PNG 基本都是空白图（隐藏窗口没画出来），换下一种配置重试
      if (buf && buf.length > 2000) return buf;
      lastError = new Error(`截图为空白（${buf?.length ?? 0} 字节）`);
    } catch (error) {
      lastError = error;
    } finally {
      try { win?.destroy(); } catch { /* 窗口已经没了 */ }
    }
  }
  throw lastError || new Error('渲染失败');
}

// ── Skill 生命周期 ────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;

  api.registerTool({
    id: 'help_board',
    name: '指令一览',
    description: '扫描所有已启用插件的指令与自动生效的能力，生成一张功能一览图发到群里。群友输入 /help、帮助、菜单或问你能做什么时调用。',
    category: 'system',
    icon: '🧭',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '调用原因（可选，仅用于日志）' }
      }
    },
    async execute(ctx, args) {
      try {
        const c = cfg();
        const exclude = c.excludeSelf !== false ? ['help-board'] : [];
        const manifests = loadManifests();
        const tools = listTools();
        const hasTools = new Set(tools.map((t) => String(t?.skillId ?? '')).filter(Boolean));

        if (c.seedTriggers !== false) {
          if (seedTriggerFile()) log(`已生成触发词配置文件：${TRIGGER_FILE}`);
        }

        const groups = buildGroups(tools, manifests, {
          includeBuiltin: c.includeBuiltin !== false,
          exclude,
          maxDescLen: c.maxDescLen ?? 42,
          maxTriggers: c.maxTriggers ?? 2,
          triggerLen: c.triggerLen ?? 18,
          overrides: c.showTriggers === false ? {} : loadTriggerOverrides()
        });

        // 自动功能：没有注册任何指令、但会自己触发的插件
        let passive = [];
        if (c.showPassive !== false) {
          passive = collectPassive(manifests, hasTools, {
            exclude: Array.isArray(c.passiveExclude) ? c.passiveExclude : DEFAULT_PASSIVE_EXCLUDE,
            include: Array.isArray(c.passiveInclude) ? c.passiveInclude : [],
            maxDescLen: c.maxDescLen ?? 42,
            iconOverrides: c.passiveIcons ?? { 'red-packet-radar': '🧧' }
          });
          if (c.showState !== false) {
            for (const p of passive) {
              try {
                p.active = api.isSkillActive ? api.isSkillActive(p.id, {}) : p.enabledByDefault;
              } catch {
                p.active = p.enabledByDefault;
              }
            }
            if (c.hideInactivePassive === true) passive = passive.filter((p) => p.active !== false);
          }
        }

        if (!groups.length && !passive.length) return { content: '当前没有任何已启用的插件提供功能。' };

        // ① 先试图片
        try {
          const html = buildBoardHtml({
            title: c.title || '功能指令一览',
            subtitle: c.subtitle || '',
            groups,
            passive,
            width: c.width ?? 760,
            showState: c.showState !== false
          });
          const buf = await renderPng(html, c.width ?? 760);
          fs.mkdirSync(OUT_DIR, { recursive: true });
          const file = path.join(OUT_DIR, 'help-board.png');
          fs.writeFileSync(file, buf);
          await ctx.onebot.sendImage(ctx.kind, ctx.chatId, file);
          const total = groups.reduce((n, g) => n + g.items.length, 0);
          log(`已发送功能一览图：${groups.length} 个插件 / ${total} 条指令 / ${passive.length} 项自动功能（${args?.reason ?? '未注明原因'}）`);
          return { content: `功能一览图已发出（${groups.length} 个插件 / ${total} 条指令 / ${passive.length} 项自动功能）。不要再复述一遍列表。` };
        } catch (renderError) {
          log(`图片渲染失败，降级为文字：${renderError?.message ?? renderError}`);
          if (c.textFallback === false) throw renderError;

          // ② 降级：文字列表
          const text = buildText({ groups, passive, subtitle: c.subtitle || '', showState: c.showState !== false });
          await ctx.sender.sendTextBatch(ctx.chatKey, [text]);
          return { content: `当前环境不支持生成图片，已改为发送文字版一览：\n${text}\n不要再复述一遍。` };
        }
      } catch (error) {
        return { content: `生成功能一览失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

export function available() { return true; }

export const internals = {
  escapeHtml, shorten, loadManifests, loadSkillNames, cleanWhen, extractTriggers,
  mergeTriggers, loadTriggerOverrides, seedTriggerFile, buildGroups, collectPassive,
  buildBoardHtml, buildText, renderPng, ROOT, OUT_DIR, TRIGGER_FILE, DEFAULT_PASSIVE_EXCLUDE
};
