'use strict';

const net = require('node:net');
const { spawn } = require('node:child_process');
const {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { join, resolve, sep } = require('node:path');

const shellRoot = resolve(__dirname, '..');
const outRoot = join(shellRoot, 'out');
const providerUrl = String(process.env.EMPIR3_ACCEPT_PROVIDER_URL || '').replace(/\/+$/, '');
const providerModel = String(process.env.EMPIR3_ACCEPT_PROVIDER_MODEL || '').trim();
const providerKey = String(process.env.EMPIR3_ACCEPT_PROVIDER_KEY || '');
const apiProvider = String(process.env.EMPIR3_ACCEPT_API_PROVIDER || '').trim().toLowerCase();
const apiProviderModel = String(process.env.EMPIR3_ACCEPT_API_MODEL || '').trim();
const apiProviderKey = String(process.env.EMPIR3_ACCEPT_API_KEY || '');
const requestedClis = String(process.env.EMPIR3_ACCEPT_CLIS || '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const supportedClis = new Set(['codex', 'claude', 'grok', 'agy']);

if (!providerUrl && !apiProvider && requestedClis.length === 0) {
  throw new Error('Set EMPIR3_ACCEPT_PROVIDER_URL, EMPIR3_ACCEPT_API_PROVIDER, and/or EMPIR3_ACCEPT_CLIS');
}
if (apiProvider && !apiProviderKey) throw new Error('EMPIR3_ACCEPT_API_KEY is required for API-provider acceptance');
for (const cli of requestedClis) {
  if (!supportedClis.has(cli)) throw new Error(`Unsupported live CLI acceptance target: ${cli}`);
}

function walk(root, matches = []) {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === 'make') continue;
      walk(full, matches);
    } else if (stat.isFile()) {
      const lower = name.toLowerCase();
      if (process.platform === 'win32' && lower === 'empir3-bridge.exe') matches.push(full);
      if (process.platform !== 'win32' && name === 'empir3-bridge') matches.push(full);
    }
  }
  return matches;
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

async function bridgeRequest(baseUrl, pathname, {
  method = 'GET',
  body,
  timeoutMs = 20_000,
  allowFailure = false,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
      if (allowFailure) return null;
      throw new Error(`${method} ${pathname} failed with HTTP ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (allowFailure) return null;
    if (error?.name === 'AbortError') throw new Error(`${method} ${pathname} timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(baseUrl, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await bridgeRequest(baseUrl, '/api/status', {
      timeoutMs: 1000,
      allowFailure: true,
    });
    if (status) return status;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Packaged Bridge did not become healthy within ${timeoutMs}ms`);
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function deleteTranscriptSafely(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return;
  const allowed = `${resolve(homedir(), '.empir3-bridge', 'cli-runs')}${sep}`.toLowerCase();
  const target = resolve(transcriptPath).toLowerCase();
  if (!target.startsWith(allowed)) {
    throw new Error(`Refusing to remove CLI acceptance transcript outside ${allowed}`);
  }
  unlinkSync(transcriptPath);
}

async function main() {
  const candidates = walk(outRoot).filter((file) => {
    if (process.platform !== 'darwin') return true;
    return file.includes('.app') && file.includes(`${join('Contents', 'MacOS')}`);
  });
  if (candidates.length !== 1) {
    throw new Error(`Expected one packaged executable, found ${candidates.length}: ${candidates.join(', ')}`);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'empir3-live-integration-'));
  const scratchRoot = `${resolve(tmpdir())}${sep}`.toLowerCase();
  if (!resolve(scratch).toLowerCase().startsWith(scratchRoot)) {
    throw new Error(`Acceptance scratch escaped the system temp directory: ${scratch}`);
  }

  const [wrapperPort, bridgePort, cdpPort] = await Promise.all([freePort(), freePort(), freePort()]);
  if (new Set([wrapperPort, bridgePort, cdpPort]).size !== 3) throw new Error('Could not reserve distinct test ports');
  const baseUrl = `http://127.0.0.1:${wrapperPort}`;
  const existing = await bridgeRequest(baseUrl, '/api/status', { timeoutMs: 500, allowFailure: true });
  if (existing) throw new Error(`Acceptance wrapper port ${wrapperPort} is already occupied`);

  const child = spawn(candidates[0], ['--hidden'], {
    cwd: shellRoot,
    windowsHide: true,
    env: {
      ...process.env,
      APPDATA: join(scratch, 'appdata-roaming'),
      LOCALAPPDATA: join(scratch, 'appdata-local'),
      XDG_CONFIG_HOME: join(scratch, 'xdg-config'),
      XDG_DATA_HOME: join(scratch, 'xdg-data'),
      EMPIR3_DESKTOP_USER_DATA: join(scratch, 'electron-user-data'),
      EMPIR3_BRIDGE_PROFILE: join(scratch, 'chrome-profile'),
      EMPIR3_BRIDGE_NO_RELAY: '1',
      EMPIR3_PW_PORT: String(wrapperPort),
      EMPIR3_BRIDGE_HTTP_PORT: String(bridgePort),
      EMPIR3_CDP_PORT: String(cdpPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-128_000); });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-128_000); });

  let providerSlug = '';
  let configuredApiProvider = '';
  try {
    const status = await waitForHealth(baseUrl);
    const state = await bridgeRequest(baseUrl, '/api/settings/state', { timeoutMs: 90_000 });
    const actualDataDir = resolve(String(state.paths?.dataDir || '')).toLowerCase();
    if (!actualDataDir.startsWith(resolve(scratch).toLowerCase())) {
      throw new Error(`Packaged acceptance escaped isolated state: ${actualDataDir}`);
    }
    await bridgeRequest(baseUrl, '/api/settings/state', {
      method: 'POST',
      body: { bridge: { globalSafety: { execute: true } } },
      timeoutMs: 90_000,
    });

    let provider = null;
    if (providerUrl) {
      providerSlug = `live-acceptance-${Date.now()}`;
      const definition = {
        slug: providerSlug,
        name: String(process.env.EMPIR3_ACCEPT_PROVIDER_NAME || 'Live Provider Acceptance'),
        apiBaseUrl: providerUrl,
        lend: true,
      };
      if (providerKey) definition.apiKey = providerKey;
      const added = await bridgeRequest(baseUrl, '/api/cli/providers', {
        method: 'POST',
        body: definition,
        timeoutMs: 30_000,
      });
      if (!added.ok || !added.provider?.available || !Array.isArray(added.provider.models)) {
        throw new Error(`Live provider discovery failed for ${definition.name}`);
      }
      const model = providerModel || added.provider.models[0];
      if (!model || !added.provider.models.includes(model)) {
        throw new Error(`Requested live provider model was not discovered: ${model || '(empty)'}`);
      }
      const marker = 'EMPIR3_LOCAL_PROVIDER_ACCEPTED';
      const command = await bridgeRequest(baseUrl, '/api/command', {
        method: 'POST',
        timeoutMs: 180_000,
        body: {
          type: 'custom_llm',
          params: {
            provider: providerSlug,
            model,
            prompt: `Reply with exactly ${marker} and nothing else.`,
          },
        },
      });
      const completion = String(command.result?.text || '').trim();
      if (!command.ok || command.result?.success !== true || !completion.includes(marker)) {
        throw new Error(`Live provider completion failed for ${definition.name}/${model}`);
      }
      provider = {
        name: definition.name,
        discoveredModelCount: added.provider.models.length,
        selectedModel: model,
        completion,
      };
    }

    let keyedProvider = null;
    if (apiProvider) {
      const configured = await bridgeRequest(baseUrl, `/api/api-providers/${encodeURIComponent(apiProvider)}/key`, {
        method: 'POST',
        timeoutMs: 30_000,
        body: { apiKey: apiProviderKey, share: true },
      });
      if (!configured.ok || !configured.provider?.available || !Array.isArray(configured.provider.models)) {
        throw new Error(`Live API provider setup failed for ${apiProvider}`);
      }
      configuredApiProvider = apiProvider;
      const model = apiProviderModel || configured.provider.models[0];
      if (!model || !configured.provider.models.includes(model)) {
        throw new Error(`Requested API provider model was not discovered: ${model || '(empty)'}`);
      }
      const marker = 'EMPIR3_BYO_API_ACCEPTED';
      const command = await bridgeRequest(baseUrl, '/api/command', {
        method: 'POST',
        timeoutMs: 180_000,
        body: {
          type: 'custom_llm',
          params: {
            provider: apiProvider,
            model,
            prompt: `Reply with exactly ${marker} and nothing else.`,
          },
        },
      });
      const completion = String(command.result?.text || '').trim();
      if (!command.ok || command.result?.success !== true || !completion.includes(marker)) {
        throw new Error(`Live API provider completion failed for ${apiProvider}/${model}`);
      }
      keyedProvider = {
        provider: apiProvider,
        discoveredModelCount: configured.provider.models.length,
        selectedModel: model,
        completion,
      };
    }

    const clis = [];
    for (const cli of requestedClis) {
      await bridgeRequest(baseUrl, '/api/command', {
        method: 'POST',
        body: { type: `${cli}:cli:set_opted_in`, params: { value: true } },
      });
      const roster = await bridgeRequest(baseUrl, '/api/command', {
        method: 'POST',
        body: { type: 'cli_status', params: {} },
        timeoutMs: 30_000,
      });
      const entry = roster.result?.result?.models?.find((candidate) => candidate.model === cli);
      if (!entry?.available || !entry?.authenticated || !entry?.ready) {
        throw new Error(`Live ${cli} CLI is not ready in the packaged host`);
      }
      const marker = `EMPIR3_CLI_${cli.toUpperCase()}_ACCEPTED`;
      const command = await bridgeRequest(baseUrl, '/api/command', {
        method: 'POST',
        timeoutMs: 180_000,
        body: {
          type: 'cli_run',
          params: {
            model: cli,
            mode: 'text',
            prompt: `Do not use tools. Reply with exactly ${marker} and nothing else.`,
            timeoutMs: 120_000,
          },
        },
      });
      const result = command.result?.result;
      const completion = String(result?.text || '').trim();
      if (!command.ok || command.result?.success !== true || result?.status !== 'done' || !completion.includes(marker)) {
        throw new Error(`Live ${cli} CLI turn failed in the packaged host`);
      }
      deleteTranscriptSafely(result.transcriptPath);
      clis.push({
        model: cli,
        status: result.status,
        durationMs: result.durationMs,
        completion,
      });
    }

    console.log(JSON.stringify({
      ok: true,
      executable: candidates[0],
      packageVersion: status.version,
      platform: status.platform,
      isolatedState: true,
      relayDisabled: true,
      provider,
      keyedProvider,
      clis,
    }));
  } catch (error) {
    const detail = [stdout, stderr].filter(Boolean).join('\n').slice(-4000);
    if (detail) error.message = `${error.message}\nPackaged host tail:\n${detail}`;
    throw error;
  } finally {
    if (providerSlug) {
      await bridgeRequest(baseUrl, `/api/cli/providers/${encodeURIComponent(providerSlug)}`, {
        method: 'DELETE',
        timeoutMs: 5000,
        allowFailure: true,
      });
    }
    if (configuredApiProvider) {
      await bridgeRequest(baseUrl, `/api/api-providers/${encodeURIComponent(configuredApiProvider)}/key`, {
        method: 'DELETE',
        timeoutMs: 5000,
        allowFailure: true,
      });
    }
    await bridgeRequest(baseUrl, '/api/shutdown', {
      method: 'POST',
      timeoutMs: 5000,
      allowFailure: true,
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await waitForExit(child);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
