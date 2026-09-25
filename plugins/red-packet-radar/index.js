// 红包雷达 —— 检测群里出现的红包（链接/口令形态），立即提醒，并尝试自动领取。
//
// ── 能做什么 / 不能做什么（先把丑话说在前面）────────────────────────────
// ✅ 能：消息文本/链接里出现红包特征（红包分享链接、口令红包等）时，
//      立即把提醒文案发到群里（确定性触发，不经过模型）。
// ✅ 能：tryGrab 开启时自动尝试一组"领红包"候选接口 —— 当前协议端没有
//      领红包 API，调用会静默失败并记日志；将来协议端加了，无需改本插件。
// ❌ 不能：检测 JSON 卡片形态的普通群红包 —— 核心会把 json 段折叠成
//      "[卡片消息]" 占位符后才进 media.download 通道（见 src/onebot.js），
//      且该通道只对文本含 http(s)/裸短链的消息触发。不改动 src/ 无解。
//
// ── 为什么挂在 media.download 上 ─────────────────────────────────────────
// 本系统给插件的唯一"每条消息都能看到"的确定性通道就是 media.download
// （src/app.js ingest → forwardLinkedMedia）。红包分享链接恰好是 http 链接，
// 会进入该通道；核心按"谁认领谁处理"协商，本插件认领后自己负责发提醒。

let cfg = () => ({});
let log = () => {};

/** 同一会话上次提醒的时间戳，冷却用。 */
const lastAlertAt = new Map();

/** 领红包候选接口：当前协议端都不存在，调用失败只记日志；将来支持哪个哪个生效。 */
const GRAB_API_CANDIDATES = [
  { name: 'open_red_packet', args: (chatId) => ({ group_id: Number(chatId) }) },
  { name: 'grab_red_packet', args: (chatId) => ({ group_id: Number(chatId) }) },
  { name: 'grab_online_redpacket', args: (chatId) => ({ group_id: Number(chatId) }) },
  { name: 'open_red_envelope', args: (chatId) => ({ group_id: Number(chatId) }) }
];

/**
 * 判断一段文本/链接是否像红包。纯函数，便于测试。
 *
 * 命中任一特征即认领：
 *   · URL 带 hongbao / redpacket / red_envelope / hb.qq.com 等路径特征
 *   · 文本含"红包/紅包"（media.download 通道本身要求消息里有链接，
 *     所以"提到红包"几乎总是红包链接分享文案或口令红包）
 */
export function isRedPacket(text) {
  const s = String(text || '');
  if (!s) return false;
  if (/hongbao|red[_-]?packet|red[_-]?envelope|hb\.qq\.com|h5\.qzone\.qq\.com\/mapping\/redbag/i.test(s)) return true;
  if (/红包|紅包/.test(s)) return true;
  return false;
}

/** 冷却判断（顺带清理过期记录，防止 Map 无限增长）。纯逻辑，便于测试。 */
export function isCooling(chatKey, cooldownSec, now = Date.now()) {
  const sec = Math.max(0, Number(cooldownSec) || 0);
  if (!sec) return false;
  const last = lastAlertAt.get(String(chatKey || ''));
  if (last == null) return false;
  if (now - last >= sec * 1000) { lastAlertAt.delete(String(chatKey)); return false; }
  return true;
}

function markAlerted(chatKey, now = Date.now()) {
  lastAlertAt.set(String(chatKey || ''), now);
  // Map 只在写入时清理：超过 1000 条说明长期没重启，把最旧的丢掉
  if (lastAlertAt.size > 1000) {
    const oldest = [...lastAlertAt.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) lastAlertAt.delete(oldest[0]);
  }
}

/** 尝试领红包：逐个候选接口试，全失败只记日志（一个都不抛错）。 */
async function tryGrab(onebot, chatId) {
  for (const cand of GRAB_API_CANDIDATES) {
    try {
      const r = await onebot?.call?.(cand.name, cand.args(chatId));
      // 有的实现返回 {status:'failed', retcode:...} 而不是抛错，两种都当失败
      const failed = r && (r.status === 'failed' || (r.retcode != null && r.retcode !== 0));
      if (failed) {
        log(`尝试 ${cand.name} 失败：retcode=${r.retcode} ${r.message ?? r.wording ?? ''}`);
        continue;
      }
      log(`已调用领红包接口 ${cand.name} 成功 ✓`);
      return true;
    } catch (e) {
      // 正常情况：协议端没实现该接口，抛 "unknown action" 之类 —— 静默跳过
      log(`尝试 ${cand.name} 不可用：${e?.message ?? e}`);
    }
  }
  return false;
}

// ── Skill 生命周期 ────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;
}

export const providers = {
  // ⚠️ 必须用解构参数，不能用 arguments（箭头函数没有自己的 arguments）。
  'media.download': async ({ url = '', text = '', onebot, sender, kind, chatId } = {}) => {
    const c = cfg();
    const chatKey = `${kind}:${chatId}`;
    const blob = `${url}\n${text}`;

    // 不像红包 → 立即不认领，把机会让给别的提供者（B站/抖音插件等）
    if (!isRedPacket(blob)) return { ok: false, skip: true };

    // 冷却中：认领但不重复提醒（返回 ok 让核心知道这条已被处理）
    if (isCooling(chatKey, c.cooldownSec)) {
      log(`${chatKey} 红包提醒冷却中，跳过重复提醒`);
      return { ok: true, platform: 'qq-redpacket', title: '红包（冷却中）' };
    }
    markAlerted(chatKey);

    log(`${chatKey} 检测到红包特征 → 发送提醒`);
    const alert = String(c.alertText || '🧧 红包雷达：群里出现红包了！快抢！！');
    try {
      await sender?.sendTextBatch?.(chatKey, [alert]);
    } catch (e) {
      log(`发送提醒失败：${e?.message ?? e}`);
    }

    if (c.tryGrab !== false) {
      const grabbed = await tryGrab(onebot, chatId);
      if (!grabbed) log('当前协议端没有可用的领红包接口（已尝试全部候选，均不可用）');
    }

    // 认领并处理成功。核心只记日志，不做别的（提醒是我们自己发的）。
    return { ok: true, platform: 'qq-redpacket', title: '检测到红包并已提醒' };
  }
};

export function available() { return { ok: true }; }

export const internals = { isRedPacket, isCooling, markAlerted, tryGrab, GRAB_API_CANDIDATES };
