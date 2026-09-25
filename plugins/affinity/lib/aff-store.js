// aff-store.js —— 好感度本地 JSON 存储（宿主用 Mongo，V0.3.1 轻部署改本地文件，软依赖降级）
// 文件：<dataDir>/affinity/affinity-state.json（每人一行）+ affinity-events.jsonl（append-only）
// 2 秒落盘节流（宿主语义：高频写要节流）；任何失败只打日志，绝不影响聊天。
import fs from 'node:fs';
import path from 'node:path';

let writeTimer = null;
let pendingDirty = false;

export class AffinityStore {
  constructor({ dataDir } = {}) {
    this.dir = dataDir || path.join(process.cwd(), 'data', 'affinity');
    this.stateFile = path.join(this.dir, 'affinity-state.json');
    this.eventFile = path.join(this.dir, 'affinity-events.jsonl');
    this.states = new Map();   // personId → state
    this.dirty = false;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.stateFile)) {
        let t = fs.readFileSync(this.stateFile, 'utf8');
        if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
        const arr = JSON.parse(t);
        for (const s of arr) this.states.set(String(s.person_id || s.personId), s);
      }
    } catch { this.states = new Map(); }
  }

  _ensureDir() {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
  }

  getState(personId) {
    const key = String(personId ?? '');
    let s = this.states.get(key);
    if (!s) {
      s = {
        person_id: key,
        raw: 0,
        events: [],
        created_at: new Date().toISOString(),
        last_talk_at: null,
        rebirth: { count: 0, buffMult: 1, lastAt: null, pending: false },
      };
      this.states.set(key, s);
      this.markDirty();
    }
    return s;
  }

  loadAll() {
    return [...this.states.values()];
  }

  appendEvent(event) {
    try {
      this._ensureDir();
      fs.appendFileSync(this.eventFile, JSON.stringify(event) + '\n');
    } catch {}
    return event;
  }

  markDirty() {
    pendingDirty = true;
    this.dirty = true;
    // 2 秒节流（宿主语义）
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      this.flush();
    }, 2000);
    writeTimer.unref?.();
  }

  flush() {
    if (!this.dirty) return;
    try {
      this._ensureDir();
      const arr = [...this.states.values()];
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(arr, null, 1));
      try { fs.unlinkSync(this.stateFile); } catch {}
      fs.renameSync(tmp, this.stateFile);
      this.dirty = false;
      pendingDirty = false;
    } catch {}
  }

  close() {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    this.flush();
  }
}

/** 跨群熟悉度（宿主 familiarity 0~100，每日首次 +1，闲置衰减 —— 简化版）。 */
export function familiarityOf(state, { todayFirst = false, decayPerDay = 0, idleDays = 0 } = {}) {
  let fam = Number(state?.familiarity ?? 0);
  if (todayFirst) fam = Math.min(100, fam + 1);
  fam = Math.max(0, fam - (Number(decayPerDay) || 0) * Math.max(0, Number(idleDays) || 0));
  state.familiarity = fam;
  return fam;
}

/** 熟悉度 4 档（宿主：老熟人≥81 / 熟悉≥51 / 眼熟≥21 / 陌生≥0）。 */
export function familiarityTier(fam) {
  const f = Number(fam) || 0;
  if (f >= 81) return { tier: 4, name: '老熟人' };
  if (f >= 51) return { tier: 3, name: '熟悉' };
  if (f >= 21) return { tier: 2, name: '眼熟' };
  return { tier: 1, name: '陌生' };
}
