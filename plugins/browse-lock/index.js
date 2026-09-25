// browse-lock —— 浏览锁定（宿主 03-image-browse 的 security.browseLock 语义照搬）
//
// 一句话：把「机器人能主动上哪些网站」收窄到一份域名清单。
//   只作用于**主动上网**的工具（web_fetch / web_search / send_image / search_images），
//   **不碰** QQ 自己的图源（表情包、群聊图片）—— 那些不在拦截名单里。
//
// 为什么用 before-tool 钩子：V0.3.1 核心在每次工具调用前跑 before-tool，
//   拿到 { toolName, argsRaw }，插件返回 { block: true, reason } 即可否决这一次调用
//   （orchestrator.js 的注释：「用于 Skill 运行期发现不该执行」）。
//   注：`tool.guard` 能力拿不到参数（只在算工具可用性时调），做不了逐次 URL 校验。
//
// 配置：settings.enabled + settings.domains（逗号分隔）+ settings.includeSubdomains。

import { lockStateFrom, hostAllowed, hostOf, urlsInArgs } from './lib/browsedomains.js';

/** 需要做域名校验的工具（"主动上网"那批）。 */
const GUARDED_TOOLS = new Set(['web_fetch', 'web_search', 'send_image', 'search_images']);

let cfg = () => ({});

function state() {
  const c = cfg();
  const domains = String(c.domains ?? '')
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
  return lockStateFrom({ enabled: c.enabled === true, domains, includeSubdomains: c.includeSubdomains !== false });
}

export function setup(api) {
  cfg = api.config;
  api.log('browse-lock 已加载（主动上网工具的域名白名单守卫；默认关闭）');
}

export function available() {
  const st = state();
  return { ok: true, reason: st.enabled ? ('锁定生效，允许 ' + st.domains.length + ' 个域名') : '未启用（默认放行所有域名）' };
}

export function dispose() {}

export const hooks = {
  /**
   * 工具调用前：锁定生效时，逐跳校验主动上网工具的 URL 主机名。
   * 返回 { block: true, reason } 否决；放行则返回 undefined。
   */
  'before-tool'({ toolName, argsRaw } = {}) {
    try {
      const st = state();
      if (!st.enabled) return undefined;
      const name = String(toolName || '');
      // 去掉 skillId__ 前缀（工具 id 进模型时是 <skillId>__<toolId>）
      const short = name.includes('__') ? name.slice(name.indexOf('__') + 2) : name;
      if (!GUARDED_TOOLS.has(short)) return undefined;

      const urls = urlsInArgs(argsRaw);
      if (!urls.length) return undefined;          // 没有 URL（如 web_search 纯关键词）→ 放行

      for (const u of urls) {
        const h = hostOf(u) || (() => { try { return new URL(u).hostname; } catch { return ''; } })();
        if (h && !hostAllowed(h, st)) {
          return {
            block: true,
            reason: '浏览锁定：' + h + ' 不在允许清单里（当前允许 ' + st.domains.join('/') + '）。'
              + '管理员可在「插件 → browse-lock」里加域名，或关掉浏览锁定。',
          };
        }
      }
      return undefined;
    } catch {
      return undefined;   // 守卫异常一律放行（不因安全插件自身出错而阻断正常聊天）
    }
  },
};
