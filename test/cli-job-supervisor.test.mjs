import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, lstatSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import jobModule from '../src/cli-job-supervisor.ts';
import lifeModule from '../src/cli-turn-lifecycle.ts';
import journalModule from '../src/cli-turn-journal.ts';
import treeModule from '../src/cli-process-tree.ts';
import nodePty from 'node-pty';
const { createWindowsCliSupervisor, getCliJobControl } = jobModule;
const { CliTurnLifecycle } = lifeModule;
const { CliTurnJournal, cliTurnHash } = journalModule;
const { registerOwnedCliProcess, terminateCliProcessTree } = treeModule;
const helperPath = resolve('native/cli-job/bin', `win32-${process.arch}`, 'empir3-cli-job.exe');
const windows = { skip: process.platform !== 'win32', timeout: 30_000 };
const pause = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, label) {
  const deadline = Date.now() + 7000;
  while (!check()) { if (Date.now() > deadline) throw Error('Timed out: ' + label); await pause(20); }
}
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'empir3-native-job-'));
  const journal = new CliTurnJournal(join(dir, 'turns.sqlite'));
  const lifecycle = new CliTurnLifecycle(() => ({ store: journal, binding: cliTurnHash('native-test') }),
    createWindowsCliSupervisor({ helperPath, root: join(dir, 'jobs'), ...options }));
  const scope = lifecycle.begin('codex', 'native-turn', { prompt: 'private fixture only' });
  const owned = [];
  t.after(async () => {
    try { scope.close(); } catch {}
    for (const entry of owned) {
      try { getCliJobControl(entry)?.cancel(); await getCliJobControl(entry)?.waitForStop(); } catch { try { entry.kill(); } catch {} }
    }
    journal.close();
    // The fresh directory is exclusively owned by this fixture; never follow
    // links during cleanup, and don't touch any live Bridge profile.
    const remove = path => {
      for (const name of readdirSync(path)) { const child = join(path, name), stat = lstatSync(child);
        if (stat.isDirectory() && !stat.isSymbolicLink()) remove(child); else unlinkSync(child); }
      rmdirSync(path);
    };
    assert.equal(resolve(dir, '..'), resolve(tmpdir())); remove(dir);
  });
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
  const node = parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'spawnCli');
  assert.ok(node);
  const compiled = ts.transpileModule(node.getText(parsed) + '\nglobalThis.launch=spawnCli;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { process, basename, existsSync, cliTurnLifecycle: lifecycle, normalizeCliShim: x => x, spawn, registerOwnedCliProcess };
  vm.runInNewContext(compiled, context);
  const launch = (args, stdio = ['ignore', 'pipe', 'pipe']) => scope.run(() => {
    const child = context.launch(process.execPath, args, { cwd: dir, env: process.env, stdio }); owned.push(child); return child;
  });
  return { dir, lifecycle, scope, launch, owned, journal };
}

function worker(f) {
  const script = join(f.dir, 'worker.cjs'), pidFile = join(f.dir, 'pids.json'), finish = join(f.dir, 'finish');
  writeFileSync(script, `const fs=require('fs'),{spawn}=require('child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));
    console.log('READY');setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)}))process.exit(0)},20);`);
  return { script, pidFile, finish };
}

for (const mode of ['ordinary', 'pty']) test(`${mode}: actual launch containment stops descendants and preserves unrelated processes`, windows, async t => {
  const f = fixture(t), w = worker(f);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const unrelatedClosed = once(unrelated, 'close');
  t.after(async () => { unrelated.kill(); await unrelatedClosed; });
  let child, closed, output = '';
  if (mode === 'ordinary') {
    child = f.launch([w.script]); closed = once(child, 'close');
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  } else {
    child = f.scope.run(() => f.lifecycle.spawn(process.execPath, [w.script], { cwd: f.dir, env: process.env, name: 'xterm', cols: 100, rows: 30, useConpty: true },
      (file, args, opts) => registerOwnedCliProcess(nodePty.spawn(file, args, opts), 'native-test-pty'), true));
    f.owned.push(child); closed = new Promise(r => child.onExit(r)); child.onData(data => { output += data; });
  }
  await until(() => existsSync(w.pidFile), 'provider spawned: ' + output);
  const pids = JSON.parse(readFileSync(w.pidFile)); assert.ok(pids.every(alive));
  assert.ok(getCliJobControl(child), 'actual launch attached its private job control');
  const result = await terminateCliProcessTree(child, { reason: 'native test stop' });
  assert.equal(result.ok, true, result.error);
  await closed;
  assert.ok(pids.every(pid => !alive(pid)), 'receipt is only accepted after root and descendant stop');
  assert.ok(alive(unrelated.pid));
  assert.equal((await terminateCliProcessTree(child)).ok, true, 'same receipt after close, without reusing the PID');
});

test('normal root completion kills its detached-stream descendant before close and retains evidence', windows, async t => {
  const f = fixture(t), w = worker(f), child = f.launch([w.script]);
  const closed = once(child, 'close'); child.stdout.resume(); child.stderr.resume();
  await until(() => existsSync(w.pidFile), 'worker');
  const pids = JSON.parse(readFileSync(w.pidFile));
  writeFileSync(w.finish, 'finish');
  const [code] = await closed; assert.equal(code, 0);
  await getCliJobControl(child).waitForStop();
  assert.ok(pids.every(pid => !alive(pid)));
  f.scope.close('done');
  assert.equal(f.journal.reconcile(cliTurnHash('native-test'), 'codex', 'native-turn', cliTurnHash({ prompt: 'private fixture only' })).phase, 'uncertain',
    'local native proof alone must not claim remote side effects reconciled');
  const folder = join(f.dir, 'jobs', readdirSync(join(f.dir, 'jobs'))[0]);
  const names = readdirSync(folder);
  assert.equal(names.some(n => n.endsWith('.json')), false, 'prompt-bearing launch config consumed');
  assert.equal(names.filter(n => n.endsWith('.result')).length, 1);
  const binding = JSON.parse(readFileSync(join(folder, names.find(n => n.endsWith('.binding')))));
  assert.equal(binding.receipt.id, 'native-turn'); assert.equal(JSON.stringify(binding).includes('private fixture'), false);
});

test('scope closure cancels every overlapping attempt and permanently fences late retries', windows, async t => {
  const f = fixture(t);
  const children = [f.launch(['-e', 'setInterval(()=>{},1000)']), f.launch(['-e', 'setInterval(()=>{},1000)'])];
  const closed = children.map(child => { child.stdout.resume(); child.stderr.resume(); return once(child, 'close'); });
  f.scope.close('error');
  await Promise.all(children.map(child => getCliJobControl(child).waitForStop())); await Promise.all(closed);
  assert.throws(() => f.launch(['-e', 'process.exit(99)']), /already settled/);
});

test('missing native helper refuses the actual runner instead of launching uncontained', windows, async t => {
  const f = fixture(t, { helperPath: resolve('native/cli-job/bin/missing.exe') });
  assert.throws(() => f.launch(['-e', 'process.exit(99)']), /ENOENT|missing/);
  assert.equal(f.owned.length, 0);
});

test('actual spawn boundary preserves Unicode stdin and argument boundaries', windows, async t => {
  const f = fixture(t), arg = 'spaces & symbols 日本語';
  const child = f.launch(['-e', "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>console.log(JSON.stringify([process.argv[1],s])))", arg], ['pipe', 'pipe', 'pipe']);
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.resume();
  const closed = once(child, 'close'); child.stdin.end('héllo\n世界');
  assert.equal((await closed)[0], 0); assert.deepEqual(JSON.parse(output), [arg, 'héllo\n世界']);
  await getCliJobControl(child).waitForStop();
});

test('changed stop receipt is refused even after root exit; no PID fallback can target an unrelated process', windows, async t => {
  const f = fixture(t), child = f.launch(['-e', 'process.exit(0)']);
  child.stdout.resume(); child.stderr.resume(); await once(child, 'close');
  const folder = join(f.dir, 'jobs', readdirSync(join(f.dir, 'jobs'))[0]);
  const file = join(folder, readdirSync(folder).find(name => name.endsWith('.result')));
  const original = readFileSync(file, 'utf8'), bad = JSON.parse(original); bad.nonce = '0'.repeat(64);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const closed = once(unrelated, 'close');
  t.after(async () => { unrelated.kill(); await closed; });
  const originalPid = child.pid; child.pid = unrelated.pid;
  writeFileSync(file, JSON.stringify(bad));
  try {
    const result = await terminateCliProcessTree(child);
    assert.equal(result.ok, false); assert.match(result.error, /identity/);
    assert.ok(alive(unrelated.pid), 'a receipt failure must not invoke taskkill or owner.kill');
  } finally { child.pid = originalPid; writeFileSync(file, original); }
});
