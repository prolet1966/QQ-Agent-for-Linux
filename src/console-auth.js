import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const COOKIE = 'qqa_session';
const TTL = 8 * 60 * 60 * 1000;

export class ConsoleAuth {
  constructor(dir, { password = process.env.QQ_AGENT_CONSOLE_PASSWORD, maxSessions = 16 } = {}) {
    this.file = path.join(dir, 'console-auth.json');
    this.initialFile = path.join(dir, 'console-initial-password.txt');
    this.password = password;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
    this.attempts = new Map();
    this.hashing = 0;
    this.changing = false;
  }
  async init(log = console.log) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    if (this.password) {
      if (typeof this.password !== 'string' || this.password.length < 12 || this.password.length > 256) throw new Error('QQ_AGENT_CONSOLE_PASSWORD 需为 12–256 个字符');
      const salt = crypto.randomBytes(16).toString('hex');
      this.environmentCredentials = { salt, hash: (await scrypt(this.password, salt, 32)).toString('hex'), initial: false };
      this.password = undefined;
      return;
    }
    try {
      this.credentials = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!/^[a-f0-9]{32}$/.test(this.credentials.salt) || !/^[a-f0-9]{64}$/.test(this.credentials.hash)) throw new Error('控制台凭据文件损坏');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      let password;
      try { password = (await fs.readFile(this.initialFile, 'utf8')).trim(); }
      catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
      if (!password) {
        password = crypto.randomBytes(18).toString('base64url');
        await fs.writeFile(this.initialFile, `${password}\n`, { mode: 0o600, flag: 'wx' });
      }
      await this.savePassword(password, true);
      log(`控制台首次密码已写入 ${this.initialFile}，登录后请修改密码。`);
    }
  }
  async savePassword(password, initial = false) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw Object.assign(new Error('密码需为 12–256 个字符'), { status: 400, expose: true });
    const salt = crypto.randomBytes(16).toString('hex');
    const credentials = { salt, hash: (await scrypt(password, salt, 32)).toString('hex'), initial };
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(credentials), { mode: 0o600 });
    await fs.rename(tmp, this.file);
    this.credentials = credentials;
  }
  authorized(req) {
    const token = /(?:^|;\s*)qqa_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (!token) return false;
    const key = hash(token);
    const session = this.sessions.get(key);
    if (!session || session.until < Date.now()) { this.sessions.delete(key); return false; }
    return true;
  }
  cookie(req, token, maxAge = TTL / 1000) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.socket.encrypted ? '; Secure' : ''}`;
  }
  async verify(req, password) {
    const now = Date.now();
    for (const [ip, row] of this.attempts) if (row.until <= now) this.attempts.delete(ip);
    const ip = req.socket.remoteAddress || 'unknown';
    if ((this.attempts.get(ip)?.failures || 0) >= 5 || this.hashing >= 2) throw Object.assign(new Error('尝试过于频繁，请稍后重试'), { status: 429, expose: true });
    this.hashing++;
    try {
      const credentials = this.environmentCredentials || this.credentials;
      const candidate = (await scrypt(typeof password === 'string' && password.length <= 256 ? password : '', credentials.salt, 32));
      const ok = crypto.timingSafeEqual(candidate, Buffer.from(credentials.hash, 'hex'));
      if (ok) this.attempts.delete(ip);
      else {
        if (!this.attempts.has(ip) && this.attempts.size >= 256) this.attempts.delete(this.attempts.keys().next().value);
        const old = this.attempts.get(ip);
        this.attempts.set(ip, { failures: (old?.failures || 0) + 1, until: old?.until || now + 15 * 60 * 1000 });
      }
      return ok;
    } finally { this.hashing--; }
  }
  newSession(req, res) {
    for (const [key, session] of this.sessions) if (session.until < Date.now()) this.sessions.delete(key);
    while (this.sessions.size >= this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(hash(token), { until: Date.now() + TTL });
    res.setHeader('set-cookie', this.cookie(req, token));
  }
  async handle(req, res, pathname, { json, readBody, originAllowed }) {
    if (!pathname.startsWith('/api/auth/')) return false;
    if (!originAllowed(req)) { json(res, 403, { error: '请求来源不被信任' }); return true; }
    try {
      if (pathname === '/api/auth/session' && req.method === 'GET') {
        json(res, 200, { authenticated: this.authorized(req), mustChangePassword: (this.environmentCredentials || this.credentials).initial,
          environmentPassword: !!this.environmentCredentials });
      } else if (pathname === '/api/auth/login' && req.method === 'POST') {
        const body = await readBody(req, { maxBytes: 4096 });
        if (!await this.verify(req, body.password)) json(res, 401, { error: '密码错误' });
        else { this.newSession(req, res); json(res, 200, { ok: true, mustChangePassword: (this.environmentCredentials || this.credentials).initial }); }
      } else if (pathname === '/api/auth/logout' && req.method === 'POST') {
        const token = /(?:^|;\s*)qqa_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
        if (token) this.sessions.delete(hash(token));
        res.setHeader('set-cookie', this.cookie(req, '', 0));
        json(res, 200, { ok: true });
      } else if (pathname === '/api/auth/password' && req.method === 'POST') {
        if (!this.authorized(req)) json(res, 401, { error: '请先登录' });
        else if (this.environmentCredentials) json(res, 409, { error: '密码由部署环境设置，请修改 QQ_AGENT_CONSOLE_PASSWORD 后重启' });
        else if (this.changing) json(res, 409, { error: '正在修改密码' });
        else {
          this.changing = true;
          try {
            const body = await readBody(req, { maxBytes: 4096 });
            if (!await this.verify(req, body.oldPassword)) json(res, 401, { error: '原密码错误' });
            else {
              await this.savePassword(body.password);
              await fs.unlink(this.initialFile).catch(() => {});
              this.sessions.clear(); this.newSession(req, res); json(res, 200, { ok: true });
            }
          } finally { this.changing = false; }
        }
      } else json(res, 404, { error: '未知认证接口' });
    } catch (error) { if (!error.expose) throw error; json(res, error.status, { error: error.message }); }
    return true;
  }
  close() { this.sessions.clear(); this.attempts.clear(); }
}
