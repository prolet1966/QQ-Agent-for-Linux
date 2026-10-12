#!/usr/bin/env node
// Build from this checkout and the exact lockfile. No desktop runtime, user
// data, bundled extensions or ci-input archive enters the server artifact.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${args[0] || ''} 失败：${String(result.stderr || result.stdout).slice(-4000)}`);
  return String(result.stdout || '').trim();
}
function nodeNpmCli() {
  const candidates = [process.env.QQ_AGENT_NPM_CLI,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  for (const file of candidates) if (fs.existsSync(file)) return file;
  throw new Error('找不到 npm-cli.js；请用 QQ_AGENT_NPM_CLI 指定 npm 的绝对 JS 入口。');
}

export function filesUnder(root) {
  const files = [];
  function walk(dir, relative = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.name === '.bin' || entry.name === '.package-lock.json') continue;
      const local = relative ? `${relative}/${entry.name}` : entry.name;
      if (/[\r\n\x00]/.test(local)) throw new Error(`不支持含控制字符的包路径：${local}`);
      if (entry.isSymbolicLink()) throw new Error(`服务器包不允许符号链接：${local}`);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), local);
      else if (entry.isFile()) files.push(local);
      else throw new Error(`服务器包不允许特殊文件：${local}`);
    }
  }
  walk(root); return files;
}

function writeTarField(header, offset, size, value) {
  const encoded = Buffer.from(String(value));
  if (encoded.length > size) throw new Error(`tar 字段超长：${value}`);
  encoded.copy(header, offset);
}
export function tarHeader(name, size, mode, epoch) {
  const header = Buffer.alloc(512);
  let base = name, prefix = '';
  if (Buffer.byteLength(base) > 100) {
    for (let split = name.lastIndexOf('/'); split > 0; split = name.lastIndexOf('/', split - 1)) {
      if (Buffer.byteLength(name.slice(split + 1)) <= 100 && Buffer.byteLength(name.slice(0, split)) <= 155) {
        prefix = name.slice(0, split); base = name.slice(split + 1); break;
      }
    }
    if (!prefix) throw new Error(`USTAR 路径超过 255 字节：${name}`);
  }
  writeTarField(header, 0, 100, base);
  writeTarField(header, 100, 8, `${mode.toString(8).padStart(7, '0')}\0`);
  writeTarField(header, 108, 8, '0000000\0'); writeTarField(header, 116, 8, '0000000\0');
  writeTarField(header, 124, 12, `${size.toString(8).padStart(11, '0')}\0`);
  writeTarField(header, 136, 12, `${epoch.toString(8).padStart(11, '0')}\0`);
  header.fill(32, 148, 156); header[156] = 48;
  writeTarField(header, 257, 6, 'ustar\0'); writeTarField(header, 263, 2, '00');
  writeTarField(header, 265, 32, 'root'); writeTarField(header, 297, 32, 'root');
  writeTarField(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarField(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

export async function createServerArchive(sourceDir, destination, epoch) {
  const files = filesUnder(sourceDir);
  async function* tar() {
    for (const name of files) {
      const file = path.join(sourceDir, name);
      const size = fs.statSync(file).size;
      yield tarHeader(`qq-agent-server/${name}`, size, /\.sh$/.test(name) ? 0o755 : 0o644, epoch);
      let read = 0;
      for await (const chunk of fs.createReadStream(file)) { read += chunk.length; yield chunk; }
      if (read !== size) throw new Error(`打包时文件发生变化：${name}`);
      const padding = (512 - size % 512) % 512;
      if (padding) yield Buffer.alloc(padding);
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(tar()), createGzip({ level: 9 }), fs.createWriteStream(destination, { mode: 0o644 }));
}

export async function buildServer({ root = ROOT, outputDir = path.join(root, 'dist/server') } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16)) throw new Error('服务器构建需要 Node >=22.16；验收基线为 22.17.1。');
  root = path.resolve(root); outputDir = path.resolve(outputDir);
  const packageFile = path.join(root, 'package.json');
  const lockFile = path.join(root, 'package-lock.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const commit = run('git', ['rev-parse', 'HEAD'], root);
  const dirty = run('git', ['status', '--porcelain=v1', '--untracked-files=normal'], root).split(/\r?\n/).filter(Boolean);
  const sourceEpoch = process.env.SOURCE_DATE_EPOCH || run('git', ['show', '-s', '--format=%ct', 'HEAD'], root);
  const epoch = Number(sourceEpoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('SOURCE_DATE_EPOCH 无效');
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-server-build-'));
  const stage = path.join(stageRoot, 'qq-agent-server'); fs.mkdirSync(stage);
  try {
    const dirs = ['src', 'ui', 'assets', 'deploy'];
    for (const dir of dirs) if (fs.existsSync(path.join(root, dir))) fs.cpSync(path.join(root, dir), path.join(stage, dir), { recursive: true, dereference: false });
    fs.mkdirSync(path.join(stage, 'docs')); fs.mkdirSync(path.join(stage, 'scripts'));
    for (const file of fs.readdirSync(path.join(root, 'docs')).filter(file => /\.md$/i.test(file))) fs.copyFileSync(path.join(root, 'docs', file), path.join(stage, 'docs', file));
    for (const file of ['message-storage.mjs', 'verify-no-missing-requires.mjs']) fs.copyFileSync(path.join(root, 'scripts', file), path.join(stage, 'scripts', file));
    fs.cpSync(path.join(root, 'scripts/server'), path.join(stage, 'scripts/server'), { recursive: true });
    for (const file of ['LICENSE', 'README.md', 'prices.json']) if (fs.existsSync(path.join(root, file))) fs.copyFileSync(path.join(root, file), path.join(stage, file));
    fs.copyFileSync(lockFile, path.join(stage, 'package-lock.json'));
    const serverPackage = { ...pkg, main: 'src/server.js', scripts: { start: 'node src/server.js', server: 'node src/server.js' } };
    delete serverPackage.devDependencies; delete serverPackage.build;
    fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(serverPackage, null, 2)}\n`);
    run(process.execPath, [nodeNpmCli(), 'ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
    fs.rmSync(path.join(stage, 'node_modules/.bin'), { recursive: true, force: true });
    fs.rmSync(path.join(stage, 'node_modules/.package-lock.json'), { force: true });
    run(process.execPath, [path.join(root, 'scripts/verify-no-missing-requires.mjs'), stage], root);
    const files = filesUnder(stage);
    const forbidden = /^(?:electron|snowluma|runtime|ci-input|plugins|skills|data(?:-[^/]+)?)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)[^/]+\.(?:key|pem)$/i;
    for (const file of files) {
      if (forbidden.test(file) || /\.node$/i.test(file) || /(?:^|\/)electron(?:\/|$)/i.test(file)) throw new Error(`服务器产物包含禁止内容：${file}`);
    }
    const manifest = { format: 1, package: 'qq-agent-server', version: pkg.version,
      source: { commit, dirty: dirty.length > 0, changes: dirty, epoch, packageSha256: sha256(packageFile), lockSha256: sha256(lockFile) },
      runtime: { minimumNode: '22.16.0', validatedNode: '22.17.1', mode: 'server', preset: 'server-2c2g', bundledNode: false, bundledProtocol: false },
      files: files.map(file => ({ path: file, size: fs.statSync(path.join(stage, file)).size, sha256: sha256(path.join(stage, file)), mode: /\.sh$/.test(file) ? '0755' : '0644' })),
    };
    fs.writeFileSync(path.join(stage, 'server-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    run(process.execPath, [path.join(stage, 'scripts/server/verify-release.mjs'), stage], root);
    fs.mkdirSync(outputDir, { recursive: true });
    const archive = path.join(outputDir, `qq-agent-server-v${pkg.version}-node22.tar.gz`);
    const tempArchive = `${archive}.${process.pid}.tmp`;
    await createServerArchive(stage, tempArchive, epoch);
    fs.renameSync(tempArchive, archive);
    const digest = sha256(archive);
    fs.writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
    fs.writeFileSync(path.join(outputDir, 'server-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { archive, sha256: digest, files: files.length + 1, sourceCommit: commit, dirty: manifest.source.dirty, bytes: fs.statSync(archive).size };
  } finally { fs.rmSync(stageRoot, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === '--output')) throw new Error('用法：node scripts/build-server.mjs [--output /输出目录]');
    console.log(JSON.stringify(await buildServer(args.length ? { outputDir: args[1] } : {}), null, 2));
  } catch (error) { console.error(`服务器构建失败：${error.message}`); process.exitCode = 1; }
}
