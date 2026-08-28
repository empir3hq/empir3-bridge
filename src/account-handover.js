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

module.exports = { postHandover, revokePriorDeviceCredential, settingsPaths };
