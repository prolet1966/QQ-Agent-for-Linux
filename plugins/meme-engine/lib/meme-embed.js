// meme-embed.js —— 梗库向量（宿主 memes.js 哈希向量 + 语义 3917 降级）
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
