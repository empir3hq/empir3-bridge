import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const desktopMain = readFileSync(new URL('../desktop-shell/src/main.cjs', import.meta.url), 'utf8');
const tray = readFileSync(new URL('../tray/tray.py', import.meta.url), 'utf8');

test('local user launch bypasses agent Execute permission without weakening agent commands', () => {
  assert.match(
    server,
    /url\.pathname === '\/api\/browser\/show'[\s\S]*?handleAgentBrowserAction\('show', \{\}\)/,
  );
  assert.match(
    server,
    /\['click',[\s\S]*?'desktop:browse:show'[\s\S]*?\]\s*\.includes\(type\)\) return 'execute'/,
  );
});

test('every local Launch browser surface uses the user-owned endpoint', () => {
  const welcomeHandler = server.match(/async function onOpenBridge\(e\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const desktopHandler = desktopMain.match(/async function showBridgeBrowser\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  const trayHandler = tray.match(/    def _open_bridge\([\s\S]*?\n    def _has_focus/)?.[0] || '';

  assert.match(welcomeHandler, /postJson\('\/api\/browser\/show', \{\}\)/);
  assert.doesNotMatch(welcomeHandler, /\/api\/command/);
  assert.match(desktopHandler, /bridgeRequest\('\/api\/browser\/show'/);
  assert.doesNotMatch(desktopHandler, /\/api\/command/);
  assert.match(trayHandler, /\/api\/browser\/show/);
  assert.doesNotMatch(trayHandler, /\/api\/command/);
});

test('the console reports a rejected launch instead of false success', () => {
  const welcomeHandler = server.match(/async function onOpenBridge\(e\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(welcomeHandler, /openResult\.success === false/);
  assert.match(welcomeHandler, /Could not open browser:/);
});
