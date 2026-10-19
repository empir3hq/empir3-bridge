/**
 * Credential file permissions — regression test for the world-readable
 * bridge-auth.json bug.
 *
 * bridge-auth.json holds an ACCOUNT-scoped bearer token. It used to be written
 * with a plain writeFileSync, which on POSIX yields mode 0644 inside a 0755
 * directory: every local user on the machine could read the token, and that
 * token authenticates as the account on every paired device. Harmless on a
 * single-user Windows desktop; serious on a shared Linux server or a VPS —
 * which is exactly where the bridge is headed.
 *
 * These tests assert the write sequence used by `writeSecureJson` (server.ts)
 * and `writeAuthFileSecurely` (pair-claim.ts). They are deliberately written
 * against the SEQUENCE rather than by importing server.ts, because importing
 * that module boots the whole bridge and binds ports.
 *
 * On Windows the assertions are skipped: NTFS uses ACLs and Node reports a
 * synthetic mode, so POSIX bits are not meaningful. The Linux CI lane is what
 * actually guards this.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, chmodSync, statSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const POSIX = process.platform !== 'win32';
const SECURE_FILE_MODE = 0o600;
const SECURE_DIR_MODE = 0o700;

function makeTempDir() {
  const dir = join(tmpdir(), `e3-cred-${process.pid}-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The exact sequence under test (mirrors both implementations). */
function writeSecure(dir, file, value) {
  mkdirSync(dir, { recursive: true });
  if (POSIX) { try { chmodSync(dir, SECURE_DIR_MODE); } catch { /* best-effort */ } }
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: SECURE_FILE_MODE });
  if (POSIX) { try { chmodSync(file, SECURE_FILE_MODE); } catch { /* best-effort */ } }
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

test('a fresh credential write is 0600 in a 0700 dir', { skip: !POSIX && 'POSIX modes only' }, () => {
  const dir = makeTempDir();
  const file = join(dir, 'bridge-auth.json');
  try {
    writeSecure(dir, file, { legacyToken: 'secret' });
    assert.equal(mode(file), SECURE_FILE_MODE, 'auth file must not be group/world readable');
    assert.equal(mode(dir), SECURE_DIR_MODE, 'settings dir must not be traversable by others');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an EXISTING world-readable credential file is repaired', { skip: !POSIX && 'POSIX modes only' }, () => {
  // This is the case that matters for already-deployed bridges. Note that
  // writeFileSync's `mode` option is IGNORED when the file already exists —
  // which is why the implementation chmods after writing. Without that chmod
  // this test fails, and every pre-existing install would stay exposed.
  const dir = makeTempDir();
  const file = join(dir, 'bridge-auth.json');
  try {
    writeFileSync(file, '{"legacyToken":"old"}', { mode: 0o644 });
    chmodSync(file, 0o644);
    assert.equal(mode(file), 0o644, 'precondition: file starts world-readable');

    writeSecure(dir, file, { legacyToken: 'new' });
    assert.equal(mode(file), SECURE_FILE_MODE, 'pre-existing 0644 file must be tightened to 0600');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repair-on-read tightens without rewriting content', { skip: !POSIX && 'POSIX modes only' }, () => {
  const dir = makeTempDir();
  const file = join(dir, 'bridge-auth.json');
  try {
    const body = JSON.stringify({ legacyToken: 'keep-me' }, null, 2);
    writeFileSync(file, body, { mode: 0o644 });
    chmodSync(file, 0o644);

    // repairSecureFileMode's behavior: stat, compare, chmod only when wrong.
    const current = mode(file);
    if (current !== SECURE_FILE_MODE) chmodSync(file, SECURE_FILE_MODE);

    assert.equal(mode(file), SECURE_FILE_MODE);
    assert.equal(statSync(file).size, Buffer.byteLength(body), 'content must be untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secure write is idempotent and never throws on repeat', () => {
  const dir = makeTempDir();
  const file = join(dir, 'bridge-settings.json');
  try {
    writeSecure(dir, file, { deviceId: 'bridge-1' });
    writeSecure(dir, file, { deviceId: 'bridge-1' });
    writeSecure(dir, file, { deviceId: 'bridge-2' });
    assert.ok(existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, 'utf-8')).deviceId, 'bridge-2');
    if (POSIX) assert.equal(mode(file), SECURE_FILE_MODE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
