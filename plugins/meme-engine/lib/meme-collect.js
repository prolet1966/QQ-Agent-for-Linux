// meme-collect.js —— 梗库收编与标签规范化（宿主 P1/P2 语义照搬：三道闸收编 + 固定标签集）

export const MEME_TAG_SET = ['称呼', '口头禅', '黑话', '梗图', '典故', '群梗'];

const TAG_MAP = {
  调侃: '群梗', 吃瓜: '群梗', 插件: '群梗', 聊天: '群梗',
  外号: '称呼', 名字: '称呼',
  指令: '黑话', 暗号: '黑话',
  表情: '梗图', jpg: '梗图',
};

export function normalizeTags(tags) {
  const out = new Set();
  for (const t of (Array.isArray(tags) ? tags : [])) {
    const norm = TAG_MAP[String(t).trim()] || String(t).trim();
    if (MEME_TAG_SET.includes(norm)) out.add(norm);
    else out.add('群梗');
  }
  return [...out];
}

export function inferTags(text) {
  const t = String(text ?? '');
  const out = new Set();
  if (/(自称|称为|外号)/.test(t)) out.add('称呼');
  if (/(指令|暗号|#)/.test(t) && /(是|代表)/.test(t)) out.add('黑话');
  if (/(\.jpg|\.png|表情|图)/i.test(t)) out.add('梗图');
  if (/(典故|出处|来源)/.test(t)) out.add('典故');
  if (/(口头禅|常说的|总说)/.test(t)) out.add('口头禅');
  if (!out.size) out.add('群梗');
  return [...out];
}

const EVENT_HINTS = ['使用', '封装', '运行', '开源', '部署', '配置', '完成', '成功', '询问', '让'];
const MEME_HINTS = ['梗', '外号', '自称', '称为', '口头禅', '暗号', '叫', '说', '玩', '开'];

export function collectFromMemory(memoryMemes, existingItems, { dedupeThreshold = 0.9, semanticOk } = {}) {
  const existingTexts = existingItems.map((m) => m.text);
  let imported = 0, deduped = 0, skipped = 0;
  const batch = [];
  for (const raw of (Array.isArray(memoryMemes) ? memoryMemes : [])) {
    const text = String(raw.content ?? raw.text ?? '').trim();
    if (!text) continue;
    const isEvent = EVENT_HINTS.some((w) => text.includes(w));
    const isMeme = MEME_HINTS.some((w) => text.includes(w));
    if (isEvent && !isMeme) { skipped++; continue; }
    const dup = isDuplicate(text, existingTexts, batch, dedupeThreshold);
    if (dup) { deduped++; continue; }
    const cut = cutAtPause(text);
    batch.push({
      id: 'mm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: cut,
      tags: inferTags(cut),
      uses: 0, saves: 1,
      createdFrom: 'memory',
      sourceMemoryId: raw.memory_id ?? null,
      lastUpdatedAt: new Date().toISOString(),
    });
    imported++;
  }
  existingItems.push(...batch);
  return { imported, deduped, skipped };
}

function isDuplicate(text, existingTexts, batch, threshold) {
  const tNorm = normalize(text);
  const all = [...existingTexts, ...batch.map((b) => b.text)];
  for (const t of all) {
    const jac = jaccard(normalize(t), tNorm);
    if (jac >= threshold) return true;
    if (jac >= threshold - 0.03) return true;
  }
  return false;
}

function cutAtPause(text) {
  const m = String(text ?? '').match(/^(.{1,40}?)(?:[，。；！？,.!?;\s]|$)/);
  return m ? m[1].trim() : String(text ?? '').slice(0, 40);
}

function normalize(text) {
  return String(text ?? '').replace(/[\s\u3000「」"“”‘’'、，。！？!?；;：:\[\]【】()（）]/g, '').toLowerCase();
}
function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  for (const c of sa) if (sb.has(c)) inter++;
  return inter / (sa.size + sb.size - inter);
}
