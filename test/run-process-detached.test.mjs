/**
 * execute:run returns when the command exits even if a detached child keeps
 * the output pipes open (Work Board 24fafb79). Before: the shell hung to the
 * PC-side limit, the tree was killed (including the server the user had just
 * started) and the result said "timed out" for work that had finished.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runProcess, SHELL_HELD_BY_CHILD_NOTE } from '../src/run-process.ts';

// A parent that prints a sentinel, starts a grandchild INHERITING its stdio
// (so the pipe stays open), and exits immediately. The grandchild sleeps 8s.
const PARENT_SCRIPT = `
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 8000)'], { stdio: 'inherit', detached: true });
  child.unref();
  console.log('PARENT_DONE pid=' + child.pid);
`;

test('a parent whose detached child holds stdout settles on exit, not on the timeout', async () => {
  const started = Date.now();
  const r = await runProcess(process.execPath, ['-e', PARENT_SCRIPT], { timeoutMs: 20_000, exitCloseGraceMs: 500 });
  const elapsed = Date.now() - started;
  assert.equal(r.timedOut, false, 'must not be reported as a timeout');
  assert.equal(r.code, 0);
  assert.equal(r.shellHeldByChild, true);
  assert.match(r.stdout, /PARENT_DONE pid=(\d+)/);
  assert.ok(elapsed < 6_000, `settled in ${elapsed}ms, well before the 8s grandchild and the 20s timeout`);
  assert.ok(r.cleanupPending instanceof Promise, 'pipe close is handed back for callers that need it');
  // The grandchild was NOT killed: it is the user's background process.
  const pid = Number(/pid=(\d+)/.exec(r.stdout)[1]);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, true, 'detached grandchild still running');
  try { process.kill(pid); } catch {}
});

test('an ordinary command still resolves on close with no held-open flag', async () => {
  const r = await runProcess(process.execPath, ['-e', 'console.log("plain")'], { timeoutMs: 10_000 });
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.shellHeldByChild, undefined);
  assert.match(r.stdout, /plain/);
});

test('a genuinely hung command still times out and is killed', async () => {
  const started = Date.now();
  const r = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { timeoutMs: 800 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, -2);
  assert.ok(Date.now() - started < 5_000);
});

test('execute:run surfaces the held-open state and does not call it a timeout', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /shellHeldByChild: result\.shellHeldByChild \|\| undefined/);
  assert.match(server, /const heldNote = result\.shellHeldByChild \? `\\n\[bridge\] \$\{SHELL_HELD_BY_CHILD_NOTE\}` : ''/);
  assert.match(SHELL_HELD_BY_CHILD_NOTE, /was NOT killed/);
});
