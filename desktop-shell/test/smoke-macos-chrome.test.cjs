'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareMacSmokeChrome } = require('../scripts/smoke-macos-chrome.cjs');

test('Mac smoke launcher preserves arguments and confines the browser profile', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), "smoke-chrome-'"));
  const outside = mkdtempSync(join(tmpdir(), 'smoke-chrome-outside-'));
  try {
    const profile = join(root, 'profile with spaces'); mkdirSync(profile);
    const chrome = join(root, 'fake-chrome');
    const receipt = join(root, 'receipt');
    writeFileSync(chrome, '#!/bin/sh\nprintf "%s\\n" "$HOME" "$@" > "$RECEIPT"\n', { mode: 0o700 });
    const launcher = prepareMacSmokeChrome(root, { platform: 'darwin', home: '/native/account', chromePath: chrome });
    const env = { ...process.env, HOME: root, RECEIPT: receipt };
    for (const args of [[], [`--user-data-dir=${outside}`], ['--user-data-dir', profile], [`--user-data-dir=${profile}`, `--user-data-dir=${outside}`]]) {
      assert.equal(spawnSync(launcher, args, { env }).status, 64);
      assert.equal(existsSync(receipt), false);
    }
    const args = [`--user-data-dir=${profile}`, 'http://127.0.0.1:4406/control-lab'];
    assert.equal(spawnSync(launcher, args, { env }).status, 0);
    assert.deepEqual(readFileSync(receipt, 'utf8').trim().split('\n'), ['/native/account', ...args]);
    assert.equal(env.HOME, root);
    assert.equal(prepareMacSmokeChrome(root, { platform: 'darwin', home: '/native/account', chromePath: chrome }), launcher);
    assert.equal(spawnSync(launcher, args, { env }).status, 0);
    assert.throws(() => prepareMacSmokeChrome(root, { platform: 'darwin', home: '/different/account', chromePath: chrome }), /does not match/);
    writeFileSync(launcher, '#!/bin/sh\nexit 0\n');
    assert.throws(() => prepareMacSmokeChrome(root, { platform: 'darwin', home: '/native/account', chromePath: chrome }), /does not match/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('other platforms keep their original browser launcher', () => {
  assert.equal(prepareMacSmokeChrome('/unused', { platform: 'win32' }), null);
  assert.equal(prepareMacSmokeChrome('/unused', { platform: 'linux' }), null);
});
