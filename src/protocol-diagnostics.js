import fs from 'node:fs/promises';
import path from 'node:path';
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } }
export async function diagnoseSnowluma(dir) {
  if (!dir) return { installed: false, version: '', state: 'not-installed', steps: ['安装匹配架构的 SnowLuma 完整发行包'] };
  const [pkg, runtime, webui] = await Promise.all(['package.json', 'config/runtime.json', 'config/webui.json'].map(file => readJson(path.join(dir, file))));
  let accounts = [];
  try { accounts = (await fs.readdir(path.join(dir, 'config'))).filter(f => /^onebot_\d+\.json$/.test(f)); } catch { /* not configured */ }
  const steps = [];
  if (!webui || webui.mustChangePassword) steps.push('打开 SnowLuma 管理入口，修改初始密码并阅读、确认协议');
  if (runtime?.hookAutoLoad === false) steps.push('SnowLuma 的 Hook 自动加载已关闭，请在管理界面加载 QQ Hook');
  if (!accounts.length) steps.push('检查 QQ 扫码登录、Hook 注入权限和版本兼容，等待账号 OneBot 配置生成');
  let ptraceScope = null;
  if (process.platform === 'linux') { try { ptraceScope = Number((await fs.readFile('/proc/sys/kernel/yama/ptrace_scope', 'utf8')).trim()); } catch {} }
  if (ptraceScope === 3) steps.push('内核 ptrace_scope=3 禁止注入，需要管理员调整运行环境');
  return { installed: !!pkg, version: pkg?.version || '', hookAutoLoad: runtime?.hookAutoLoad ?? null,
    mustChangePassword: webui?.mustChangePassword ?? null, accountConfigCount: accounts.length,
    ptraceScope, display: process.env.DISPLAY || process.env.WAYLAND_DISPLAY || '', steps,
    state: !pkg ? 'not-installed' : steps.length ? 'setup-required' : 'configuration-present' };
}
