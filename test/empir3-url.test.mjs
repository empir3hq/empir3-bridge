/**
 * empir3-url — the shared server/ws URL normalizer (Phase 8 extraction).
 *
 * These helpers were duplicated in pair-claim.ts and server.ts with a
 * "keep in sync" comment; now that three consumers exist (enroll.js is the
 * third) the behavior is pinned here once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_EMPIR3_SERVER,
  normalizeServer,
  classifyServer,
  defaultWsUrl,
  normalizeWsUrl,
} = require('../src/empir3-url.js');

test('normalizeServer: bare hosts get https, localhost-ish get http, garbage falls back to production', () => {
  assert.equal(normalizeServer('app.empir3.com'), 'https://app.empir3.com');
  assert.equal(normalizeServer('localhost:3005'), 'http://localhost:3005');
  assert.equal(normalizeServer('127.0.0.1:3005'), 'http://127.0.0.1:3005');
  assert.equal(normalizeServer('https://my.example.com/'), 'https://my.example.com');
  assert.equal(normalizeServer('https://my.example.com/base/'), 'https://my.example.com/base');
  assert.equal(normalizeServer(''), DEFAULT_EMPIR3_SERVER);
  // Only inputs the WHATWG URL parser REJECTS fall back (spaces make an
  // invalid host); merely weird-looking hosts parse and pass through — that
  // is the helper's long-standing behavior, preserved by the extraction.
  assert.equal(normalizeServer('not a url at all'), DEFAULT_EMPIR3_SERVER);
  assert.equal(normalizeServer('https://x.com/?q=1#frag'), 'https://x.com');
});

test('classifyServer: production / local-dev / custom', () => {
  assert.equal(classifyServer('https://app.empir3.com'), 'production');
  assert.equal(classifyServer(undefined), 'production');
  assert.equal(classifyServer('localhost:3005'), 'local-dev');
  assert.equal(classifyServer('http://127.0.0.1:3005'), 'local-dev');
  assert.equal(classifyServer('https://selfhost.example.com'), 'custom');
});

test('defaultWsUrl mirrors the http-ness of the server', () => {
  assert.equal(defaultWsUrl('https://app.empir3.com'), 'wss://app.empir3.com/ws');
  assert.equal(defaultWsUrl('http://localhost:3005'), 'ws://localhost:3005/ws');
});

test('normalizeWsUrl: keeps a good url, replaces /relay and garbage with the default', () => {
  assert.equal(normalizeWsUrl('wss://app.empir3.com/ws', 'https://app.empir3.com'), 'wss://app.empir3.com/ws');
  assert.equal(normalizeWsUrl('wss://app.empir3.com/relay', 'https://app.empir3.com'), 'wss://app.empir3.com/ws');
  assert.equal(normalizeWsUrl('not a url', 'https://app.empir3.com'), 'wss://app.empir3.com/ws');
  assert.equal(normalizeWsUrl(null, 'http://localhost:3005'), 'ws://localhost:3005/ws');
});
