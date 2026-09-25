// direct-load-test.mjs —— 直接调用 V0.4.4 的插件加载器，拿到每个插件/技能的**加载结果**。
//
// 为什么不用「启动整个 app 看日志」：
//   并入的插件大多 enabledByDefault=false，默认关闭时**不打印任何日志**。
//   于是「日志里没出现」既可能是「没加载」也可能是「加载了但没启用」——
//   分不清。而这两者的后果完全不同：前者是缺陷，后者是正常设计。
//
//   loadPlugins() 返回 { loaded, failed }，skillManager.list() 给出每个条目的
//   loaded / enabled / loadError，才是权威答案。
//
// 放置位置：必须放进 app 目录内，才能解析到 app/node_modules。

import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// 依赖 electron 的模块不能直接 import（会报 cannot find electron）。
// loadPlugins 本身不依赖 electron —— 但 skillManager 链路上可能间接依赖，
// 所以用 try 包住并给出清晰提示。
let loadPlugins, skillManager;
try {
  const loaderUrl = pathToFileURL(path.join(APP, 'src', 'plugin-loader.js')).href;
  const mod = await import(loaderUrl);
  loadPlugins = mod.loadPlugins;
  if (!loadPlugins) throw new Error('plugin-loader.js 未导出 loadPlugins');
} catch (err) {
  console.error('❌ 无法导入 plugin-loader.js');
  console.error('   ' + (err?.message ?? err));
  console.error('   提示：本脚本必须放在 app 目录内运行（node test/direct-load-test.mjs）');
  process.exit(2);
}

try {
  const mgr = await import(pathToFileURL(path.join(APP, 'src', 'skills', 'manager.js')).href);
  skillManager = mgr.skillManager;
} catch (err) {
  console.error('⚠️  无法导入 skillManager，改用 loadPlugins 的返回值判断');
  console.error('   ' + (err?.message ?? err));
}

console.log('############ 插件/技能加载结果（直连加载器）############');
console.log('  APP:', APP);
console.log('  插件目录:', fs.readdirSync(path.join(APP, 'plugins')).length, '个');
console.log('  技能目录:', fs.readdirSync(path.join(APP, 'skills')).length, '个');
console.log('');

const logs = [];
const result = await loadPlugins({ log: (m) => logs.push(String(m)) });

console.log('== loadPlugins() 返回值 ==');
console.log('  已加载:', result?.loaded?.length ?? '?');
console.log('  失败  :', result?.failed?.length ?? '?');

if (result?.failed?.length) {
  console.log('\n== 加载失败清单 ==');
  for (const f of result.failed) {
    console.log(`  ❌ ${f.id ?? f.name ?? '(无名)'}`);
    if (f.error) console.log(`       ${String(f.error).slice(0, 200)}`);
  }
} else {
  console.log('\n  ✅ 没有任何条目加载失败');
}

if (skillManager) {
  const all = skillManager.list();
  console.log(`\n== skillManager 登记总数: ${all.length} ==`);

  const loaded = all.filter((s) => s.loaded);
  const enabled = all.filter((s) => s.enabled);
  const withErr = all.filter((s) => s.loadError || s.error);

  console.log(`  已加载  : ${loaded.length}`);
  console.log(`  已启用  : ${enabled.length}  （其余为 enabledByDefault=false，属正常）`);
  console.log(`  有加载错误: ${withErr.length}`);

  if (withErr.length) {
    console.log('\n== 有错误的条目 ==');
    for (const s of withErr) {
      console.log(`  ⚠️  ${s.id}: ${String(s.loadError || s.error).slice(0, 180)}`);
    }
  }

  // 按目录来源分类统计
  const pluginsDir = path.join(APP, 'plugins') + path.sep;
  const skillsDir = path.join(APP, 'skills') + path.sep;
  const fromPlugins = all.filter((s) => (s.dir || s.path || '').startsWith(pluginsDir));
  const fromSkills = all.filter((s) => (s.dir || s.path || '').startsWith(skillsDir));
  console.log(`\n  来自 plugins/ : ${fromPlugins.length}`);
  console.log(`  来自 skills/  : ${fromSkills.length}`);

  console.log('\n== 全部条目（id / 来源 / 加载 / 启用）==');
  const rows = all
    .map((s) => ({
      id: s.id,
      src: (s.dir || s.path || '').startsWith(pluginsDir) ? 'plugins' : 'skills',
      loaded: s.loaded ? '✅' : '❌',
      enabled: s.enabled ? '开' : '—',
      err: s.loadError ? String(s.loadError).slice(0, 40) : '',
    }))
    .sort((a, b) => (a.src + a.id).localeCompare(b.src + b.id));
  for (const r of rows) {
    console.log(`  ${r.loaded} ${r.src.padEnd(8)} ${String(r.id).padEnd(28)} ${r.enabled.padEnd(3)} ${r.err}`);
  }
} else {
  console.log('\n== loadPlugins 返回的 loaded 列表 ==');
  for (const r of result?.loaded ?? []) {
    console.log('  ' + (r.id ?? r.name));
  }
}

// 汇总判据
const failedN = result?.failed?.length ?? 0;
const errN = skillManager ? skillManager.list().filter((s) => s.loadError).length : 0;
console.log('\n' + '═'.repeat(72));
if (failedN === 0 && errN === 0) {
  console.log('  ✅ 结论：全部插件与技能加载成功，零失败零错误');
  process.exit(0);
} else {
  console.log(`  ❌ 结论：${failedN} 个失败，${errN} 个有加载错误 —— 需处理`);
  process.exit(1);
}
