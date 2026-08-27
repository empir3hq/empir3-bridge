import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_GROK_REFRESH_MARGIN_MS,
  GrokRefreshGate,
  atomicWrite,
  parseGrokAuthFreshness,
  writeBackRefreshedAuth,
} from '../src/grok-refresh-gate.ts';

const HOUR_MS = 60 * 60_000;

function fakeJwt(claims) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.signature-not-checked`;
}

function authStore({ expiresAt, jwtExpSec, refreshToken = 'refresh-token-1' } = {}) {
  const entry = { auth_mode: 'oidc', refresh_token: refreshToken };
  if (expiresAt !== undefined) entry.expires_at = expiresAt;
  entry.key = jwtExpSec !== undefined ? fakeJwt({ exp: jwtExpSec }) : 'not-a-jwt';
  return JSON.stringify({ 'https://auth.x.ai::00000000-0000-0000-0000-000000000000': entry });
}

async function makeHome(root, name, content) {
  const home = join(root, name);
  await mkdir(join(home, '.grok'), { recursive: true });
  if (content !== undefined) await writeFile(join(home, '.grok', 'auth.json'), content, 'utf-8');
  return home;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFileContent(path, expected, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let observed = null;
  while (Date.now() < deadline) {
    try { observed = await readFile(path, 'utf-8'); } catch { observed = null; }
    if (observed === expected) return;
    await sleep(25);
  }
  assert.equal(observed, expected);
}

test('Windows atomic auth replacement retries transient destination locks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empir3-grok-atomic-write-'));
  const authPath = join(root, 'auth.json');
  try {
    await writeFile(authPath, 'old-token', 'utf-8');
    let attempts = 0;
    await atomicWrite(authPath, 'new-token', {
      platform: 'win32',
      wait: async () => {},
      renameFile: async (temporary, destination) => {
        attempts += 1;
        if (attempts < 4) {
          const error = new Error('destination temporarily locked');
          error.code = 'EPERM';
          throw error;
        }
        await rename(temporary, destination);
      },
    });
    assert.equal(attempts, 4);
    assert.equal(await readFile(authPath, 'utf-8'), 'new-token');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('freshness parsing prefers expires_at, falls back to the JWT exp claim', () => {
  const at = '2026-08-16T20:00:00.000Z';
  const atMs = Date.parse(at);
  assert.deepEqual(parseGrokAuthFreshness(authStore({ expiresAt: at, jwtExpSec: 1 })), {
    expiresAtMs: atMs,
    source: 'expires_at',
  });

  const jwtOnly = parseGrokAuthFreshness(authStore({ jwtExpSec: Math.floor(atMs / 1000) }));
  assert.deepEqual(jwtOnly, { expiresAtMs: atMs, source: 'jwt_exp' });

  // Earliest expiry wins across multiple credential entries.
  const early = '2026-08-16T10:00:00.000Z';
  const multi = JSON.stringify({
    'https://auth.x.ai::a': { expires_at: at, key: 'x', refresh_token: 'r1' },
    'https://auth.x.ai::b': { expires_at: early, key: 'x', refresh_token: 'r2' },
  });
  assert.equal(parseGrokAuthFreshness(multi).expiresAtMs, Date.parse(early));

  // Unknown shapes never produce a fake expiry.
  assert.deepEqual(parseGrokAuthFreshness('not json'), { expiresAtMs: null, source: null });
  assert.deepEqual(parseGrokAuthFreshness('{"k":{"refresh_token":"r"}}').expiresAtMs, null);
  assert.deepEqual(parseGrokAuthFreshness(JSON.stringify({ k: { expires_at: 'garbage', key: 'nope' } })).expiresAtMs, null);
});

test('admission is concurrent while fresh and serialized inside the refresh margin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empir3-grok-gate-limit-'));
  try {
    let nowMs = Date.parse('2026-08-16T12:00:00.000Z');
    const home = await makeHome(root, 'home', authStore({ expiresAt: new Date(nowMs + HOUR_MS).toISOString() }));
    const gate = new GrokRefreshGate({ realHome: () => home, now: () => nowMs, freshnessCacheMs: 0 });

    assert.equal(gate.effectiveLimit(5), 5);
    assert.equal(gate.poolState(), 'open');

    // Clock walks inside the margin → the pool serializes without any writes.
    nowMs += HOUR_MS - DEFAULT_GROK_REFRESH_MARGIN_MS + 1_000;
    assert.equal(gate.effectiveLimit(5), 1);
    assert.equal(gate.poolState(), 'refreshing');

    // Fully expired stays serialized.
    nowMs += HOUR_MS;
    assert.equal(gate.effectiveLimit(5), 1);

    // A rotation lands (re-login or refresher write-back) → reopen.
    await writeFile(join(home, '.grok', 'auth.json'), authStore({ expiresAt: new Date(nowMs + HOUR_MS).toISOString(), refreshToken: 'refresh-token-2' }), 'utf-8');
    gate.noteRotation();
    assert.equal(gate.effectiveLimit(5), 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unknown freshness admits concurrently; an auth failure latches the drain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empir3-grok-gate-latch-'));
  try {
    let nowMs = Date.parse('2026-08-16T12:00:00.000Z');
    // No auth.json at all (API-key mode) → freshness unknown → concurrent.
    const home = await makeHome(root, 'home');
    const gate = new GrokRefreshGate({ realHome: () => home, now: () => nowMs, freshnessCacheMs: 0, latchMs: 60_000 });
    assert.equal(gate.effectiveLimit(5), 5);

    gate.noteAuthFailure();
    assert.equal(gate.effectiveLimit(5), 1);
    assert.equal(gate.poolState(), 'refreshing');

    // Latch expires without a rotation → concurrent again (reactive only).
    nowMs += 61_000;
    assert.equal(gate.effectiveLimit(5), 5);

    // A rotation clears an active latch immediately.
    gate.noteAuthFailure();
    assert.equal(gate.effectiveLimit(5), 1);
    gate.noteRotation();
    assert.equal(gate.effectiveLimit(5), 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('eager watcher persists a rotated token mid-turn and reopens the pool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empir3-grok-gate-watch-'));
  try {
    const nowMs = Date.parse('2026-08-16T12:00:00.000Z');
    const v1 = authStore({ expiresAt: new Date(nowMs + 60_000).toISOString(), refreshToken: 'refresh-token-1' });
    const v2 = authStore({ expiresAt: new Date(nowMs + HOUR_MS).toISOString(), refreshToken: 'refresh-token-2' });
    const v3 = authStore({ expiresAt: new Date(nowMs + 2 * HOUR_MS).toISOString(), refreshToken: 'refresh-token-3' });

    const home = await makeHome(root, 'home', v1);
    const isolated = await makeHome(root, 'turn', v1);
    const isolatedGrokDir = join(isolated, '.grok');
    const gate = new GrokRefreshGate({ realHome: () => home, now: () => Date.now(), freshnessCacheMs: 0, watchIntervalMs: 40 });

    gate.registerIsolation('turn-1', home, isolatedGrokDir, v1);
    try {
      // A torn mid-write read must never reach the real store.
      await writeFile(join(isolatedGrokDir, 'auth.json'), '{"truncated-mid-wr', 'utf-8');
      await sleep(160);
      assert.equal(await readFile(join(home, '.grok', 'auth.json'), 'utf-8'), v1);

      // The CLI finishes its rotation → eager CAS write-back, baseline advances.
      await writeFile(join(isolatedGrokDir, 'auth.json'), v2, 'utf-8');
      await waitForFileContent(join(home, '.grok', 'auth.json'), v2);
      assert.equal(gate.baselineFor('turn-1'), v2);

      // A second in-turn rotation still lands because the baseline advanced.
      await writeFile(join(isolatedGrokDir, 'auth.json'), v3, 'utf-8');
      await waitForFileContent(join(home, '.grok', 'auth.json'), v3);
    } finally {
      gate.unregisterIsolation('turn-1');
    }

    // After unregistering, further isolated changes are ignored.
    await writeFile(join(isolatedGrokDir, 'auth.json'), v1, 'utf-8');
    await sleep(160);
    assert.equal(await readFile(join(home, '.grok', 'auth.json'), 'utf-8'), v3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write-back CAS keeps a newer token that another writer already landed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empir3-grok-gate-cas-'));
  try {
    const nowMs = Date.parse('2026-08-16T12:00:00.000Z');
    const v1 = authStore({ refreshToken: 'refresh-token-1', expiresAt: new Date(nowMs + 60_000).toISOString() });
    const v2 = authStore({ refreshToken: 'refresh-token-2', expiresAt: new Date(nowMs + HOUR_MS).toISOString() });
    const newer = authStore({ refreshToken: 'refresh-token-newer', expiresAt: new Date(nowMs + 3 * HOUR_MS).toISOString() });

    const home = await makeHome(root, 'home', newer); // another turn already rotated
    const isolated = await makeHome(root, 'turn', v2);

    const observed = await writeBackRefreshedAuth(home, join(isolated, '.grok'), v1);
    assert.equal(observed, v2); // caller may advance its baseline…
    assert.equal(await readFile(join(home, '.grok', 'auth.json'), 'utf-8'), newer); // …but the newer token stays

    // No original copy → nothing to sync.
    assert.equal(await writeBackRefreshedAuth(home, join(isolated, '.grok'), null), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
