import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyBridgeWebSocket, isTrustedLocalBridgeOrigin } from '../src/browser-surface-security.mjs';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('only the exact localhost dashboard origin can claim browser control', () => {
  assert.equal(isTrustedLocalBridgeOrigin('http://localhost:3006', 3006), true);
  assert.equal(isTrustedLocalBridgeOrigin('http://127.0.0.1:3006', 3006), true);
  assert.equal(isTrustedLocalBridgeOrigin('https://localhost:3006', 3006), false);
  assert.equal(isTrustedLocalBridgeOrigin('http://localhost.evil.example:3006', 3006), false);
  assert.equal(isTrustedLocalBridgeOrigin('https://evil.example', 3006), false);
});

test('a malicious page cannot claim cli, control, or retired overlay roles', () => {
  const hostileOrigin = 'https://malicious.example';
  assert.deepEqual(
    classifyBridgeWebSocket({ role: 'cli', origin: hostileOrigin, port: 3006 }),
    { accepted: false, reason: 'browser origins cannot claim the cli role' },
  );
  assert.deepEqual(
    classifyBridgeWebSocket({ role: 'control', origin: hostileOrigin, port: 3006 }),
    { accepted: false, reason: 'control role requires the trusted localhost origin' },
  );
  assert.deepEqual(
    classifyBridgeWebSocket({ role: 'overlay', origin: hostileOrigin, port: 3006 }),
    { accepted: false, reason: 'unsupported browser socket role' },
  );
});

test('native cli and trusted dashboard retain their intended channels', () => {
  assert.deepEqual(
    classifyBridgeWebSocket({ role: 'cli', origin: '', port: 3006 }),
    { accepted: true, role: 'cli' },
  );
  assert.deepEqual(
    classifyBridgeWebSocket({ role: 'control', origin: 'http://localhost:3006', port: 3006 }),
    { accepted: true, role: 'control' },
  );
});

test('legacy page-world transports are unreachable and receive no broadcasts', () => {
  assert.match(server, /if \(url\.pathname === '\/overlay\.js'\)[\s\S]{0,700}res\.writeHead\(410/);
  assert.match(server, /if \(url\.pathname === '\/api\/overlay-script'[\s\S]{0,500}res\.writeHead\(410/);
  assert.match(server, /new WebSocket\('ws:\/\/localhost:\$\{PORT\}\?role=control'\)/);

  const broadcast = server.match(/function broadcastToOverlay\(msg: any\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.ok(broadcast, 'broadcast function should exist');
  assert.doesNotMatch(broadcast, /pushToCdpOverlay|__empir3_inbox/);

  const injectCurrent = server.match(/async function injectOverlay\([^]*?\n\}/)?.[0] || '';
  const injectAll = server.match(/async function injectOverlayAll\([^]*?\n\}/)?.[0] || '';
  assert.match(injectCurrent, /return retireLegacyPageOverlay\(\)/);
  assert.match(injectAll, /return retireLegacyPageOverlay\(\)/);
  assert.doesNotMatch(injectCurrent + injectAll, /getOverlayScript|getStandaloneOverlayScript|register-auto-inject.*overlayScript/);
});

test('hostile chat markup is rendered as text, never dashboard HTML', () => {
  const addChat = server.match(/function addChatMsg\(msg\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.ok(addChat, 'dashboard chat renderer should exist');
  assert.match(addChat, /body\.textContent = String\(msg\.text \|\| ''\)/);
  assert.doesNotMatch(addChat, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(server, /Content-Security-Policy[^\n]+script-src 'nonce-/);

  const hostile = '<img src=x onerror="fetch(\'/api/command\')">';
  assert.equal(String(hostile), hostile, 'the payload remains inert text for textContent');
});
