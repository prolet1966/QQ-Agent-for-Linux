// check-skill-compat.mjs —— 检查 V0.3.1 技能能否安全纳入 V0.4.4。
//
// 比插件更麻烦的地方：
//   1. 技能里有若干「同一功能的旧版」，例如 V0.3.1 的 image-gen-skill 与
//      V0.4.4 的 image-generate。两个都装可能造成工具 id 冲突或行为重复，
//      而 V0.4.4 对工具 id 冲突**只是 warning 然后覆盖**（见 plugin-loader L91），
//      不会报错 —— 属于静默故障，必须提前识别。
//   2. 技能清单是 skill.json，带 permissions（如 web_fetch）与 tools。
//      permissions 声明不对 → 运行时 fetch 被拒。
//
// 输出三类结论：可安全纳入 / 可能冲突 / 需要人工判断。

import fs from 'node:fs';
import path from 'node:path';

const V031 = 'E:\\QQ-Agent V0.3.1 For developer\\develop\\skills';
const V044 = 'E:\\Program Files\\QQ Agent\\QQ Agent v0.4 setup\\resources\\app\\skills';

function readManifest(dir) {
  for (const f of ['skill.json', 'plugin.json']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) {
      try { return { file: f, data: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
      catch (e) { return { file: f, error: e.message }; }
    }
  }
  return null;
}

function listDirs(root) {
  return fs.readdirSync(root).filter((n) => {
    try { return fs.statSync(path.join(root, n)).isDirectory(); } catch { return false; }
  });
}

const v044Names = listDirs(V044);
const v044Set = new Set(v044Names);

// 收集 V0.4.4 已有技能的工具 id，用于检测冲突
const v044ToolIds = new Map(); // toolId -> skillName
const v044Manifests = new Map();
for (const n of v044Names) {
  const m = readManifest(path.join(V044, n));
  if (m?.data) {
    v044Manifests.set(n, m.data);
    for (const t of m.data.tools || []) {
      if (t?.id) v044ToolIds.set(String(t.id), n);
    }
  }
}

const candidates = listDirs(V031).filter((n) => !v044Set.has(n));

console.log(`V0.4.4 已有技能 ${v044Names.length} 个，工具 id ${v044ToolIds.size} 个`);
console.log(`V0.3.1 候选新增技能 ${candidates.length} 个\n`);

const ok = [], conflicts = [], problems = [];

for (const name of candidates) {
  const dir = path.join(V031, name);
  const m = readManifest(dir);
  if (!m) { problems.push({ name, why: '无清单文件' }); continue; }
  if (m.error) { problems.push({ name, why: `清单 JSON 解析失败: ${m.error}` }); continue; }

  const d = m.data;
  const apiV = Number(d.apiVersion) || 1;
  const toolIds = (d.tools || []).map((t) => String(t.id || '')).filter(Boolean);
  const clash = toolIds.filter((id) => v044ToolIds.has(id));
  const perms = d.permissions || [];

  const entry = {
    name, manifestFile: m.file, apiVersion: apiV, version: d.version || '?',
    category: d.category || '-', tools: toolIds.length, toolIds,
    permissions: perms, enabledByDefault: d.enabledByDefault,
    requires: d.requires || [],
    hasPrompt: !!d.prompt,
    size: (() => {
      let s = 0;
      const walk = (p) => {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          const q = path.join(p, e.name);
          if (e.isDirectory()) walk(q); else s += fs.statSync(q).size;
        }
      };
      walk(dir); return s;
    })(),
  };

  if (apiV > 1) { problems.push({ name, why: `apiVersion ${apiV} > 1（V0.4.4 只支持 1）` }); continue; }
  if (clash.length) { entry.clash = clash; conflicts.push(entry); }
  else ok.push(entry);
}

function table(rows, title) {
  console.log(`\n${'═'.repeat(120)}`);
  console.log(title);
  console.log('─'.repeat(120));
  console.log('技能名'.padEnd(26) + '版本'.padEnd(10) + '分类'.padEnd(12) + '工具'.padEnd(6) + '权限'.padEnd(12) + '大小'.padEnd(8) + '缺省启用');
  for (const r of rows) {
    console.log(
      r.name.padEnd(26) +
      String(r.version).padEnd(10) +
      String(r.category).padEnd(12) +
      String(r.tools).padEnd(6) +
      (r.permissions.join(',') || '—').padEnd(12) +
      (Math.round(r.size / 1024) + 'KB').padEnd(8) +
      String(r.enabledByDefault ?? '?')
    );
  }
}

table(ok, `✅ 可安全纳入（${ok.length} 个，无工具 id 冲突）`);

if (conflicts.length) {
  table(conflicts, `⚠️  工具 id 与已有技能冲突（${conflicts.length} 个）—— 需人工判断`);
  for (const r of conflicts) {
    for (const id of r.clash) {
      console.log(`      ${r.name} 的工具 "${id}" 与 ${v044ToolIds.get(id)} 冲突`);
    }
  }
}

if (problems.length) {
  console.log(`\n${'═'.repeat(120)}`);
  console.log(`❌ 存在问题（${problems.length} 个）`);
  for (const p of problems) console.log(`      ${p.name}: ${p.why}`);
}

// 需要 web_fetch 权限的（V0.4.4 里 fetch 受该权限门控）
const needFetch = ok.filter((r) => r.permissions.includes('web_fetch'));
console.log(`\n需要 web_fetch 权限的技能 ${needFetch.length} 个：${needFetch.map((r) => r.name).join(', ') || '无'}`);
console.log('（V0.4.4 只在声明了 web_fetch 时才给出真实 fetch，否则返回 reject —— 声明正确即可用）');

const totalSize = [...ok, ...conflicts].reduce((a, r) => a + r.size, 0);
console.log(`\n候选总体积：约 ${Math.round(totalSize / 1024)} KB`);
