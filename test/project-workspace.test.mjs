import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  directoryOpenPlan,
  openProjectDirectory,
  prepareProjectDirectory,
} = require('../src/project-workspace.js');

test('project directory preparation stays inside the configured root', () => {
  const root = mkdtempSync(join(tmpdir(), 'empir3-project-open-'));
  try {
    const project = join(root, 'My Project');
    assert.equal(prepareProjectDirectory(root, project), realpathSync(project));
    assert.throws(
      () => prepareProjectDirectory(root, join(root, '..', 'outside')),
      /outside the configured Projects folder/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('project directory preparation rejects a symlink escape', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'empir3-project-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'empir3-project-outside-'));
  try {
    const linked = join(root, 'Linked Project');
    symlinkSync(outside, linked, 'dir');
    assert.throws(
      () => prepareProjectDirectory(root, linked),
      /resolves outside the configured Projects folder/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('file-manager launch uses argument arrays, no shell, and a visible Windows window', async () => {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const target = 'C:\\Users\\Winnie\\Empir3\\Projects\\Launch Plan';
  const result = await openProjectDirectory(target, {
    platform: 'win32',
    profile: { headless: false, hasDisplay: true },
    spawnFn,
  });
  assert.deepEqual(result, { success: true });
  assert.deepEqual(calls, [{
    command: 'explorer.exe',
    args: [target],
    options: { detached: true, stdio: 'ignore', windowsHide: false },
  }]);
});

test('headless bridges return a structured refusal without spawning', async () => {
  let spawned = false;
  const result = await openProjectDirectory('/srv/Empir3/Projects/Test', {
    platform: 'linux',
    profile: { headless: true, hasDisplay: false },
    spawnFn: () => { spawned = true; },
  });
  assert.equal(spawned, false);
  assert.equal(result.success, false);
  assert.equal(result.code, 'capability_unsupported');
});

test('file-manager plans cover supported desktop platforms', () => {
  assert.deepEqual(directoryOpenPlan('win32', 'C:\\Project'), { command: 'explorer.exe', args: ['C:\\Project'] });
  assert.deepEqual(directoryOpenPlan('darwin', '/Project'), { command: 'open', args: ['/Project'] });
  assert.deepEqual(directoryOpenPlan('linux', '/Project'), { command: 'xdg-open', args: ['/Project'] });
  assert.equal(directoryOpenPlan('aix', '/Project'), null);
});
