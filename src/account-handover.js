'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { accountKeyFor } = require('./account-profile.js');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function settingsPaths(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const base = options.settingsBase || env.APPDATA || path.join(homeDir, '.empir3');
  const dir = path.join(base, 'Empir3');
  return {
    authFile: options.authFile || path.join(dir, 'bridge-auth.json'),
    settingsFile: options.settingsFile || path.join(dir, 'bridge-settings.json'),
  };
}

function postHandover(serverUrl, deviceToken, deviceId, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/auth/pairing-sessions/device-token/handover', serverUrl);
    const data = JSON.stringify({ deviceId });
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'empir3-bridge-account-handover',
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode || 0, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('handover request timed out')));
    req.end(data);
  });
}

/** Best-effort self-revocation before replacing local auth with another
 * account. Failure never strands pairing; callers surface it in local logs. */
async function revokePriorDeviceCredential(nextAuth, options = {}) {
  const paths = settingsPaths(options);
  const previous = options.previousAuth || readJson(paths.authFile);
  if (!previous?.deviceToken) return { attempted: false, reason: 'no-device-token' };

  const previousKey = accountKeyFor(previous);
  const nextKey = accountKeyFor(nextAuth);
  if (!previousKey || !nextKey) return { attempted: false, reason: 'missing-account-identity' };
  if (previousKey === nextKey) return { attempted: false, reason: 'same-account' };

  const settings = options.settings || readJson(paths.settingsFile);
  const deviceId = String(previous.deviceId || settings?.deviceId || '').trim();
  if (!deviceId) return { attempted: false, reason: 'missing-device-id' };

  const request = options.request || postHandover;
  try {
    const result = await request(previous.serverUrl || 'https://app.empir3.com', previous.deviceToken, deviceId);
    if (result?.status === 200 && result?.body?.success === true) {
      return { attempted: true, revoked: true, deviceId };
    }
    return { attempted: true, revoked: false, deviceId, status: result?.status || 0 };
  } catch (error) {
    return { attempted: true, revoked: false, deviceId, error: error?.message || String(error) };
  }
}

/** Explicit sign-out retires this device's credential even when no next account
 * exists. The credential itself identifies the device; omit the optional local
 * device-id check so stale local metadata cannot prevent its retirement. */
async function revokeCurrentDeviceCredential(options = {}) {
  const previous = options.previousAuth || readJson(settingsPaths(options).authFile);
  if (!previous?.deviceToken) return { attempted: false, reason: 'no-device-token' };
  const request = options.request || postHandover;
  const serverUrl = previous.serverUrl || 'https://app.empir3.com';
  // What a later retry needs if the server cannot confirm now (card 8c9c2aab).
  const pending = { deviceToken: previous.deviceToken, serverUrl };
  try {
    const result = await request(serverUrl, previous.deviceToken);
    if (result?.status === 200 && result?.body?.success === true) return { attempted: true, revoked: true };
    // This self-revocation endpoint rejects only unusable credentials when no
    // optional deviceId is supplied. A repeated sign-out can safely complete.
    if (result?.status === 403) return { attempted: true, revoked: true, alreadyRevoked: true };
    return { attempted: true, revoked: false, status: result?.status || 0, pending };
  } catch {
    return { attempted: true, revoked: false, reason: 'service-unavailable', pending };
  }
}

// ---- Pending retirement (card 8c9c2aab) ------------------------------------
//
// A sign-out is the user's decision about THIS computer and always completes
// locally. On 2026-10-24 the owner could not sign out of any Bridge: the server
// answered 429 (its sign-out route then shared the failed-login limiter), and a
// Bridge signed in to a development server that is down could never sign out at
// all. When the server cannot confirm the retirement, the device token (and
// only it) is kept here, outside bridge-auth.json, so the Bridge is signed out
// while the server-side credential is still retired as soon as the server
// answers. 200 and 403 both end the retry: 403 means the credential is already
// unusable.

function pendingRetirePath(options = {}) {
  return options.pendingFile || path.join(path.dirname(settingsPaths(options).authFile), 'bridge-pending-retire.json');
}

function readPendingRetire(options = {}) {
  const list = readJson(pendingRetirePath(options));
  return Array.isArray(list) ? list.filter((e) => e && typeof e.deviceToken === 'string' && e.deviceToken) : [];
}

function writePendingRetire(list, options = {}) {
  const file = pendingRetirePath(options);
  if (!list.length) { try { fs.unlinkSync(file); } catch {} return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list), { encoding: 'utf8', mode: 0o600 });
}

function queuePendingRetire(entry, options = {}) {
  if (!entry?.deviceToken) return false;
  const list = readPendingRetire(options).filter((e) => e.deviceToken !== entry.deviceToken);
  list.push({ deviceToken: entry.deviceToken, serverUrl: entry.serverUrl || 'https://app.empir3.com', queuedAt: new Date().toISOString() });
  writePendingRetire(list, options);
  return true;
}

/** Retry every queued retirement once. Entries the server confirms (200) or
 *  reports unusable (403) are dropped; anything else stays for the next try. */
async function retirePendingCredentials(options = {}) {
  const request = options.request || postHandover;
  const outcomes = new Map();
  let retired = 0;
  for (const entry of readPendingRetire(options)) {
    let result;
    try { result = await request(entry.serverUrl, entry.deviceToken); } catch { result = null; }
    const status = result?.status || 0;
    const confirmed = status === 403 || (status === 200 && result?.body?.success === true);
    if (confirmed) retired++;
    outcomes.set(entry.deviceToken, { confirmed, lastStatus: status, lastTriedAt: new Date().toISOString() });
  }
  // A sign-out may append while a network request is pending. Reconcile with
  // the current queue so those new credentials survive, and another completed
  // retry cannot have its removed entries resurrected by this older snapshot.
  const kept = readPendingRetire(options).flatMap(entry => {
    const outcome = outcomes.get(entry.deviceToken);
    if (!outcome) return [entry];
    if (outcome.confirmed) return [];
    return [{ ...entry, lastStatus: outcome.lastStatus, lastTriedAt: outcome.lastTriedAt }];
  });
  writePendingRetire(kept, options);
  return { retired, remaining: kept.length };
}

module.exports = {
  postHandover, revokePriorDeviceCredential, revokeCurrentDeviceCredential, settingsPaths,
  pendingRetirePath, readPendingRetire, queuePendingRetire, retirePendingCredentials,
};
