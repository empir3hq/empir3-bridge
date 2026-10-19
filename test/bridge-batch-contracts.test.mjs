/**
 * Source contracts for the 2026-09-14 Bridge batch (Work Board batches 1 and 4
 * plus batch 2/3 freshness items). Each block names its card and pins the
 * behaviour in the current source, so an "already fixed" verdict on the
 * board is backed by something that goes red if it regresses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const higgs = readFileSync(new URL('../src/handlers/higgsfield-cli.ts', import.meta.url), 'utf8');
const recorder = readFileSync(new URL('../src/browser-recorder.js', import.meta.url), 'utf8');

function block(text, startMarker, length = 2500) {
  const at = text.indexOf(startMarker);
  assert.ok(at >= 0, `marker present: ${startMarker}`);
  return text.slice(at, at + length);
}

// ── 37b2f2d0 / bbc67963: recording no longer depends on the retired overlay ──
test('record_start captures through the isolated-world recorder, not the page-world overlay', () => {
  const start = block(server, "case 'record_start': {", 900);
  assert.match(start, /await cdpPost\('\/record-start'/);
  assert.doesNotMatch(start, /ensureOverlayReady/);
  assert.match(recorder, /mode:'isolated-world'/);
  // isRecording / recordingStartTime are set only AFTER the capture call
  // succeeded, so a refused start leaves no half-open state behind.
  assert.ok(start.indexOf("cdpPost('/record-start'") < start.indexOf('isRecording = true;'));
  assert.ok(start.indexOf('isRecording = true;') < start.indexOf('recordingStartTime = Date.now();'));
});

test('record_stop refuses when nothing is recording instead of saving a phantom file', () => {
  const stop = block(server, "case 'record_stop': {", 400);
  assert.match(stop, /if\(!isRecording\)throw new Error\('No recording is active\.'\);/);
  assert.ok(stop.indexOf("throw new Error('No recording is active.')") < stop.indexOf("cdpPost('/record-stop'"));
});

// ── 869b1e97: console version badge ──
test('/console is served no-store with the same hardening as / and /welcome, and the badge self-corrects', () => {
  const route = block(server, "if (url.pathname === '/console') {", 700);
  assert.match(route, /'Cache-Control': 'no-store'/);
  assert.match(route, /'X-Content-Type-Options': 'nosniff'/);
  assert.match(server, /<span id="railVersion">BRIDGE \$\{BRIDGE_VERSION\} · LIVE<\/span>/);
  assert.match(server, /if \(daemonAlive && s\.version\) setText\('railVersion', 'BRIDGE ' \+ s\.version \+ ' · LIVE'\);/);
});

test('no payload-selection path sorts version directory names as text', () => {
  // The card's hypothesis. The pointer file is the source of truth and every
  // comparison is numeric: tray is_newer (tuple compare), bootstrapper
  // semverCmp, and BRIDGE_VERSION read from the running payload's package.json.
  const tray = readFileSync(new URL('../tray/tray.py', import.meta.url), 'utf8');
  const go = readFileSync(new URL('../build/bootstrap-go/main.go', import.meta.url), 'utf8');
  assert.match(tray, /def is_newer\(remote: str, local: str\) -> bool:\r?\n\s+return _ver_tuple\(remote\) > _ver_tuple\(local\)/);
  assert.match(go, /func semverCmp\(a, b string\) int/);
  assert.match(go, /readVersionFile\(filepath\.Join\(p\.payloadRoot, "\.version"\)\)/);
  assert.doesNotMatch(go, /sort\.Strings\([^)]*payload/i);
  assert.match(server, /const BRIDGE_VERSION = process\.env\.EMPIR3_BRIDGE_PAYLOAD_VERSION \|\| readPackageVersion\(\);/);
});

// ── d5872d03: higgsfield_status verifies instead of trusting token shape ──
test('higgsfield_status reports verified/needs_reauth/unverified and the working re-auth command', () => {
  assert.match(higgs, /\/session\.\{0,20\}expired\/i,/);
  assert.match(higgs, /export const HIGGSFIELD_REAUTH_HINT = 'run `higgsfield auth login`';/);
  assert.doesNotMatch(higgs, /hf auth login/);
  const status = block(higgs, 'export async function higgsfieldStatus(', 2600);
  assert.match(status, /const tokenPresent = tok\.exitCode === 0/);
  assert.match(status, /const verdict = await verifyHiggsfieldAuth\(\);/);
  assert.match(status, /authenticated: verdict\.status === 'verified',/);
  assert.match(status, /authVerification: verdict\.status,/);
  // A real call that hits an auth error retires the cached verdict.
  const classify = block(higgs, 'function parseHiggsfieldError(', 900);
  assert.match(classify, /authVerdict = \{ at: Date\.now\(\), status: 'needs_reauth'/);
  // Server probe forwards the shape cli_status uses for Grok.
  const probe = block(server, 'async function probeHiggsfieldCli()', 1200);
  assert.match(probe, /auth_verification: r\.authVerification/);
  assert.match(probe, /auth_last_verified_at: r\.authLastVerifiedAt/);
  assert.match(probe, /auth_reason: r\.authReason/);
});

// ── 87d2a92d follow-up: the welcome screen answers "linked to my account?" in plain words ──
test('splash states name the account link explicitly in every state', () => {
  assert.match(server, /Not linked to an account — your team cannot reach this computer yet/);
  assert.match(server, /'Linked to your account' \+ \(who \? ' \(' \+ who \+ '\)' : ''\) \+ ' — connected, your team can reach this computer'/);
  assert.match(server, /' — reconnecting to empir3…'/);
  assert.match(server, /' — this computer is no longer reachable by your team until you sign in again'/);
});
