// mg-embed.js —— 记忆库嵌入（语义 3917 软依赖 + 哈希降级，宿主 kb-embed.js 同款）
export function hashEmbed(text, dim = 256) {
  const t = String(text ?? '').toLowerCase();
  const vec = new Array(dim).fill(0);
  const grams = [];
  const zh = t.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const seg of zh) for (let i = 0; i + 2 <= seg.length; i++) grams.push(seg.slice(i, i + 2));
  for (const w of (t.match(/[a-z0-9_]{2,}/g) || [])) grams.push(w);
  for (const g of grams) {
    let h = 0;
    for (let i = 0; i < g.length; i++) h = (h * 31 + g.charCodeAt(i)) | 0;
    vec[Math.abs(h) % dim]++;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map((v) => v / norm);
}

export async function embedForIngest(text, { semanticUrl = 'http://127.0.0.1:3917', semanticOk } = {}) {
  if (semanticOk) {
    try {
      const res = await fetch(semanticUrl + '/embed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = await res.json();
        const v = data.vectors?.[0] ?? data.embedding;
        if (Array.isArray(v) && v.length) return { vector: v, provider: 'local-semantic' };
      }
    } catch {}
    // 失败退回哈希
  }
  return { vector: hashEmbed(text), provider: 'local-hash' };
}
