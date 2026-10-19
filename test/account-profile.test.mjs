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
  queueAccountProfileRecoveryAction,
  readAccountProfileRecoveryStatus,
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

test('a materially established previous Bridge profile creates an explicit recovery choice', () => {
  const f = fixture();
  try {
    writeAuth(f, 'owner-1');
    const owner = resolveAccountProfile(f.options);
    mkdirSync(join(owner.profilePath, 'Default', 'Network'), { recursive: true });
    writeFileSync(join(owner.profilePath, 'Default', 'Network', 'Cookies'), Buffer.alloc(300 * 1024, 7));
    writeFileSync(owner.migrationFile, JSON.stringify({ version: 1, accountKey: owner.accountKey }), 'utf8');

    writeAuth(f, 'owner-2');
    const next = resolveAccountProfile(f.options);
    const prepared = prepareAccountProfile(next);
    const status = readAccountProfileRecoveryStatus(next.recoveryFile);

    assert.equal(prepared.recoveryAvailable, true);
    assert.equal(status.available, true);
    assert.equal(status.state, 'pending');
    assert.equal(status.sourceStateBytes, 300 * 1024);
    assert.equal(status.targetStateBytes, 0);
    assert.equal('previousAccountKey' in status, false);
    assert.equal('currentAccountKey' in status, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('keeping accounts separate dismisses the recovery choice without copying cookies', () => {
  const f = fixture();
  try {
    writeAuth(f, 'owner-1');
    const owner = resolveAccountProfile(f.options);
    mkdirSync(join(owner.profilePath, 'Default', 'Network'), { recursive: true });
    writeFileSync(join(owner.profilePath, 'Default', 'Network', 'Cookies'), Buffer.alloc(300 * 1024, 1));
    writeFileSync(owner.migrationFile, JSON.stringify({ version: 1, accountKey: owner.accountKey }), 'utf8');
    writeAuth(f, 'owner-2');
    const next = resolveAccountProfile(f.options);
    prepareAccountProfile(next);

    const action = queueAccountProfileRecoveryAction(next.recoveryFile, 'keep_separate');
    assert.equal(action.restartRequired, false);
    assert.equal(readAccountProfileRecoveryStatus(next.recoveryFile).state, 'dismissed');
    assert.equal(existsSync(join(next.profilePath, 'Default', 'Network', 'Cookies')), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('confirmed recovery copies only the prior Bridge profile and backs up the target', () => {
  const f = fixture();
  try {
    writeAuth(f, 'owner-1');
    const owner = resolveAccountProfile(f.options);
    mkdirSync(join(owner.profilePath, 'Default', 'Network'), { recursive: true });
    writeFileSync(join(owner.profilePath, 'Default', 'Network', 'Cookies'), Buffer.alloc(300 * 1024, 3));
    writeFileSync(join(owner.profilePath, 'source-only.txt'), 'previous-session', 'utf8');
    writeFileSync(owner.migrationFile, JSON.stringify({ version: 1, accountKey: owner.accountKey }), 'utf8');

    writeAuth(f, 'owner-2');
    const next = resolveAccountProfile(f.options);
    prepareAccountProfile(next);
    writeFileSync(join(next.profilePath, 'target-only.txt'), 'new-session', 'utf8');
    queueAccountProfileRecoveryAction(next.recoveryFile, 'restore');
    const restored = prepareAccountProfile(next);
    const record = JSON.parse(readFileSync(next.recoveryFile, 'utf8'));

    assert.equal(restored.recoveryAvailable, false);
    assert.equal(record.state, 'completed');
    assert.equal(readFileSync(join(next.profilePath, 'source-only.txt'), 'utf8'), 'previous-session');
    assert.equal(readFileSync(join(owner.profilePath, 'source-only.txt'), 'utf8'), 'previous-session');
    assert.ok(record.backupName);
    assert.equal(readFileSync(join(next.stateDir, 'profiles', record.backupName, 'target-only.txt'), 'utf8'), 'new-session');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('an interrupted recovery preserves the target and stays retryable', () => {
  const f = fixture();
  try {
    writeAuth(f, 'owner-1');
    const owner = resolveAccountProfile(f.options);
    mkdirSync(join(owner.profilePath, 'Default', 'Network'), { recursive: true });
    writeFileSync(join(owner.profilePath, 'Default', 'Network', 'Cookies'), Buffer.alloc(300 * 1024, 4));
    writeFileSync(owner.migrationFile, JSON.stringify({ version: 1, accountKey: owner.accountKey }), 'utf8');
    writeAuth(f, 'owner-2');
    const next = resolveAccountProfile(f.options);
    prepareAccountProfile(next);
    writeFileSync(join(next.profilePath, 'target-only.txt'), 'still-here', 'utf8');
    queueAccountProfileRecoveryAction(next.recoveryFile, 'restore');

    const prepared = prepareAccountProfile(next, { copyProfile() { throw new Error('simulated copy interruption'); } });
    const status = readAccountProfileRecoveryStatus(next.recoveryFile);
    assert.equal(prepared.recoveryAvailable, true);
    assert.equal(status.state, 'failed');
    assert.match(status.error, /simulated copy interruption/);
    assert.equal(readFileSync(join(next.profilePath, 'target-only.txt'), 'utf8'), 'still-here');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('recovery never falls back to the normal Chrome profile', () => {
  const f = fixture();
  try {
    const normalChrome = join(f.root, 'Google', 'Chrome', 'User Data', 'Default');
    mkdirSync(normalChrome, { recursive: true });
    writeFileSync(join(normalChrome, 'Cookies'), Buffer.alloc(400 * 1024, 9));
    writeAuth(f, 'owner-2');
    const selected = resolveAccountProfile(f.options);
    prepareAccountProfile(selected);
    assert.equal(readAccountProfileRecoveryStatus(selected.recoveryFile).available, false);
    assert.equal(existsSync(join(selected.profilePath, 'Default', 'Cookies')), false);
    assert.equal(readFileSync(join(normalChrome, 'Cookies')).length, 400 * 1024);
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
