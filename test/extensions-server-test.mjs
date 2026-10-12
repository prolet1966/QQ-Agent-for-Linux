import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import vm from 'node:vm';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-extensions-test-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.env.QQ_AGENT_MODE = 'server';
const loader = await import('../src/plugin-loader.js');
const { skillManager } = await import('../src/skills/manager.js');
const config = await import('../src/config.js');
const { setSkillEnabled } = await import('../src/skills/config.js');
const { getTool } = await import('../src/tool-registry.js');
const { importZip, importModules } = await import('../src/module-import.js');
const { parseZip, unzipToModuleDir } = await import('../src/zip-install.js');
const { readBoundedDownload, publishModule, installByCode } = await import('../src/market.js');
const quiet = () => {};

// Small deterministic ZIP fixture. Reader tests do not rely on platform zip tools.
function archive(files, { declaredSize, compressed = false } = {}) {
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content);
    const payload = compressed ? deflateRawSync(bytes) : bytes;
    const filename = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(compressed ? 8 : 0, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(declaredSize ?? bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    chunks.push(local, filename, payload);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
    header.writeUInt16LE(compressed ? 8 : 0, 10);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(declaredSize ?? bytes.length, 24);
    header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(offset, 42);
    central.push(header, filename);
    offset += local.length + filename.length + payload.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

test('extensions live in writable data, disabled code never executes, and toggling disposes it', async () => {
  assert.equal(loader.SKILLS_DIR, path.join(dataDir, 'extensions', 'skills'));
  loader.prepareExtensionRoots();
  const bridge = await import(pathToFileURL(path.join(dataDir, 'extensions', 'src', 'config.js')).href);
  assert.equal(bridge.getConfig, config.getConfig, 'legacy relative imports share the app config instance');

  const dir = path.join(loader.SKILLS_DIR, 'fixture-folder');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({
    id: 'fixture', name: 'Fixture', enabledByDefault: false, settings: { limit: 3 }
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), `
    import { DATA_DIR } from '../../src/config.js';
    globalThis.fixtureImports = (globalThis.fixtureImports || 0) + 1;
    export function setup(api) {
      globalThis.fixtureSetups = (globalThis.fixtureSetups || 0) + 1;
      globalThis.fixtureDataDir = DATA_DIR;
      api.registerTool({ id: 'probe', name: 'Probe', description: 'fixture', execute: async () => 'ok' });
    }
    export function deactivate() { globalThis.fixtureStops = (globalThis.fixtureStops || 0) + 1; }
    export function dispose() { globalThis.fixtureDisposals = (globalThis.fixtureDisposals || 0) + 1; }
  `);
  await loader.loadPlugins({ log: quiet });
  assert.equal(globalThis.fixtureImports, undefined);
  assert.equal(globalThis.fixtureSetups, undefined);
  const disabled = skillManager.status('fixture');
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.loaded, false);
  assert.equal(disabled.loadError, '');
  assert.equal(skillManager.settingsOf('fixture').limit, 3);
  assert.equal(skillManager.summary().disabled, 1);
  assert.equal(skillManager.summary().broken, 0);

  setSkillEnabled('fixture', true);
  await loader.loadPlugins({ log: quiet });
  assert.equal(globalThis.fixtureImports, 1);
  assert.equal(globalThis.fixtureSetups, 1);
  assert.equal(globalThis.fixtureDataDir, dataDir);
  assert.equal(skillManager.status('fixture').loaded, true);
  assert.ok(getTool('fixture__probe'));

  // Publishing resolves the loader's directory even when manifest ID differs.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.ok(options.body.get('file').size > 0);
    return new Response('{"ok":true}', { status: 200 });
  };
  try { assert.equal((await publishModule({ kind: 'skill', id: 'fixture', token: 'test' })).ok, true); }
  finally { globalThis.fetch = realFetch; }

  setSkillEnabled('fixture', false);
  await loader.loadPlugins({ log: quiet });
  assert.equal(globalThis.fixtureImports, 1);
  assert.equal(globalThis.fixtureStops, 1);
  assert.equal(globalThis.fixtureDisposals, 1);
  assert.equal(getTool('fixture__probe'), null);
  fs.rmSync(dir, { recursive: true });
  const res = await loader.loadPlugins({ log: quiet });
  assert.deepEqual(res.pruned, ['fixture']);
  assert.equal(skillManager.registry.get('fixture'), null);
});

test('ZIP import selects manifest kind, collision does not overwrite, and package remains disabled', async () => {
  const zip = archive({
    'download/plugin.json': JSON.stringify({ id: 'download', enabledByDefault: false }),
    'download/index.js': 'throw new Error("disabled entry must not run")'
  });
  const first = await importZip(zip, { kind: 'skill' });
  const second = await importZip(zip, { kind: 'skill' });
  assert.equal(first.kind, 'plugin');
  assert.equal(first.dir, path.join(loader.PLUGINS_DIR, 'download'));
  assert.equal(second.id, 'download_1');
  await loader.loadPlugins({ log: quiet });
  assert.equal(skillManager.status('download').loadError, '');
  assert.equal(skillManager.status('download').enabled, false);
  const result = await importModules({ zipBase64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') });
  assert.equal(result.installed.length, 0);
  assert.match(result.errors[0].error, /8MB/);
});

test('downloads stop at the byte cap for both declared and chunked responses', async () => {
  let cancelled = false;
  const source = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); },
    cancel() { cancelled = true; }
  });
  await assert.rejects(readBoundedDownload(new Response(source), 10), /8MB/);
  assert.equal(cancelled, true);
  await assert.rejects(readBoundedDownload(new Response('small', { headers: { 'content-length': '999' } }), 10), /8MB/);
  assert.equal((await readBoundedDownload(new Response('valid'), 10)).toString(), 'valid');
});

test('marketplace and local ZIP share the install roots and package type detection', async () => {
  const zip = archive({
    'market-fixture/plugin.json': JSON.stringify({ id: 'market-fixture', enabledByDefault: false }),
    'market-fixture/index.js': 'export const providers = {};'
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(zip);
  try {
    const installed = await installByCode({ code: 'TEST', verified: { ok: true, id: 'wrong', type: 'skill' } });
    assert.equal(installed.kind, 'plugin', 'downloaded manifest takes precedence over browser-provided type');
    assert.equal(installed.dir, path.join(loader.PLUGINS_DIR, 'market-fixture'));
  } finally { globalThis.fetch = realFetch; }
});

test('ZIP rejects traversal, malformed offsets, and oversized output before allocation', async () => {
  assert.throws(() => parseZip(archive({ '../escape.js': 'export {}' })), /非法路径/);
  assert.throws(() => parseZip(archive({ 'C:/escape.js': 'export {}' })), /非法路径/);
  assert.throws(() => parseZip(archive({ 'entry.js': 'x' }, { declaredSize: 33 * 1024 * 1024, compressed: true })), /32MB/);
  const broken = archive({ 'index.js': 'export {}' });
  broken.writeUInt32LE(0xfffffffe, broken.length - 6);
  assert.throws(() => parseZip(broken), /截断|偏移/);
  const id = await unzipToModuleDir(archive({ 'index.js': 'export {}' }), {
    root: loader.EXTENSIONS_DIR, type: 'skill', preferId: '../escape'
  });
  assert.equal(id, 'module');
  assert.ok(fs.existsSync(path.join(loader.SKILLS_DIR, 'module', 'index.js')));
});

test('browser toggle can enable a manifest-only disabled module', async () => {
  class Input {
    constructor() { this.dataset = { skillToggle: 'disabled' }; this.style = {}; this.checked = true; this.handlers = {}; }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    closest() { return { addEventListener() {} }; }
  }
  const input = new Input();
  const box = { querySelectorAll: (selector) => selector === 'input[data-skill-toggle]' ? [input] : [] };
  const requests = [];
  const context = vm.createContext({
    state: { skills: [{ id: 'disabled', loaded: false, enabled: false, loadError: '' }] },
    HTMLInputElement: Input,
    $: (selector) => selector === '#skills-page' ? box : null,
    api: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { skill: { id: 'disabled', loaded: true, enabled: true } };
    },
    alert: (message) => { throw new Error(message); }
  });
  vm.runInContext(fs.readFileSync(new URL('../ui/app/06-settings-render.js', import.meta.url), 'utf8'), context);
  context.bindModuleDropZone = () => {};
  context.setupCardDrag = () => {};
  context.loadSkillsStatus = async () => {};
  context.renderModulePage = () => {};
  context.bindModulePageEvents('skill');
  await input.handlers.change();
  assert.deepEqual(requests, [{ url: '/api/skills/disabled', body: { enabled: true } }]);
});

test.after(() => {
  for (const id of skillManager.registry.clear()) skillManager.capabilities.removeOwner(id);
  // Only this test-owned, resolved temporary directory is removed.
  assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(dataDir, { recursive: true, force: true });
});
