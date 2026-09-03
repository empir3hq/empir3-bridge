import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getCliProcessTelemetry,
  registerOwnedCliProcess,
  terminateCliProcessTree,
  windowsTreeKillArgs,
} from '../src/cli-process-tree.ts';

function waitForLine(stream, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for child pid')), timeoutMs);
    stream.on('data', (chunk) => {
      text += chunk.toString();
      const match = text.match(/CHILD=(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
  });
}

function waitForClose(child, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error('owned process did not close')), timeoutMs);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('Windows tree-kill argv is exact and shell-free ready', () => {
  assert.deepEqual(windowsTreeKillArgs(1234), ['/PID', '1234', '/T', '/F']);
});

test('unregistered process identity cannot authorize a kill', async () => {
  const fake = { pid: 424242, kill() { throw new Error('must not run'); } };
  const result = await terminateCliProcessTree(fake, { reason: 'unowned test' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_owned');
});

test('owned cmd wrapper and descendants terminate while an unrelated process survives', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'empir3-cli-tree-test-'));
  const worker = join(root, 'worker.cjs');
  const shim = join(root, 'owned.cmd');
  await writeFile(worker, [
    "const {spawn}=require('child_process');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
    "console.log('CHILD='+child.pid);",
    'setInterval(()=>{},1000);',
  ].join('\n'), 'utf-8');
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${worker}"\r\n`, 'utf-8');

  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const wrapper = registerOwnedCliProcess(spawn('cmd.exe', ['/d', '/s', '/c', shim], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  }), 'test-cmd-wrapper');

  try {
    const descendantPid = await waitForLine(wrapper.stdout);
    assert.equal(alive(wrapper.pid), true);
    assert.equal(alive(descendantPid), true);
    assert.equal(alive(unrelated.pid), true);

    const killed = await terminateCliProcessTree(wrapper, { signal: 'SIGTERM', reason: 'cmd wrapper integration test' });
    assert.equal(killed.ok, true);
    await waitForClose(wrapper);
    await new Promise(resolve => setTimeout(resolve, 250));

    assert.equal(alive(wrapper.pid), false);
    assert.equal(alive(descendantPid), false);
    assert.equal(alive(unrelated.pid), true);
    assert.equal(getCliProcessTelemetry().active.some(item => item.pid === wrapper.pid), false);
  } finally {
    try { unrelated.kill('SIGKILL'); } catch {}
    try { wrapper.kill('SIGKILL'); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test('owned direct executable terminates without touching an unrelated peer', { skip: process.platform !== 'win32' }, async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const owned = registerOwnedCliProcess(spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  }), 'test-direct-executable');
  try {
    assert.equal(alive(owned.pid), true);
    assert.equal(alive(unrelated.pid), true);
    const killed = await terminateCliProcessTree(owned, { reason: 'direct executable integration test' });
    assert.equal(killed.ok, true);
    await waitForClose(owned);
    assert.equal(alive(owned.pid), false);
    assert.equal(alive(unrelated.pid), true);
  } finally {
    try { owned.kill('SIGKILL'); } catch {}
    try { unrelated.kill('SIGKILL'); } catch {}
  }
});

test('owned Windows ConPTY process terminates by exact pid', { skip: process.platform !== 'win32' }, async () => {
  const nodePty = await import('node-pty');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const pty = registerOwnedCliProcess(nodePty.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 20,
    cwd: process.cwd(),
    env: { ...process.env },
    useConpty: true,
  }), 'test-conpty');
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('owned ConPTY process did not exit')), 7000);
    pty.onExit(() => { clearTimeout(timer); resolve(); });
  });
  try {
    assert.equal(alive(pty.pid), true);
    assert.equal(alive(unrelated.pid), true);
    const killed = await terminateCliProcessTree(pty, { reason: 'ConPTY integration test' });
    assert.equal(killed.ok, true);
    await exited;
    assert.equal(alive(pty.pid), false);
    assert.equal(alive(unrelated.pid), true);
  } finally {
    if (alive(pty.pid)) {
      try { await terminateCliProcessTree(pty, { reason: 'ConPTY test cleanup' }); } catch {}
    }
    try { unrelated.kill('SIGKILL'); } catch {}
  }
});
