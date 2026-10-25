'use strict';

const { createHash } = require('node:crypto');
const {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MIGRATION_FILE = 'account-profile-migration.json';
const ACTIVE_FILE = 'account-profile-active.json';
const RECOVERY_FILE = 'account-profile-recovery.json';
const ACCOUNT_KEY_RE = /^[a-f0-9]{20}$/;
const PROFILE_STATE_FILES = [
  'Local State',
  path.join('Default', 'Network', 'Cookies'),
  path.join('Default', 'Login Data'),
  path.join('Default', 'History'),
  path.join('Default', 'Preferences'),
];

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function normalizedServerIdentity(value) {
  return String(value || 'https://app.empir3.com').trim().toLowerCase().replace(/\/+$/, '');
}

function accountKeyFor(auth) {
  const userId = String(auth?.user?.id || '').trim();
  if (!userId) return '';
  const server = normalizedServerIdentity(auth?.serverUrl);
  return createHash('sha256').update(`${server}\0${userId}`).digest('hex').slice(0, 20);
}

function validAccountKey(value) {
  return ACCOUNT_KEY_RE.test(String(value || ''));
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(temp, file);
}

function profileStateBytes(profilePath) {
  return PROFILE_STATE_FILES.reduce((total, relative) => {
    try {
      const stat = statSync(path.join(profilePath, relative));
      return stat.isFile() ? total + stat.size : total;
    } catch {
      return total;
    }
  }, 0);
}

function profilePathForKey(stateDir, accountKey) {
  if (!validAccountKey(accountKey)) return '';
  return path.join(stateDir, 'profiles', `account-${accountKey}`);
}

function recoveryPairMatches(record, previousAccountKey, currentAccountKey) {
  return record?.previousAccountKey === previousAccountKey
    && record?.currentAccountKey === currentAccountKey;
}

function exactTreeMetrics(root) {
  const metrics = { files: 0, bytes: 0 };
  if (!existsSync(root)) return metrics;
  const pending = [root];
  const { readdirSync } = require('node:fs');
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) {
        const stat = statSync(full);
        metrics.files += 1;
        metrics.bytes += stat.size;
      }
    }
  }
  return metrics;
}

function performQueuedRecovery(selection, record, log, options = {}) {
  if (record?.state !== 'queued'
      || record.currentAccountKey !== selection.accountKey
      || !validAccountKey(record.previousAccountKey)) return record;

  const source = profilePathForKey(selection.stateDir, record.previousAccountKey);
  const target = selection.profilePath;
  const staging = `${target}.restoring-${process.pid}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${target}.before-restore-${stamp}`;
  let targetBackedUp = false;
  try {
    if (!existsSync(source)) throw new Error('The previous Bridge profile is no longer present');
    rmSync(staging, { recursive: true, force: true });
    const copyProfile = options.copyProfile || cpSync;
    copyProfile(source, staging, { recursive: true, errorOnExist: true });
    const sourceMetrics = exactTreeMetrics(source);
    const stagedMetrics = exactTreeMetrics(staging);
    if (sourceMetrics.files !== stagedMetrics.files || sourceMetrics.bytes !== stagedMetrics.bytes) {
      throw new Error('The restored profile did not match the previous profile');
    }
    if (existsSync(target)) {
      renameSync(target, backup);
      targetBackedUp = true;
    }
    renameSync(staging, target);
    const completed = {
      ...record,
      state: 'completed',
      completedAt: new Date().toISOString(),
      backupName: targetBackedUp ? path.basename(backup) : '',
      sourceFiles: sourceMetrics.files,
      sourceBytes: sourceMetrics.bytes,
      error: '',
    };
    writeJsonAtomic(selection.recoveryFile, completed);
    log(`restored the previous Bridge browser profile (${sourceMetrics.files} files) and preserved the prior target${targetBackedUp ? ' as a backup' : ''}`);
    return completed;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (targetBackedUp && !existsSync(target) && existsSync(backup)) {
      try { renameSync(backup, target); } catch {}
    }
    const failed = {
      ...record,
      state: 'failed',
      failedAt: new Date().toISOString(),
      error: error?.message || String(error),
    };
    writeJsonAtomic(selection.recoveryFile, failed);
    log(`could not restore the previous Bridge browser profile: ${failed.error}`);
    return failed;
  }
}

/**
 * Select the controlled-Chrome profile without exposing account identifiers in
 * its filesystem path. Unpaired installs retain the historical profile path;
 * paired installs get one stable profile per Empir3 account and environment.
 */
function resolveAccountProfile(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const explicit = env.EMPIR3_BRIDGE_PROFILE
    || env.BRIDGE_PROFILE
    || env.EMPIR3_BRIDGE_CHROME_PROFILE;
  if (explicit) {
    return {
      profilePath: path.resolve(explicit),
      explicit: true,
      paired: false,
      accountKey: '',
    };
  }

  const stateDir = options.stateDir || path.join(homeDir, '.empir3-bridge');
  const legacyProfile = path.join(stateDir, 'profile');
  const settingsBase = options.settingsBase || env.APPDATA || path.join(homeDir, '.empir3');
  const authFile = options.authFile || path.join(settingsBase, 'Empir3', 'bridge-auth.json');
  const auth = readJson(authFile);
  const accountKey = accountKeyFor(auth);

  if (!accountKey) {
    return {
      profilePath: legacyProfile,
      explicit: false,
      paired: false,
      accountKey: '',
      stateDir,
      legacyProfile,
      migrationFile: path.join(stateDir, MIGRATION_FILE),
      activeFile: path.join(stateDir, ACTIVE_FILE),
      recoveryFile: path.join(stateDir, RECOVERY_FILE),
    };
  }

  return {
    profilePath: path.join(stateDir, 'profiles', `account-${accountKey}`),
    explicit: false,
    paired: true,
    accountKey,
    stateDir,
    legacyProfile,
    migrationFile: path.join(stateDir, MIGRATION_FILE),
    activeFile: path.join(stateDir, ACTIVE_FILE),
    recoveryFile: path.join(stateDir, RECOVERY_FILE),
  };
}

function writeMigrationMarker(file, accountKey) {
  writeJsonAtomic(file, { version: 1, accountKey });
}

/**
 * Prepare the selected profile after stale Bridge/Chrome processes have been
 * stopped. The first paired account receives a COPY of the legacy profile so
 * an upgrade preserves its existing browser logins. A durable, opaque marker
 * prevents that legacy data from ever being copied into a different account.
 */
function prepareAccountProfile(selection, options = {}) {
  const log = options.log || (() => {});
  if (!selection?.profilePath) throw new Error('profile selection is required');

  if (selection.explicit || !selection.paired) {
    mkdirSync(selection.profilePath, { recursive: true });
    return { ...selection, migrated: false };
  }

  mkdirSync(selection.stateDir, { recursive: true });
  const markerExists = existsSync(selection.migrationFile);
  const marker = readJson(selection.migrationFile);
  const active = readJson(selection.activeFile);
  let recovery = readJson(selection.recoveryFile);
  recovery = performQueuedRecovery(selection, recovery, log, options);
  const targetExists = existsSync(selection.profilePath);
  const legacyExists = existsSync(selection.legacyProfile);
  // An unreadable pre-existing marker is treated conservatively: never copy
  // browser data when we cannot prove which account already claimed it.
  const legacyBelongsHere = !markerExists || marker?.accountKey === selection.accountKey;

  // Claim the legacy data BEFORE copying. If the copy is interrupted, the
  // same account may retry on restart, but a different account can never race
  // in and inherit those cookies.
  if (!markerExists) writeMigrationMarker(selection.migrationFile, selection.accountKey);

  if (!targetExists && legacyExists && legacyBelongsHere) {
    mkdirSync(path.dirname(selection.profilePath), { recursive: true });
    const staging = `${selection.profilePath}.migrating-${process.pid}`;
    try {
      rmSync(staging, { recursive: true, force: true });
      cpSync(selection.legacyProfile, staging, { recursive: true, errorOnExist: true });
      renameSync(staging, selection.profilePath);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    log('preserved the existing controlled-browser login in this account\'s private profile');
    return { ...selection, migrated: true };
  }

  mkdirSync(selection.profilePath, { recursive: true });
  if (legacyExists && marker && marker.accountKey !== selection.accountKey) {
    log('kept the newly paired account in its own controlled-browser profile');
  }

  const previousAccountKey = validAccountKey(active?.accountKey)
    ? active.accountKey
    : (validAccountKey(marker?.accountKey) ? marker.accountKey : '');
  if (previousAccountKey && previousAccountKey !== selection.accountKey) {
    const previousProfile = profilePathForKey(selection.stateDir, previousAccountKey);
    const sourceStateBytes = profileStateBytes(previousProfile);
    const targetStateBytes = profileStateBytes(selection.profilePath);
    // A profile switch is only surfaced when the previous Bridge-owned profile
    // is materially more established. This avoids nagging deliberate account
    // switches after both profiles have accumulated their own sessions, while
    // catching the update/re-pair case that otherwise looks like data loss.
    const materiallyMoreEstablished = existsSync(previousProfile)
      && sourceStateBytes >= 256 * 1024
      && sourceStateBytes >= Math.max(1, targetStateBytes) * 2;
    const settled = recoveryPairMatches(recovery, previousAccountKey, selection.accountKey)
      && ['dismissed', 'completed'].includes(recovery?.state);
    if (materiallyMoreEstablished && !settled) {
      if (!recoveryPairMatches(recovery, previousAccountKey, selection.accountKey)
          || !['pending', 'failed'].includes(recovery?.state)) {
        recovery = {
          version: 1,
          state: 'pending',
          previousAccountKey,
          currentAccountKey: selection.accountKey,
          detectedAt: new Date().toISOString(),
          sourceStateBytes,
          targetStateBytes,
        };
        writeJsonAtomic(selection.recoveryFile, recovery);
      }
      log('a previous Bridge browser profile is available to restore from the local Account screen');
    }
  }
  writeJsonAtomic(selection.activeFile, { version: 1, accountKey: selection.accountKey, updatedAt: new Date().toISOString() });
  return { ...selection, migrated: false, recoveryAvailable: recovery?.state === 'pending' || recovery?.state === 'failed' };
}

function configureAccountProfile(options = {}) {
  const env = options.env || process.env;
  const selection = prepareAccountProfile(resolveAccountProfile(options), options);
  if (!selection.explicit) {
    env.EMPIR3_BRIDGE_PROFILE = selection.profilePath;
    env.BRIDGE_PROFILE = selection.profilePath;
    if (selection.recoveryFile) env.EMPIR3_BRIDGE_PROFILE_RECOVERY_FILE = selection.recoveryFile;
  }
  return selection;
}

function readAccountProfileRecoveryStatus(file) {
  const record = file ? readJson(file) : null;
  if (!record || !validAccountKey(record.previousAccountKey) || !validAccountKey(record.currentAccountKey)) {
    return { available: false, state: 'none' };
  }
  const available = record.state === 'pending' || record.state === 'failed';
  return {
    available,
    state: String(record.state || 'none'),
    detectedAt: record.detectedAt || null,
    sourceStateBytes: Number(record.sourceStateBytes || 0),
    targetStateBytes: Number(record.targetStateBytes || 0),
    error: record.state === 'failed' ? String(record.error || 'Restore did not complete') : '',
  };
}

function queueAccountProfileRecoveryAction(file, action) {
  if (!file) throw new Error('No account-profile recovery is available');
  const record = readJson(file);
  if (!record || !validAccountKey(record.previousAccountKey) || !validAccountKey(record.currentAccountKey)) {
    throw new Error('No valid account-profile recovery is available');
  }
  if (!['pending', 'failed'].includes(record.state)) {
    throw new Error('This account-profile recovery has already been handled');
  }
  if (action === 'keep_separate') {
    writeJsonAtomic(file, { ...record, state: 'dismissed', dismissedAt: new Date().toISOString(), error: '' });
    return { ok: true, action, restartRequired: false };
  }
  if (action !== 'restore') throw new Error('Unknown account-profile recovery action');
  writeJsonAtomic(file, { ...record, state: 'queued', queuedAt: new Date().toISOString(), error: '' });
  return { ok: true, action, restartRequired: true };
}

module.exports = {
  ACTIVE_FILE,
  MIGRATION_FILE,
  RECOVERY_FILE,
  accountKeyFor,
  configureAccountProfile,
  prepareAccountProfile,
  queueAccountProfileRecoveryAction,
  readAccountProfileRecoveryStatus,
  resolveAccountProfile,
};
