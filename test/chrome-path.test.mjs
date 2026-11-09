import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { chromeCandidatePaths, findChromePath, chromeNotFoundMessage } from '../src/chrome-path.ts';

// Work Board b6430238 / 802e566a: Chrome installed without admin rights lives
// under %LOCALAPPDATA%, and the Bridge used to look only under Program Files.
const PROFILE = String.raw`C:\Users\conta`;
const LOCAL = join(PROFILE, 'AppData', 'Local');
const perUser = join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe');

test('a per-user Windows Chrome install is found without CHROME_PATH', () => {
  const found = findChromePath({ LOCALAPPDATA: LOCAL }, 'win32', (p) => p === perUser);
  assert.equal(found, perUser);
});

test('machine-wide Chrome still wins over the per-user copy', () => {
  const machine = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const found = findChromePath({ LOCALAPPDATA: LOCAL }, 'win32', (p) => p === machine || p === perUser);
  assert.equal(found, machine);
});

test('CHROME_PATH still overrides every default', () => {
  const custom = 'D:/Portable/chrome.exe';
  const found = findChromePath({ CHROME_PATH: custom, LOCALAPPDATA: LOCAL }, 'win32', () => true);
  assert.equal(found, custom);
});

test('USERPROFILE stands in when LOCALAPPDATA is missing', () => {
  const paths = chromeCandidatePaths({ USERPROFILE: PROFILE }, 'win32');
  assert.ok(paths.includes(perUser), paths.join('\n'));
});

test('the not-found error names every path it tried', () => {
  assert.throws(
    () => findChromePath({ LOCALAPPDATA: LOCAL }, 'win32', () => false),
    (err) => {
      assert.match(err.message, /Program Files\/Google\/Chrome/);
      assert.ok(err.message.includes(perUser), err.message);
      assert.match(err.message, /Install Google Chrome/);
      // The app's missing-browser classifier (empir3 bridgePolicyRefusal.ts).
      assert.match(err.message, /chrome(?:\/chromium)?\s+not found/i);
      return true;
    },
  );
});

test('Linux candidates contain Linux browser locations only', () => {
  const paths = chromeCandidatePaths({}, 'linux');
  assert.deepEqual(paths, [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser',
    '/usr/bin/chromium', '/snap/bin/chromium',
  ]);
});

test('macOS finds both system and per-user Applications installs', () => {
  const userChrome = '/Users/test/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const paths = chromeCandidatePaths({ HOME: '/Users/test' }, 'darwin');
  assert.deepEqual(paths, ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', userChrome]);
  assert.equal(findChromePath({ HOME: '/Users/test' }, 'darwin', p => p === userChrome), userChrome);
});

test('macOS missing-browser guidance never recommends apt or a Windows executable', () => {
  const message = chromeNotFoundMessage(chromeCandidatePaths({}, 'darwin'), 'darwin');
  assert.match(message, /Chrome\/Chromium not found/);
  assert.match(message, /Applications/);
  assert.match(message, /google\.com\/chrome/);
  assert.doesNotMatch(message, /apt|chrome\.exe|Program Files/);
});

test('the Bridge browser launcher uses this lookup', () => {
  const source = readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("from './chrome-path.js'"), 'bridge.ts must import ./chrome-path.js');
  assert.ok(/findChromePath\(\)/.test(source), 'bridge.ts must launch the path findChromePath() returns');
  assert.ok(!source.includes("'Chrome not found. Set CHROME_PATH env var.'"), 'the old Program-Files-only message is gone');
});
