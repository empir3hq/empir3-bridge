import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sourceModule from '../src/bridge-jobs.ts';
const { BridgeJobRunner, JOB_LIMITS, clampJobTimeout, collectOutputs, globToRegExp, isSafeOutputGlob } = sourceModule;

/** A fake child process: emits scripted stdout/stderr then closes. */
function fakeSpawnFactory(script) {
  const spawned = [];
  const spawn = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    child.killed = false;
    child.file = file; child.args = args; child.opts = opts;
    spawned.push(child);
    setTimeout(() => script(child), 5);
    return child;
  };
  return { spawn, spawned };
}

function deps(root, extra = {}) {
  const terminated = [];
  return {
    terminated,
    deps: {
      jobsDir: join(root, 'jobs'),
      resolveCwd: (name, id) => join(root, 'Projects', `${name}-${id.slice(0, 4)}`),
      resolveShell: (_requested, command) => ({ file: '/bin/sh', args: ['-c', command], shell: 'sh' }),
      register: (child) => child,
      terminate: async (child, opts) => { terminated.push(opts.reason); child.emit('close', null); },
      now: () => 1_700_000_000_000,
      ...extra,
    },
  };
}

test('glob matching is posix, supports ** and never escapes the project', () => {
  assert.equal(globToRegExp('reports/**').test('reports/a/b.md'), true);
  assert.equal(globToRegExp('reports/**/*.json').test('reports/face-scan.json'), true);
  assert.equal(globToRegExp('reports/**/*.json').test('reports/2026/x.json'), true);
  assert.equal(globToRegExp('*.md').test('sub/x.md'), false);
  assert.equal(globToRegExp('out/?.txt').test('out/a.txt'), true);
  assert.equal(isSafeOutputGlob('reports/**'), true);
  assert.equal(isSafeOutputGlob('../secrets/*'), false);
  assert.equal(isSafeOutputGlob('/etc/passwd'), false);
  assert.equal(isSafeOutputGlob('C:/Users/x'), false);
  assert.equal(isSafeOutputGlob(42), false);
});

test('collectOutputs walks the tree with caps and skips node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3-jobs-'));
  try {
    await mkdir(join(root, 'reports', 'deep'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(root, 'reports', 'a.json'), '{}');
    await writeFile(join(root, 'reports', 'deep', 'b.json'), '{}');
    await writeFile(join(root, 'node_modules', 'x', 'c.json'), '{}');
    await writeFile(join(root, 'big.bin'), Buffer.alloc(2048));
    const small = collectOutputs(root, ['reports/**/*.json', '*.bin'], { ...JOB_LIMITS, outputsMaxFileBytes: 1024 });
    assert.deepEqual(small.files.map((f) => f.relPath).sort(), ['reports/a.json', 'reports/deep/b.json']);
    assert.equal(small.skipped, 1);
    assert.equal(small.skippedFiles[0].path, 'big.bin');
    assert.match(small.skippedFiles[0].reason, /2048 bytes.*1024 bytes/);
    const count = collectOutputs(root, ['reports/**/*.json'], { ...JOB_LIMITS, outputsMaxFiles: 1 });
    assert.equal(count.files.length, 1);
    assert.equal(count.skipped, 1);
    assert.match(count.skippedFiles[0].reason, /file count/);
    const total = collectOutputs(root, ['reports/**/*.json'], { ...JOB_LIMITS, outputsMaxTotalBytes: 3 });
    assert.equal(total.files.length, 1);
    assert.equal(total.skipped, 1);
    assert.match(total.skippedFiles[0].reason, /total transfer limit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('timeouts are clamped into the job budget', () => {
  assert.equal(clampJobTimeout(undefined), JOB_LIMITS.defaultTimeoutMs);
  assert.equal(clampJobTimeout(10), 1000);
  assert.equal(clampJobTimeout(999_999_999), JOB_LIMITS.maxTimeoutMs);
  assert.equal(clampJobTimeout(45_000), 45_000);
});

test('a job runs in the project mirror, records output, exit code and a transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3-jobs-'));
  try {
    const { spawn, spawned } = fakeSpawnFactory((child) => {
      child.stdout.emit('data', Buffer.from('scanning 3 cards\n'));
      child.stderr.emit('data', Buffer.from('warn: grainy\n'));
      child.emit('close', 0);
    });
    const d = deps(root, { spawn });
    const runner = new BridgeJobRunner(d.deps);
    const started = runner.start({ projectId: 'e256f965-b4ef-41e2-8cca-86bd767bd436', projectName: 'Anon', command: 'python3 tools/face_gate.py scan' });
    assert.equal(started.ok, true);
    assert.equal(spawned[0].args[1], 'python3 tools/face_gate.py scan');
    assert.equal(spawned[0].opts.cwd, join(root, 'Projects', 'Anon-e256'));
    assert.equal(spawned[0].opts.env.E3_JOB_PLACEMENT, 'my-bridge');
    const done = await runner.wait(started.record.id, 2000);
    assert.equal(done.status, 'done');
    assert.equal(done.exitCode, 0);
    assert.equal(done.stdoutTail, 'scanning 3 cards\n');
    assert.equal(done.stderrTail, 'warn: grainy\n');
    assert.equal(done.placement, 'my-bridge');
    const transcript = await readFile(done.transcriptPath, 'utf8');
    assert.match(transcript, /# \$ python3 tools\/face_gate.py scan/);
    assert.match(transcript, /scanning 3 cards/);
    assert.match(transcript, /status=done exit=0/);
    const logs = runner.logs(started.record.id);
    assert.match(logs.tail, /scanning 3 cards/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the deadline kills the tree and the record says timeout; cancel says cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3-jobs-'));
  try {
    const { spawn } = fakeSpawnFactory(() => { /* never closes on its own */ });
    const d = deps(root, { spawn });
    const runner = new BridgeJobRunner(d.deps);
    const t = runner.start({ projectId: 'p', command: 'sleep 999', timeoutMs: 1000 });
    const rec = await runner.wait(t.record.id, 3000);
    assert.equal(rec.status, 'timeout');
    assert.equal(rec.exitCode, null);
    assert.match(d.terminated[0], /timeout/);

    const c = runner.start({ projectId: 'p', command: 'sleep 999', timeoutMs: 60_000 });
    const cancel = runner.cancel(c.record.id);
    assert.equal(cancel.ok, true);
    const crec = await runner.wait(c.record.id, 3000);
    assert.equal(crec.status, 'cancelled');
    assert.match(d.terminated[1], /cancelled/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a still-running job returns a running snapshot after waitMs, and concurrency is bounded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3-jobs-'));
  try {
    const { spawn } = fakeSpawnFactory(() => { /* runs "forever" */ });
    const d = deps(root, { spawn });
    const runner = new BridgeJobRunner(d.deps, { maxConcurrent: 1 });
    const a = runner.start({ projectId: 'p', command: 'long', timeoutMs: 60_000 });
    const snap = await runner.wait(a.record.id, 50);
    assert.equal(snap.status, 'running');
    const b = runner.start({ projectId: 'p', command: 'another' });
    assert.equal(b.ok, false);
    assert.equal(b.code, 'busy');
    assert.equal(runner.cancel(a.record.id).ok, true);
    await runner.wait(a.record.id, 2000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('outputs matching the globs are pushed back when the job ends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3-jobs-'));
  try {
    const cwd = join(root, 'Projects', 'Anon-e256');
    await mkdir(join(cwd, 'reports'), { recursive: true });
    await writeFile(join(cwd, 'reports', 'face-scan.json'), '{"ok":true}');
    await writeFile(join(cwd, 'notes.txt'), 'not requested');
    const pushed = [];
    const { spawn } = fakeSpawnFactory((child) => child.emit('close', 0));
    const d = deps(root, { spawn, pushOutputFile: async (f) => { pushed.push(f.relPath); return true; } });
    const runner = new BridgeJobRunner(d.deps);
    const s = runner.start({ projectId: 'e256f965-b4ef-41e2-8cca-86bd767bd436', projectName: 'Anon', command: 'x', outputs: ['reports/**'] });
    const rec = await runner.wait(s.record.id, 2000);
    assert.equal(rec.status, 'done');
    assert.deepEqual(pushed, ['reports/face-scan.json']);
    assert.equal(rec.outputs.pushed, 1);
    assert.deepEqual(rec.outputs.files, ['reports/face-scan.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an escaping outputs glob is refused before anything starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3-jobs-'));
  try {
    const { spawn, spawned } = fakeSpawnFactory((child) => child.emit('close', 0));
    const runner = new BridgeJobRunner(deps(root, { spawn }).deps);
    const s = runner.start({ projectId: 'p', command: 'x', outputs: ['../../etc/*'] });
    assert.equal(s.ok, false);
    assert.equal(s.code, 'bad-request');
    assert.equal(spawned.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('job receipts distinguish pending delivery, accepted files and unconfirmed files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3-jobs-'));
  try {
    const cwd = join(root, 'Projects', 'Anon-e256');
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, 'a.dat'), Buffer.from([0, 255, 128]));
    await writeFile(join(cwd, 'b.dat'), Buffer.from([255]));
    let confirm;
    const confirmation = new Promise(resolve => { confirm = resolve; });
    const { spawn, spawned } = fakeSpawnFactory(child => child.emit('close', 0));
    let pushes = 0;
    const runner = new BridgeJobRunner(deps(root, { spawn, pushOutputFile: async f => {
      pushes += 1;
      if (f.relPath === 'a.dat') return confirmation;
      return { accepted: false, reason: 'No workspace acknowledgement; delivery is unknown.' };
    } }).deps);
    const started = runner.start({ projectId: 'e256', projectName: 'Anon', command: 'x', outputs: ['*.dat'] });
    const pending = await runner.wait(started.record.id, 50);
    assert.equal(pending.outputs.deliveryPending, true);
    assert.equal(pending.outputs.pushed, 0);
    spawned[0].emit('close', 0);
    assert.equal(pushes, 1, 'repeated process completion cannot submit the same output twice');
    confirm({ accepted: true });
    const done = await runner.wait(started.record.id, 2000);
    assert.equal(done.outputs.deliveryPending, false);
    assert.equal(done.outputs.matched, 2);
    assert.equal(done.outputs.pushed, 1);
    assert.equal(done.outputs.bytes, 3);
    assert.equal(done.outputs.skipped, 1);
    assert.deepEqual(done.outputs.files, ['a.dat']);
    assert.deepEqual(done.outputs.skippedFiles, [{ path: 'b.dat', reason: 'No workspace acknowledgement; delivery is unknown.' }]);
    done.outputs.skippedFiles[0].reason = 'mutated';
    assert.match((await runner.wait(started.record.id, 0)).outputs.skippedFiles[0].reason, /delivery is unknown/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
