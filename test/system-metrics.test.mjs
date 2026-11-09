/**
 * Fleet health collector tests — the SHELL-FREE contract.
 *
 * The old sysinfo path shelled to PowerShell per call (Windows-only, ~1s
 * stall, one process per beat) and hardcoded cpu.percent = 0 and disk zeros.
 * These tests pin that the pure-Node collector returns REAL numbers on every
 * platform, respects its failure contract (partial + named errors, never a
 * throw), and never spawns a child process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import child_process from 'node:child_process';

const require_ = createRequire(import.meta.url);
const {
  collectHealthSnapshot,
  memoryStats,
  diskStats,
} = require_('../src/system-metrics.js');

test('snapshot has real memory numbers', () => {
  const mem = memoryStats();
  assert.ok(mem.memPercent > 0 && mem.memPercent < 100, `memPercent real: ${mem.memPercent}`);
  assert.ok(mem.memTotalGb > 0.1, `memTotalGb real: ${mem.memTotalGb}`);
});

test('disk stats report at least one real mount with nonzero totals', async () => {
  const disks = await diskStats();
  assert.ok(disks.length >= 1, 'at least one disk');
  const d = disks[0];
  assert.ok(d.totalGb > 0, `totalGb ${d.totalGb}`);
  assert.ok(d.freeGb >= 0 && d.freeGb <= d.totalGb, `freeGb ${d.freeGb} sane`);
  assert.ok(d.percent >= 0 && d.percent <= 100, `percent ${d.percent} sane`);
});

test('full snapshot: real CPU + uptime, correct failure contract, no shelling', async () => {
  const spawned = [];
  const origSpawn = child_process.spawn;
  const origExec = child_process.exec;
  const origExecSync = child_process.execSync;
  child_process.spawn = (...args) => { spawned.push(args[0]); return origSpawn.apply(child_process, args); };
  child_process.exec = (...args) => { spawned.push(args[0]); return origExec.apply(child_process, args); };
  child_process.execSync = (...args) => { spawned.push(args[0]); return origExecSync.apply(child_process, args); };
  try {
    const snap = await collectHealthSnapshot({ budgetMs: 8000 });
    // cpuPercent may legitimately be ~0 on an idle box, but must be a number
    // (the OLD code hardcoded 0 — the tell is that it can never be non-zero;
    // we assert type + range here and rely on live smokes for movement).
    assert.equal(typeof snap.cpuPercent, 'number');
    assert.ok(snap.cpuPercent >= 0 && snap.cpuPercent <= 100);
    assert.ok(snap.uptimeSec > 0);
    assert.ok(snap.hostname.length > 0);
    assert.ok(Array.isArray(snap.disks) && snap.disks.length >= 1, 'disks populated');
    assert.ok(Array.isArray(snap.errors));
    if (!snap.partial) assert.equal(snap.errors.length, 0, 'no errors when not partial');
    if (process.platform === 'linux') {
      assert.ok(snap.processCount > 10, `processCount real on linux: ${snap.processCount}`);
    }
    assert.deepEqual(spawned, [], `collector must never shell out — spawned: ${spawned.join(', ')}`);
  } finally {
    child_process.spawn = origSpawn;
    child_process.exec = origExec;
    child_process.execSync = origExecSync;
  }
});

test('two consecutive CPU samples both land in range (delta path)', async () => {
  const a = await collectHealthSnapshot({ includeDisks: false, includeProcessCount: false });
  await new Promise(r => setTimeout(r, 300));
  const b = await collectHealthSnapshot({ includeDisks: false, includeProcessCount: false });
  for (const s of [a, b]) {
    assert.ok(s.cpuPercent >= 0 && s.cpuPercent <= 100, `cpu in range: ${s.cpuPercent}`);
  }
});
