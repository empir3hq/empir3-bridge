#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, spawnSync } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = new Set(process.argv.slice(2));
const getArg = (name, fallback = '') => {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const PASSES = Number(getArg('--passes', process.env.BRIDGE_CERT_PASSES || '3'));
const PROD_SERVER = normalizeServer(getArg('--prod', process.env.BRIDGE_CERT_PROD_SERVER || 'https://app.empir3.com'));
const DEV_SERVER = normalizeServer(getArg('--dev', process.env.BRIDGE_CERT_DEV_SERVER || 'http://localhost:3005'));
const INSTALLER_ARG = getArg('--installer', process.env.BRIDGE_CERT_INSTALLER || join(ROOT, 'build', 'dist', 'Empir3Setup.exe'));
const DOWNLOAD_INSTALLER = args.has('--download-installer');
const SKIP_INSTALL = args.has('--skip-install');
const SKIP_VINCENT = args.has('--skip-vincent');
const OUT_ROOT = resolve(getArg('--out', process.env.BRIDGE_CERT_OUT || join(tmpdir(), 'empir3-bridge-cert', stamp())));
const BRIDGE = 'http://127.0.0.1:3006';
const EXPECTED_MCP_TOOLS = [
  'browser_status', 'bridge_reliability_status', 'bridge_reliability_smoke', 'bridge_action_log',
  'bridge_safety_status', 'bridge_revoke_control',
  'browser_navigate', 'browser_click', 'browser_click_ref', 'browser_click_xy',
  'browser_type', 'browser_type_ref', 'browser_press', 'browser_scroll',
  'browser_screenshot', 'desktop_monitors', 'desktop_screenshot', 'desktop_click',
  'desktop_hover', 'desktop_drag', 'browser_snapshot', 'browser_text', 'browser_evaluate',
  'browser_highlight', 'browser_chat', 'browser_read_chat', 'browser_record_start',
  'browser_record_stop', 'browser_play', 'browser_recordings', 'browser_refresh',
];

mkdirSync(OUT_ROOT, { recursive: true });

const summary = {
  startedAt: new Date().toISOString(),
  outRoot: OUT_ROOT,
  prodServer: PROD_SERVER,
  devServer: DEV_SERVER,
  installer: INSTALLER_ARG,
  passes: [],
  accounts: [],
};

main().catch((err) => {
  summary.fatal = err?.stack || err?.message || String(err);
  writeJson('summary.json', summary);
  console.error(summary.fatal);
  process.exit(1);
});

async function main() {
  console.log(`[cert] evidence: ${OUT_ROOT}`);
  const installer = DOWNLOAD_INSTALLER ? await downloadInstaller() : INSTALLER_ARG;
  if (!existsSync(installer)) throw new Error(`Installer not found: ${installer}`);
  summary.installer = installer;
  summary.installerVersion = runCapture(installer, ['--version']).stdout.trim();
  writeJson('installer-version.json', {
    installer,
    version: summary.installerVersion,
    sha256: runCapture('powershell', ['-NoProfile', '-Command', `(Get-FileHash -Algorithm SHA256 -LiteralPath ${psQuote(installer)}).Hash`]).stdout.trim(),
  });

  const prodA = await createAccount(PROD_SERVER, 'prod-a');
  const prodB = await createAccount(PROD_SERVER, 'prod-b');
  const devA = await createAccount(DEV_SERVER, 'dev-a');
  summary.accounts = [
    redactAccount(prodA),
    redactAccount(prodB),
    redactAccount(devA),
  ];
  writeJson('accounts.redacted.json', summary.accounts);
  writeJson('accounts.private.json', [prodA, prodB, devA]);

  for (let i = 1; i <= PASSES; i++) {
    const passDir = join(OUT_ROOT, `pass-${i}`);
    mkdirSync(passDir, { recursive: true });
    console.log(`[cert] pass ${i}/${PASSES}`);
    const result = await certifyPass(i, passDir, installer, { prodA, prodB, devA });
    summary.passes.push(result);
    writeJson('summary.json', summary);
    if (!result.ok) throw new Error(`Certification pass ${i} failed; see ${passDir}`);
  }

  summary.completedAt = new Date().toISOString();
  summary.ok = true;
  writeJson('summary.json', summary);
  console.log(`[cert] OK - ${PASSES} pass(es) completed`);
}

async function certifyPass(pass, passDir, installer, accounts) {
  const checks = [];
  const evidence = (name, value) => {
    const target = join(passDir, name);
    if (Buffer.isBuffer(value)) writeFileSync(target, value);
    else writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return target;
  };
  const check = async (name, fn) => {
    const start = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, ok: true, elapsedMs: Date.now() - start, detail: trimDetail(detail) });
      return detail;
    } catch (err) {
      checks.push({ name, ok: false, elapsedMs: Date.now() - start, error: err?.message || String(err) });
      throw err;
    }
  };

  await check('install-and-launch', async () => {
    if (!SKIP_INSTALL) {
      await stopExistingTray();
      const child = spawn(installer, [], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    }
    const status = await waitForBridge(90_000);
    evidence('status-after-install.json', status);
    return status;
  });

  await check('welcome-visual', async () => {
    await bridgeCommand({ action: 'navigate', url: `${BRIDGE}/welcome` });
    await sleep(1200);
    const shot = await getBinary(`${BRIDGE}/api/screenshot?maxWidth=1600`);
    const path = evidence('welcome-9867.jpg', shot);
    const html = await getText(`${BRIDGE}/welcome`);
    assertWelcomeScriptSyntax(html);
    evidence('welcome-3006.html', html);
    const ui = await bridgeCommand({
      type: 'evaluate',
      script: `(() => {
        const before = document.querySelector('#panel-mcp')?.classList.contains('active') === true;
        document.querySelector('button[data-mode="empir3"]')?.click();
        const after = document.querySelector('#panel-empir3')?.classList.contains('active') === true;
        return { selectedServer: typeof selectedServer, before, after };
      })()`,
    });
    if (ui?.result?.selectedServer !== 'function' || !ui?.result?.before || !ui?.result?.after) {
      throw new Error(`Welcome mode UI did not initialize correctly: ${JSON.stringify(ui)}`);
    }
    return { screenshot: path, htmlBytes: html.length, modeUi: ui.result };
  });

  await check('mcp-mode-full-surface', async () => {
    await postJson(`${BRIDGE}/api/install/sign-out`, {});
    await waitForBridge(60_000);
    const mcp = await postJson(`${BRIDGE}/api/install/claude-code`, {});
    evidence('mcp-config.json', mcp.body);
    const result = await runMcpSmoke(installer, passDir);
    evidence('mcp-smoke.json', result);
    return result;
  });

  await check('prod-account-a-login-relay', async () => {
    const status = await loginBridge(accounts.prodA);
    const relay = await relaySmoke(accounts.prodA, passDir, `prod-a-pass-${pass}`);
    evidence('prod-a-relay.json', relay);
    return { status, relay };
  });

  await check('prod-account-logout-login-new-account', async () => {
    await signOutBridge();
    const status = await loginBridge(accounts.prodB);
    const relay = await relaySmoke(accounts.prodB, passDir, `prod-b-pass-${pass}`);
    evidence('prod-b-relay.json', relay);
    return { status, relay };
  });

  await check('dev-account-login-local-server', async () => {
    await signOutBridge();
    const status = await loginBridge(accounts.devA);
    const relay = await relaySmoke(accounts.devA, passDir, `dev-a-pass-${pass}`);
    evidence('dev-a-relay.json', relay);
    return { status, relay };
  });

  await check('switch-dev-back-to-production', async () => {
    await signOutBridge();
    const status = await loginBridge(accounts.prodA);
    if (!String(status.serverUrl || '').includes('app.empir3.com')) throw new Error(`Expected production server, got ${status.serverUrl}`);
    return status;
  });

  if (!SKIP_VINCENT) {
    await check('vincent-direct-control', async () => {
      const vincent = await vincentDirectSmoke(accounts.prodA, passDir, pass);
      evidence('vincent-direct.json', vincent);
      return vincent;
    });
  }

  const ok = checks.every((c) => c.ok);
  const result = { pass, ok, checks, finishedAt: new Date().toISOString(), passDir };
  evidence('pass-summary.json', result);
  return result;
}

async function runMcpSmoke(installer, passDir) {
  const transport = new StdioClientTransport({
    command: installer,
    args: ['--mcp'],
    env: { ...process.env, BRIDGE_URL: BRIDGE },
  });
  const client = new Client({ name: 'empir3-bridge-cert', version: '1.0.0' });
  await client.connect(transport);
  const calls = [];
  const call = async (name, args = {}) => {
    const started = Date.now();
    try {
      const result = await client.callTool({ name, arguments: args });
      const text = contentText(result).slice(0, 1000);
      if (result?.isError) {
        throw new Error(`MCP tool ${name} returned error: ${text}`);
      }
      calls.push({ name, ok: true, elapsedMs: Date.now() - started, text });
      return result;
    } catch (err) {
      calls.push({ name, ok: false, elapsedMs: Date.now() - started, error: err?.message || String(err) });
      throw err;
    }
  };

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name).sort();
  const missing = EXPECTED_MCP_TOOLS.filter((name) => !toolNames.includes(name));
  if (missing.length) throw new Error(`MCP missing tools: ${missing.join(', ')}`);

  const html = `<!doctype html><html><body style="font-family:sans-serif;padding:30px;min-height:1400px">
    <h1>Empir3 Bridge Cert</h1>
    <button id="certButton" onclick="window.certClicked=(window.certClicked||0)+1">Cert Button</button>
    <input id="certInput" aria-label="Cert Input" placeholder="type here">
    <div id="result"></div>
    <script>window.certClicked=0</script>
  </body></html>`;
  await call('browser_status');
  await call('browser_navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
  await sleep(1000);
  await call('browser_snapshot', { filter: 'all', format: 'json' });
  await call('browser_text');
  await call('browser_click', { selector: '#certButton' });
  await call('browser_type', { selector: '#certInput', text: 'mcp selector typed' });
  await call('browser_press', { key: 'Tab' });
  await call('browser_click_xy', { x: 95, y: 88 });
  await call('browser_scroll', { y: 400 });
  await call('browser_evaluate', { script: '({clicked: window.certClicked, input: document.querySelector("#certInput")?.value})' });
  await call('browser_highlight', { selector: '#certButton' });
  await call('browser_screenshot');
  await call('browser_chat', { message: `Bridge certification MCP chat ${new Date().toISOString()}` });
  await call('browser_read_chat');
  await call('browser_record_start');
  await call('browser_click', { selector: '#certButton' });
  const stopped = await call('browser_record_stop', { name: `cert-pass-${Date.now()}` });
  await call('browser_recordings');
  await call('browser_refresh');
  await call('desktop_monitors');
  await call('desktop_screenshot', { monitor: 'primary' });
  await call('desktop_hover', { monitor: 'primary', x: 25, y: 25 });
  await call('bridge_reliability_status');
  await call('bridge_reliability_smoke');
  await call('bridge_action_log');
  await call('bridge_safety_status');

  const screenshot = await getBinary(`${BRIDGE}/api/screenshot?maxWidth=1600`);
  writeFileSync(join(passDir, 'mcp-final-browser.jpg'), screenshot);

  await client.close();
  return {
    tools: toolNames,
    skippedDestructiveTools: ['bridge_revoke_control', 'desktop_click', 'desktop_drag', 'browser_play'],
    recordStop: contentText(stopped).slice(0, 500),
    calls,
    ok: calls.every((c) => c.ok),
  };
}

async function relaySmoke(account, passDir, label) {
  const wsUrl = account.serverUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(account.token)}`;
  const ws = await openWs(wsUrl);
  const results = [];
  try {
    for (const item of [
      ['desktop:capabilities', { action: 'quick' }],
      ['desktop:sysinfo', { action: 'overview' }],
      ['desktop:window', { action: 'list', params: {} }],
      ['desktop:gui', { action: 'screenshot', params: { quality: 65 } }],
      ['desktop:agent-browser', { action: 'status', params: {} }],
    ]) {
      const [type, payload] = item;
      const result = await wsRequest(ws, type, payload, 45_000);
      results.push({
        type,
        success: result.success !== false,
        keys: Object.keys(result).sort(),
        imageBytes: result?.data?.thumbnail ? Buffer.byteLength(result.data.thumbnail, 'base64') : 0,
        detail: trimDetail(result),
      });
    }
    const screenshotResult = results.find((r) => r.type === 'desktop:gui' && r.imageBytes);
    if (!screenshotResult) throw new Error('Relay desktop screenshot returned no image bytes');
  } finally {
    ws.close();
  }
  writeJson(join(passDir, `${label}.relay-summary.json`), results);
  return { ok: results.every((r) => r.success), results };
}

async function vincentDirectSmoke(account, passDir, pass) {
  const dm = await postJson(`${account.serverUrl}/api/projects/dm`, { agentId: 'ceo' }, account.token);
  if (dm.status !== 200 || !dm.body?.project?.id) throw new Error(`DM create failed: ${dm.status} ${JSON.stringify(dm.body)}`);
  const projectId = dm.body.project.id;
  const wsUrl = account.serverUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(account.token)}`;
  const ws = await openWs(wsUrl);
  const seen = [];
  const content = [
    `Vincent, this is bridge certification pass ${pass}.`,
    'Use desktop_control exactly once with type "window" and action "list".',
    'Then reply with the number of windows you saw and the phrase BRIDGE_CERT_DIRECT_OK.',
  ].join(' ');
  try {
    ws.send(JSON.stringify({
      type: 'chat:send',
      payload: {
        projectId,
        content,
        mentionedAgents: [],
        autonomyLevel: 'unrestricted',
        flowPreset: 'balanced',
        webSearchEnabled: false,
        agentTimeout: 180,
        discussionRounds: 1,
      },
    }));
    const complete = await waitWs(ws, (msg) => {
      seen.push(trimDetail(msg));
      return msg.type === 'chat:complete';
    }, 210_000);
    const text = JSON.stringify(complete);
    writeJson(join(passDir, `vincent-pass-${pass}.events.json`), seen);
    if (/Budget limit reached|can't verify the usage balance|No .*model configured/i.test(text)) {
      throw new Error(`Vincent direct blocked by server/account/provider: ${text.slice(0, 500)}`);
    }
    if (!/BRIDGE_CERT_DIRECT_OK|window/i.test(text)) {
      throw new Error(`Vincent direct completed without expected bridge evidence: ${text.slice(0, 500)}`);
    }
    return { ok: true, projectId, complete: trimDetail(complete), eventCount: seen.length };
  } finally {
    ws.close();
  }
}

async function createAccount(serverUrl, lane) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `bridge-cert-${lane}-${id}@example.com`;
  const password = `BridgeCert!${Math.random().toString(36).slice(2)}${Date.now()}`;
  const name = `Bridge Cert ${lane}`;
  const res = await postJson(`${serverUrl}/api/auth/register`, { email, password, name });
  if (res.status !== 201 || !res.body?.token) {
    throw new Error(`Register ${lane} failed on ${serverUrl}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    lane,
    serverUrl,
    email,
    password,
    token: res.body.token,
    user: res.body.user,
    channelId: res.body.channelId,
  };
}

async function loginBridge(account) {
  const r = await postJson(`${BRIDGE}/api/install/empir3-login`, {
    email: account.email,
    password: account.password,
    serverUrl: account.serverUrl,
  });
  if (r.status !== 200 || !r.body?.ok) throw new Error(`Bridge login failed: ${r.status} ${JSON.stringify(r.body)}`);
  const status = await waitForRelay(account.email, account.serverUrl, 90_000);
  return status;
}

async function signOutBridge() {
  await postJson(`${BRIDGE}/api/install/sign-out`, {});
  await waitForBridge(60_000);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = await getJson(`${BRIDGE}/api/relay-status`).catch(() => null);
    if (status?.body && !status.body.hasAuth) return status.body;
    await sleep(1000);
  }
  throw new Error('Bridge did not sign out within timeout');
}

async function waitForRelay(email, serverUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await getJson(`${BRIDGE}/api/relay-status`).catch(() => null);
    const status = res?.body;
    if (status?.authUser?.email === email && status?.relay?.connected) {
      const got = normalizeServer(status.serverUrl || status.relay?.serverUrl || '');
      if (got === normalizeServer(serverUrl)) return status;
    }
    await sleep(1500);
  }
  throw new Error(`Relay did not connect as ${email} on ${serverUrl}`);
}

async function waitForBridge(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const res = await getJson(`${BRIDGE}/api/status`);
      if (res.status === 200 && res.body?.running) {
        const bridgeUrl = res.body.bridgeUrl || 'http://localhost:9867';
        const health = await getJson(`${bridgeUrl}/health`);
        if (health.status === 200 && health.body?.status === 'connected') {
          return { ...res.body, bridgeHealth: health.body };
        }
        last = { status: res.body, bridgeHealth: health.body };
      } else {
        last = res.body;
      }
    } catch (err) {
      last = err?.message || String(err);
    }
    await sleep(1000);
  }
  throw new Error(`Bridge did not become healthy: ${JSON.stringify(last)}`);
}

async function stopExistingTray() {
  if (process.platform !== 'win32') return;
  spawnSync('taskkill', ['/F', '/IM', 'Empir3Tray.exe'], { stdio: 'ignore', windowsHide: true });
  spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    '$ports=3006,3106,3206,3306,9867; foreach($p in $ports){ Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {} } }',
  ], { stdio: 'ignore', windowsHide: true });
  await sleep(1500);
}

async function downloadInstaller() {
  const target = join(OUT_ROOT, 'Empir3Setup.exe');
  await downloadFile(`${PROD_SERVER}/downloads/Empir3Setup.exe`, target);
  return target;
}

async function downloadFile(url, target) {
  mkdirSync(dirname(target), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed ${url}: ${res.status}`);
  await new Promise((resolvePromise, reject) => {
    const file = createWriteStream(target);
    res.body.pipeTo(new WritableStream({
      write(chunk) { file.write(Buffer.from(chunk)); },
      close() { file.end(resolvePromise); },
      abort(err) { file.destroy(err); reject(err); },
    })).catch(reject);
  });
}

async function bridgeCommand(cmd) {
  const res = await postJson(`${BRIDGE}/api/command`, cmd);
  if (res.status !== 200 || !res.body?.ok) throw new Error(`Bridge command failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.result;
}

async function getJson(url, token) {
  return requestJson('GET', url, undefined, token);
}

async function postJson(url, body, token) {
  return requestJson('POST', url, body, token);
}

async function requestJson(method, url, body, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed, text };
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.text();
}

async function getBinary(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function openWs(url) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`WebSocket timeout: ${url}`)), 20_000);
    ws.on('open', () => { clearTimeout(timer); resolvePromise(ws); });
    ws.on('error', reject);
  });
}

function wsRequest(ws, type, payload, timeoutMs) {
  const id = `cert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resultType = `${type}:result`;
  ws.send(JSON.stringify({ type, payload: { id, ...payload } }));
  return waitWs(ws, (msg) => msg.type === resultType && (msg.payload?.id === id || msg.id === id), timeoutMs)
    .then((msg) => msg.payload || msg);
}

function waitWs(ws, predicate, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for websocket message after ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (data) => {
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      try {
        if (predicate(msg)) {
          cleanup();
          resolvePromise(msg);
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.status !== 0) {
    throw new Error(`${basename(command)} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return { stdout: result.stdout || '', stderr: result.stderr || '' };
}

function contentText(result) {
  return (result?.content || []).map((item) => item.text || '').join('\n');
}

function assertWelcomeScriptSyntax(html) {
  const match = String(html || '').match(/<script>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('Welcome page script block not found');
  try {
    new Function(match[1]);
  } catch (err) {
    throw new Error(`Welcome page script syntax error: ${err?.message || String(err)}`);
  }
}

function trimDetail(value) {
  const text = JSON.stringify(value, (_, v) => {
    if (typeof v === 'string' && v.length > 1400) return `${v.slice(0, 1400)}...(${v.length} chars)`;
    return v;
  });
  try { return JSON.parse(text); } catch { return value; }
}

function redactAccount(account) {
  return {
    lane: account.lane,
    serverUrl: account.serverUrl,
    email: account.email,
    user: account.user,
    channelId: account.channelId,
  };
}

function writeJson(nameOrPath, data) {
  const target = nameOrPath.includes(':') || nameOrPath.startsWith('/') || nameOrPath.includes('\\')
    ? nameOrPath
    : join(OUT_ROOT, nameOrPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(data, null, 2));
}

function normalizeServer(input) {
  const raw = String(input || '').trim();
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const u = new URL(withProtocol);
  u.pathname = u.pathname.replace(/\/+$/, '');
  if (u.pathname === '/') u.pathname = '';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/+$/, '');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
