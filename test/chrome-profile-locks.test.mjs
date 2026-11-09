import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { removeStaleChromeSingletons } = require('../src/chrome-profile-locks.js');

function fakeSymlinkFs(lockTarget = 'agentbox-424242') {
  const files = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'Preferences']);
  return {
    files,
    lstatSync(file) {
      if (!files.has(basename(file))) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isSymbolicLink: () => true };
    },
    readlinkSync() { return lockTarget; },
    unlinkSync(file) {
      const name = basename(file);
      if (!files.delete(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
  };
}

test('removes only the exact Chromium singleton files when the recorded Linux owner is dead', () => {
  const fsApi = fakeSymlinkFs();
  const result = removeStaleChromeSingletons('/profile', { platform: 'linux', pidIsAlive: () => false, fsApi });
  assert.equal(result.pid, 424242);
  assert.deepEqual(result.removed.sort(), ['SingletonCookie', 'SingletonLock', 'SingletonSocket']);
  assert.equal(result.reason, 'owner-dead');
  assert.deepEqual([...fsApi.files], ['Preferences']);
});

test('preserves live, malformed, and non-Linux locks', () => {
  for (const options of [
    { platform: 'linux', pidIsAlive: () => true },
    { platform: 'win32', pidIsAlive: () => false },
  ]) {
    const fsApi = fakeSymlinkFs();
    const result = removeStaleChromeSingletons('/profile', { ...options, fsApi });
    assert.deepEqual(result.removed, []);
    assert.equal(fsApi.files.has('SingletonLock'), true);
  }

  const malformedFs = fakeSymlinkFs('hostname-without-a-pid');
  const malformed = removeStaleChromeSingletons('/profile', { platform: 'linux', pidIsAlive: () => false, fsApi: malformedFs });
  assert.equal(malformed.reason, 'owner-unproven');
  assert.deepEqual(malformed.removed, []);
});
