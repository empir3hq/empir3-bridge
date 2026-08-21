/**
 * Launcher process-handling tests.
 *
 * THE P0 THIS GUARDS: `launch.js` started both halves of the bridge with
 *   spawn('cmd', ['/c','start','/b','npx','tsx', target])
 * and attached NO 'error' listener. `cmd` does not exist on Linux, so the spawn
 * raised ENOENT — and since ChildProcess is an EventEmitter, an 'error' with no
 * listener is re-thrown as an uncaught exception that killed the launcher. The
 * systemd unit the VPS flow installs (`ExecStart=... npm start`, Restart=always)
 * therefore crash-looped forever, behind a `sleep 4; systemctl is-active` check
 * that was too early to notice. The Linux bridge has never actually run.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
const {
  psSnapshot,
  classifyBridgeProcess,
  listOwnedProcesses,
  spawnDetached,
  resolveTsx,
} = require_('../src/proc-util.js');

// ── The P0 ──────────────────────────────────────────────────────────────────

test('THE regression: spawning a nonexistent binary RETURNS, never throws', async () => {
  // Before the fix this exact shape took the whole process down on Linux.
  const priorExitCode = process.exitCode;
  let threw = false;
  let child = null;
  try {
    child = spawnDetached('definitely-not-a-real-binary-xyz', ['--nope'], { stdio: 'ignore' });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'spawnDetached must never throw synchronously');

  // The async 'error' event must be HANDLED rather than becoming an uncaught
  // exception. Give the event loop a tick to deliver it.
  await new Promise(r => setTimeout(r, 250));

  // Handling it still has to be loud: the launcher marks the run failed so a
  // supervisor sees a non-zero exit instead of a silently half-started bridge.
  assert.equal(process.exitCode, 1, 'a failed spawn must mark the process failed');
  process.exitCode = priorExitCode ?? 0; // don't fail this test file itself

  // Do not call kill() on a failed spawn. On POSIX the process handle can
  // briefly exist without a valid positive PID; signaling it can target the
  // test runner's process group instead of a child.
});

test('spawnDetached attaches an error listener', async () => {
  const priorExitCode = process.exitCode;
  const child = spawnDetached('definitely-not-a-real-binary-xyz2', [], { stdio: 'ignore' });
  if (child) {
    assert.ok(child.listenerCount('error') > 0, 'an error listener must be attached');
  }
  await new Promise(r => setTimeout(r, 250));
  process.exitCode = priorExitCode ?? 0;
});

// ── Process identification ──────────────────────────────────────────────────

test('psSnapshot returns real processes on this platform', () => {
  const snap = psSnapshot();
  assert.ok(Array.isArray(snap));
  // A silent empty result is the dangerous failure: the launcher's reap becomes
  // a no-op and a stale bridge keeps the port, so the next launch EADDRINUSEs.
  // (This is exactly what a quoting bug in the Windows CIM call caused.)
  assert.ok(snap.length > 0, 'process snapshot must not be silently empty');
  assert.ok(snap.every(p => Number.isFinite(p.pid) && typeof p.cmd === 'string'));
});

test('classify: our repo processes', () => {
  const root = '/home/empir3/apps/empir3-bridge';
  assert.equal(classifyBridgeProcess(`/usr/bin/node tsx ${root}/src/bridge.ts`, { root }), 'repo');
  assert.equal(classifyBridgeProcess(`/usr/bin/node tsx ${root}/src/server.ts`, { root }), 'repo');
  assert.equal(classifyBridgeProcess(`/usr/bin/node ${root}/src/headless-entry.js`, { root }), 'repo');
});

test('classify: the installed payload daemon', () => {
  assert.equal(
    classifyBridgeProcess('C:\\Users\\x\\.empir3-bridge\\payload\\0.3.39\\entry.js --daemon', {}),
    'payload',
  );
});

test('classify: Chrome ONLY by our CDP port, not by profile', () => {
  assert.equal(
    classifyBridgeProcess('/usr/bin/chromium --remote-debugging-port=9222', { cdpPort: 9222 }),
    'chrome',
  );
  // A different bridge's Chrome must not match.
  assert.equal(
    classifyBridgeProcess('/usr/bin/chromium --remote-debugging-port=9322', { cdpPort: 9222 }),
    null,
  );
  // Matching on the profile path too would sweep up Chrome's renderer/gpu
  // children for no benefit — killing the parent already takes them.
  assert.equal(
    classifyBridgeProcess('/usr/bin/chromium --type=renderer --user-data-dir=/home/u/.empir3-bridge/profile', { cdpPort: 9222 }),
    null,
  );
});

test('classify: unrelated processes are never claimed', () => {
  const root = '/home/empir3/apps/empir3-bridge';
  assert.equal(classifyBridgeProcess('/usr/sbin/nginx -g daemon off;', { root, cdpPort: 9222 }), null);
  assert.equal(classifyBridgeProcess('/usr/bin/node /srv/other-app/server.js', { root, cdpPort: 9222 }), null);
  assert.equal(classifyBridgeProcess('', { root, cdpPort: 9222 }), null);
});

test('listOwnedProcesses never returns our own pid', () => {
  const owned = listOwnedProcesses({ root: process.cwd(), cdpPort: 9222, pwPort: 3006, bridgePort: 9867 });
  assert.ok(!owned.some(p => p.pid === process.pid));
});

// ── tsx resolution ──────────────────────────────────────────────────────────

test('resolveTsx finds the real tsx entry (no npx round-trip)', () => {
  // Only meaningful where deps are installed; the suite must stay runnable from
  // a bare checkout or a scratch dir.
  const root = process.cwd();
  if (!existsSync(join(root, 'node_modules', 'tsx'))) {
    return; // nothing to resolve here
  }
  const resolved = resolveTsx(root);
  assert.ok(resolved, 'tsx should resolve when node_modules/tsx exists');
  assert.ok(resolved.file.length > 0);
  assert.ok(Array.isArray(resolved.args));
});

test('resolveTsx returns null when node_modules is absent', () => {
  const dir = join(tmpdir(), `e3-tsx-${process.pid}-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, 'package.json'), '{}');
    assert.equal(resolveTsx(dir), null, 'a clear null beats a confusing spawn failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
