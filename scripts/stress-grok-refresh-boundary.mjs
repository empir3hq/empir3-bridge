#!/usr/bin/env node

/**
 * Forced refresh-boundary stress for the Grok channel pool (Bridge 0.3.86).
 *
 * Unlike stress-grok-concurrency.mjs (which spawns raw isolated CLI processes
 * to prove output isolation), this harness drives the BRIDGE's admission path
 * — POST /api/command cli_run — so the freshness gate, drain-to-one,
 * eager write-back, and reopen behavior are what is actually under test.
 * Raw concurrent spawns across a refresh boundary would deliberately trigger
 * the single-use refresh-token reuse revocation this work exists to prevent;
 * never run THAT shape near expiry.
 *
 * --near-expiry[=seconds] rewrites `expires_at` (metadata, not a secret) in
 * the REAL ~/.grok/auth.json to now+seconds so the gate sees an imminent
 * boundary. If the CLI keys refresh off its JWT exp instead, no rotation will
 * occur — the run then proves drain/serialize/reopen-by-timeout and REPORTS
 * HONESTLY that the rotation itself was not exercised.
 *
 * SAFETY: this consumes the owner's real Grok session (N turns + possibly one
 * refresh-token rotation). Run in a low-traffic window with the owner aware.
 * The pre-run auth bytes are NEVER backed up and restored: after a rotation
 * the old refresh token is consumed, and restoring it would trip reuse
 * detection and revoke the whole session family.
 *
 * Usage:
 *   node scripts/stress-grok-refresh-boundary.mjs --yes [--count=5] [--near-expiry=90] [--bridge=http://127.0.0.1:3006]
 */

import { readFileSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const bridgeUrl = value('bridge', process.env.BRIDGE_URL || 'http://localhost:3006');
const count = Math.max(2, Math.min(10, Number(value('count', 5)) || 5));
const nearExpirySec = flag('near-expiry') || value('near-expiry', null) !== null
  ? Math.max(20, Number(value('near-expiry', 90)) || 90)
  : null;
const perRunTimeoutMs = Math.max(60_000, Number(process.env.EMPIR3_GROK_STRESS_TIMEOUT_MS) || 180_000);
const authPath = join(homedir(), '.grok', 'auth.json');

if (!flag('yes')) {
  console.error('This stress consumes the owner\'s REAL Grok session (turns + possibly one token rotation).');
  console.error('Re-run with --yes in a low-traffic window with the owner aware.');
  process.exit(2);
}

function nonceHeader() {
  const headers = { 'Content-Type': 'application/json' };
  const explicit = (process.env.EMPIR3_BRIDGE_NONCE || process.env.BRIDGE_NONCE || '').trim();
  try {
    const nonce = explicit || readFileSync(join(homedir(), '.empir3-bridge', 'nonce'), 'utf-8').trim();
    if (nonce) headers['X-Empir3-Nonce'] = nonce;
  } catch {}
  return headers;
}

async function command(body) {
  const res = await fetch(`${bridgeUrl}/api/command`, {
    method: 'POST',
    headers: nonceHeader(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Bridge /api/command: ${res.status} ${await res.text()}`);
  return res.json();
}

function authSignature(raw) {
  // Structure-only view: per-entry expires_at + a hash prefix of the refresh
  // token so rotation is detectable without any token material leaving disk.
  const out = [];
  try {
    const data = JSON.parse(raw);
    for (const [key, entry] of Object.entries(data)) {
      if (!entry || typeof entry !== 'object') continue;
      out.push({
        entry: createHash('sha256').update(key).digest('hex').slice(0, 8),
        expires_at: typeof entry.expires_at === 'string' ? entry.expires_at : null,
        refresh_token_sha8: typeof entry.refresh_token === 'string'
          ? createHash('sha256').update(entry.refresh_token).digest('hex').slice(0, 8)
          : null,
      });
    }
  } catch {
    out.push({ parse: 'failed' });
  }
  return out;
}

async function forceNearExpiry(seconds) {
  const raw = await readFile(authPath, 'utf-8');
  const data = JSON.parse(raw);
  const target = new Date(Date.now() + seconds * 1000).toISOString();
  let touched = 0;
  for (const entry of Object.values(data)) {
    if (entry && typeof entry === 'object' && typeof entry.expires_at === 'string') {
      entry.expires_at = target;
      touched += 1;
    }
  }
  if (!touched) throw new Error('no expires_at field found in auth store — aborting rather than guessing');
  const next = JSON.stringify(data);
  const tempPath = `${authPath}.tmp-${process.pid}`;
  await writeFile(tempPath, next, { encoding: 'utf-8', mode: 0o600 });
  try {
    await rename(tempPath, authPath);
  } catch (error) {
    try { await rm(tempPath, { force: true }); } catch {}
    throw error;
  }
  console.log(`forced expires_at to ${target} on ${touched} credential entr${touched === 1 ? 'y' : 'ies'}`);
}

async function runOne(index, marker) {
  const startedAt = Date.now();
  try {
    const response = await command({
      action: 'cli_run',
      params: {
        model: 'grok',
        prompt: `Reply with exactly ${marker} and no other text.`,
        mode: 'text',
        timeoutMs: perRunTimeoutMs,
      },
    });
    // /api/command wraps the cliRun envelope: { ok, result: { success, result: {...} } }
    const envelope = response?.result ?? response;
    const result = envelope?.result ?? envelope;
    const text = String(result?.text ?? '');
    const error = String(result?.error ?? envelope?.error ?? '');
    return {
      index,
      startedAtMs: startedAt,
      endedAtMs: Date.now(),
      durationMs: Date.now() - startedAt,
      status: result?.status ?? (response?.success ? 'done' : 'error'),
      busy: response?.code === 'provider_concurrency_busy' || result?.code === 'provider_concurrency_busy',
      credentialsRejected: /credentials were rejected|re-authenticate/i.test(error),
      ownMarker: text.includes(marker),
      error: error.slice(0, 200) || undefined,
    };
  } catch (error) {
    return {
      index,
      startedAtMs: startedAt,
      endedAtMs: Date.now(),
      durationMs: Date.now() - startedAt,
      status: 'transport_error',
      credentialsRejected: false,
      ownMarker: false,
      error: String(error?.message || error).slice(0, 200),
    };
  }
}

const before = authSignature(await readFile(authPath, 'utf-8'));
console.log('auth store before:', JSON.stringify(before));

if (nearExpirySec !== null) await forceNearExpiry(nearExpirySec);

const nonce = Date.now().toString(36);
const markers = Array.from({ length: count }, (_, index) => `EMPIR3_GROK_BOUNDARY_${nonce}_${String(index + 1).padStart(2, '0')}`);
console.log(`launching ${count} concurrent cli_run grok turns through ${bridgeUrl} ...`);

const results = await Promise.all(markers.map((marker, index) => runOne(index, marker)));
for (const result of results) console.log(JSON.stringify(result));

// Let any trailing cleanup write-back land before judging the store.
await new Promise((resolve) => setTimeout(resolve, 4_000));
const after = authSignature(await readFile(authPath, 'utf-8'));
console.log('auth store after:', JSON.stringify(after));

const rotated = JSON.stringify(before.map(entry => entry.refresh_token_sha8))
  !== JSON.stringify(after.map(entry => entry.refresh_token_sha8));
const expiryAdvanced = before.every((entry, index) => {
  const post = after[index];
  return post?.expires_at && entry?.expires_at ? Date.parse(post.expires_at) > Date.parse(entry.expires_at) : false;
});

const completed = results.filter(result => result.status === 'done' && result.ownMarker).length;
const rejected = results.filter(result => result.credentialsRejected).length;
const busy = results.filter(result => result.busy).length;

console.log('---');
console.log(`completed: ${completed}/${count} (busy: ${busy}, credentials_rejected: ${rejected})`);
console.log(`rotation persisted to real auth store: ${rotated ? 'YES' : 'no'}${expiryAdvanced ? ' (expiry advanced)' : ''}`);
if (nearExpirySec !== null && !rotated) {
  console.log('NOTE: forced expires_at did not trigger a CLI rotation — the CLI may key off the JWT exp claim.');
  console.log('This run still proves drain/serialize behavior; the true boundary is covered by the organic soak.');
}

process.exitCode = rejected === 0 && completed === count ? 0 : 1;
