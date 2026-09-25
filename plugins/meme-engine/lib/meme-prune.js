// meme-prune.js —— 梗库淘汰与真实使用统计（宿主 memes.js prune/noteMemeUse 语义照搬）

export function prune(items, max) {
  const limit = Math.max(0, Number(max) || 200);
  if (items.length <= limit) return { pruned: 0, detail: '未超限' };
  const byUpdated = (a, b) => new Date(b.lastUpdatedAt ?? 0) - new Date(a.lastUpdatedAt ?? 0);
  const disabled = items.filter((m) => m.disabled === true && m.locked !== true).sort(byUpdated);
  const unused = items.filter((m) => (m.uses ?? 0) === 0 && m.locked !== true && m.disabled !== true).sort(byUpdated);
  const rest = items.filter((m) => m.locked !== true && m.disabled !== true && (m.uses ?? 0) > 0).sort(byUpdated);
  const overflow = items.length - limit;
  const toRemove = [...disabled, ...unused, ...rest].slice(0, overflow);
  const removeIds = new Set(toRemove.map((m) => m.id));
  for (let i = items.length - 1; i >= 0; i--) if (removeIds.has(items[i].id)) items.splice(i, 1);
  return { pruned: toRemove.length, detail: { disabled: disabled.length, unused: unused.length, rest: rest.length } };
}

export function noteMemeUse(items, sentText) {
  const t = String(sentText ?? '');
  let matched = 0, count = 0;
  for (const m of items) {
    if (m.disabled === true) continue;
    const core = String(m.text ?? '').trim();
    const alias = core.match(/[「"“]([^””"]{1,20})[””"]/);
    const hitText = alias ? alias[1] : core.slice(0, Math.min(12, core.length));
    if (hitText.length >= 2 && t.includes(hitText)) {
      m.uses = (m.uses ?? 0) + 1;
      m.lastUsedAt = new Date().toISOString();
      matched++;
      count++;
    }
  }
  return { matched, count };
}
