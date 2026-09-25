// threads-core.js —— 讨论线核心算法（六维记分卡 + 双层窗口 + 用进废退）
//
// ⚠️ 规格来源：宿主「功能全清单」§3.1 只有一句话 ——
//    「讨论线记忆（threads.js）六维记分卡驱动，活跃层（带摘要）+ 沉睡层（仅标签）双层窗口」
//    宿主**从未实现**（src/ 里没有 threads.js），所以六维是我按这句话和相邻条款
//    （「拟人记忆上限：只主动提起最相关 1~3 条」「用进废退：被注入的线索巩固度上升」）
//    定的。六维定义写在下面 SCORE_WEIGHTS 里，可调。
//
// 六维（各 0~100，加权求和 → 总分 0~100）：
//   1. recency       新鲜度：越近发生的线索越值得提（按小时指数衰减）
//   2. heat          热度：被提及的次数（对数压缩，防刷屏话题永远第一）
//   3. breadth       参与面：有多少个不同的人参与（人多 = 公共话题，值得提）
//   4. charge        情绪强度：感叹号/问号/情绪词密度（情绪浓的线索更容易被记住）
//   5. unresolved    未完度：带问号、待办、"回头再说"→ 没聊完的更该被续上
//   6. reinforcement 巩固度：被注入过会上升，长期不被注入会衰减（用进废退）
//
// 双层窗口：
//   总分 >= activeThreshold(默认 45) → 活跃层，注入时带 summary
//   否则                              → 沉睡层，注入时只留 tags（省 token）

export const SCORE_WEIGHTS = {
  recency: 0.30,
  heat: 0.15,
  breadth: 0.15,
  charge: 0.10,
  unresolved: 0.10,
  reinforcement: 0.20,
};

/** 新鲜度：按小时指数衰减，半衰期默认 12 小时。 */
export function recencyScore(ageMs, halfLifeHours = 12) {
  const h = Math.max(0, Number(ageMs) || 0) / 3600000;
  const hl = Math.max(0.1, Number(halfLifeHours) || 12);
  return 100 * Math.pow(0.5, h / hl);
}

/** 热度：提及次数对数压缩（1 次≈33，3 次≈50，10 次≈67，100 次≈100）。 */
export function heatScore(mentions) {
  const n = Math.max(0, Number(mentions) || 0);
  if (n <= 0) return 0;
  return Math.min(100, 100 * Math.log10(1 + n) / 2);
}

/** 参与面：不同参与人数（1 人 0，2 人 40，3 人 60，5 人 80，10 人 100）。 */
export function breadthScore(people) {
  const n = Math.max(0, Number(people) || 0);
  if (n <= 1) return 0;
  return Math.min(100, 100 * Math.log10(n) / 1);
}

/** 情绪强度：标点 + 情绪词密度。 */
const EMOTION_WORDS = ['哈哈', '草', '卧槽', '呜呜', '好家伙', '笑死', '离谱', '绝了', '救命', '气死', '爱了', '牛逼', '好耶', '可惜', '难过', '开心', '烦', '累'];
export function chargeScore(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  const bang = (s.match(/[!！]/g) || []).length;
  const ques = (s.match(/[?？]/g) || []).length;
  const words = EMOTION_WORDS.reduce((n, w) => n + (s.split(w).length - 1), 0);
  // 密度用文本长度归一，避免长文本天然高分
  const per100 = (bang * 1.0 + ques * 0.6 + words * 1.5) / Math.max(10, s.length) * 100;
  return Math.min(100, per100 * 25);
}

/** 未完度：带问号、待办、未答复 → 更该被续上。 */
const UNRESOLVED_HINTS = ['?', '？', '怎么办', '回头', '下次', '待会', '还没', '待定', '要不要', '哪个好', '求'];
export function unresolvedScore(text, resolved = false) {
  if (resolved === true) return 0;
  const s = String(text ?? '');
  if (!s) return 0;
  const hits = UNRESOLVED_HINTS.filter((h) => s.includes(h)).length;
  return Math.min(100, hits * 34);
}

/** 巩固度：被注入次数（用进废退的"进"）。 */
export function reinforcementScore(injections) {
  const n = Math.max(0, Number(injections) || 0);
  return Math.min(100, n * 25);
}

/** 计算一条线索的六维分数与总分。 */
export function scoreThread(thread, now = Date.now(), opts = {}) {
  const w = { ...SCORE_WEIGHTS, ...(opts.weights || {}) };
  const dims = {
    recency: recencyScore(now - (Number(thread?.lastActiveAt) || now), opts.halfLifeHours ?? 12),
    heat: heatScore(thread?.mentions),
    breadth: breadthScore((thread?.participants || []).length),
    charge: Number(thread?.charge) || 0,
    unresolved: Number(thread?.unresolved) || 0,
    reinforcement: reinforcementScore(thread?.injections),
  };
  let total = 0;
  for (const k of Object.keys(w)) total += (dims[k] || 0) * (w[k] || 0);
  return { dims, total: Math.round(total * 10) / 10 };
}

/** 双层窗口分层：活跃层（带摘要）/ 沉睡层（仅标签）。 */
export function layerOf(total, activeThreshold = 45) {
  return Number(total) >= Number(activeThreshold) ? 'active' : 'dormant';
}

/**
 * 选出该注入的线索（拟人记忆上限：只提最相关 1~3 条）。
 * @returns {{ active: Array, dormant: Array }}
 */
export function selectForInjection(threads = [], { now = Date.now(), maxActive = 3, maxDormant = 5, activeThreshold = 45, weights = null, minScore = 5 } = {}) {
  const scored = (Array.isArray(threads) ? threads : [])
    .map((t) => {
      const s = scoreThread(t, now, { weights: weights || undefined });
      return { thread: t, total: s.total, dims: s.dims, layer: layerOf(s.total, activeThreshold) };
    })
    .filter((x) => x.total >= minScore)
    .sort((a, b) => b.total - a.total);
  return {
    active: scored.filter((x) => x.layer === 'active').slice(0, maxActive),
    dormant: scored.filter((x) => x.layer === 'dormant').slice(0, maxDormant),
  };
}

/** 渲染成提示词片段（活跃层带摘要，沉睡层只留标签）。 */
export function renderThreads({ active = [], dormant = [] } = {}) {
  const out = [];
  if (active.length) {
    out.push('【聊到一半的线索】');
    out.push('（这些是还没聊完的话题；想接话时自然带上，别硬拽；不确定就不要提）');
    for (const x of active) {
      const t = x.thread || {};
      const tags = (t.tags || []).length ? ' [' + t.tags.join('/') + ']' : '';
      out.push('- ' + String(t.topic || '').slice(0, 40) + tags + '：' + String(t.summary || '').slice(0, 120));
    }
  }
  if (dormant.length) {
    out.push('【以前聊过】');
    out.push(dormant.map((x) => (x.thread?.tags || []).join('/') || String(x.thread?.topic || '').slice(0, 20)).filter(Boolean).join(' · '));
  }
  return out.join('\n');
}

/**
 * 合并一条新线索：同 topic 视为同一条（提及数 +1、刷新时间、补充标签与摘要）。
 * @returns {Array} 新数组（不改原数组）
 */
export function upsertThread(threads = [], patch = {}, now = Date.now()) {
  const list = Array.isArray(threads) ? threads.slice() : [];
  const topic = String(patch.topic ?? '').trim();
  if (!topic) return list;
  const i = list.findIndex((t) => String(t?.topic ?? '').trim() === topic);
  const incoming = {
    id: patch.id || ('t_' + now.toString(36) + Math.random().toString(36).slice(2, 6)),
    topic,
    tags: Array.isArray(patch.tags) ? patch.tags.map((x) => String(x).trim()).filter(Boolean) : [],
    summary: String(patch.summary ?? '').trim(),
    charge: Number(patch.charge) || 0,
    unresolved: Number(patch.unresolved) || 0,
    createdAt: now,
    lastActiveAt: now,
    mentions: 1,
    participants: Array.isArray(patch.participants) ? patch.participants.map(String) : [],
    injections: 0,
  };
  if (i < 0) { list.push(incoming); return prune(list, now); }
  const old = list[i];
  list[i] = {
    ...old,
    tags: [...new Set([...(old.tags || []), ...incoming.tags])].slice(0, 8),
    summary: incoming.summary || old.summary,
    charge: Math.max(Number(old.charge) || 0, incoming.charge),
    unresolved: incoming.unresolved || Number(old.unresolved) || 0,
    lastActiveAt: now,
    mentions: (Number(old.mentions) || 0) + 1,
    participants: [...new Set([...(old.participants || []), ...incoming.participants])].slice(0, 30),
  };
  return prune(list, now);
}

/** 记账一次注入（用进废退的"进"）。 */
export function markInjected(threads = [], ids = [], now = Date.now()) {
  const set = new Set((ids || []).map(String));
  return (Array.isArray(threads) ? threads : []).map((t) => (
    set.has(String(t?.id)) ? { ...t, injections: (Number(t.injections) || 0) + 1, lastInjectedAt: now } : t
  ));
}

/**
 * 用进废退的"废"：巩固度随时间回落（距上次注入每过 1 天扣 1 次注入当量），
 * 并清理彻底沉寂的线索（默认 30 天）。
 */
export function decayAndPrune(threads = [], now = Date.now(), { decayPerDayMs = 86400000, keepDays = 30, maxThreads = 60 } = {}) {
  const out = [];
  for (const t of Array.isArray(threads) ? threads : []) {
    const last = Number(t?.lastInjectedAt) || Number(t?.createdAt) || now;
    const days = Math.floor((now - last) / decayPerDayMs);
    const injections = Math.max(0, (Number(t?.injections) || 0) - days);
    const ageDays = (now - (Number(t?.lastActiveAt) || now)) / decayPerDayMs;
    if (ageDays > keepDays) continue;   // 彻底沉寂 → 忘掉
    out.push({ ...t, injections });
  }
  return out;
}

/** 总量上限：超出按总分砍尾（拟人记忆有限）。 */
export function prune(threads = [], now = Date.now(), maxThreads = 60) {
  const list = decayAndPrune(threads, now);
  if (list.length <= maxThreads) return list;
  return list
    .map((t) => ({ t, s: scoreThread(t, now).total }))
    .sort((a, b) => b.s - a.s)
    .slice(0, maxThreads)
    .map((x) => x.t);
}
