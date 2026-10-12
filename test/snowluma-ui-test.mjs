import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { rewriteSnowlumaAsset } from '../src/snowluma-proxy.js';

test('pinned Vite preload resolver keeps lazy page JS and CSS under the authenticated proxy', () => {
  // Exact helper and dependency table shape from SnowLuma 1.14.22's real client.
  const bundle = 'const deps=["assets/overview-page-Cyb74m32.js","assets/overview-page-Bm3ks5zC.css"];var iy=function(e){return`/`+e};globalThis.urls=deps.map(iy);';
  const context = vm.createContext({});
  vm.runInContext(rewriteSnowlumaAsset(Buffer.from(bundle), 'application/javascript').toString(), context);
  assert.deepEqual(Array.from(context.urls), ['/snowluma/assets/overview-page-Cyb74m32.js', '/snowluma/assets/overview-page-Bm3ks5zC.css']);
});

test('pinned client public-path navigation respects proxy prefix and keeps relative page labels', () => {
  const source = 'var selector={select:e=>e.location.pathname};globalThis.page=selector.select({location:{pathname:"/snowluma/processes"}});window.location.assign(`/`);window.history.replaceState({},``,`/`);var onboarding=`/onboarding?mode=developer`,settings=`/settings?tab=developer`;globalThis.developer=(e=>e.pathname===`/onboarding`)({pathname:"/snowluma/onboarding"});';
  const destinations = [];
  const context = vm.createContext({ window: { location: { assign: url => destinations.push(url) }, history: { replaceState: (_state, _title, url) => destinations.push(url) } } });
  vm.runInContext(rewriteSnowlumaAsset(Buffer.from(source), 'application/javascript').toString(), context);
  assert.equal(context.page, '/processes'); assert.equal(context.developer, true);
  assert.deepEqual(destinations, ['/snowluma/', '/snowluma/']);
  assert.equal(context.onboarding, '/snowluma/onboarding?mode=developer'); assert.equal(context.settings, '/snowluma/settings?tab=developer');
});

test('pinned client avatar and uploaded background requests stay under the proxy', () => {
  const source = 'var id="10001";globalThis.avatar=`/avatar/${encodeURIComponent(id)}`;globalThis.background=`/ui-asset/background?v=1`;globalThis.style=`url("/ui-asset/background?v=1")`;';
  const context = vm.createContext({});
  vm.runInContext(rewriteSnowlumaAsset(Buffer.from(source), 'application/javascript').toString(), context);
  assert.equal(context.avatar, '/snowluma/avatar/10001');
  assert.equal(context.background, '/snowluma/ui-asset/background?v=1');
  assert.equal(context.style, 'url("/snowluma/ui-asset/background?v=1")');
});

function browser(status, responses = {}) {
  const nodes = new Map();
  const calls = [];
  class Node {
    constructor(id = '') { this.id = id; this.handlers = {}; this.textContent = ''; this._html = ''; this.style = {}; }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    get innerHTML() { return this._html; }
    set innerHTML(html) {
      this._html = html;
      if (this.id === 'snowluma-page') {
        nodes.clear(); nodes.set('snowluma-page', this);
        for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], new Node(match[1]));
      }
    }
    querySelector(selector) {
      if (selector.startsWith('#')) return nodes.get(selector.slice(1)) || null;
      if (selector === '.snowluma-page-card' && this.innerHTML.includes('snowluma-page-card')) return this;
      return null;
    }
  }
  const box = new Node('snowluma-page'); nodes.set(box.id, box);
  const errors = [];
  const context = vm.createContext({
    URL, Date, Promise,
    window: { location: { origin: 'http://47.109.97.184:3210' } },
    $: selector => nodes.get(selector.replace(/^#/, '')) || null,
    esc: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
    setTimeout: () => 1,
    console: { error: error => errors.push(error), log: () => {} },
    alert: message => { throw new Error(message); },
    api: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/status') return status;
      if (responses[url]) return responses[url];
      return { logs: [] };
    }
  });
  vm.runInContext(fs.readFileSync(new URL('../ui/app/03-snowluma.js', import.meta.url), 'utf8'), context);
  return { box, nodes, calls, errors, load: () => context.loadSnowlumaPage(), context };
}

test('external protocol mode hides local controls and renders without binding missing elements', async () => {
  const b = browser({ snowluma: { mode: 'external' }, onebot: { connected: false, diagnosis: '外部协议端不可达' }, qqPortable: {} });
  await b.load();
  assert.equal(b.errors.length, 0);
  for (const id of ['quick-start-btn', 'qq-start-btn', 'qq-stop-btn', 'sl-start-btn', 'sl-stop-btn']) assert.equal(b.nodes.has(id), false);
  assert.match(b.box.innerHTML, /由外部协议端管理/);
  assert.doesNotMatch(b.box.innerHTML, /npm run setup/);
});

test('local protocol displays setup steps in order, independent process and WebUI reachability', async () => {
  const b = browser({
    snowluma: { mode: 'local', running: true, webuiReachable: false, managed: true, pid: 12, webuiUrl: '/snowluma/',
      diagnostics: { installed: true, mustChangePassword: true, steps: ['第一步 <配置>', '第二步', '第三步'] } },
    onebot: { connected: false }, qqPortable: { ready: true }, desktop: { enabled: false }
  }, { '/api/snowluma/initial-password': { user: 'admin', password: 'private-initial-password' } });
  await b.load();
  assert.equal(b.errors.length, 0);
  assert.match(b.box.innerHTML, /QQA 托管服务/);
  assert.match(b.box.innerHTML, /WebUI 不可达/);
  assert.match(b.box.innerHTML, /<a[^>]+href="\/snowluma\/"[^>]+target="_blank"/);
  assert.ok(b.box.innerHTML.indexOf('第一步 &lt;配置&gt;') < b.box.innerHTML.indexOf('第二步'));
  assert.ok(b.box.innerHTML.indexOf('第二步') < b.box.innerHTML.indexOf('第三步'));
  assert.equal(b.calls.some(c => c.url.includes('initial-password')), false, 'password must not be fetched automatically');
  await b.nodes.get('sl-initial-password-btn').handlers.click();
  assert.equal(b.calls.at(-1).options.method, 'POST');
  assert.match(b.nodes.get('sl-initial-password').textContent, /管理员：admin，密码：private-initial-password/);
  assert.equal(b.errors.length, 0, 'secret must not be logged');
});

test('desktop service opens only after click and supplies persistent clickable link, then closes', async () => {
  const b = browser({ snowluma: { mode: 'local' }, onebot: { connected: true }, qqPortable: {}, desktop: { enabled: true } }, {
    '/api/qq-desktop/open': { ok: true, url: '/qq-desktop' }, '/api/qq-desktop/close': { ok: true }
  });
  await b.load();
  assert.equal(b.calls.some(c => c.url.startsWith('/api/qq-desktop')), false);
  await b.nodes.get('qq-desktop-open-btn').handlers.click();
  assert.equal(b.calls.at(-1).url, '/api/qq-desktop/open');
  assert.equal(b.calls.at(-1).options.method, 'POST');
  assert.match(b.nodes.get('qq-desktop-hint').innerHTML, /href="\/qq-desktop".*target="_blank"/);
  await b.load();
  assert.match(b.box.innerHTML, /href="\/qq-desktop".*target="_blank"/);
  await b.nodes.get('qq-desktop-close-btn').handlers.click();
  assert.equal(b.calls.at(-1).url, '/api/qq-desktop/close');
  assert.equal(b.calls.at(-1).options.method, 'POST');
  await b.load();
  assert.doesNotMatch(b.box.innerHTML, /href="\/qq-desktop"/);
});

test('protocol links reject executable URL schemes', async () => {
  const b = browser({ snowluma: { mode: 'local', webuiUrl: 'javascript:alert(1)' }, onebot: {}, qqPortable: {} });
  await b.load();
  assert.doesNotMatch(b.box.innerHTML, /javascript:/);
  assert.equal(b.errors.length, 0);
});

test('unsupported server WebUI explains the loopback tunnel without linking browser localhost', async () => {
  const b = browser({
    snowluma: { mode: 'local', running: true, webuiUrl: '', proxySupported: false, tunnelPort: 5123 },
    onebot: {}, qqPortable: {}
  });
  await b.load();
  assert.match(b.box.innerHTML, /SSH 本地转发.*127\.0\.0\.1:5123/);
  assert.match(b.box.innerHTML, /升级至 1\.14\.22/);
  assert.equal(b.nodes.has('sl-open-webui-link'), false);
  assert.doesNotMatch(b.box.innerHTML, /href="http:\/\/127\.0\.0\.1/);
  assert.equal(b.errors.length, 0);
});

test('external OneBot connection makes top readiness indicators reflect externally managed services', () => {
  const dots = Array.from({ length: 4 }, () => ({ addEventListener() {}, dataset: {} }));
  const context = vm.createContext({
    state: { config: {} },
    $: () => ({ addEventListener() {} }),
    $$: () => dots
  });
  vm.runInContext(fs.readFileSync(new URL('../ui/app/01-boot.js', import.meta.url), 'utf8'), context);
  context.updateReadinessDots({ snowluma: { mode: 'external', running: false }, qqPortable: { running: false }, onebot: { connected: true } });
  assert.ok(dots.slice(0, 3).every(dot => dot.className === 'rdot on'));
  assert.match(dots[0].title, /外部协议端管理/);
  assert.match(dots[1].title, /外部协议端已连接/);
  context.updateReadinessDots({ snowluma: { mode: 'external' }, onebot: { connected: false } });
  assert.ok(dots.slice(0, 3).every(dot => dot.className === 'rdot'));
  assert.match(dots[1].title, /等待外部协议端连接/);
  assert.ok(dots.slice(0, 2).every(dot => !dot.title.includes('点击前往启动')));
});

test('refresh reads actual desktop service state and clears stale opened state after expiry', async () => {
  const status = { snowluma: { mode: 'local' }, onebot: {}, desktop: { enabled: true, running: true, state: 'running' } };
  const b = browser(status);
  await b.load();
  assert.match(b.box.innerHTML, /id="qq-desktop-open-btn" disabled/);
  assert.doesNotMatch(b.box.innerHTML, /id="qq-desktop-close-btn" disabled/);
  assert.match(b.box.innerHTML, /href="\/qq-desktop"/);
  status.desktop.running = false; status.desktop.state = 'dead';
  await b.load();
  assert.doesNotMatch(b.box.innerHTML, /id="qq-desktop-open-btn" disabled/);
  assert.match(b.box.innerHTML, /id="qq-desktop-close-btn" disabled/);
  assert.doesNotMatch(b.box.innerHTML, /href="\/qq-desktop"/);
  assert.equal(b.calls.some(call => call.url.startsWith('/api/qq-desktop')), false);
});

test('status route redacts binding credentials and only checks enabled server desktop service', async (t) => {
  const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-status-route-'));
  const prior = { mode: process.env.QQ_AGENT_MODE, data: process.env.QQ_AGENT_DATA_DIR };
  process.env.QQ_AGENT_MODE = 'server'; process.env.QQ_AGENT_DATA_DIR = dir;
  t.after(() => {
    if (prior.mode === undefined) delete process.env.QQ_AGENT_MODE; else process.env.QQ_AGENT_MODE = prior.mode;
    if (prior.data === undefined) delete process.env.QQ_AGENT_DATA_DIR; else process.env.QQ_AGENT_DATA_DIR = prior.data;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { DEFAULT_CONFIG, deepMerge, setRuntimeConfig } = await import('../src/config.js');
  const { createRoutes } = await import('../src/routes.js');
  const checked = [];
  let stoppedSnow = 0; let stoppedQq = 0;
  const routes = createRoutes({
    sessions: { todayUsage: () => ({}) }, onebot: { wsUrl: 'ws://127.0.0.1:3001', connected: true },
    orchestrator: { statusSummary: () => ({}), paused: false }, snowlumaWebuiPort: () => 5099,
    isPortOpen: async () => false, snowlumaDir: () => dir, snowlumaWebuiUrl: () => 'http://127.0.0.1:5099/',
    snowlumaStatus: async () => ({ running: true, embedded: false, pid: null }),
    qqPortableStatus: async () => ({ running: true }), protocolDiagnostics: async () => ({ installed: true }),
    stopSnowluma: async () => { stoppedSnow++; return true; },
    stopPortableQQ: async () => { stoppedQq++; return { ok: true }; },
    snowlumaBindingStatus: () => ({ account: '10001', bound: true, applied: true,
      wsUrl: 'ws://alice:ws-secret@127.0.0.1:3001/?access_token=ws-token&channel=group',
      httpUrl: 'http://bob:http-secret@127.0.0.1:3000/?api_key=http-key&password=pw-query' }),
    protocolService: async (...args) => { checked.push(args); return { ok: true, running: true, state: 'running', pid: 123 }; }
  });
  const handler = routes.find(route => route.pattern === '/api/status').handler;
  async function status(server = true, enabled = true, mode = 'external') {
    process.env.QQ_AGENT_MODE = server ? 'server' : 'desktop';
    setRuntimeConfig(deepMerge(DEFAULT_CONFIG, { snowluma: { mode }, server: { desktopProxy: enabled } }));
    let response;
    await handler({ res: {}, json: (_res, code, body) => { assert.equal(code, 200); response = body; } });
    return response;
  }
  const active = await status();
  assert.deepEqual(checked, [['desktop']]);
  assert.deepEqual(active.desktop, { enabled: true, running: true, state: 'running' });
  const binding = active.snowluma.binding;
  assert.equal(binding.account, '10001'); assert.equal(binding.applied, true);
  for (const secret of ['alice', 'ws-secret', 'ws-token', 'bob', 'http-secret', 'http-key', 'pw-query']) assert.ok(!JSON.stringify(binding).includes(secret), secret);
  assert.equal(new URL(binding.wsUrl).searchParams.get('channel'), 'group');
  assert.equal(new URL(binding.wsUrl).searchParams.get('access_token'), 'REDACTED');
  assert.deepEqual((await status(true, false)).desktop, { enabled: false, running: false, state: '' });
  assert.deepEqual((await status(false, true)).desktop, { enabled: false, running: false, state: '' });
  assert.equal(checked.length, 1, 'desktop service must not be queried when disabled or in desktop app mode');

  for (const endpoint of ['/api/snowluma/stop', '/api/qq-portable/stop']) {
    let response;
    await routes.find(route => route.pattern === endpoint).handler({ res: {}, json: (_res, code, body) => { response = { code, body }; } });
    assert.equal(response.code, 409);
    assert.match(response.body.error, /外部协议端/);
  }
  assert.equal(stoppedSnow, 0); assert.equal(stoppedQq, 0);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.13.5' }));
  const unsupported = (await status(true, false, 'local')).snowluma;
  assert.equal(unsupported.webuiUrl, ''); assert.equal(unsupported.proxySupported, false); assert.equal(unsupported.tunnelPort, 5099);
  assert.equal(unsupported.running, true); assert.equal(unsupported.webuiReachable, false);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.14.22' }));
  const supported = (await status(true, false, 'local')).snowluma;
  assert.equal(supported.webuiUrl, '/snowluma/'); assert.equal(supported.proxySupported, true); assert.equal(supported.tunnelPort, null);
  const local = (await status(false, false, 'local')).snowluma;
  assert.equal(local.webuiUrl, 'http://127.0.0.1:5099/'); assert.equal(local.running, true); assert.equal(local.tunnelPort, null);

  await t.test('desktop app detects an independently running local WebUI', async () => {
    const net = await import('node:net');
    const webui = net.createServer(socket => socket.end());
    await new Promise(resolve => webui.listen(0, '127.0.0.1', resolve));
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'runtime.json'), JSON.stringify({ webuiPort: webui.address().port }));
    setRuntimeConfig(deepMerge(DEFAULT_CONFIG, {
      snowluma: { mode: 'local', dir },
      background: { priceFeed: false, communitySync: false, cacheWarm: false, telemetry: false, usageWarm: false }
    }));
    let app;
    try {
      const { createApp } = await import('../src/app.js');
      app = createApp({ log() {} });
      const running = await app.snowlumaStatus();
      assert.equal(running.running, true); assert.equal(running.embedded, false);
      await new Promise(resolve => webui.close(resolve));
      assert.equal((await app.snowlumaStatus()).running, false);
    } finally {
      if (webui.listening) await new Promise(resolve => webui.close(resolve));
      await app?.stop();
    }
  });
});
