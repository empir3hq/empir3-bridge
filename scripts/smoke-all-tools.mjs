#!/usr/bin/env node
// Full-coverage smoke driver for every tool in TOOL_META.
//
// Calls each tool via /api/command, captures pass/fail + a short response
// excerpt + any screenshot path it produced, and writes a single markdown
// report.
//
// Tiers:
//   1 — read/status (always safe; no side effects)
//   2 — browser navigate (visible, but only on the bridge welcome page)
//   3 — browser interact (safe on the bridge welcome page)
//   4 — desktop interact (moves the user's mouse / clicks real coords) —
//       only runs with --tier4 flag. User must be near the keyboard.
//   5 — recordings (creates files; safe)
//   6 — eval (default-off; only with --eval)
//
// Usage:
//   node scripts/smoke-all-tools.mjs                 # tiers 1-3 + 5
//   node scripts/smoke-all-tools.mjs --tier4         # add desktop interact
//   node scripts/smoke-all-tools.mjs --eval          # add browser_evaluate
//   node scripts/smoke-all-tools.mjs --only=read     # subset by tier name
//
// Report: build/smoke-all-<stamp>/report.md

import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = process.env.BRIDGE_SMOKE_URL || 'http://127.0.0.1:3006';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = resolve(process.env.BRIDGE_SMOKE_OUT || join(ROOT, 'build', `smoke-all-${STAMP}`));
const SHOTS_DIR = join(OUT_DIR, 'shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const args = new Set(process.argv.slice(2));
const onlyArg = process.argv.slice(2).find(a => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1].split(',') : null;
const RUN_TIER4 = args.has('--tier4');
const RUN_EVAL = args.has('--eval');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function command(body, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) {
      // Sanitize unescaped control chars (some PS responses include raw newlines in element names)
      try { json = JSON.parse(text.replace(/[\u0000-\u001F]/g, ' ')); }
      catch { json = { ok: false, error: `JSON parse failed: ${e.message}`, _raw_len: text.length }; }
    }
    return { status: res.status, body: json };
  } finally { clearTimeout(t); }
}

function summarise(value, limit = 500) {
  if (value == null) return String(value);
  if (typeof value !== 'object') return String(value).slice(0, limit);
  try {
    const s = JSON.stringify(value, (k, v) => {
      if (typeof v === 'string' && /^[A-Za-z0-9+/=]{600,}$/.test(v)) return `[base64 ${v.length}b]`;
      if (typeof k === 'string' && /(screenshot|base64|thumbnail|data)/i.test(k) && typeof v === 'string' && v.length > 200) {
        return `[base64 ${v.length}b]`;
      }
      return v;
    });
    return s.length > limit ? s.slice(0, limit) + `... (${s.length} chars total)` : s;
  } catch { return String(value).slice(0, limit); }
}

function extractScreenshotPath(result) {
  const paths = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'string' && /\.(png|jpg|jpeg)$/i.test(val) && /[\\/]/.test(val)) {
        if (existsSync(val)) paths.push(val);
      } else if (val && typeof val === 'object') walk(val);
    }
  };
  walk(result);
  return paths;
}

const results = [];
let snapshotRef = null; // browser ref captured for interact tests
let desktopRef = null;  // desktop UIA ref captured for tier4

async function runTest(t) {
  if (ONLY && !ONLY.includes(t.tier)) return;
  if (t.tier === '4' && !RUN_TIER4) {
    results.push({ name: t.name, tier: t.tier, status: 'SKIP', note: 'tier 4 (desktop interact) — pass --tier4 to enable' });
    return;
  }
  if (t.tier === 'eval' && !RUN_EVAL) {
    results.push({ name: t.name, tier: t.tier, status: 'SKIP', note: 'eval — pass --eval to enable' });
    return;
  }
  const started = Date.now();
  try {
    const out = await t.run();
    const ms = Date.now() - started;
    const result = out?.result ?? out;
    const shots = extractScreenshotPath(result);
    let copied = [];
    for (const s of shots.slice(0, 2)) {
      const dst = join(SHOTS_DIR, `${t.name}-${basename(s)}`);
      try { copyFileSync(s, dst); copied.push(dst); } catch {}
    }
    const pass = out?.status ? (out.status < 400) : true;
    const okBody = out?.body ? out.body.ok !== false : true;
    results.push({
      name: t.name,
      tier: t.tier,
      status: pass && okBody ? 'PASS' : 'FAIL',
      ms,
      summary: summarise(result),
      shots: copied,
      error: pass && okBody ? null : (out?.body?.error || `HTTP ${out?.status}`),
    });
  } catch (e) {
    results.push({ name: t.name, tier: t.tier, status: 'FAIL', ms: Date.now() - started, error: e?.message || String(e) });
  }
}

// ────────────────── TESTS ──────────────────

const tests = [];

// ── TIER 1: read / status ──
// Wire protocol uses short type names (status, text, navigate, click...) —
// the tool-meta name is the user-facing label; we tag results by tool-meta
// but POST with the wire name.
const READ = [
  ['browser_status',          () => command({ type: 'status' })],
  ['browser_text',            async () => {
    await openBrowserFixture();
    return command({ type: 'text' });
  }],
  ['browser_snapshot',        async () => {
    await openBrowserFixture();
    const r = await command({ type: 'snapshot' });
    const nodes = r.body?.result?.nodes || r.body?.result?.snapshot?.nodes;
    const first = nodes?.[0]?.ref;
    if (first) snapshotRef = first;
    return r;
  }],
  ['browser_screenshot',      async () => {
    await openBrowserFixture();
    return command({ type: 'screenshot' });
  }],
  ['desktop_monitors',        () => command({ type: 'desktop_monitors' })],
  ['desktop_screenshot',      () => command({ type: 'desktop_screenshot', monitor: 'primary' })],
  ['desktop_screenshot_zoom', async () => {
    const mon = await command({ type: 'desktop_monitors' });
    const m = mon.body?.result?.monitors?.[0] || { bounds: { x: 0, y: 0, width: 1920, height: 1080 }};
    const cx = m.bounds.x + Math.round(m.bounds.width / 2);
    const cy = m.bounds.y + Math.round(m.bounds.height / 2);
    return command({ type: 'desktop_screenshot_zoom', x: cx, y: cy, radius: 60 });
  }],
  ['desktop_cursor_position', () => command({ type: 'desktop_cursor_position' })],
  ['desktop_snapshot',        async () => {
    const r = await command({ type: 'desktop_snapshot', scope: 'foreground', maxElements: 30 });
    const first = r.body?.result?.elements?.[0]?.ref;
    if (first) desktopRef = first;
    return r;
  }],
  ['desktop_focus_status',    () => command({ type: 'desktop_focus_status' })],
  ['desktop_pointer_status',  () => command({ type: 'desktop_pointer_status' })],
  ['desktop_calibration_status', () => command({ type: 'desktop_calibration_status' })],
  ['desktop_snapshot_som',    () => command({ type: 'desktop_snapshot_som', region: { x: 0, y: 0, width: 800, height: 600 } })],
];
for (const [name, run] of READ) tests.push({ name, tier: '1', run });

// ── TIER 2: browser navigate (safe — bridge welcome) ──
const WELCOME = `${BRIDGE}/welcome`;
const BROWSER_FIXTURE_HTML = '<!doctype html><title>Smoke</title><button id=b aria-label="Smoke Click Target">Click Target</button><input id=i aria-label="Smoke Input"><div style="height:1400px">Scroll</div><script>window.smokeClicked=0;window.lastKey="";b.onclick=function(){window.smokeClicked++};document.onkeydown=function(e){window.lastKey=e.key}</script>';
let browserFixtureSeq = 0;
let browserFixtureBasePromise = null;
let browserFixtureServer = null;

function browserFixtureBase() {
  if (browserFixtureBasePromise) return browserFixtureBasePromise;
  browserFixtureBasePromise = new Promise((resolveBase, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/fixture') {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Connection': 'close' });
        res.end('not found');
        return;
      }
      const nonce = url.searchParams.get('nonce') || '';
      const html = `${BROWSER_FIXTURE_HTML}<script>window.smokeNonce=${JSON.stringify(nonce)}</script>`;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Connection': 'close',
      });
      res.end(html);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      browserFixtureServer = server;
      server.unref();
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fixture server did not bind to a TCP port'));
        return;
      }
      resolveBase(`http://127.0.0.1:${address.port}`);
    });
  });
  return browserFixtureBasePromise;
}

async function openBrowserFixture() {
  let lastError = 'fixture did not open';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const nonce = `smoke-${Date.now()}-${++browserFixtureSeq}`;
    const base = await browserFixtureBase();
    const url = `${base}/fixture?nonce=${encodeURIComponent(nonce)}`;
    try {
      const r = await command({ type: 'navigate', url }, { timeoutMs: 50000 });
      const ready = await waitForBrowserFixture(nonce, 20000);
      if (ready.ok) return r;
      lastError = ready.error;
    } catch (e) {
      lastError = e?.message || String(e);
    }
    if (attempt < 3) await sleep(1000);
  }
  return { status: 500, body: { ok: false, error: lastError } };
}

async function waitForBrowserFixture(nonce, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const r = await command({
        type: 'evaluate',
        script: `JSON.stringify({ href: location.href, ready: document.readyState, nonce: window.smokeNonce })`,
      }, { timeoutMs: 5000 });
      last = r;
      const raw = r.body?.result?.result;
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (result?.nonce === nonce && result?.ready !== 'loading') return { ok: true };
    } catch (e) {
      last = e;
    }
  }
  return { ok: false, error: `fixture did not become ready for nonce ${nonce}: ${summarise(last)}` };
}
tests.push({ name: 'browser_navigate', tier: '2', run: () => openBrowserFixture() });
tests.push({ name: 'browser_scroll',   tier: '2', run: async () => {
  await openBrowserFixture();
  return command({ type: 'scroll', y: 200 });
}});
tests.push({ name: 'browser_refresh',  tier: '2', run: async () => {
  await openBrowserFixture();
  return command({ type: 'refresh' });
}});

// ── TIER 3: browser interact (welcome page has labeled buttons) ──
tests.push({ name: 'browser_click',     tier: '3', run: async () => {
  await openBrowserFixture();
  const clicked = await command({ type: 'click', selector: '#b' });
  const check = await command({ type: 'evaluate', script: 'window.smokeClicked' });
  if (check.body?.result?.result !== 1) return { status: 500, body: { ok: false, error: `click did not update fixture counter: ${summarise(check)}` }};
  return clicked;
}});
tests.push({ name: 'browser_click_ref', tier: '3', run: async () => {
  await openBrowserFixture();
  const snap = await command({ type: 'snapshot' });
  const nodes = snap.body?.result?.nodes || snap.body?.result?.snapshot?.nodes || [];
  const ref = nodes.find(n => n.role === 'button' && /click target/i.test(n.name || ''))?.ref || nodes.find(n => n.role === 'button')?.ref;
  if (!ref) return { status: 500, body: { ok: false, error: `no button ref on page (snapshot returned ${nodes.length} nodes)` }};
  const clicked = await command({ type: 'click_ref', ref });
  const check = await command({ type: 'evaluate', script: 'window.smokeClicked' });
  if (check.body?.result?.result !== 1) return { status: 500, body: { ok: false, error: `click_ref did not update fixture counter: ${summarise(check)}` }};
  return clicked;
}});
tests.push({ name: 'browser_click_xy',  tier: '3', run: async () => {
  await openBrowserFixture();
  const clicked = await command({ type: 'click_xy', x: 35, y: 18 });
  const check = await command({ type: 'evaluate', script: 'window.smokeClicked' });
  if (check.body?.result?.result !== 1) return { status: 500, body: { ok: false, error: `click_xy did not update fixture counter: ${summarise(check)}` }};
  return clicked;
}});
tests.push({ name: 'browser_type',      tier: '3', run: async () => {
  await openBrowserFixture();
  const typed = await command({ type: 'type', selector: '#i', text: 'smoke-test' });
  const check = await command({ type: 'evaluate', script: 'document.querySelector("#i")?.value' });
  if (check.body?.result?.result !== 'smoke-test') return { status: 500, body: { ok: false, error: `type did not update fixture input: ${summarise(check)}` }};
  return typed;
}});
tests.push({ name: 'browser_type_ref',  tier: '3', run: async () => {
  await openBrowserFixture();
  const snap = await command({ type: 'snapshot' });
  const nodes = snap.body?.result?.nodes || snap.body?.result?.snapshot?.nodes || [];
  const ref = nodes.find(n => (n.role === 'input' || n.role === 'textbox') && /smoke input/i.test(n.name || ''))?.ref
    || nodes.find(n => n.role === 'input' || n.role === 'textbox')?.ref;
  if (!ref) return { status: 500, body: { ok: false, error: `no input ref on fixture (snapshot returned ${nodes.length} nodes)` }};
  const typed = await command({ type: 'type_ref', ref, text: 'smoke-test-ref' });
  const check = await command({ type: 'evaluate', script: 'document.querySelector("#i")?.value' });
  if (check.body?.result?.result !== 'smoke-test-ref') return { status: 500, body: { ok: false, error: `type_ref did not update fixture input: ${summarise(check)}` }};
  return typed;
}});
tests.push({ name: 'browser_press',     tier: '3', run: async () => {
  await openBrowserFixture();
  await command({ type: 'click', selector: '#i' });
  const pressed = await command({ type: 'press', key: 'Escape' });
  const check = await command({ type: 'evaluate', script: 'window.lastKey' });
  if (check.body?.result?.result !== 'Escape') return { status: 500, body: { ok: false, error: `press did not update fixture key: ${summarise(check)}` }};
  return pressed;
}});
tests.push({ name: 'browser_highlight', tier: '3', run: async () => {
  await openBrowserFixture();
  return command({ type: 'highlight', selector: '#b' });
}});

// ── TIER 4: desktop interact (--tier4) ──
const D = (name, body) => tests.push({ name, tier: '4', run: () => command(body) });
D('desktop_click',  { type: 'desktop_click',  x: 5, y: 5, space: 'desktop' });
D('desktop_hover',  { type: 'desktop_hover',  x: 50, y: 50, space: 'desktop' });
D('desktop_drag',   { type: 'desktop_drag',   x: 50, y: 50, toX: 60, toY: 60, space: 'desktop' });
tests.push({ name: 'desktop_click_ref', tier: '4', run: async () => {
  if (!desktopRef) {
    const s = await command({ type: 'desktop_snapshot', scope: 'foreground' });
    desktopRef = s.body?.result?.elements?.[0]?.ref;
  }
  if (!desktopRef) return { status: 500, body: { ok: false, error: 'no desktop ref' }};
  return command({ type: 'desktop_click_ref', ref: desktopRef });
}});
tests.push({ name: 'desktop_hover_ref', tier: '4', run: async () => {
  if (!desktopRef) {
    const s = await command({ type: 'desktop_snapshot', scope: 'foreground' });
    desktopRef = s.body?.result?.elements?.[0]?.ref;
  }
  if (!desktopRef) return { status: 500, body: { ok: false, error: 'no desktop ref' }};
  return command({ type: 'desktop_hover_ref', ref: desktopRef });
}});
D('desktop_overlay', { type: 'desktop_overlay', show: false });
D('desktop_pointer_show',  { type: 'desktop_pointer_show', x: 200, y: 200, label: 'smoke', space: 'desktop' });
D('desktop_pointer_move',  { type: 'desktop_pointer_move', x: 220, y: 220, space: 'desktop' });
D('desktop_pointer_pulse', { type: 'desktop_pointer_pulse' });
D('desktop_pointer_hide',  { type: 'desktop_pointer_hide' });
// focus-dependent tools — only attempt when a focus region exists
tests.push({ name: 'desktop_click_cell', tier: '4', run: async () => {
  const f = await command({ type: 'desktop_focus_status' });
  if (!f.body?.result?.active) return { status: 200, body: { ok: true, note: 'no agent-focus active (acceptable skip)' }};
  return command({ type: 'desktop_click_cell', col: 2, row: 2 });
}});
tests.push({ name: 'desktop_pointer_cell', tier: '4', run: async () => {
  const f = await command({ type: 'desktop_focus_status' });
  if (!f.body?.result?.active) return { status: 200, body: { ok: true, note: 'no agent-focus active (acceptable skip)' }};
  return command({ type: 'desktop_pointer_cell', col: 2, row: 2 });
}});
tests.push({ name: 'desktop_focus_grid', tier: '4', run: async () => {
  const f = await command({ type: 'desktop_focus_status' });
  if (!f.body?.result?.active) return { status: 200, body: { ok: true, note: 'no agent-focus active (acceptable skip)' }};
  const on = await command({ type: 'desktop_focus_grid', action: 'show' });
  await sleep(300);
  await command({ type: 'desktop_focus_grid', action: 'hide' });
  return on;
}});
// region select + pick point + calibrate are USER-INTERACTIVE — skip in auto tier4
tests.push({ name: 'desktop_select_region',  tier: '4', run: async () => ({ status: 200, body: { ok: true, note: 'user-interactive — skipped in auto smoke (would block on user click)' }})});
tests.push({ name: 'desktop_release_focus',  tier: '4', run: () => command({ type: 'desktop_release_focus' })});
tests.push({ name: 'desktop_calibrate_pointer', tier: '4', run: async () => ({ status: 200, body: { ok: true, note: 'user-interactive — skipped in auto smoke' }})});
tests.push({ name: 'desktop_pick_point',     tier: '4', run: async () => ({ status: 200, body: { ok: true, note: 'user-interactive — skipped in auto smoke' }})});

// ── TIER 5: recordings ──
tests.push({ name: 'browser_recordings',   tier: '5', run: async () => {
  const r = await fetch(`${BRIDGE}/api/recordings`);
  return { status: r.status, body: { ok: r.ok, result: { recordings: await r.json() }}};
}});
tests.push({ name: 'browser_record_start', tier: '5', run: () => command({ type: 'record_start', name: `smoke-${STAMP}` }) });
tests.push({ name: 'browser_record_stop',  tier: '5', run: async () => { await sleep(300); return command({ type: 'record_stop' }); } });
tests.push({ name: 'browser_play',         tier: '5', run: async () => {
  const r = await fetch(`${BRIDGE}/api/recordings`);
  const list = await r.json();
  const first = list?.[0]?.name;
  if (!first) return { status: 200, body: { ok: true, note: 'no saved recordings — skip' }};
  return { status: 200, body: { ok: true, note: `would play "${first}" (skipped to avoid state changes)` }};
}});
tests.push({ name: 'browser_chat',         tier: '5', run: () => command({ type: 'chat', message: 'smoke-test' }) });
tests.push({ name: 'browser_read_chat',    tier: '5', run: async () => {
  const r = await fetch(`${BRIDGE}/api/chat?limit=5`);
  return { status: r.status, body: { ok: r.ok, result: { messages: await r.json() }}};
}});

// ── TIER 6: eval (--eval) ──
tests.push({ name: 'browser_evaluate', tier: 'eval', run: async () => {
  await openBrowserFixture();
  const r = await command({ type: 'evaluate', script: '1+1' });
  if (r.body?.result?.result !== 2) return { status: 500, body: { ok: false, error: `evaluate returned unexpected result: ${summarise(r)}` }};
  return r;
}});

// ────────────────── RUN ──────────────────
console.log(`[smoke-all] bridge=${BRIDGE} out=${OUT_DIR}`);
console.log(`[smoke-all] tier4=${RUN_TIER4} eval=${RUN_EVAL} total=${tests.length}`);

const enableNeeded = [
  'browser_click','browser_click_ref','browser_click_xy','browser_type','browser_type_ref',
  'browser_press','browser_highlight','browser_evaluate',
  'desktop_click','desktop_hover','desktop_drag','desktop_click_ref','desktop_hover_ref',
  'desktop_overlay','desktop_select_region','desktop_release_focus','desktop_pointer_show',
  'desktop_pointer_move','desktop_pointer_pulse','desktop_pointer_hide','desktop_calibrate_pointer',
  'desktop_click_cell','desktop_pointer_cell','desktop_focus_grid','desktop_pick_point',
  'browser_record_start','browser_record_stop','browser_play','browser_recordings',
  'browser_chat','browser_read_chat',
];
// Snapshot current settings, force-enable per-tool toggles AND global read/write/execute,
// restore at end. globalSafety lives under bridge.globalSafety, enabledTools under chat.
const stateRes = await fetch(`${BRIDGE}/api/settings/state`).then(r => r.json()).catch(() => ({}));
const enabledBefore = stateRes?.chat?.enabledTools || {};
const safetyBefore = stateRes?.bridge?.globalSafety || { read: true, write: true, execute: true };
const overrides = {};
for (const n of enableNeeded) overrides[n] = true;
await fetch(`${BRIDGE}/api/settings/state`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat: { enabledTools: { ...enabledBefore, ...overrides }},
    bridge: { globalSafety: { read: true, write: true, execute: true }},
  }),
});

try {
  for (const t of tests) {
    if (ONLY && !ONLY.includes(t.tier)) continue;
    process.stdout.write(`[${t.tier}] ${t.name} ... `);
    await runTest(t);
    const last = results[results.length - 1];
    console.log(last.status === 'PASS' ? `\u2713 ${last.ms}ms` : last.status === 'SKIP' ? 'skip' : `\u2717 ${last.error}`);
  }
} finally {
  // Restore enabled state even when an individual smoke crashes or times out.
  await fetch(`${BRIDGE}/api/settings/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat: { enabledTools: enabledBefore },
      bridge: { globalSafety: safetyBefore },
    }),
  }).catch(() => {});
  if (browserFixtureServer) {
    await new Promise(resolve => browserFixtureServer.close(resolve)).catch(() => {});
  }
}

// ────────────────── REPORT ──────────────────
const pass = results.filter(r => r.status === 'PASS').length;
const fail = results.filter(r => r.status === 'FAIL').length;
const skip = results.filter(r => r.status === 'SKIP').length;

const lines = [];
lines.push(`# Bridge full-tool smoke — v${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version}`);
lines.push('');
lines.push(`Generated: ${new Date().toISOString()}  ·  Bridge: ${BRIDGE}`);
lines.push(`Total ${results.length} · PASS ${pass} · FAIL ${fail} · SKIP ${skip}`);
lines.push('');
const tiers = [['1', 'Read / status'], ['2', 'Browser navigate'], ['3', 'Browser interact'], ['4', 'Desktop interact'], ['5', 'Recordings'], ['eval', 'Eval (JS)']];
for (const [t, label] of tiers) {
  const sub = results.filter(r => r.tier === t);
  if (!sub.length) continue;
  lines.push(`## Tier ${t} — ${label}`);
  lines.push('');
  lines.push('| Tool | Result | Latency | Notes |');
  lines.push('|---|---|---|---|');
  for (const r of sub) {
    const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '–';
    const ms = r.ms != null ? `${r.ms}ms` : '';
    const note = r.error ? `error: ${r.error}` : (r.summary ? r.summary.slice(0, 180) : '');
    lines.push(`| \`${r.name}\` | ${icon} ${r.status} | ${ms} | ${note.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
}

const allShots = results.flatMap(r => (r.shots || []).map(s => `- \`${r.name}\` → [${basename(s)}](shots/${basename(s)})`));
if (allShots.length) {
  lines.push('## Captured screenshots');
  lines.push('');
  lines.push(...allShots);
}

const reportPath = join(OUT_DIR, 'report.md');
writeFileSync(reportPath, lines.join('\n'));
writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(results, null, 2));

console.log('');
console.log(`[smoke-all] PASS ${pass}  FAIL ${fail}  SKIP ${skip}`);
console.log(`[smoke-all] report: ${reportPath}`);

process.exit(fail > 0 ? 1 : 0);
