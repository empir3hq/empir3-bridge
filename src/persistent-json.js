'use strict';

const {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require('fs');
const { basename, dirname, join } = require('path');
const { randomBytes } = require('crypto');

const DEFAULT_SECURE_MODE = 0o600;
const WINDOWS_REPLACE_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const WINDOWS_REPLACE_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 160, 160];

function temporaryPath(path) {
  return join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`,
  );
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function replaceFileAtomically(temporary, path) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temporary, path);
      return;
    } catch (error) {
      const retryable = process.platform === 'win32'
        && WINDOWS_REPLACE_RETRY_CODES.has(error?.code)
        && attempt < WINDOWS_REPLACE_RETRY_DELAYS_MS.length;
      if (!retryable) throw error;
      // Defender, search indexing, and sync clients can briefly hold the
      // destination after reading it. Keep the existing primary intact and
      // retry the atomic replace instead of deleting it or entering a write/
      // acknowledgement loop.
      sleepSync(WINDOWS_REPLACE_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function writeTextAtomically(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = temporaryPath(path);
  let descriptor = null;
  try {
    descriptor = openSync(temporary, 'wx', mode);
    writeFileSync(descriptor, text, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    replaceFileAtomically(temporary, path);
    try { chmodSync(path, mode); } catch { /* Windows ACLs; best-effort */ }
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function parseJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function defaultValidator(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function preserveCorruptFile(path, mode) {
  if (!existsSync(path)) return null;
  const preserved = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    renameSync(path, preserved);
    try { chmodSync(preserved, mode); } catch { /* Windows ACLs; best-effort */ }
    return preserved;
  } catch {
    return null;
  }
}

/**
 * Replace a JSON file through a same-directory temporary file. When a valid
 * primary already exists, a failed write leaves it untouched. After a
 * successful replace, mirror the exact new bytes to a last-known-good backup.
 * If that final mirror is interrupted, the previous backup remains intact.
 */
function writePersistentJson(path, value, options = {}) {
  const mode = options.mode ?? DEFAULT_SECURE_MODE;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  writeTextAtomically(path, serialized, mode);
  if (options.backupPath) writeTextAtomically(options.backupPath, serialized, mode);
}

/**
 * Read the primary JSON file, restoring its last-known-good backup when the
 * primary is missing, truncated, or invalid. Invalid bytes are preserved for
 * support instead of being silently overwritten by defaults.
 */
function readPersistentJson(path, options = {}) {
  const mode = options.mode ?? DEFAULT_SECURE_MODE;
  const validate = options.validate ?? defaultValidator;
  let primaryProblem = existsSync(path) ? 'invalid' : 'missing';

  if (existsSync(path)) {
    try {
      const primaryText = readFileSync(path, 'utf8');
      const primary = JSON.parse(primaryText);
      if (validate(primary)) {
        if (options.backupPath) {
          let backupMatches = false;
          try {
            const backupText = readFileSync(options.backupPath, 'utf8');
            JSON.parse(backupText);
            backupMatches = backupText === primaryText;
          } catch {}
          if (!backupMatches) writeTextAtomically(options.backupPath, primaryText, mode);
        }
        return primary;
      }
      primaryProblem = 'invalid shape';
    } catch {
      primaryProblem = 'invalid JSON';
    }
  }

  if (options.backupPath && existsSync(options.backupPath)) {
    try {
      const backup = parseJson(options.backupPath);
      if (validate(backup)) {
        const preserved = preserveCorruptFile(path, mode);
        writeTextAtomically(path, `${JSON.stringify(backup, null, 2)}\n`, mode);
        options.onRecovery?.(
          `Restored ${path} from ${options.backupPath} after the primary was ${primaryProblem}`
          + (preserved ? `; preserved the damaged file at ${preserved}` : ''),
        );
        return backup;
      }
    } catch {
      // Fall through to the explicit default path below.
    }
  }

  if (!options.defaultValue) {
    throw new Error(`Persistent JSON is ${primaryProblem} and no valid backup exists: ${path}`);
  }

  const fallback = options.defaultValue();
  const preserved = preserveCorruptFile(path, mode);
  if (options.writeDefault) writePersistentJson(path, fallback, { backupPath: options.backupPath, mode });
  options.onRecovery?.(
    `Using defaults for ${path}; primary was ${primaryProblem} and no valid backup exists`
    + (preserved ? `; preserved the damaged file at ${preserved}` : ''),
  );
  return fallback;
}

module.exports = {
  readPersistentJson,
  writePersistentJson,
};
