// image-gen-skill —— LLM 型技能：检索增强生图（宿主 image-gen.js generate_image 的 searchFirst 增强）
//
// 与 V0.3.1 既有 skills/image-generate（工具 image-generate__draw，纯生图）的边界：
//   - 本技能工具 id = generate_image_search_first
//   - 定位：现实/具体画面（人物/事件/作品）先查清事实要素，产出一段「事实校准后的提示词」，
//     再用它去调既有 image-generate 工具出图（模型自行调 image-generate__draw）
//   - 纯虚构/风格化创作 → 直接用 image-generate__draw，不用本工具
//
// 软依赖：
//   - api.capability('search.aggregate')（plugins/search-aggregator）：缺了逐字节退回「不检索、原样提示词」
//     （宿主 searchFirst 降级路径照搬）
//   - 生图本身不依赖 image.generate 能力（V0.3.1 没把它做成 provider），而是让模型接着调
//     既有 image-generate__draw 工具。本工具只负责「先检索 + 校准提示词」这一段。

export function setup(api) {
  let cfg = () => ({});
  const searchAggFn = api.capability('search.aggregate');   // 软依赖，缺了直接返回原提示词
  cfg = api.config;
  const ok = (data) => ({ content: typeof data === 'string' ? data : JSON.stringify(data, null, 2) });
  const err = (msg) => ({ content: msg, isError: true });

  api.registerTool({
    id: 'generate_image_search_first',
    name: '检索校准生图提示词',
    description: '先联网检索再生图提示词：把画面里的事实要素（XX 是什么/长什么样/有什么特征）用聚合搜索查清，产出一段事实校准后的提示词，再用它去调既有「生成图片」工具（image-generate__draw）出图。群友要求画「现实里存在的人物/事件/作品/场景」时用（避免生错）；纯虚构创作/风格化二创直接调生成图片工具，不用本工具。本工具只产出提示词，不自己出图。',
    category: 'media',
    icon: '🖼️',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述：主体、场景、动作、光线、构图（越具体越好）' },
        style: { type: 'string', description: '画风（写实/插画/水彩…）' },
      },
      required: ['prompt'],
    },
    async execute(ctx, args) {
      try {
        let prompt = String(args.prompt ?? '').trim();
        if (!prompt) return err('要指定 prompt');
        const c = cfg();
        let facts = '';

        // 宿主 searchFirst：先聚合搜索一轮 → 检索要点喂进提示词 → 才出图（超时/失败静默降级）
        if (c.searchFirst !== false && searchAggFn) {
          try {
            const r = await searchAggFn({ query: prompt, maxResults: c.searchMaxResults ?? 4 });
            if (r.results?.length) {
              facts = r.results.slice(0, 4).map((x) => x.title + (x.snippet ? '：' + x.snippet.slice(0, 80) : '')).join('；');
            }
          } catch { /* 静默降级：宿主超时/失败不拖生图 */ }
        }

        const calibrated = facts
          ? prompt + '（检索补充：' + facts.slice(0, 400) + '）'
          : prompt;

        return ok({
          calibrated_prompt: calibrated,
          facts: facts || '未检索到补充（聚合搜索不可用或无命中，已退回原提示词）',
          style: String(args.style ?? '').trim() || undefined,
          next: '用 calibrated_prompt 调既有「生成图片」工具（image-generate__draw）出图，把 style 一并传入。一句话告知即可，不要念技术细节。',
        });
      } catch (error) {
        return err('检索校准失败：' + (error?.message ?? error));
      }
    },
  });
}

export function available() {
  return { ok: true, reason: '工具可用（检索能力 search.aggregate 由 plugins/search-aggregator 软依赖提供，缺了直接返回原提示词；生图交给既有 image-generate 工具）' };
}
