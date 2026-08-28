#!/usr/bin/env node
/**
 * Koba Installer Server — local HTTP server behind the chat UI.
 *
 * Flow:
 *   1. Pick a random localhost port, start the HTTP server.
 *   2. Open the user's default browser to http://localhost:<port>/
 *   3. Serve the chat UI; respond to its fetch() calls:
 *        POST /api/login  { email, password }
 *        POST /api/signup { email, password, name }
 *        POST /api/launch { token, user }     → writes auth+settings, spawns bridge
 *        POST /api/open-browser               → launches Chrome on /connect?oauth_token=...
 *        POST /api/close                      → exit after a delay so the fetch resolves
 *   4. When the chat is done, installer exits and the detached Bridge takes over.
 *
 * This file never embeds credentials. All auth calls go to app.empir3.com
 * which issues the token and sets the server-side cookie; we just relay the
 * POST and persist the returned token locally.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, exec } = require('child_process');
const https = require('https');

const SERVER = process.env.EMPIR3_SERVER || 'https://app.empir3.com';
// In dev runs UI files are next to this script; in SEA-packaged runs the
// payload tarball ships installer-ui/ alongside this bundle and the path
// is surfaced through an env var by build/payload-entry.js.
const UI_DIR = process.env.EMPIR3_BRIDGE_INSTALLER_UI_DIR || path.join(__dirname, 'ui');
const APPDATA = path.join(process.env.APPDATA || path.join(os.homedir(), '.empir3'), 'Empir3');
const AUTH_FILE = path.join(APPDATA, 'bridge-auth.json');
const SETTINGS_FILE = path.join(APPDATA, 'bridge-settings.json');

function ensureAppdata() { try { fs.mkdirSync(APPDATA, { recursive: true }); } catch {} }

// ── Tiny HTTPS JSON client (no external deps) ──────────────────────────

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'empir3-bridge-installer',
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(chunks); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: chunks });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Local state for the installer session ─────────────────────────────

let savedAuth = null;
let bridgeChild = null;

// ── HTTP handlers ──────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try { resolve(JSON.parse(buf)); } catch { resolve({}); }
    });
  });
}

function sendJson(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function serveStatic(req, res) {
  // Map request paths to files under UI_DIR. Default → index.html.
  let rel = req.url.split('?')[0];
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = path.normalize(rel).replace(/^([/\\])+/, '');
  const filePath = path.join(UI_DIR, safe);
  if (!filePath.startsWith(UI_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const ct = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
}

async function handleApi(req, res, pathname) {
  const body = await readBody(req);

  if (pathname === '/api/login') {
    // NEVER log password material. Even length + last char is enough to
    // accelerate a brute-force / shoulder-surf attack and leaks signal
    // about the user's password. The previous log line shipped to the
    // installer's local console + bridge.log on disk — caught live in
    // cont-13O smoke when the user spotted "[login] ... password.length=14
    // password.lastChar='m'" scrolling past during install.
    console.log(`[login] email=${JSON.stringify(body.email)}`);
    const r = await postJson(`${SERVER}/api/auth/login`, { email: body.email, password: body.password });
    if (r.status === 200 && r.body?.token) {
      savedAuth = { legacyToken: r.body.token, user: r.body.user, channelId: r.body.channelId || null };
      return sendJson(res, 200, { ok: true, user: r.body.user });
    }
    return sendJson(res, r.status, { ok: false, error: r.body?.error || 'Login failed' });
  }

  if (pathname === '/api/signup') {
    const r = await postJson(`${SERVER}/api/auth/register`, { email: body.email, password: body.password, name: body.name });
    if ((r.status === 200 || r.status === 201) && r.body?.token) {
      savedAuth = { legacyToken: r.body.token, user: r.body.user, channelId: r.body.channelId || null };
      return sendJson(res, 200, { ok: true, user: r.body.user });
    }
    return sendJson(res, r.status, { ok: false, error: r.body?.error || 'Signup failed' });
  }

  if (pathname === '/api/launch') {
    if (!savedAuth) return sendJson(res, 400, { ok: false, error: 'Not authenticated' });
    ensureAppdata();
    // Persist auth
    fs.writeFileSync(AUTH_FILE, JSON.stringify(savedAuth, null, 2));
    // Ensure a settings file exists; Bridge fills in deviceId on first boot
    if (!fs.existsSync(SETTINGS_FILE)) {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
        deviceName: os.hostname(),
        homeDirectory: path.join(os.homedir(), 'Documents', 'Empir3'),
        permissions: { read: true, write: false, execute: false },
      }, null, 2));
    }
    // Spawn the Bridge — detached. In SEA-packaged runs we invoke the
    // bootstrapper with `--daemon`, which spawns the tray wrapper, which
    // in turn supervises the actual daemon. The user sees a tray icon.
    // In dev runs we still point Node directly at index.js (no tray) so
    // smoke-tests of the installer don't depend on a built Empir3Tray.exe.
    let isSea = false;
    try { isSea = !!require('node:sea').isSea(); } catch {}
    const spawnArgs = isSea ? ['--daemon'] : [path.resolve(__dirname, '..', 'index.js')];
    bridgeChild = spawn(process.execPath, spawnArgs, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, RELAY_SECRET: process.env.RELAY_SECRET || '' },
    });
    bridgeChild.unref();
    return sendJson(res, 200, { ok: true, pid: bridgeChild.pid });
  }

  if (pathname === '/api/bridge-status') {
    // Poll for 'relay.connected' in the recent bridge log
    const logPath = path.join(APPDATA, 'bridge.log');
    let connected = false;
    try {
      const size = fs.statSync(logPath).size;
      const start = Math.max(0, size - 20_000);
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      connected = buf.toString('utf8').includes('relay.connected');
    } catch {}
    return sendJson(res, 200, { connected });
  }

  if (pathname === '/api/open-browser') {
    if (!savedAuth) return sendJson(res, 400, { ok: false, error: 'Not authenticated' });
    const userJson = encodeURIComponent(JSON.stringify(savedAuth.user));
    const target = `${SERVER}/connect?oauth_token=${encodeURIComponent(savedAuth.legacyToken)}&oauth_user=${userJson}`;
    // Open in system default browser (user's regular Chrome, with their cookies + history)
    const cmd = process.platform === 'win32' ? `start "" "${target}"` :
                process.platform === 'darwin' ? `open "${target}"` :
                `xdg-open "${target}"`;
    exec(cmd);
    return sendJson(res, 200, { ok: true, url: target });
  }

  if (pathname === '/api/close') {
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 400);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
}

// ── Server ─────────────────────────────────────────────────────────────

function start() {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (pathname.startsWith('/api/')) {
      try { await handleApi(req, res, pathname); }
      catch (e) { sendJson(res, 500, { ok: false, error: e.message }); }
      return;
    }
    serveStatic(req, res);
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/`;
    console.log(`[koba-installer] ${url}`);
    const cmd = process.platform === 'win32' ? `start "" "${url}"` :
                process.platform === 'darwin' ? `open "${url}"` :
                `xdg-open "${url}"`;
    exec(cmd);
  });
}

if (require.main === module) start();

module.exports = { start };
