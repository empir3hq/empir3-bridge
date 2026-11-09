/**
 * bridge_job syncFirst reports which mirror writes the Bridge refused
 * (Work Board 2e0867d0) instead of "N file(s) hydrated" while a script never
 * arrived. The tracker collects refusals during the sync window; the job
 * result carries them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
const { SyncPushFailureTracker, describeSyncOutcome } = require_('../src/sync-push-window.js');

test('refused writes inside a window are listed with their reason; successes are counted', () => {
  const t = new SyncPushFailureTracker();
  t.record('ignored/before-window.py', { success: false, error: 'x' });
  t.begin();
  t.record('scripts/run.py', { success: true, savedPath: '/m/scripts/run.py' });
  t.record('scripts/launch.ps1', { success: false, error: 'File type not allowed: .ps1' });
  t.record('notes/report.md', { success: true });
  t.record('.env', { success: false, error: 'Refusing to sync unsafe/noisy file: .env' });
  const s = t.end(4);
  assert.deepEqual(s, {
    totalPushed: 4,
    written: 2,
    failed: [
      { path: 'scripts/launch.ps1', error: 'File type not allowed: .ps1' },
      { path: '.env', error: 'Refusing to sync unsafe/noisy file: .env' },
    ],
    failedCount: 2,
  });
  t.record('after/window.txt', { success: false, error: 'late' });
  assert.equal(t.failed.length, 2, 'nothing recorded once the window is closed');
});

test('the summary sentence names what did not land', () => {
  assert.equal(describeSyncOutcome({ requested: false }), null);
  assert.match(describeSyncOutcome({ requested: true, completed: false }), /did not finish in time/);
  const complete = describeSyncOutcome({ requested: true, completed: true, totalPushed: 3, written: 3, failed: [] });
  assert.match(complete, /^Mirror sync before start: complete, 3 file\(s\) written to the mirror\./);
  assert.match(complete, /eligible project files only/);
  assert.match(complete, /\.qa, \.e3home, \.tbverify/);
  assert.match(complete, /tools\/ or scripts\//);
  assert.match(describeSyncOutcome({ requested: true, completed: true, totalPushed: 3, written: 2, failed: [{ path: 'a.ps1', error: 'File type not allowed: .ps1' }] }), /2 file\(s\) written, 1 REFUSED by this Bridge and NOT on the machine: a\.ps1 \(File type not allowed: \.ps1\)/);
});

test('server opens the window around the job sync and records every sync push result', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /const syncPushFailures = new SyncPushFailureTracker\(\);/);
  assert.match(server, /syncPushFailures\.begin\(\);/);
  assert.match(server, /const summary = syncPushFailures\.end\(outcome\.report\.totalPushed\);/);
  assert.match(server, /syncPushFailures\.record\(params\?\.path, result\);/);
  // The summary now UNIONS the server's own refusals (cards 7ed38615 /
  // 31ae9f13): this machine only sees pushes that reached it.
  assert.match(server, /written: summary\.written,/);
  assert.match(server, /failed,\s+failedCount: failed\.length,/);
});

test('.ps1 is no longer refused by mirror sync or file:push', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const m = /const BLOCKED_EXT_WRITE = new Set\(\[([^\]]+)\]\);/.exec(server);
  assert.ok(m, 'BLOCKED_EXT_WRITE present');
  assert.doesNotMatch(m[1], /'\.ps1'/, '.ps1 must not be in the write blocklist');
  for (const ext of ['.exe', '.bat', '.cmd', '.msi', '.reg']) assert.match(m[1], new RegExp(`'\\${ext}'`), `${ext} stays blocked`);
});
