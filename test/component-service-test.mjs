import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requestComponentAction } from '../src/protocol-service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t, handler) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-components-'));
  const target = process.platform === 'win32' ? `\\\\.\\pipe\\qqa-components-${process.pid}-${Date.now()}` : path.join(temp, 'socket');
  const server = net.createServer(handler);
  await new Promise(resolve => server.listen(target, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(temp, { recursive: true, force: true }); });
  return target;
}

test('component socket accepts one bounded request and propagates a refusal', async t => {
  const packets = [];
  const target = await fixture(t, socket => socket.once('data', data => {
    packets.push(JSON.parse(data)); socket.end(JSON.stringify({ ok: false, error: 'service unavailable' }) + '\n');
  }));
  await assert.rejects(requestComponentAction(target, 'desktop', 'start'), /service unavailable/);
  assert.deepEqual(packets, [{ kind: 'desktop', action: 'start' }]);
  await assert.rejects(requestComponentAction(target, 'arbitrary.service', 'start'), /无效/);
  await assert.rejects(requestComponentAction(target, 'desktop', 'enable'), /无效/);
  assert.equal(packets.length, 1);
});

test('component socket caps responses and times out a silent peer', async t => {
  const sockets = new Set();
  const target = await fixture(t, socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => socket.write('x'.repeat(9000)));
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  await assert.rejects(requestComponentAction(target, 'snow', 'start'), /响应超限/);
  const silent = await fixture(t, socket => { socket.on('error', () => {}); socket.resume(); });
  await assert.rejects(requestComponentAction(silent, 'snow', 'stop', { timeoutMs: 40 }), /超时/);
});

test('root component broker rejects malformed or arbitrary operations before systemctl', { skip: process.platform !== 'linux' }, () => {
  for (const packet of ['bad\n', '{}\n', '{"kind":"desktop","action":"enable"}\n',
    '{"kind":"ssh.service","action":"stop"}\n', '{"kind":"desktop","action":"start","unit":"ssh.service"}\n',
    '{"kind":[],"action":"start"}\n', 'x'.repeat(257) + '\n']) {
    const result = spawnSync('/usr/bin/python3', [path.join(root, 'scripts/server/component-broker.py')], { input: packet, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal(result.stderr, '');
  }
});

test('SnowLuma launcher runs through a current release symlink and captures the initial password', { skip: process.platform !== 'linux' }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-snow-link-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const release = path.join(temp, 'release'); await fs.mkdir(release);
  await fs.copyFile(path.join(root, 'scripts/server/snowluma-launcher.mjs'), path.join(release, 'snowluma-launcher.mjs'));
  const current = path.join(temp, 'current'); await fs.symlink(release, current);
  await fs.writeFile(path.join(temp, 'index.mjs'), 'console.log("initial credentials: password=fixture-bootstrap-pass");\n');
  const result = spawnSync(process.execPath, [path.join(current, 'snowluma-launcher.mjs')], { cwd: temp, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /REDACTED/);
  assert.doesNotMatch(result.stdout, /fixture-bootstrap-pass/);
  const credential = path.join(temp, 'config/qqa-initial-password.txt');
  assert.equal((await fs.readFile(credential, 'utf8')).trim(), 'fixture-bootstrap-pass');
  assert.equal((await fs.stat(credential)).mode & 0o777, 0o600);
});
