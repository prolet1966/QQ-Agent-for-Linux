// 表情包自动标注：给没有描述的表情补一句说明和标签。
//
// ── 解决什么问题 ──────────────────────────────────────────────────────
// `collect_sticker` 原本只让模型写一句备注，没有结构化描述，导致新收的表情
// 在 `list_stickers` 搜索里命中率低、模型也不知道它到底表达什么情绪 ——
// 结果就是收藏了一堆表情却几乎不用。
// 本 Skill 看图产出 `{ desc, note, tags }`：描述用于搜索匹配，标签用于语义检索。
//
// ── 为什么是 Skill ────────────────────────────────────────────────────
// 它要花额外的视觉模型调用（有成本），而且没有视觉模型的用户完全用不上。
// 做成默认关闭的 Skill：需要的人点开，其他人零影响。
//
// ── 队列为什么要串行 ──────────────────────────────────────────────────
// 并发标注会同时打多个视觉请求，抢占正在进行的聊天请求的额度与带宽 ——
// 表现就是"标注的时候机器人变迟钝"。所以并发度固定为 1，宁可慢也不抢。
//
// ── 与社区版的关键差异 ────────────────────────────────────────────────
// 社区版直接用 `cfg.api.apiKey` 发裸 fetch。本项目里 API Key 可能**不在** api.apiKey 上，
// 而是在 providers[] / dshProviderKeys（多提供商目录）里 —— 那种情况下裸 fetch 会 401。
// 所以这里统一走核心的 chatCompletion：它负责 key 解析、超时、重试，
// 以及"有图片时切到 visionModel"（我们刚补上的能力）。
// 这也顺带让标注请求和聊天请求走同一条可观测链路。

import fs from 'node:fs';
import path from 'node:path';
import { chatCompletion } from '../../src/llm.js';

let cfg = () => ({});
let log = () => {};

/** 系统提示：要求严格 JSON，字段顺序固定（顺序固定能让输出更稳定、更好解析）。 */
const SYS = '你在为一个QQ群聊机器人整理表情包库。看这张表情图，输出严格 JSON，不要 markdown 代码块，字段顺序固定：'
  + '{"desc":"6字以内的中文短标签","note":"一句话说明它表达什么情绪/什么场合用","tags":["3-6个中文关键词"]}';

const queue = [];
let running = 0;
const MAX_CONCURRENT = 1;   // 串行：不抢占聊天请求

/** 从扩展名猜 mime。拿不到 content-type 时的兜底。 */
function mimeOf(p) {
  const e = String(p || '').toLowerCase();
  if (e.endsWith('.gif')) return 'image/gif';
  if (e.endsWith('.png')) return 'image/png';
  if (e.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

/**
 * 把图片读成 base64 data URL。本地文件优先，否则按 http(s) 抓。
 *
 * 走 safe-fetch 校验而不是裸 fetch：src 可能来自 QQ CDN 上的表情图地址，
 * 属于**群友可影响**的输入，裸 fetch 会变成 SSRF 通道。
 */
async function loadImage(src) {
  const s = String(src || '');
  if (/^https?:\/\//i.test(s)) {
    const { validateImageUrl, safeFetchBinary } = await import('../../src/safe-fetch.js');
    const safeUrl = await validateImageUrl(s);
    const { buffer, contentType } = await safeFetchBinary(safeUrl);
    if (!buffer || buffer.length < 200) throw new Error(`图片过小或无内容（${buffer?.length || 0}B）`);
    const ct = String(contentType || '').split(';')[0].trim();
    return { b64: buffer.toString('base64'), mime: ct.startsWith('image/') ? ct : mimeOf(s), bytes: buffer.length, buf: buffer };
  }
  if (!fs.existsSync(s)) throw new Error('本地文件不存在');
  const buf = fs.readFileSync(s);
  if (buf.length < 200) throw new Error(`图片过小（${buf.length}B）`);
  return { b64: buf.toString('base64'), mime: mimeOf(s), bytes: buf.length, buf };
}

/** 调视觉模型打标。返回 { desc, note, tags } 或抛错。 */
async function caption(b64, mime) {
  const c = cfg();
  const r = await chatCompletion({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: SYS },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
      ]
    }],
    temperature: 0.2,
    overrides: { timeoutMs: Math.max(5000, Number(c.timeoutMs) || 120000) }
  });

  const txt = String(r?.message?.content ?? '').trim()
    .replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      return normalize(o);
    } catch { /* 落到下面的截断兜底 */ }
  }
  // 截断兜底：模型有时写一半被 token 上限切断，逐字段正则捞回来，
  // 总比整条标注失败强（desk/note 通常在前半段就写完了）。
  const g = (re) => { const x = txt.match(re); return x ? x[1] : ''; };
  const desc = g(/"desc"\s*:\s*"([^"]*)"/);
  const note = g(/"note"\s*:\s*"([^"]*)"/);
  const tagsRaw = g(/"tags"\s*:\s*\[([^\]]*)/);
  if (desc || note) {
    return normalize({
      desc,
      note,
      tags: tagsRaw ? tagsRaw.split(',').map((t) => t.replace(/["\s]/g, '')).filter(Boolean) : []
    });
  }
  throw new Error('模型未返回可解析的 JSON');
}

/** 夹断各字段长度：描述太长会污染搜索结果，标签太多等于没标签。 */
function normalize(o) {
  return {
    desc: String(o?.desc ?? '').trim().slice(0, 20),
    note: String(o?.note ?? '').trim().slice(0, 120),
    tags: Array.isArray(o?.tags)
      ? [...new Set(o.tags.map((t) => String(t).trim().slice(0, 12)).filter(Boolean))].slice(0, 8)
      : []
  };
}

async function runOne(job) {
  const { id, src, onDone } = job;
  try {
    const img = await loadImage(src);
    const cap = await caption(img.b64, img.mime);
    onDone?.(null, { ...cap, bytes: img.bytes, buf: img.buf });
    log(`标注完成 ${id}：${cap.desc} [${cap.tags.join('/')}]`);
  } catch (error) {
    onDone?.(error);
    log(`标注失败 ${id}：${error?.message ?? error}`);
  }
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running++;
    runOne(job).finally(() => { running--; pump(); });
  }
}

/**
 * 排队一个标注任务（不阻塞调用方）。
 * @param {{id:string, src:string, onDone:(err:Error|null, result?:object)=>void}} job
 * @returns {boolean} 是否入队（队列未启用时返回 false）
 */
export function queueAnnotation(job) {
  if (!job?.src) return false;
  queue.push(job);
  pump();
  return true;
}

/** 队列状态（UI 显示"还剩几张"）。 */
export function queueState() {
  return { pending: queue.length, running };
}

// ── Skill 生命周期 ────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;

  // 本模块在 skills/ 下 = LLM 型：必须有工具，否则模型看不见它、功能永远不触发。
  // （sticker.annotate / sticker.annotate-batch 能力保留，供别的模块软依赖。）
  api.registerTool({
    id: 'annotate_image',
    name: '看图打标注',
    description: '用视觉模型看清一张图的内容，返回描述与标签。当用户发来图片问"这是什么/图里有什么/什么梗"，或要求"给这张表情包加备注"时使用。',
    category: 'media',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片地址（http/https）或本地路径。与 stickerId 二选一。' },
        stickerId: { type: 'string', description: '表情包库里的 id。与 url 二选一；给了它就能顺便把结果写回备注。' },
        save: { type: 'boolean', description: '是否把结果写回表情包备注（需要 stickerId）。默认 false。' }
      }
    },
    async execute(ctx, args) {
      try {
        let src = String(args?.url || '').trim();
        const stickerId = String(args?.stickerId || '').trim();

        // 没给 url 就从表情库取：省得模型去翻 list_stickers 再抄一遍地址
        if (!src && stickerId) {
          const sticker = await ctx?.stickers?.find?.(stickerId);
          if (!sticker) return { content: `表情库里找不到 ${stickerId}`, isError: true };
          src = String(sticker.url || '').trim();
        }
        if (!src) return { content: '需要提供 url 或 stickerId', isError: true };

        // 走能力取用（本模块自己提供 sticker.annotate）：
        // 保证打标逻辑只有一份实现，也让能力有真实消费方。
        const r = await (api?.capability ? api.capability('sticker.annotate', { id: stickerId, src }) : undefined)
          || await providers['sticker.annotate']({ id: stickerId, src });
        if (!r?.ok) return { content: `打标失败：${r?.error || '未知原因'}`, isError: true };

        let saved = false;
        if (args?.save === true && stickerId) {
          // applyStickerNote 只认 note / tags / usage —— 别把 desc 当 note 之外的东西传
          const entry = ctx?.stickers?.note?.(stickerId, { note: r.note || r.desc || '', tags: r.tags || [], source: 'ai' });
          saved = Boolean(entry);
        }

        const lines = [`描述：${r.desc || '（无）'}`];
        if (r.note) lines.push(`备注：${r.note}`);
        if (Array.isArray(r.tags) && r.tags.length) lines.push(`标签：${r.tags.join('、')}`);
        if (saved) lines.push('（已写回表情库备注）');
        return { content: lines.join('\n') };
      } catch (error) {
        return { content: `打标失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

export const providers = {
  /**
   * 标注一张图。本模块的**工具**与外部模块都通过这个能力取用。
   * 输入 { id, src } → { ok, desc, note, tags, bytes } 或 { ok:false, error }
   */
  'sticker.annotate': async ({ id, src } = {}) => {
    try {
      const img = await loadImage(src);
      const cap = await caption(img.b64, img.mime);
      return { ok: true, ...cap, bytes: img.bytes };
    } catch (error) {
      log(`标注失败：${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
};

/**
 * 批量标注（串行、限量）。
 *
 * 注意：它**不是**能力，而是普通导出 —— 因为目前没有消费方
 * （原注释说"用于设置页的一键补备注"，但设置页并没有那个按钮）。
 * 声明成能力却没人取用会被审计判为"孤儿"，也会让人误以为有现成接口。
 * 将来要接 UI 时，再在清单里补 capabilities 并接线。
 */
export async function annotateBatch({ items = [], onProgress } = {}) {
  const c = cfg();
  const limit = Math.max(1, Math.min(50, Number(c.maxPerRun) || 10));
  const list = (Array.isArray(items) ? items : []).slice(0, limit);
  const done = [];
  const failed = [];
  for (const it of list) {
    const r = await providers['sticker.annotate']({ id: it.id, src: it.src });
    if (r.ok) done.push({ id: it.id, ...r });
    else failed.push({ id: it.id, error: r.error });
    try { onProgress?.({ total: list.length, done: done.length, failed: failed.length, id: it.id }); } catch { /* ignore */ }
  }
  return { ok: true, annotated: done, failed, total: list.length };
}

export function available() {
  // 严格说还需要一个支持看图的模型；但"模型支不支持图片"由核心的 vision 判定负责，
  // 这里只检查最基本的配置，避免把判定逻辑重复一份。
  return { ok: true };
}

export function promptSections() {
  return [{
    id: 'sticker-annotate-note',
    title: '表情包库',
    priority: 30,
    content: '表情包的备注与标签是由视觉模型看图生成的，可能不完全贴合你的理解。挑选时以备注描述的情绪为准，不确定就先看一眼图。'
  }];
}

export const internals = {
  queueAnnotation, queueState, loadImage, caption, normalize,
  __resetQueue: () => { queue.length = 0; running = 0; }
};
