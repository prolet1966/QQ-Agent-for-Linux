// check-plugin-api.mjs —— 静态检查 V0.3.1 插件是否调用了 V0.4.4 不提供的 api 方法。
//
// 为什么必须先查：
//   V0.4.4 对插件只暴露一组有限的方法（registerTool / config / isSkillActive /
//   capability / hasCapability / log / warn / error / fetch / utils）。
//   若某个旧插件调用了 api.xxx（V0.4.4 没有这个 xxx），在**调用那一刻**才会抛
//   TypeError，而且很可能发生在某次真实消息处理中 —— 表现为"机器人突然不回话"，
//   排查起来极其痛苦。
//   静态扫一遍能在纳入之前就把这类插件挑出来。
//
// V0.4.4 的 api 表面（取自 src/plugin-loader.js 第 90-140 行）：
const V044_API = new Set([
  'registerTool', 'config', 'isSkillActive', 'capability', 'hasCapability',
  'log', 'warn', 'error', 'fetch', 'utils',
]);

import fs from 'node:fs';
import path from 'node:path';

const OLD_V031 = 'E:\\QQ-Agent V0.3.1 For developer\\develop\\plugins';
const V044_PLUGINS = 'E:\\Program Files\\QQ Agent\\QQ Agent v0.4 setup\\resources\\app\\plugins';

const installed = new Set(
  fs.readdirSync(V044_PLUGINS).filter((n) => fs.statSync(path.join(V044_PLUGINS, n)).isDirectory())
);

const dirs = fs.readdirSync(OLD_V031)
  .filter((n) => fs.statSync(path.join(OLD_V031, n)).isDirectory())
  .filter((n) => !installed.has(n));

console.log(`待纳入插件：${dirs.length} 个（V0.4.4 已装的 ${installed.size} 个除外）\n`);

let riskyCount = 0;
const report = [];

for (const name of dirs) {
  const dir = path.join(OLD_V031, name);
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) files.push(p);
    }
  };
  walk(dir);

  // 收集该插件用到的所有 api.<method>
  const usedApi = new Set();
  const fileApis = new Map();
  let totalBytes = 0;

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    totalBytes += src.length;
    const found = new Set();
    // 匹配 api.xxx(  以及解构形式 const { xxx } = api
    for (const m of src.matchAll(/\bapi\.([A-Za-z_$][\w$]*)/g)) {
      usedApi.add(m[1]);
      found.add(m[1]);
    }
    // 注意：有些插件用参数名不是 api（比如 sk / ctx），这类漏检要在真实加载测试里补
    if (found.size) fileApis.set(path.relative(dir, f), [...found].sort());
  }

  const unknown = [...usedApi].filter((m) => !V044_API.has(m)).sort();
  const known = [...usedApi].filter((m) => V044_API.has(m)).sort();

  // 清单
  let manifestOk = false;
  let manifestFile = '';
  for (const cand of ['skill.json', 'plugin.json']) {
    const p = path.join(dir, cand);
    if (fs.existsSync(p)) {
      manifestOk = true;
      manifestFile = cand;
      break;
    }
  }

  if (unknown.length) riskyCount++;
  report.push({ name, files: files.length, bytes: totalBytes, manifestOk, manifestFile, known, unknown, fileApis });
}

console.log('插件名                   文件  大小   清单        已知api                        未知api');
console.log('─'.repeat(140));
for (const r of report) {
  const flag = r.unknown.length ? '⚠️ ' : '   ';
  console.log(
    `${flag}${r.name.padEnd(22)} ${String(r.files).padStart(3)}  ${String(Math.round(r.bytes / 1024)).padStart(4)}KB  ` +
    `${(r.manifestFile || '(无)').padEnd(11)} ` +
    `${(r.known.join(',') || '—').slice(0, 30).padEnd(30)} ` +
    `${r.unknown.join(',') || '—'}`
  );
}

console.log('\n' + '═'.repeat(140));
if (riskyCount === 0) {
  console.log('✅ 全部插件只使用 V0.4.4 提供的方法，静态检查无风险');
} else {
  console.log(`⚠️  ${riskyCount} 个插件调用了 V0.4.4 未提供的方法：`);
  for (const r of report) {
    if (!r.unknown.length) continue;
    console.log(`\n   ${r.name}`);
    console.log(`     未知方法: ${r.unknown.join(', ')}`);
    for (const [f, apis] of r.fileApis) {
      const bad = apis.filter((a) => r.unknown.includes(a));
      if (bad.length) console.log(`       ${f}: ${bad.join(', ')}`);
    }
  }
}

console.log('\n注：本检查只覆盖 `api.xxx` 形式。若插件用别的形参名（sk/ctx/host）接 api，');
console.log('    静态扫描查不到，需要靠真实加载测试兜底。');
