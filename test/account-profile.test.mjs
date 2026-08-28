import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const {
  accountKeyFor,
  prepareAccountProfile,
  resolveAccountProfile,
} = require('../src/account-profile.js');

function fixture() {
  const root = join(tmpdir(), `e3-account-profile-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const homeDir = join(root, 'home');
  const settingsBase = join(root, 'settings');
  const authFile = join(settingsBase, 'Empir3', 'bridge-auth.json');
  mkdirSync(join(settingsBase, 'Empir3'), { recursive: true });
  return {
    root,
    homeDir,
    settingsBase,
    authFile,
    options: { env: {}, homeDir, settingsBase, authFile },
  };
}

function writeAuth(f, userId, serverUrl = 'https://app.empir3.com') {
  writeFileSync(f.authFile, JSON.stringify({ user: { id: userId }, serverUrl }), 'utf8');
}

test('explicit profile override wins and is never account-remapped', () => {
  const f = fixture();
  try {
    writeAuth(f, 'owner-1');
    const selected = resolveAccountProfile({ ...f.options, env: { EMPIR3_BRIDGE_PROFILE: join(f.root, 'explicit') } });
    assert.equal(selected.profilePath, join(f.root, 'explicit'));
    assert.equal(selected.explicit, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('unpaired installs keep the legacy controlled-browser profile', () => {
  const f = fixture();
  try {
    const selected = resolveAccountProfile(f.options);
    assert.equal(selected.profilePath, join(f.homeDir, '.empir3-bridge', 'profile'));
    assert.equal(selected.paired, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('paired account profile is stable, opaque, and server-scoped', () => {
  const first = accountKeyFor({ user: { id: 'owner-1' }, serverUrl: 'https://app.empir3.com/' });
  const same = accountKeyFor({ user: { id: 'owner-1' }, serverUrl: 'https://app.empir3.com' });
  const otherUser = accountKeyFor({ user: { id: 'owner-2' }, serverUrl: 'https://app.empir3.com' });
  const otherServer = accountKeyFor({ user: { id: 'owner-1' }, serverUrl: 'http://localhost:3005' });
  assert.equal(first, same);
  assert.notEqual(first, otherUser);
  assert.notEqual(first, otherServer);
  assert.doesNotMatch(first, /owner/i);
});

test('legacy profile migrates once to the current paired account', () => {
  const f = fixture();
  try {
    writeAuth(f, 'owner-1');
    const selected = resolveAccountProfile(f.options);
    mkdirSync(selected.legacyProfile, { recursive: true });
    writeFileSync(join(selected.legacyProfile, 'Cookies'), 'owner-login', 'utf8');

    const prepared = prepareAccountProfile(selected);
    assert.equal(prepared.migrated, true);
    assert.equal(readFileSync(join(selected.profilePath, 'Cookies'), 'utf8'), 'owner-login');
    assert.equal(JSON.parse(readFileSync(selected.migrationFile, 'utf8')).accountKey, selected.accountKey);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a different paired account gets a clean profile, never the legacy login', () => {
  const f = fixture();
  try {
    writeAuth(f, 'owner-1');
    const owner = resolveAccountProfile(f.options);
    mkdirSync(owner.legacyProfile, { recursive: true });
    writeFileSync(join(owner.legacyProfile, 'Cookies'), 'owner-login', 'utf8');
    prepareAccountProfile(owner);

    writeAuth(f, 'other-account');
    const other = resolveAccountProfile(f.options);
    prepareAccountProfile(other);
    assert.notEqual(other.profilePath, owner.profilePath);
    assert.equal(existsSync(join(other.profilePath, 'Cookies')), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('an unreadable migration marker fails closed instead of leaking legacy cookies', () => {
  const f = fixture();
  try {
    writeAuth(f, 'owner-1');
    const selected = resolveAccountProfile(f.options);
    mkdirSync(selected.legacyProfile, { recursive: true });
    writeFileSync(join(selected.legacyProfile, 'Cookies'), 'private-login', 'utf8');
    writeFileSync(selected.migrationFile, '{broken', 'utf8');

    prepareAccountProfile(selected);
    assert.equal(existsSync(join(selected.profilePath, 'Cookies')), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
