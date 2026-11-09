'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

function ownsBrowser(commandLine, profile, port) {
  for (const name of ['user-data-dir', 'remote-debugging-port']) {
    if ((commandLine.match(new RegExp(`(?:^|\\s)"?--${name}(?:=|\\s|$)`, 'gi')) || []).length !== 1) return false;
  }
  const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flag = (name, value) => new RegExp(`(?:^|\\s)(?:"--${name}=${escape(value)}"|--${name}="${escape(value)}"|--${name}=${escape(value)})(?=\\s|$)`, 'i');
  return flag('user-data-dir', profile).test(commandLine)
    && flag('remote-debugging-port', port).test(commandLine);
}

function fixtureProfile(scratch) {
  const root = path.resolve(scratch);
  assert.match(path.basename(root), /^empir3-windows-installer-[a-zA-Z0-9]+$/);
  assert.equal(fs.realpathSync(path.dirname(root)), fs.realpathSync(tmpdir()));
  assert.equal(fs.realpathSync(root), root, 'Fixture root must not be redirected');
  let current = root;
  for (const part of ['home', '.empir3-bridge', 'profile-2']) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) return null;
    assert.equal(fs.lstatSync(current).isSymbolicLink(), false, 'Fixture profile must not be linked');
    assert.equal(fs.realpathSync(current), current, 'Fixture profile must not be redirected');
  }
  return current;
}

// A Windows Chrome launcher can hand off to a process outside the wrapper's
// process tree. Close only the browser on this live CDP connection after its
// browser PID proves the exact disposable profile AND debugging port. Never
// kill Chrome by image name, a port alone, or a PID from an old receipt.
async function closeFixtureBrowser({ scratch, port }) {
  assert.equal(process.platform, 'win32');
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
  const profile = fixtureProfile(scratch);
  if (!profile) return { connected: false };
  let version;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    assert.ok(response.ok);
    version = await response.json();
  } catch { return { connected: false }; }
  const endpoint = new URL(version.webSocketDebuggerUrl);
  assert.equal(endpoint.protocol, 'ws:');
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.equal(endpoint.port, String(port));
  assert.match(endpoint.pathname, /^\/devtools\/browser\/[a-zA-Z0-9-]+$/);
  assert.equal(endpoint.username + endpoint.password + endpoint.search + endpoint.hash, '');
  const socket = new WebSocket(endpoint);
  let sentClose = false;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture browser close timed out')), 8000);
      const fail = error => { clearTimeout(timer); reject(error); };
      // Chrome can reset CDP rather than send a WebSocket close frame when
      // Browser.close exits the browser. Only tolerate that AFTER ownership
      // proof and close submission; the port-closed check below is mandatory.
      socket.addEventListener('error', () => { if (!sentClose) fail(new Error('Fixture browser connection failed')); });
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        if (sentClose) resolve(); else reject(new Error('Fixture browser closed before ownership proof'));
      });
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' })));
      socket.addEventListener('message', event => {
        try {
          const message = JSON.parse(event.data);
          if (message.id !== 1) return;
          assert.ok(!message.error);
          const browsers = message.result.processInfo.filter(p => p.type === 'browser');
          assert.equal(browsers.length, 1);
          const pid = browsers[0].id;
          assert.ok(Number.isSafeInteger(pid) && pid > 0);
          const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p.Name -ne 'chrome.exe'){exit 2}; [Console]::Write($p.CommandLine)`],
          { encoding: 'utf8', windowsHide: true, timeout: 5000 });
          assert.equal(result.status, 0, 'Could not establish fixture browser ownership');
          assert.ok(ownsBrowser(result.stdout, profile, port), 'Refusing a browser outside the exact fixture profile and port');
          sentClose = true;
          socket.send(JSON.stringify({ id: 2, method: 'Browser.close' }));
        } catch (error) { fail(error); }
      });
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      } catch (error) {
        if (error.cause?.code === 'ECONNREFUSED') return { connected: true, closed: true };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Fixture browser debugging port remains reachable or its closure is unverified');
  } finally { socket.close(); }
}

module.exports = { ownsBrowser, fixtureProfile, closeFixtureBrowser };
