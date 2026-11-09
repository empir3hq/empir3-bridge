'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ownsBrowser } = require('../scripts/windows-fixture-browser.cjs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('fixture browser ownership requires exact profile and debugging port arguments', () => {
  const profile = 'C:\\Users\\Test User\\Temp\\empir3-windows-installer-abc123\\home\\.empir3-bridge\\profile-2';
  for (const arg of [`"--user-data-dir=${profile}"`, `--user-data-dir="${profile}"`]) {
    assert.equal(ownsBrowser(`chrome.exe ${arg} --remote-debugging-port=45678`, profile, 45678), true);
    assert.equal(ownsBrowser(`chrome.exe --remote-debugging-port=45678 ${arg}`, profile, 45678), true);
  }
  for (const line of [
    `chrome.exe "--user-data-dir=${profile}-other" --remote-debugging-port=45678`,
    `chrome.exe "--user-data-dir=${profile}" --remote-debugging-port=456789`,
    `chrome.exe "--user-data-dir=${profile}" --remote-debugging-port=45677`,
    `chrome.exe "--user-data-dir=C:\\Users\\Owner\\Chrome" --remote-debugging-port=45678`,
    `chrome.exe "--user-data-dir=${profile}"`,
    'chrome.exe --remote-debugging-port=45678',
    `chrome.exe "--user-data-dir=${profile}" --user-data-dir=C:\\Owner --remote-debugging-port=45678`,
    `chrome.exe "--user-data-dir=${profile}" --remote-debugging-port=45678 --remote-debugging-port=9999`,
  ]) assert.equal(ownsBrowser(line, profile, 45678), false, line);
});

async function exercise({ wrongProfile = false, wrongEndpoint = false, linked = false, closeReset = false, portStillOpen = false, uncertainClose = false } = {}) {
  const scratch = 'C:\\Temp\\empir3-windows-installer-abc123';
  const profile = path.win32.join(scratch, 'home', '.empir3-bridge', 'profile-2');
  const sent = [];
  class Socket {
    constructor() { this.listeners = {}; queueMicrotask(() => this.emit('open')); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    emit(name, value) { this.listeners[name]?.(value); }
    send(text) {
      const message = JSON.parse(text); sent.push(message.method);
      if (message.id === 1) queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: 1, result: { processInfo: [{ type: 'browser', id: 123 }] } }) }));
      else queueMicrotask(() => { if (closeReset) this.emit('error'); this.emit('close'); });
    }
    close() {}
  }
  const module = { exports: {} };
  let now = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/windows-fixture-browser.cjs'), 'utf8'), {
    module, process: { platform: 'win32' }, URL, AbortSignal, WebSocket: Socket, setTimeout, clearTimeout,
    Date: { now: () => { now += 3000; return now; } },
    fetch: async () => {
      if (sent.includes('Browser.close') && !portStillOpen) throw Object.assign(new Error('closed'), { cause: { code: uncertainClose ? 'ETIMEDOUT' : 'ECONNREFUSED' } });
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${wrongEndpoint ? 9999 : 45678}/devtools/browser/abc-123` }) };
    },
    require(name) {
      if (name === 'node:assert/strict') return assert;
      if (name === 'node:path') return path.win32;
      if (name === 'node:os') return { tmpdir: () => 'C:\\Temp' };
      if (name === 'node:fs') return { existsSync: () => true, realpathSync: p => p, lstatSync: () => ({ isSymbolicLink: () => linked }) };
      if (name === 'node:child_process') return { spawnSync(exe, args, options) {
        assert.equal(exe, 'powershell.exe');
        assert.match(args.at(-1), /ProcessId=123/);
        assert.equal(options.windowsHide, true);
        return { status: 0, stdout: `chrome.exe "--user-data-dir=${wrongProfile ? 'C:\\Owner' : profile}" --remote-debugging-port=45678` };
      } };
      throw Error(name);
    },
  });
  let error;
  try { await module.exports.closeFixtureBrowser({ scratch, port: 45678 }); } catch (e) { error = e; }
  return { sent, error };
}

test('fixture cleanup closes only the ownership-verified live browser connection', async () => {
  for (const closeReset of [false, true]) {
    const result = await exercise({ closeReset });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.sent, ['SystemInfo.getProcessInfo', 'Browser.close']);
  }
});

test('a close frame is insufficient while the debugging port remains open or closure is uncertain', async () => {
  for (const options of [{ portStillOpen: true }, { uncertainClose: true }]) {
    const result = await exercise(options);
    assert.match(result.error.message, /closure is unverified/);
  }
});

test('fixture cleanup refuses wrong profile, redirected endpoint and linked profile without closing a browser', async () => {
  for (const options of [{ wrongProfile: true }, { wrongEndpoint: true }, { linked: true }]) {
    const result = await exercise(options);
    assert.ok(result.error);
    assert.equal(result.sent.includes('Browser.close'), false);
  }
});
