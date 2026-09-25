// 每日打卡技能 —— 自定义打卡内容，记住群里每个人当天是否打卡，并可催促未打卡的群友。
//
// ── 机制说明 ──────────────────────────────────────────────────────────
//   · 数据存 <DATA_DIR>/skills/check-in/checkins.json。
//     DATA_DIR 复用核心导出（src/config.js），多实例下与正在运行的进程完全一致，
//     不会出现"实例 #2 的打卡写进了 #1 的目录"。
//   · 结构：{ [chatKey]: { [YYYY-MM-DD]: { [memberKey]: { name, at } } } }
//   · 每天按日期自然重置：查询时只取"今天"的条目，没有即视为无人打卡。
//   · 保留 retentionDays 天历史，超出自动清理，防止数据无限膨胀。
//
// ── 三个工具（LLM 型，由模型判断何时调用）────────────────────────────
//   check_in         群友打卡（每人每天一次）
//   check_in_status  查询打卡情况（谁打了 / 谁没打）
//   remind_check_in  催促未打卡的群友（直接发送，确定性最强）

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

let cfg = () => ({});
let log = () => {};

const dataFile = () => path.join(DATA_DIR, 'skills', 'check-in', 'checkins.json');

/** 本地时区今天的 YYYY-MM-DD（打卡按自然日重置）。 */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 当前时刻的 HH:mm，给人看的打卡时间。 */
function nowTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 读数据；文件不存在或损坏时从空开始（打卡记录损坏不该让技能挂掉）。 */
function loadData() {
  try {
    const raw = fs.readFileSync(dataFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 原子写：先写 .tmp 再 rename，避免写到一半进程退出留下损坏的 JSON。 */
function saveData(db) {
  try {
    fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
    const tmp = `${dataFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, dataFile());
  } catch (error) {
    throw new Error(`打卡数据保存失败：${error?.message ?? error}`);
  }
}

/** 按保留天数清理过期记录（对每个会话只留最近 N 天）。 */
function prune(db, keepDays) {
  const keep = Math.max(1, Number(keepDays) || 30);
  const cutoff = new Date(Date.now() - keep * 86400000).toISOString().slice(0, 10);
  for (const chatKey of Object.keys(db)) {
    const dayMap = db[chatKey];
    if (!dayMap || typeof dayMap !== 'object') { delete db[chatKey]; continue; }
    for (const date of Object.keys(dayMap)) {
      if (date < cutoff) delete dayMap[date];
    }
    if (!Object.keys(dayMap).length) delete db[chatKey];
  }
}

/**
 * 成员唯一键：优先 QQ 号；只有昵称时加 "~" 前缀，避免与 QQ 号撞 key。
 * 同名昵称在同一个群里会互相覆盖 —— 所以模型能拿到 QQ 号时应优先传 userId。
 */
function memberKey(args) {
  const uid = String(args?.userId ?? '').trim();
  if (uid) return uid;
  const name = String(args?.name ?? '').trim();
  return name ? `~${name}` : '';
}

/** 从 store 拉活跃成员，尽力解析出 [{userId, nickname}]；拿不到就返回 []。 */
async function activeMembers(store, chatKey) {
  try {
    if (!store || typeof store.activeMembers !== 'function') return [];
    const members = await store.activeMembers(chatKey);
    if (!Array.isArray(members)) return [];
    return members
      .map((m) => ({
        userId: String(m?.userId ?? m?.senderId ?? ''),
        nickname: String(m?.nickname ?? m?.senderName ?? '').trim()
      }))
      .filter((m) => m.userId || m.nickname);
  } catch {
    return [];
  }
}

/** 算出今天已打卡 / 未打卡两批人（未打卡依赖活跃成员列表，拿不到就只报已打卡）。 */
async function splitToday(ctx, db) {
  const date = today();
  const rec = db[ctx.chatKey]?.[date] || {};
  const doneKeys = new Set(Object.keys(rec));
  const done = Object.values(rec).map((m) => m.name || '群友');
  const members = await activeMembers(ctx.store, ctx.chatKey);
  const pending = members
    .filter((m) => {
      if (m.userId && doneKeys.has(m.userId)) return false;
      if (m.nickname && doneKeys.has(`~${m.nickname}`)) return false;
      return true;
    })
    .map((m) => m.nickname || m.userId || '群友');
  return { date, rec, done, pending };
}

export function setup(api) {
  cfg = api.config;
  log = api.log;

  // ── 工具 1：打卡 ──────────────────────────────────────────────────────
  api.registerTool({
    id: 'check_in',
    name: '打卡',
    description: '记录某人今天完成打卡，每人每天只能打一次。当群友说「打卡」「签到」「打卡啦」或表达完成今日打卡的意愿时使用。name 传说话人的昵称；能确定其 QQ 号时用 userId 更准确。',
    category: 'system',
    icon: '✅',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '打卡人的昵称（群里显示的名字），从对话上下文判断' },
        userId: { type: 'string', description: '打卡人的 QQ 号（可选，比昵称更准确，可避免同名覆盖）' }
      }
    },
    async execute(ctx, args) {
      const key = memberKey(args);
      if (!key) return { content: '缺少打卡人信息：请提供昵称或 QQ 号', isError: true };
      try {
        const c = cfg();
        const db = loadData();
        prune(db, c.retentionDays);
        if (!db[ctx.chatKey]) db[ctx.chatKey] = {};
        if (!db[ctx.chatKey][today()]) db[ctx.chatKey][today()] = {};
        const rec = db[ctx.chatKey][today()];
        const name = String(args?.name ?? '').trim() || key.replace(/^~/, '') || '群友';

        if (rec[key]) {
          const existed = rec[key];
          return { content: `${existed.name} 今天（${today()}）已经打过卡了（${existed.at}），不用重复打。今天已有 ${Object.keys(rec).length} 人完成打卡。` };
        }
        rec[key] = { name, at: nowTime() };
        saveData(db);
        const count = Object.keys(rec).length;
        const members = Object.values(rec).map((m) => m.name).join('、');
        const extra = String(c.checkinText ?? '').trim();
        return {
          content: `${name} 打卡成功！今天（${today()}）已打卡 ${count} 人：${members}。`
            + (extra ? ` 打卡固定文案：${extra}` : '')
        };
      } catch (error) {
        return { content: `打卡失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 工具 2：查询打卡情况 ──────────────────────────────────────────────
  api.registerTool({
    id: 'check_in_status',
    name: '查询打卡情况',
    description: '查询群里今天谁打了卡、谁还没打。当群友问「谁还没打卡」「打卡情况」「谁打卡了」时使用。传 name 可只查某一个人。',
    category: 'query',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要查的群友昵称（可选，不填则查全群）' }
      }
    },
    async execute(ctx, args) {
      try {
        const db = loadData();
        const { date, rec, done, pending } = await splitToday(ctx, db);
        const want = String(args?.name ?? '').trim();
        if (want) {
          const hit = Object.values(rec).find((m) => m.name === want || m.name.includes(want));
          return hit
            ? { content: `${want} 今天已经打卡了（${hit.at}）。` }
            : { content: `${want} 今天还没打卡。` };
        }
        const doneText = done.length ? done.join('、') : '（还没有人打卡）';
        const pendingText = pending.length ? `未打卡：${pending.join('、')}` : '';
        return {
          content: `今日（${date}）打卡情况：已打卡 ${done.length} 人：${doneText}。${pendingText}`
        };
      } catch (error) {
        return { content: `查询失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 工具 3：催促打卡（直接发送） ──────────────────────────────────────
  api.registerTool({
    id: 'remind_check_in',
    name: '催促打卡',
    description: '提醒未打卡的群友完成打卡，会直接把催促消息发到群里。当群友要求「催打卡」「提醒打卡」「叫他们打卡」，或每天早晨群里活跃而有人没打卡时使用。传 name 可只提醒某一个人。',
    category: 'messaging',
    icon: '⏰',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要提醒的群友昵称（可选，不填则提醒所有未打卡的人）' }
      }
    },
    async execute(ctx, args) {
      try {
        const c = cfg();
        const db = loadData();
        const { date, pending } = await splitToday(ctx, db);
        const target = String(args?.name ?? '').trim();
        const checkinName = c.checkinName || '今日打卡';

        let message;
        if (target) {
          message = `${target}，别忘了今天的「${checkinName}」呀！`;
        } else {
          const custom = String(c.remindText ?? '').trim();
          const list = pending.length
            ? `还没打卡的群友：${pending.join('、')}`
            : '今天的打卡已经全部完成啦，大家都很棒！';
          message = custom || `该「${checkinName}」啦！${list}`;
        }
        await ctx.sender.sendTextBatch(ctx.chatKey, [message]);
        log(`已催打卡（${date}）：${message}`);
        return { content: `催促消息已发出：${message}。不要再复述一遍。` };
      } catch (error) {
        return { content: `催促失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

export function available() { return true; }

// 动态提示词片段：把自定义的打卡名称注入系统提示词（每次对话都带上）。
export function promptSections(ctx) {
  try {
    const c = cfg();
    return [{
      id: 'check-in-rule',
      title: '每日打卡',
      priority: 45,
      content: `本群有「${c.checkinName || '今日打卡'}」打卡活动。群友说打卡/签到时用 check_in 工具；问谁没打卡时用 check_in_status；群友要求催打卡或每天早晨群里活跃时，用 remind_check_in 提醒未打卡的群友。每天 0 点重置，每人每天只能打一次卡。`
    }];
  } catch {
    return [];
  }
}
