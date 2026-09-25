// kb-embed.js —— 嵌入器（从宿主 kb-embed.js 提炼；语义 3917 软依赖 + 哈希降级）
export class Embedder {
  constructor({ provider = 'local-hash', dim = 256, semanticUrl = 'http://127.0.0.1:3917' } = {}) {
    this.provider = provider;
    this.dim = dim;
    this.semanticUrl = semanticUrl;
    this.semanticOk = null;  // null=未探测, true/false
  }
  async probeSemantic() {
    try {
      const res = await fetch(this.semanticUrl + '/health', { signal: AbortSignal.timeout(800) });
      this.semanticOk = res.ok;
    } catch { this.semanticOk = false; }
    return this.semanticOk;
  }
  /** 语义可用走 /embed，不可用退回哈希向量（逐字节退回，不卡调用方）。 */
  async embed(text) {
    const t = String(text ?? '');
    if (this.semanticOk) {
      try {
        const res = await fetch(this.semanticUrl + '/embed', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: t }),
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const data = await res.json();
          this.provider = 'local-semantic';
          return data.vectors?.[0] ?? data.embedding ?? null;
        }
      } catch {}
      // 失败退回哈希
    }
    this.provider = 'local-hash';
    return hashEmbed(t, this.dim);
  }
}

/** 确定性哈希向量：中文 bigram / 英文分词 → 哈希到 N 维 → L2 归一化（宿主同款）。 */
export function hashEmbed(text, dim = 256) {
  const t = String(text ?? '').toLowerCase();
  const vec = new Array(dim).fill(0);
  const zh = t.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const grams = [];
  for (const seg of zh) for (let i = 0; i + 2 <= seg.length; i++) grams.push(seg.slice(i, i + 2));
  for (const w of (t.match(/[a-z0-9_]{2,}/g) || [])) grams.push(w);
  for (const g of grams) {
    let h = 0;
    for (let i = 0; i < g.length; i++) { h = (h * 31 + g.charCodeAt(i)) | 0; }
    vec[Math.abs(h) % dim]++;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map((v) => v / norm);
}
