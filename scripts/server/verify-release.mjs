#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

try {
  const root = path.resolve(process.argv[2] || '.');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'server-manifest.json'), 'utf8'));
  if (manifest.format !== 1 || manifest.package !== 'qq-agent-server' || !Array.isArray(manifest.files)) throw new Error('服务器清单格式不正确');
  const expected = new Set(['server-manifest.json']);
  for (const item of manifest.files) {
    if (!item.path || item.path.startsWith('/') || item.path.includes('\\') || item.path.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('清单包含不安全路径');
    if (expected.has(item.path)) throw new Error(`重复文件：${item.path}`);
    expected.add(item.path);
    const file = path.join(root, item.path);
    if (!fs.lstatSync(file).isFile()) throw new Error(`清单成员不是普通文件：${item.path}`);
    if (fs.statSync(file).size !== item.size) throw new Error(`文件大小不匹配：${item.path}`);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (hash !== item.sha256) throw new Error(`文件 SHA256 不匹配：${item.path}`);
  }
  function walk(dir, relative = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), file);
      else if (!entry.isFile() || !expected.has(file)) throw new Error(`产物包含未登记或特殊文件：${file}`);
    }
  }
  walk(root);
  console.log(`服务器包校验通过：${expected.size} 个文件，来源 ${manifest.source.commit}${manifest.source.dirty ? '（包含本地修改）' : ''}`);
} catch (error) { console.error(`服务器包校验失败：${error.message}`); process.exitCode = 1; }
