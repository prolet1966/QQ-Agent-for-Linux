import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireProcessLock } from '../src/process-lock.js';
import { runStorageMaintenance } from '../src/storage-maintenance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockModule = new URL('../src/instance-lock.js', import.meta.url).href;
const roots = [];
function temporary() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-instance-lock-')); roots.push(dir); return dir; }
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

test('same-process reacquisition refuses a live lock, release permits restart, and cleanup is idempotent', () => {
  const dataDir = temporary();
  const source = `import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
    const lock=await import(${JSON.stringify(lockModule)});
    assert.equal(lock.acquireInstanceLock().ok,true);
    assert.equal(lock.acquireInstanceLock().ok,false);
    const before=['exit','SIGINT','SIGTERM'].map(event=>process.listenerCount(event));
    lock.registerLockCleanup();lock.registerLockCleanup();
    assert.deepEqual(['exit','SIGINT','SIGTERM'].map(event=>process.listenerCount(event)),before.map(count=>count+1));
    lock.releaseInstanceLock();assert.equal(fs.existsSync(path.join(process.env.QQ_AGENT_DATA_DIR,'qq-agent.lock')),false);
    assert.equal(lock.acquireInstanceLock().ok,true);lock.releaseInstanceLock();
    console.log('same-process lock passed');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir } });
  assert.equal(result.status, 0, result.stderr);
});

test('two child processes contend for one lock without dual ownership, including stale recovery', async () => {
  for (const stale of [false, true]) {
    const dataDir = temporary();
    if (stale) fs.writeFileSync(path.join(dataDir, 'qq-agent.lock'), '2147483647');
    const source = `const lock=await import(${JSON.stringify(lockModule)});
      process.on('message',message=>{if(message==='acquire'){const result=lock.acquireInstanceLock();process.send({result});}
      else if(message==='stop'){lock.releaseInstanceLock();process.exit(0);}});
      process.send({ready:true});`;
    const children = [];
    let timeout;
    try {
      const ready = [], results = [];
      for (let index = 0; index < 2; index++) {
        const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: ROOT,
          env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        children.push(child);
        ready.push(new Promise((resolve, reject) => {
          child.on('message', message => { if (message.ready) resolve(); }); child.once('error', reject);
        }));
        results.push(new Promise((resolve, reject) => {
          child.on('message', message => { if (message.result) resolve(message.result); }); child.once('error', reject);
        }));
      }
      const deadline = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('child lock test timed out')), 5000); });
      await Promise.race([Promise.all(ready), deadline]);
      for (const child of children) child.send('acquire');
      const acquired = await Promise.race([Promise.all(results), deadline]);
      assert.equal(acquired.filter(result => result.ok).length, 1, JSON.stringify(acquired));
      const winner = acquired.findIndex(result => result.ok), loser = 1 - winner;
      assert.equal(Number(fs.readFileSync(path.join(dataDir, 'qq-agent.lock'), 'utf8')), children[winner].pid);
      // A refused contender must not delete the winner's lock during cleanup.
      await new Promise(resolve => { children[loser].once('exit', resolve); children[loser].send('stop'); });
      assert.equal(Number(fs.readFileSync(path.join(dataDir, 'qq-agent.lock'), 'utf8')), children[winner].pid);
      await new Promise(resolve => { children[winner].once('exit', resolve); children[winner].send('stop'); });
      assert.equal(fs.existsSync(path.join(dataDir, 'qq-agent.lock')), false);
      assert.equal(fs.existsSync(path.join(dataDir, 'qq-agent.lock.recovery')), false);
    } finally {
      clearTimeout(timeout);
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  }
});

test('an empty or malformed lock is not removed while another starter may be writing', () => {
  for (const content of ['', 'invalid', '-1', '1.5']) {
    const dataDir = temporary(); const file = path.join(dataDir, 'qq-agent.lock'); fs.writeFileSync(file, content);
    const source = `const lock=await import(${JSON.stringify(lockModule)});console.log(JSON.stringify(lock.acquireInstanceLock()));lock.releaseInstanceLock();`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir } });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});

test('same-process core construction refuses overlap and releases failed-construction resources before rebuilding', { timeout: 15000 }, () => {
  const dataDir = temporary();
  const appModule = new URL('../src/app.js', import.meta.url).href;
  const source = `import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
    const {createApp}=await import(${JSON.stringify(appModule)});const dir=process.env.QQ_AGENT_DATA_DIR;
    fs.writeFileSync(path.join(dir,'message-storage.json'),JSON.stringify({backend:'sqlite'}));
    assert.throws(()=>createApp({log(){}}),/数据库不存在/);
    const until=Date.now()+4000;while(fs.existsSync(path.join(dir,'qq-agent.lock'))&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(fs.existsSync(path.join(dir,'qq-agent.lock')),false,'failed construction must release owned lock after cleanup');
    fs.unlinkSync(path.join(dir,'message-storage.json'));
    const first=createApp({log(){}});assert.throws(()=>createApp({log(){}}),/单实例/);
    assert.equal(Number(fs.readFileSync(path.join(dir,'qq-agent.lock'),'utf8')),process.pid);
    await first.stop();assert.equal(fs.existsSync(path.join(dir,'qq-agent.lock')),false);
    const rebuilt=createApp({log(){}});await rebuilt.stop();
    assert.equal(fs.existsSync(path.join(dir,'qq-agent.lock')),false);console.log('createApp lock and cleanup passed');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: ROOT, encoding: 'utf8', timeout: 12000,
    env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_MODE: 'server', QQ_AGENT_PRESET: 'server-2c2g', QQ_AGENT_PROTOCOL_MODE: 'external' } });
  assert.equal(result.status, 0, `${result.error?.message || ''}\n${result.stdout}\n${result.stderr}`);
});

test('core and storage maintenance share lock ownership across processes and failed contenders cannot release it', async () => {
  const dataDir = temporary(), file = path.join(dataDir, 'qq-agent.lock');
  let child;
  try {
    const source = `const lock=await import(${JSON.stringify(lockModule)});const result=lock.acquireInstanceLock();process.send({result});
      process.on('message',message=>{if(message==='stop'){lock.releaseInstanceLock();process.exit(0);}});`;
    child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: ROOT,
      env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const result = await new Promise((resolve, reject) => { child.once('message', message => resolve(message.result)); child.once('error', reject); });
    assert.equal(result.ok, true);
    await assert.rejects(runStorageMaintenance({ operation: 'migrate', dataDir }), /仍在运行/);
    assert.equal(Number(fs.readFileSync(file, 'utf8')), child.pid);
    await new Promise(resolve => { child.once('exit', resolve); child.send('stop'); });

    const owned = acquireProcessLock(file); assert.equal(owned.ok, true);
    await assert.rejects(runStorageMaintenance({ operation: 'migrate', dataDir }), /本进程已有/);
    const maintenanceModule = new URL('../src/storage-maintenance.js', import.meta.url).href;
    const maintenanceSource = `const {runStorageMaintenance}=await import(${JSON.stringify(maintenanceModule)});try{await runStorageMaintenance({operation:'migrate',dataDir:process.env.QQ_AGENT_DATA_DIR});process.exit(2);}catch(error){console.log(error.message);}`;
    const blocked = spawnSync(process.execPath, ['--input-type=module', '-e', maintenanceSource], { cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir } });
    assert.equal(blocked.status, 0, blocked.stderr); assert.match(blocked.stdout, /仍在运行/);
    assert.equal(Number(fs.readFileSync(file, 'utf8')), process.pid);
    owned.release();
    const migrated = await runStorageMaintenance({ operation: 'migrate', dataDir });
    assert.equal(migrated.backend, 'sqlite'); assert.equal(fs.existsSync(file), false);
  } finally { if (child?.exitCode === null) child.kill(); }
});
