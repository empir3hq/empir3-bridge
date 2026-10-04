import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const python = ['python', 'python3'].find((command) =>
  spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);

for (const suite of ['tray_restart_test.py', 'tray_supervisor_test.py', 'tray_handoff_test.py']) {
test(`tray lifecycle: ${suite}`, {
  skip: python ? false : 'Python is unavailable',
}, () => {
  const result = spawnSync(python, [fileURLToPath(new URL(`./${suite}`, import.meta.url))], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
}
