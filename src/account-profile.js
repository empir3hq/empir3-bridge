'use strict';

const { createHash } = require('node:crypto');
const {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MIGRATION_FILE = 'account-profile-migration.json';

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
  };
}

function writeMigrationMarker(file, accountKey) {
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify({ version: 1, accountKey }, null, 2), 'utf8');
  renameSync(temp, file);
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
    log('started a clean controlled-browser profile for the newly paired account');
  }
  return { ...selection, migrated: false };
}

function configureAccountProfile(options = {}) {
  const env = options.env || process.env;
  const selection = prepareAccountProfile(resolveAccountProfile(options), options);
  if (!selection.explicit) {
    env.EMPIR3_BRIDGE_PROFILE = selection.profilePath;
    env.BRIDGE_PROFILE = selection.profilePath;
  }
  return selection;
}

module.exports = {
  MIGRATION_FILE,
  accountKeyFor,
  configureAccountProfile,
  prepareAccountProfile,
  resolveAccountProfile,
};
