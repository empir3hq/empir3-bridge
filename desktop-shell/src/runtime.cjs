'use strict';

const http = require('node:http');
const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');

const PRODUCTION_PORTS = Object.freeze({ wrapper: 3006, bridge: 9867, cdp: 9222 });
const DEVELOPMENT_PORTS = Object.freeze({ wrapper: 3306, bridge: 10167, cdp: 10222 });

function parsePort(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(`${label} must be a port between 1024 and 65535`);
  }
  return parsed;
}

function resolvePorts({ isPackaged = false, env = process.env } = {}) {
  const defaults = isPackaged ? PRODUCTION_PORTS : DEVELOPMENT_PORTS;
  const ports = {
    wrapper: parsePort(env.EMPIR3_PW_PORT, defaults.wrapper, 'EMPIR3_PW_PORT'),
    bridge: parsePort(env.EMPIR3_BRIDGE_HTTP_PORT, defaults.bridge, 'EMPIR3_BRIDGE_HTTP_PORT'),
    cdp: parsePort(env.EMPIR3_CDP_PORT, defaults.cdp, 'EMPIR3_CDP_PORT'),
  };
  if (new Set(Object.values(ports)).size !== 3) {
    throw new Error('Bridge wrapper, CDP bridge, and Chrome CDP ports must be distinct');
  }
  return ports;
}

function resolveBridgeRoot({
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  shellSourceDir = __dirname,
  env = process.env,
} = {}) {
  if (env.EMPIR3_BRIDGE_RUNTIME_ROOT) return resolve(env.EMPIR3_BRIDGE_RUNTIME_ROOT);
  if (isPackaged) return join(resourcesPath, 'bridge');
  return resolve(shellSourceDir, '..', '..');
}

function resolveRuntimeEntry(bridgeRoot) {
  const entry = join(bridgeRoot, 'src', 'headless-entry.js');
  if (!existsSync(entry)) {
    throw new Error(`Shared Bridge runtime not found at ${entry}`);
  }
  return entry;
}

function resolveRuntimeCommand({
  isPackaged = false,
  electronExecutable = process.execPath,
  env = process.env,
} = {}) {
  if (env.EMPIR3_BRIDGE_NODE) {
    return { executable: env.EMPIR3_BRIDGE_NODE, extraEnv: {} };
  }
  if (isPackaged) {
    return { executable: electronExecutable, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { executable: 'node', extraEnv: {} };
}

function makeRuntimeEnvironment({
  ports,
  isPackaged = false,
  env = process.env,
  profilePath,
  bridgeRoot,
} = {}) {
  if (!ports) throw new Error('ports are required');
  const profile = profilePath || env.EMPIR3_BRIDGE_PROFILE || join(
    homedir(),
    '.empir3-bridge',
    isPackaged ? 'profile' : 'profile-electron-dev',
  );
  const runtimeEnv = {
    ...env,
    EMPIR3_HEADLESS: '0',
    BRIDGE_HEADLESS: 'false',
    EMPIR3_CHROME_AUTOLAUNCH: '0',
    EMPIR3_SKIP_PREDECESSOR_REAP: '1',
    EMPIR3_PW_PORT: String(ports.wrapper),
    PW_PORT: String(ports.wrapper),
    EMPIR3_BRIDGE_HTTP_PORT: String(ports.bridge),
    EMPIR3_BRIDGE_PORT: String(ports.bridge),
    BRIDGE_PORT: String(ports.bridge),
    EMPIR3_CDP_PORT: String(ports.cdp),
    CDP_PORT: String(ports.cdp),
    EMPIR3_BRIDGE_PROFILE: profile,
    BRIDGE_PROFILE: profile,
    EMPIR3_BRIDGE_LABEL: isPackaged ? 'DESKTOP' : 'ELECTRON-DEV',
  };
  if (bridgeRoot) {
    runtimeEnv.EMPIR3_BRIDGE_PAYLOAD_DIR = bridgeRoot;
    runtimeEnv.EMPIR3_BRIDGE_ACCURACY_LAB = join(bridgeRoot, 'dist', 'accuracy-lab.html');
  }
  return runtimeEnv;
}

function statusUrl(wrapperPort) {
  return `http://127.0.0.1:${wrapperPort}/api/status`;
}

function providerConsoleUrl(wrapperPort) {
  return `http://127.0.0.1:${wrapperPort}/welcome?pane=clis`;
}

function isAllowedLocalUrl(rawUrl, wrapperPort) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      && Number(url.port || 80) === wrapperPort;
  } catch {
    return false;
  }
}

function externalNavigationCommand(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { type: 'navigate', url: url.toString() };
  } catch {
    return null;
  }
}

function fetchJson(url, timeoutMs = 2500) {
  return new Promise((resolvePromise, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolvePromise(JSON.parse(body));
        } catch {
          reject(new Error('Bridge returned invalid JSON'));
        }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Bridge health request timed out')));
  });
}

async function waitForBridge({
  wrapperPort,
  timeoutMs = 45_000,
  intervalMs = 250,
  fetcher = fetchJson,
} = {}) {
  const startedAt = Date.now();
  let lastError = 'no response';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const status = await fetcher(statusUrl(wrapperPort));
      if (status && typeof status === 'object') return status;
      lastError = 'empty status response';
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new Error(`Bridge did not become healthy within ${timeoutMs}ms (${lastError})`);
}

module.exports = {
  DEVELOPMENT_PORTS,
  PRODUCTION_PORTS,
  externalNavigationCommand,
  fetchJson,
  isAllowedLocalUrl,
  makeRuntimeEnvironment,
  parsePort,
  providerConsoleUrl,
  resolveBridgeRoot,
  resolvePorts,
  resolveRuntimeCommand,
  resolveRuntimeEntry,
  statusUrl,
  waitForBridge,
};
