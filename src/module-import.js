// 本地导入：把用户拖进来 / 选中的 zip 包或文件夹装进 skills/ 或 plugins/。
//
// 与市场安装（src/market.js）的区别：那个走网络下载，这个走本机路径或前端上传的
// 字节。**安全边界与市场安装同等严格** —— 两者最终都是"往会被 require() 的目录里
// 写可执行 JS"，所以路径穿越、可执行后缀、zip 炸弹这些检查一处都不能少。
//
// 目录名冲突一律递增（_1/_2）而不覆盖：正在运行的插件目录被覆盖写一半，
// 热重载会加载出半截代码；而且覆盖会静默吞掉用户自己改过的文件。
import fs from 'node:fs';
import path from 'node:path';
import { SKILLS_DIR, PLUGINS_DIR } from './plugin-loader.js';
import { unzipToModuleDir, parseZip } from './zip-install.js';

const BANNED_EXT = /\.(exe|dll|bat|cmd|com|msi|scr|ps1|vbs|sh|lnk)$/i;
const SKIP_DIR = new Set(['node_modules', '.git', '.svn', '__pycache__', '.DS_Store']);
const MAX_FILES = 300;
const MAX_TOTAL = 64 * 1024 * 1024;

/** 目录名合法化：只留 [a-zA-Z0-9._-]，空结果回退 fallback。 */
function safeDirName(name, fallback = 'module') {
  const base = String(name || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  const cleaned = base.replace(/\.(zip|ZIP)$/, '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[.-]+/, '');
  if (!cleaned || !/^[a-zA-Z0-9]/.test(cleaned)) return fallback;
  return cleaned.slice(0, 64);
}

/** 目标目录未占用时才用原名，否则递增 _1/_2… */
function allocateDir(baseDir, name) {
  let finalName = name;
  for (let n = 1; n <= 100; n++) {
    if (!fs.existsSync(path.join(baseDir, finalName))) break;
    finalName = `${name}_${n}`;
  }
  return finalName;
}

/**
 * 按内容判断该装到哪一页：plugin.json → 插件，skill.json → 技能。
 * 认不出来才用 kindHint（用户当前所在页）。
 *
 * 为什么要"内容优先"：从市场/别人手里拿到的包，名字和放置位置都不保证对得上；
 * 装错页的代价是"条目在另一页出现、这一页刷新半天没有"，比按内容归档难排查得多。
 */
function detectKind(names, kindHint) {
  const has = (n) => names.some((x) => x === n || x.endsWith('/' + n));
  if (has('plugin.json')) return 'plugin';
  if (has('skill.json')) return 'skill';
  return kindHint === 'plugin' ? 'plugin' : 'skill';
}

const dirOf = (kind) => (kind === 'plugin' ? PLUGINS_DIR : SKILLS_DIR);

/**
 * 导入一个 zip 包。
 * @param {Buffer} buffer
 * @param {{ kind?: string, preferId?: string }} o
 * @returns {Promise<{ kind, id, dir, files }>}
 */
export async function importZip(buffer, { kind = 'skill', preferId = '' } = {}) {
  const entries = parseZip(buffer);          // 内含路径穿越/后缀/数量/体积校验
  const detected = detectKind(entries.map((e) => e.name), kind);
  const baseDir = dirOf(detected);
  fs.mkdirSync(baseDir, { recursive: true });
  const id = await unzipToModuleDir(buffer, { root: path.dirname(baseDir), type: detected, preferId });
  return { kind: detected, id, dir: path.join(baseDir, id), files: entries.length };
}

/**
 * 导入本机的一个目录（整包）或单个文件（包一层目录）。
 * @param {string} src
 * @param {{ kind?: string }} o
 */
export function importPath(src, { kind = 'skill' } = {}) {
  if (!src || typeof src !== 'string') throw new Error('缺少路径');
  const abs = path.resolve(src);
  const stat = fs.statSync(abs);            // 不存在/无权限 → 抛错，由路由转成 400

  if (stat.isFile() && /\.zip$/i.test(abs)) {
    return importZip(fs.readFileSync(abs), { kind, preferId: safeDirName(abs, '') });
  }

  // 单文件（skill.json / index.js …）：包一层以文件名命名的目录，
  // 否则装进去就是散落在 skills/ 根目录里的孤儿文件，永远不会被扫描到。
  if (stat.isFile()) {
    if (BANNED_EXT.test(abs)) throw new Error(`不支持的文件类型：${path.basename(abs)}`);
    const detected = detectKind([path.basename(abs)], kind);
    const baseDir = dirOf(detected);
    fs.mkdirSync(baseDir, { recursive: true });
    const id = allocateDir(baseDir, safeDirName(abs, 'module'));
    const target = path.join(baseDir, id);
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(abs, path.join(target, path.basename(abs)));
    return { kind: detected, id, dir: target, files: 1 };
  }

  // 目录：先整棵扫一遍（順便校验），再复制
  const collected = [];
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR.has(ent.name)) continue;
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { walk(path.join(dir, ent.name), relPath); continue; }
      if (BANNED_EXT.test(ent.name)) throw new Error(`包含禁止的文件类型：${relPath}`);
      const st = fs.statSync(path.join(dir, ent.name));
      collected.push({ abs: path.join(dir, ent.name), rel: relPath, size: st.size });
    }
  };
  walk(abs, '');
  if (!collected.length) throw new Error('这个文件夹是空的');
  if (collected.length > MAX_FILES) throw new Error(`文件数量过多（${collected.length} > ${MAX_FILES}）`);
  const total = collected.reduce((s, f) => s + f.size, 0);
  if (total > MAX_TOTAL) throw new Error('文件总大小超过 64MB');

  const detected = detectKind(collected.map((f) => f.rel), kind);
  const baseDir = dirOf(detected);
  fs.mkdirSync(baseDir, { recursive: true });
  const id = allocateDir(baseDir, safeDirName(abs, 'module'));
  const target = path.join(baseDir, id);
  for (const f of collected) {
    const dest = path.join(target, ...f.rel.split('/'));
    // 二次防线：解析后必须仍在 target 内（符号链接 / 奇怪文件名也挡在这）
    const relCheck = path.relative(target, dest);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      throw new Error(`包含非法路径：${f.rel}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.abs, dest);
  }
  return { kind: detected, id, dir: target, files: collected.length };
}

/**
 * 批量导入：一个失败不影响其它（返回 errors 逐个说明原因）。
 * @param {{ paths?: string[], zipBase64?: string, zipName?: string, kind?: string }} body
 * @returns {Promise<{ installed: Array, errors: Array }>}
 */
export async function importModules({ paths = [], zipBase64 = '', zipName = '', kind = 'skill' } = {}) {
  const installed = [];
  const errors = [];
  for (const p of paths) {
    try {
      const r = await importPath(p, { kind });
      installed.push(r);
    } catch (e) {
      errors.push({ source: path.basename(String(p)), error: String(e?.message ?? e) });
    }
  }
  if (zipBase64) {
    try {
      const buffer = Buffer.from(String(zipBase64), 'base64');
      if (!buffer.length) throw new Error('内容为空');
      const r = await importZip(buffer, { kind, preferId: safeDirName(zipName, '') });
      installed.push(r);
    } catch (e) {
      errors.push({ source: zipName || '上传的包', error: String(e?.message ?? e) });
    }
  }
  return { installed, errors };
}
