import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildServer, createServerArchive } from '../scripts/build-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = [];
function temporary() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-build-test-')); roots.push(dir); return dir; }
test.after(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function unpack(archive, destination) {
  const tar = zlib.gunzipSync(fs.readFileSync(archive));
  const files = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(x => x === 0)) break;
    const text = (start, count) => header.subarray(start, start + count).toString().replace(/\0.*$/, '');
    const name = [text(345,155),text(0,100)].filter(Boolean).join('/');
    assert.equal(name.startsWith('qq-agent-server/'), true);
    assert.equal(name.includes('..'), false);
    const size = parseInt(text(124,12),8);
    const target = path.join(destination, name.slice('qq-agent-server/'.length));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, tar.subarray(offset + 512, offset + 512 + size)); files.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

test('server artifact uses current source/exact lock, omits desktop and private state, and detects tampering', { timeout: 120000 }, async () => {
  const result = await buildServer({ outputDir: temporary() });
  const unpacked = temporary(); const files = unpack(result.archive, unpacked);
  const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'server-manifest.json'), 'utf8'));
  assert.equal(files.length, manifest.files.length + 1);
  assert.equal(manifest.source.lockSha256, sha(path.join(ROOT, 'package-lock.json')));
  assert.equal(sha(path.join(unpacked, 'src/server.js')), sha(path.join(ROOT, 'src/server.js')));
  assert.equal(sha(path.join(unpacked, 'package-lock.json')), sha(path.join(ROOT, 'package-lock.json')));
  assert.equal(files.some(file => /qq-agent-server\/(?:electron|snowluma|runtime|ci-input|data|skills|plugins)(?:\/|$)/.test(file)), false);
  assert.equal(fs.existsSync(path.join(unpacked, 'node_modules/electron')), false);
  assert.equal(fs.existsSync(path.join(unpacked, 'node_modules/ws')), true);
  const verify = () => spawnSync(process.execPath, [path.join(unpacked, 'scripts/server/verify-release.mjs'), unpacked], { encoding: 'utf8' });
  assert.equal(verify().status, 0);
  fs.appendFileSync(path.join(unpacked, 'src/server.js'), '\n//changed');
  assert.notEqual(verify().status, 0);
});

test('archive metadata and compression reproduce independently of source file mtimes', async () => {
  const source = temporary(); fs.mkdirSync(path.join(source, 'scripts'));
  fs.writeFileSync(path.join(source, 'scripts/a.sh'), '#!/bin/sh\necho fixture\n');
  fs.writeFileSync(path.join(source, 'README.md'), 'test\n');
  const destination = temporary(); const a = path.join(destination, 'first.tar.gz'), b = path.join(destination, 'second.tar.gz');
  await createServerArchive(source, a, 1700000000);
  fs.utimesSync(path.join(source, 'README.md'), new Date(), new Date());
  await createServerArchive(source, b, 1700000000);
  assert.equal(sha(a), sha(b));
  const tar = zlib.gunzipSync(fs.readFileSync(a));
  assert.equal(tar.subarray(108,116).toString(), '0000000\0');
});

test('failed installer restores only managed core release/unit/status, and fresh installs stay stopped', { skip: process.platform !== 'linux' }, () => {
  const installer = fs.readFileSync(path.join(ROOT, 'scripts/server/install-server.sh'), 'utf8');
  const rollbackFunction = installer.slice(installer.indexOf('rollback_install() {'), installer.indexOf('finish_install()'));
  assert.ok(rollbackFunction.includes('rollback_install()'));
  for (const managed of [true, false]) {
    const dir = temporary(); const install = path.join(dir, 'install');
    fs.mkdirSync(path.join(install, 'releases/new'), { recursive: true });
    fs.mkdirSync(path.join(install, 'releases/old'), { recursive: true });
    fs.mkdirSync(path.join(install, 'releases/older'), { recursive: true });
    fs.symlinkSync(path.join(install, 'releases/new'), path.join(install, 'current'));
    fs.symlinkSync(path.join(install, 'releases/old'), path.join(install, 'previous'));
    const unit = path.join(dir, 'unit.service'), backup = path.join(dir, 'old.service'), log = path.join(dir, 'calls.log');
    fs.writeFileSync(unit, 'new unit'); fs.writeFileSync(backup, 'old unit');
    const fixture = path.join(dir, 'rollback-test.sh');
    fs.writeFileSync(fixture, `#!/usr/bin/env bash\nset -eu\n${rollbackFunction}\nsystemctl() { printf '%s\\n' "$*" >> "$FIXTURE_LOG"; }\ninstall_root="$FIXTURE_INSTALL"\nunit_file="$FIXTURE_UNIT"\nold_unit_backup="$FIXTURE_BACKUP"\nold_current="$FIXTURE_OLD"\nold_previous="$FIXTURE_OLDER"\nold_unit_present=${managed ? 1 : 0}\nold_service_active=${managed ? 1 : 0}\nold_service_enabled=0\nswitched=1\nrollback_install\n`);
    const result = spawnSync('bash', [fixture], { encoding: 'utf8', env: { ...process.env,
      FIXTURE_LOG: log, FIXTURE_INSTALL: install, FIXTURE_UNIT: unit, FIXTURE_BACKUP: backup,
      FIXTURE_OLD: managed ? path.join(install, 'releases/old') : '', FIXTURE_OLDER: managed ? path.join(install, 'releases/older') : '' } });
    assert.equal(result.status, 0, result.stderr);
    const calls = fs.readFileSync(log, 'utf8');
    assert.doesNotMatch(calls, /snowluma|qq-agent-qq|electron/i);
    if (managed) {
      assert.equal(fs.realpathSync(path.join(install, 'current')), path.join(install, 'releases/old'));
      assert.equal(fs.realpathSync(path.join(install, 'previous')), path.join(install, 'releases/older'));
      assert.equal(fs.readFileSync(unit, 'utf8'), 'old unit');
      assert.match(calls, /start qq-agent-server\.service/);
    } else {
      assert.equal(fs.existsSync(path.join(install, 'current')), false);
      assert.equal(fs.existsSync(unit), false);
      assert.doesNotMatch(calls, /start qq-agent-server\.service/);
    }
  }
});

test('installer validates quoted or invalid ports before switching the managed core', { skip: process.platform !== 'linux' }, () => {
  const installer = fs.readFileSync(path.join(ROOT, 'scripts/server/install-server.sh'), 'utf8');
  assert.ok(installer.indexOf('QQ_AGENT_PORT 无效') < installer.indexOf('switched=1'), 'port validation must precede every switch');
  for (const portValue of ['3210', '"3210"', "'3210'", 'invalid', '65536']) {
    const dir = temporary(); const install = path.join(dir, 'install'), data = path.join(dir, 'data');
    const current = path.join(install, 'releases/current'), previous = path.join(install, 'releases/previous');
    fs.mkdirSync(current, { recursive: true }); fs.mkdirSync(previous, { recursive: true }); fs.mkdirSync(data);
    fs.symlinkSync(current, path.join(install, 'current')); fs.symlinkSync(previous, path.join(install, 'previous'));
    const unit = path.join(dir, 'unit.service'), envFile = path.join(dir, 'server.env'), archive = path.join(dir, 'archive.tar.gz');
    fs.writeFileSync(unit, 'original unit\n'); fs.writeFileSync(envFile, `QQ_AGENT_DATA_DIR=${data}\nQQ_AGENT_PORT=${portValue}\n`); fs.writeFileSync(archive, 'fixture');
    const node = path.join(dir, 'node-fixture'); fs.writeFileSync(node, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const log = path.join(dir, 'calls.log'), fixture = path.join(dir, 'install-preflight.sh');
    // Run the actual installer through its complete preflight. Reaching the
    // mutation section is a success marker; an invalid port must exit before it.
    const isolated = installer
      .replace("[[ $EUID -eq 0 ]] || { echo '请以 root 运行安装器' >&2; exit 2; }", ': # fixture root check')
      .replaceAll('/etc/systemd/system/qq-agent-server.service', unit)
      .replaceAll('/etc/qq-agent/server.env', envFile)
      .replaceAll('/run/qq-agent-server-unit.XXXXXX', path.join(dir, 'backup.XXXXXX'))
      .replace('switched=0\nrollback_install()', 'printf "validated-port=%s\\n" "$health_port"\nexit 0\nswitched=0\nrollback_install()');
    fs.writeFileSync(fixture, `#!/usr/bin/env bash\nid() { if [[ "$1" == -gn ]]; then printf 'fixture\\n'; fi; return 0; }\nrunuser() { shift 3; "$@"; }\nsystemctl() { printf '%s\\n' "$*" >> "$FIXTURE_LOG"; return 0; }\n${isolated}`);
    const result = spawnSync('bash', [fixture, archive, install, data, 'qqa', node], { encoding: 'utf8', env: { ...process.env, FIXTURE_LOG: log } });
    if (portValue.includes('3210')) {
      assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /validated-port=3210/);
    } else {
      assert.equal(result.status, 2, result.stderr); assert.doesNotMatch(result.stdout, /validated-port/);
    }
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    assert.doesNotMatch(calls, /(?:^|\n)(?:stop|start|restart|enable|disable) /);
    assert.equal(fs.realpathSync(path.join(install, 'current')), current);
    assert.equal(fs.realpathSync(path.join(install, 'previous')), previous);
    assert.equal(fs.readFileSync(unit, 'utf8'), 'original unit\n');
  }
});

test('manual rollback restores unit/runtime and recovers an unhealthy prior core', { skip: process.platform !== 'linux' }, () => {
  const rollback = fs.readFileSync(path.join(ROOT, 'scripts/server/rollback-server.sh'), 'utf8');
  for (const scenario of ['active', 'inactive', 'unhealthy', 'missing-snapshot']) {
    const dir = temporary();
    const install = path.join(dir, 'install');
    const old = path.join(install, 'releases/old'), current = path.join(install, 'releases/current');
    fs.mkdirSync(old, { recursive: true }); fs.mkdirSync(current, { recursive: true });
    fs.mkdirSync(path.join(install, 'unit-state'));
    fs.symlinkSync(current, path.join(install, 'current')); fs.symlinkSync(old, path.join(install, 'previous'));
    const node = path.join(dir, 'node-fixture');
    fs.writeFileSync(node, '#!/bin/sh\ncat >/dev/null\nexit "$FIXTURE_HEALTH"\n', { mode: 0o755 });
    const oldUnit = `[Service]\nExecStart=${node} ${old}/src/server.js\n# old runtime/unit\n`;
    const liveUnit = path.join(dir, 'unit.service');
    fs.writeFileSync(liveUnit, 'current unit\n');
    if (scenario !== 'missing-snapshot') fs.writeFileSync(path.join(install, 'unit-state/old.service'), oldUnit);
    const envFile = path.join(dir, 'server.env'); fs.writeFileSync(envFile, 'QQ_AGENT_PORT="3210"\n');
    const log = path.join(dir, 'calls.log');
    const fixture = path.join(dir, 'rollback-fixture.sh');
    const isolated = rollback
      .replace("[[ $EUID -eq 0 ]] || { echo '请以 root 运行回滚器' >&2; exit 2; }", ': # fixture root check')
      .replaceAll('/etc/systemd/system/qq-agent-server.service', liveUnit)
      .replaceAll('/etc/qq-agent/server.env', envFile)
      .replaceAll('/run/qq-agent-server-rollback.XXXXXX', path.join(dir, 'backup.XXXXXX'));
    fs.writeFileSync(fixture, `#!/usr/bin/env bash\nsystemctl() { printf '%s\\n' "$*" >> "$FIXTURE_LOG"; if [[ "$1" == is-active ]]; then [[ "$FIXTURE_ACTIVE" == 1 ]]; else return 0; fi; }\nsleep() { return 0; }\n${isolated}`);
    const result = spawnSync('bash', [fixture, install], { encoding: 'utf8', env: { ...process.env,
      FIXTURE_LOG: log, FIXTURE_ACTIVE: scenario === 'inactive' ? '0' : '1', FIXTURE_HEALTH: scenario === 'unhealthy' ? '1' : '0' } });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    assert.doesNotMatch(calls, /snowluma|qq-agent-qq|electron/i);
    if (scenario === 'unhealthy' || scenario === 'missing-snapshot') {
      assert.equal(result.status, scenario === 'unhealthy' ? 1 : 2, result.stderr);
      assert.equal(fs.realpathSync(path.join(install, 'current')), current);
      assert.equal(fs.realpathSync(path.join(install, 'previous')), old);
      assert.equal(fs.readFileSync(liveUnit, 'utf8'), 'current unit\n');
      if (scenario === 'missing-snapshot') assert.equal(calls, '');
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.realpathSync(path.join(install, 'current')), old);
      assert.equal(fs.realpathSync(path.join(install, 'previous')), current);
      assert.equal(fs.readFileSync(liveUnit, 'utf8'), oldUnit);
      if (scenario === 'inactive') assert.doesNotMatch(calls, /start qq-agent-server\.service/);
      else assert.match(calls, /start qq-agent-server\.service/);
    }
    assert.equal(fs.readdirSync(dir).some(file => file.startsWith('backup.')), false);
  }
});
