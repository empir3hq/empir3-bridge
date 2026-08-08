'use strict';

const http = require('node:http');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, delimiter, join, resolve } = require('node:path');
const { spawn } = require('node:child_process');

const shellRoot = resolve(__dirname, '..');
const outRoot = join(shellRoot, 'out');
const packageArch = process.platform === 'darwin'
  ? 'universal'
  : process.env.EMPIR3_DESKTOP_ARCH || process.arch;
const packageSuffix = `-${process.platform}-${packageArch}`.toLowerCase();

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

const executableOverride = String(process.env.EMPIR3_DESKTOP_SMOKE_EXECUTABLE || '').trim();
let discovered = [];
if (executableOverride) {
  const executable = resolve(executableOverride);
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    throw new Error(`Packaged smoke executable does not exist: ${executable}`);
  }
  discovered = [executable];
} else {
  const packageRoots = readdirSync(outRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().endsWith(packageSuffix))
    .map((entry) => join(outRoot, entry.name));
  if (packageRoots.length !== 1) {
    throw new Error(`Expected one Forge package root for ${process.platform}/${packageArch}, found ${packageRoots.length}`);
  }
  discovered = walk(packageRoots[0]);
}
const candidates = discovered.filter((file) => {
  if (process.platform !== 'darwin') return true;
  return file.includes('.app') && file.includes(`${join('Contents', 'MacOS')}`);
});
if (candidates.length !== 1) {
  throw new Error(`Expected one packaged executable, found ${candidates.length}: ${candidates.join(', ')}`);
}

function startMockProvider() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const authorization = String(request.headers.authorization || '');
      requests.push({ method: request.method, url: request.url, authorization, body });
      response.setHeader('Content-Type', 'application/json');
      if (authorization !== 'Bearer empir3-package-smoke-key') {
        response.writeHead(401);
        response.end(JSON.stringify({ error: 'missing smoke authorization' }));
        return;
      }
      if (request.method === 'GET' && request.url === '/models') {
        response.writeHead(200);
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'smoke-model' }] }));
        return;
      }
      if (request.method === 'POST' && request.url === '/chat/completions') {
        const parsed = JSON.parse(body || '{}');
        const prompt = String(parsed.messages?.at(-1)?.content || '');
        if (parsed.model !== 'smoke-model' || prompt !== 'hello packaged bridge') {
          response.writeHead(400);
          response.end(JSON.stringify({ error: 'unexpected smoke request' }));
          return;
        }
        response.writeHead(200);
        response.end(JSON.stringify({
          id: 'smoke-completion',
          choices: [{ message: { role: 'assistant', content: `smoke: ${prompt}` } }],
        }));
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'not found' }));
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolvePromise({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((resolveClose, rejectClose) => {
          server.close((error) => error ? rejectClose(error) : resolveClose());
        }),
      });
    });
  });
}

function createFakeCodexCli(scratch) {
  const binDir = join(scratch, 'fake-cli-bin');
  const receiptPath = join(scratch, 'fake-codex-receipt.json');
  require('node:fs').mkdirSync(binDir, { recursive: true });
  const driverPath = join(binDir, 'codex-smoke.cjs');
  writeFileSync(driverPath, `'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log('codex-cli 0.0.0-empir3-smoke');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT (Empir3 smoke)');
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const valid = args[0] === 'exec'
    && args.includes('--json')
    && args.includes('--skip-git-repo-check')
    && args.includes('--sandbox')
    && args.at(-1) === '-'
    && input === 'hello packaged cli';
  fs.writeFileSync(process.env.EMPIR3_DESKTOP_SMOKE_CLI_RECEIPT, JSON.stringify({ args, input, valid }));
  if (!valid) process.exit(42);
  console.log(JSON.stringify({ type: 'agent_message', text: 'smoke-cli: hello packaged cli' }));
});
`);
  if (process.platform === 'win32') {
    writeFileSync(
      join(binDir, 'codex.cmd'),
      '@echo off\r\n"%EMPIR3_DESKTOP_SMOKE_NODE%" "%~dp0codex-smoke.cjs" %*\r\n',
    );
  } else {
    const launcher = join(binDir, 'codex');
    writeFileSync(launcher, '#!/bin/sh\nexec "$EMPIR3_DESKTOP_SMOKE_NODE" "$(dirname "$0")/codex-smoke.cjs" "$@"\n');
    chmodSync(launcher, 0o755);
  }
  return { binDir, receiptPath };
}

function runPackagedApp(executable, env) {
  return new Promise((resolvePromise, reject) => {
    const args = ['--smoke'];
    // A built app's chrome-sandbox is not root-owned inside an unprivileged
    // GitHub runner. Disable Chromium's process sandbox only for this isolated
    // CI smoke; installed Linux packages retain Electron's normal sandbox.
    if (process.platform === 'linux' && process.env.CI === 'true') args.push('--no-sandbox');
    const child = spawn(executable, args, {
      cwd: shellRoot,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    const finish = (error, status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise({ status, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Packaged smoke timed out after 90 seconds'));
    }, 90_000);
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => finish(
      signal ? new Error(`Packaged smoke exited on signal ${signal}`) : null,
      code,
    ));
  });
}

async function main() {
  const scratchOverride = String(process.env.EMPIR3_DESKTOP_SMOKE_ROOT || '').trim();
  const scratch = scratchOverride
    ? resolve(scratchOverride)
    : mkdtempSync(join(tmpdir(), 'empir3-desktop-package-smoke-'));
  const ownsScratch = !scratchOverride;
  if (!ownsScratch) mkdirSync(scratch, { recursive: true });
  const mock = await startMockProvider();
  const fakeCli = createFakeCodexCli(scratch);
  try {
    const result = await runPackagedApp(candidates[0], {
      ...process.env,
      HOME: scratch,
      USERPROFILE: scratch,
      APPDATA: join(scratch, 'appdata-roaming'),
      LOCALAPPDATA: join(scratch, 'appdata-local'),
      XDG_CONFIG_HOME: join(scratch, 'xdg-config'),
      XDG_DATA_HOME: join(scratch, 'xdg-data'),
      EMPIR3_DESKTOP_USER_DATA: join(scratch, 'electron-user-data'),
      EMPIR3_BRIDGE_PROFILE: join(scratch, 'chrome-profile'),
      EMPIR3_BRIDGE_NO_RELAY: '1',
      EMPIR3_PW_PORT: '4306',
      EMPIR3_BRIDGE_HTTP_PORT: '11167',
      EMPIR3_CDP_PORT: '11222',
      EMPIR3_DESKTOP_SMOKE_PROVIDER_URL: mock.url,
      EMPIR3_DESKTOP_SMOKE_CLI: 'codex',
      EMPIR3_DESKTOP_SMOKE_STATE_ROOT: join(scratch, 'appdata-roaming'),
      EMPIR3_DESKTOP_SMOKE_CLI_RECEIPT: fakeCli.receiptPath,
      EMPIR3_DESKTOP_SMOKE_NODE: process.execPath,
      EMPIR3_SCALE_CHILD_STDIO: 'inherit',
      EMPIR3_SCALE_HOST_HOME: process.env.HOME || '',
      EMPIR3_SCALE_HOST_USERPROFILE: process.env.USERPROFILE || '',
      PATH: `${fakeCli.binDir}${delimiter}${process.env.PATH || ''}`,
    });
    if (result.status !== 0) throw new Error(`Packaged smoke exited ${result.status}`);
  const receiptLine = String(result.stdout || '').split(/\r?\n/)
    .find((line) => line.startsWith('{"ok":true'));
  if (!receiptLine) throw new Error('Packaged smoke produced no success receipt');
  const receipt = JSON.parse(receiptLine);
  const expectedVersion = String(process.env.EMPIR3_DESKTOP_SMOKE_EXPECTED_VERSION || '').trim();
  if (expectedVersion && receipt.version !== expectedVersion) {
    throw new Error(`Packaged app version ${receipt.version} did not match expected ${expectedVersion}`);
  }
  if (!receipt.daemonHealthy || !receipt.managedBridge || !receipt.providerPaneActive) {
    throw new Error(`Incomplete packaged smoke receipt: ${receiptLine}`);
  }
  if (receipt.browserRunning) throw new Error('Packaged provider-only smoke launched Chrome');
    if (!receipt.updateTrustRootReady) throw new Error('Packaged desktop updater trust root was not loaded');
    if (receipt.providerIntegration?.discoveredModel !== 'smoke-model') {
      throw new Error(`Packaged provider smoke was not exercised: ${receiptLine}`);
    }
    if (receipt.scaleIntegration?.via !== 'payload-headless-entry'
        || receipt.scaleIntegration?.browserRunning !== true) {
      throw new Error(`Packaged bridge_scale smoke was not exercised: ${receiptLine}`);
    }
    if (!mock.requests.some((request) => request.method === 'GET' && request.url === '/models')
        || !mock.requests.some((request) => request.method === 'POST' && request.url === '/chat/completions')) {
      throw new Error(`Packaged provider did not complete discovery and chat: ${JSON.stringify(mock.requests)}`);
    }
    if (receipt.cliIntegration?.model !== 'codex'
        || receipt.cliIntegration?.completion !== 'smoke-cli: hello packaged cli') {
      throw new Error(`Packaged CLI smoke was not exercised: ${receiptLine}`);
    }
    if (!existsSync(fakeCli.receiptPath)) throw new Error('Fake Codex CLI produced no invocation receipt');
    const cliReceipt = JSON.parse(readFileSync(fakeCli.receiptPath, 'utf8'));
    if (!cliReceipt.valid || cliReceipt.input !== 'hello packaged cli') {
      throw new Error(`Packaged CLI invocation contract failed: ${JSON.stringify(cliReceipt)}`);
    }
    const logPath = join(scratch, 'electron-user-data', 'logs', 'bridge-desktop.log');
    if (!existsSync(logPath)) throw new Error('Packaged desktop shell produced no local diagnostic log');
    const logText = readFileSync(logPath, 'utf8');
    if (!/desktop starting/.test(logText) || !/Managed Bridge ready/.test(logText)) {
      throw new Error(`Packaged desktop log is incomplete: ${logText}`);
    }
    const updateHealthPath = join(scratch, 'electron-user-data', 'update-health.json');
    if (!existsSync(updateHealthPath)) throw new Error('Packaged desktop shell produced no update health receipt');
    const updateHealth = JSON.parse(readFileSync(updateHealthPath, 'utf8'));
    if (updateHealth.version !== receipt.version || updateHealth.bridgeHealthy !== true
        || updateHealth.platform !== process.platform || updateHealth.arch !== process.arch) {
      throw new Error(`Packaged update health receipt is invalid: ${JSON.stringify(updateHealth)}`);
    }
    console.log(JSON.stringify({
      ok: true,
      executable: basename(candidates[0]),
      platform: process.platform,
      arch: process.arch,
      providerRequests: mock.requests.length,
      cliReceipt,
      logFile: 'logs/bridge-desktop.log',
      updateHealth,
      receipt,
    }));
  } finally {
    await mock.close();
    if (ownsScratch) {
      try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
      } catch (error) {
        // Chromium's cache files can remain briefly locked on Windows even
        // after the parent Electron process is gone. Test correctness must not
        // be hidden by best-effort scratch cleanup.
        console.warn(`[desktop-package] scratch cleanup deferred: ${error.message || error}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
