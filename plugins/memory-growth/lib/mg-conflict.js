// mg-conflict.js —— 冲突信号检测（宿主第十六/十七节：极性/数字互斥/关系/态度/地点/职业，词表驱动不调模型）
// 三条防误报规矩：① 对象不同就不是矛盾 ② 一方包含另一方不算矛盾 ③ 宁可漏报不要误报。

/** 互斥关系组：同组内不矛盾（情侣/恋人/男女朋友），跨组矛盾（情侣 vs 兄妹）。 */
const MUTEX_RELATIONS = [
  ['情侣', '恋人', '男女朋友', '对象', 'cp'],
  ['兄妹', '姐弟', '兄妹'],
  ['夫妻', '老公', '老婆', '丈夫', '妻子'],
];

const ATTITUDE_POS = ['喜欢', '爱', '支持', '赞赏', '欣赏', '认同'];
const ATTITUDE_NEG = ['讨厌', '恨', '反感', '鄙视', '不支持', '反'];

/**
 * 判定两条记忆是否冲突。宿主 conflictSignal 语义：
 *   同一主体 + 词面 Jaccard ≥ 0.6 + 有对立信号（极性相反 / 数字互斥 / 关系跨组 / 态度相反 / 地点互斥 / 职业不同）
 * @returns { ok: false } | { ok: true, reason, of_content }
 */
export function conflictSignal(a, b) {
  const textA = String(a?.content ?? a?.text ?? '');
  const textB = String(b?.content ?? b?.text ?? '');
  const subjA = a?.subject_id ?? a?.subject ?? '';
  const subjB = b?.subject_id ?? b?.subject ?? '';

  // 规矩①：对象不同就不是矛盾（同一个人/事才比）
  if (subjA && subjB && String(subjA) !== String(subjB)) {
    // 提取「和/跟/与」后的对象比较（宿主：同一对人才比关系）
    const objA = extractRelationObject(textA);
    const objB = extractRelationObject(textB);
    if (objA && objB && objA !== objB) return { ok: false };
  }

  // 数字互斥（宿主：只认两边都有数字且没有交集，避免 LunaBox 1.12.2 vs LunaBox-1.12.2-windows-amd64 误判）
  const numsA = extractNumbers(textA);
  const numsB = extractNumbers(textB);
  if (numsA.length && numsB.length) {
    const hasCommon = numsA.some((n) => numsB.includes(n));
    if (!hasCommon) return { ok: true, reason: 'number', of_content: textB };
  }

  // 极性相反（宿主：不(?!错|同|少|过|如|妨) 显式排除非否定常见词）
  const negA = /不(?!错|同|少|过|如|妨)/.test(textA);
  const negB = /不(?!错|同|少|过|如|妨)/.test(textB);
  if (negA !== negB && negA || negB) {
    // 一边否定一边肯定 → 极性对立（粗判，宿主同样粗判，宁可漏报）
    const coreA = textA.replace(/不(?!错|同|少|过|如|妨)/g, '');
    const coreB = textB.replace(/不(?!错|同|少|过|如|妨)/g, '');
    if (overlapRatio(coreA, coreB) > 0.5) return { ok: true, reason: 'polarity', of_content: textB };
  }

  // 关系跨组（情侣 vs 兄妹）
  const relA = matchRelationGroup(textA);
  const relB = matchRelationGroup(textB);
  if (relA != null && relB != null && relA !== relB) return { ok: true, reason: 'relation', of_content: textB };

  // 态度相反（喜欢 vs 讨厌，同一对象）
  const attA = matchAttitude(textA);
  const attB = matchAttitude(textB);
  if (attA === 'pos' && attB === 'neg' || attA === 'neg' && attB === 'pos') {
    const objA = extractObjectAfter(textA);
    const objB = extractObjectAfter(textB);
    if (!objA || !objB || objA === objB) return { ok: true, reason: 'attitude', of_content: textB };
  }

  // 地点互斥（住在北京 vs 住在上海；一方包含另一方放过）
  const placeA = extractPlace(textA);
  const placeB = extractPlace(textB);
  if (placeA && placeB && placeA !== placeB && !placeA.includes(placeB) && !placeB.includes(placeA)) {
    return { ok: true, reason: 'place', of_content: textB };
  }

  // 职业不同（「是/当/做/成为 + 职业词」结构化匹配，宿主第十七节防误报）
  const occA = extractOccupation(textA);
  const occB = extractOccupation(textB);
  if (occA && occB && occA !== occB && !occA.includes(occB) && !occB.includes(occA)) {
    return { ok: true, reason: 'occupation', of_content: textB };
  }

  return { ok: false };
}

// ── 辅助词表 ──
function extractRelationObject(text) {
  const m = String(text).match(/(?:和|跟|与|同)([\u4e00-\u9fa5A-Za-z0-9_]{1,8})/);
  return m ? m[1] : null;
}
function extractObjectAfter(text) {
  const m = String(text).match(/(?:喜欢|爱|讨厌|恨|反感|支持|赞赏|欣赏)([\u4e00-\u9fa5A-Za-z0-9_]{1,8})/);
  return m ? m[1] : null;
}
function extractNumbers(text) {
  const m = String(text).match(/\d+(?:\.\d+)?/g);
  return m ? m.map((n) => Number(n)) : [];
}
function matchRelationGroup(text) {
  const t = String(text);
  for (let gi = 0; gi < MUTEX_RELATIONS.length; gi++) {
    if (MUTEX_RELATIONS[gi].some((w) => t.includes(w))) return gi;
  }
  return null;
}
function matchAttitude(text) {
  const t = String(text);
  if (ATTITUDE_NEG.some((w) => t.includes(w))) return 'neg';
  if (ATTITUDE_POS.some((w) => t.includes(w))) return 'pos';
  return null;
}
const PLACE_RE = /(?:住[在于]|位于|在)(北京|上海|广州|深圳|杭州|南京|成都|武汉|西安|重庆|下北沢|东京|大阪)/;
function extractPlace(text) {
  const m = String(text).match(PLACE_RE);
  return m ? m[1] : null;
}
const OCC_RE = /(?:是|当|做|成为)\s*(医生|老师|学生|程序员|设计师|作家|歌手|演员|警察|工程师|经理|老板)/;
function extractOccupation(text) {
  const m = String(text).match(OCC_RE);
  return m ? m[1] : null;
}
function overlapRatio(a, b) {
  const sa = new Set(String(a).match(/[\u4e00-\u9fa5]{1,2}/g) || []);
  const sb = String(b).match(/[\u4e00-\u9fa5]{1,2}/g) || [];
  if (!sa.size || !sb.length) return 0;
  let hit = 0;
  for (const t of sb) if (sa.has(t)) hit++;
  return hit / sb.length;
}
