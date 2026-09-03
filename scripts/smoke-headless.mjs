#!/usr/bin/env node
/**
 * Headless bridge smoke — the proof that the Linux bridge story is true.
 *
 * Boots src/headless-entry.js in an ISOLATED state dir (HOME is redirected to
 * a temp dir, so your real bridge config/profile is never touched) on
 * non-default ports, then asserts the Phase 7 contract:
 *
 *   1.  the process is alive after the survival window (default 60s —
 *       EMPIR3_SMOKE_ALIVE_MS=5000 for quick iteration)
 *   2.  /api/status responds and reports a platform profile
 *   3.  NO Chromium was launched (autolaunch off is the headless default)
 *   4.  a desktop screenshot succeeds when an X11 display is present, or
 *       returns structured capability_unsupported when genuinely display-less
 *       — never a spawn ENOENT (Windows: expects it to pass the gate)
 *   5.  desktop:execute `echo ok` works via the platform shell
 *   6.  /etc/shadow and /proc/self/environ are DENIED (POSIX only)
 *   7.  a normal readable file (in /tmp) pulls fine (POSIX only)
 *   8.  SIGTERM exits cleanly within 10s
 *
 * ("real CPU/disk numbers" from the plan's spec joins this list with the
 *  Phase 7.4 pure-Node metrics collector.)
 *
 * Run on the target box:   node scripts/smoke-headless.mjs
 * Quick local iteration:   EMPIR3_SMOKE_ALIVE_MS=5000 node scripts/smoke-headless.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.EMPIR3_SMOKE_RUNTIME_ROOT
  ? resolve(process.env.EMPIR3_SMOKE_RUNTIME_ROOT)
  : SOURCE_ROOT;
const WORKING_DIR = process.env.EMPIR3_SMOKE_WORKING_DIR
  ? resolve(process.env.EMPIR3_SMOKE_WORKING_DIR)
  : ROOT;
const POSIX = process.platform !== 'win32';

const PW_PORT = 13006;
const BRIDGE_PORT = 19867;
const CDP_PORT = 19222;
const ALIVE_MS = Math.max(1000, parseInt(process.env.EMPIR3_SMOKE_ALIVE_MS || '60000', 10));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail && !ok ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getJson(path, timeoutMs = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${PW_PORT}${path}`, { signal: ctl.signal });
    return await res.json();
  } finally { clearTimeout(t); }
}

async function command(cmd, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${PW_PORT}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      signal: ctl.signal,
    });
    const body = await res.json();
    return body?.result ?? body;
  } finally { clearTimeout(t); }
}

async function main() {
  // ── isolated state dir: settings pre-seeded with execute enabled ──
  const stateHome = join(tmpdir(), `e3-smoke-${process.pid}-${Date.now()}`);
  const settingsDir = join(stateHome, '.empir3', 'Empir3');
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, 'bridge-settings.json'), JSON.stringify({
    deviceId: 'smoke-headless',
    deviceName: 'smoke-headless',
    globalSafety: { read: true, write: true, execute: true },
  }, null, 2));

  const env = {
    ...process.env,
    HOME: stateHome,
    USERPROFILE: stateHome,          // Windows homedir()
    APPDATA: join(stateHome, '.empir3'), // Windows SETTINGS_DIR base → .empir3/Empir3
    EMPIR3_PW_PORT: String(PW_PORT),
    EMPIR3_BRIDGE_HTTP_PORT: String(BRIDGE_PORT),
    EMPIR3_CDP_PORT: String(CDP_PORT),
    EMPIR3_HEADLESS: '1',
    ...(process.env.EMPIR3_SMOKE_RUNTIME_ROOT ? { EMPIR3_BRIDGE_PAYLOAD_DIR: ROOT } : {}),
    // Explicitly unset any operator overrides that would skew assertions
    EMPIR3_CHROME_AUTOLAUNCH: '0',
    EMPIR3_ALLOWED_ROOTS: '',
  };

  console.log(`[smoke] booting headless bridge (state: ${stateHome}, alive window: ${ALIVE_MS}ms)`);
  const child = spawn(process.execPath, [join(ROOT, 'src', 'headless-entry.js')], {
    cwd: WORKING_DIR, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = null;
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  try {
    // ── wait for readiness ──
    const bootDeadline = Date.now() + 90_000;
    let status = null;
    while (Date.now() < bootDeadline && !exited) {
      try { status = await getJson('/api/status'); if (status) break; } catch { /* not up yet */ }
      await wait(1000);
    }
    check('bridge boots to /api/status', !!status && !exited, exited ? { ...exited, output: output.slice(-1000) } : output.slice(-1000));
    if (!status) throw new Error('bridge never became ready');

    check('platform profile reported', !!status.platform && typeof status.platform.deviceClass === 'string', status.platform);
    if (POSIX) check('profile says headless server', status.platform?.headless === true && status.platform?.deviceClass === 'server', status.platform);

    // ── survival window (the crash-loop detector) ──
    console.log(`[smoke] waiting out the ${Math.round(ALIVE_MS / 1000)}s survival window…`);
    await wait(ALIVE_MS);
    check(`alive after ${Math.round(ALIVE_MS / 1000)}s`, exited === null, exited);

    // ── no Chromium ──
    const health = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`).then(r => r.json());
    check('no Chromium launched (chrome: not-started)', health?.chrome === 'not-started', health);

    // ── capability gate ──
    const shot = await command({ type: 'desktop_screenshot' });
    if (POSIX) {
      if (status.platform?.x11Display) {
        check('desktop_screenshot succeeds on the detected X11 display',
          shot?.success === true && shot?.display === status.platform.x11Display && Number(shot?.bytes) > 0,
          { shot, platform: status.platform });
      } else {
        check('display-less desktop_screenshot → capability_unsupported', shot?.code === 'capability_unsupported' && shot?.success === false, shot);
        check('display-less refusal carries deviceClass + hint', typeof shot?.deviceClass === 'string' && typeof shot?.hint === 'string', shot);
      }
      const sysinfo = await command({ type: 'desktop:sysinfo', params: { query: 'processes' } });
      check('sysinfo:processes → capability_unsupported', sysinfo?.code === 'capability_unsupported', sysinfo);
    } else {
      check('desktop_screenshot passes the gate on Windows', shot?.code !== 'capability_unsupported', shot);
    }
    const overview = await command({ type: 'desktop:sysinfo', params: { query: 'overview' } });
    check('sysinfo:overview works everywhere', overview?.success === true && !!overview?.data, overview);

    // ── shell execute ──
    const echo = await command({ type: 'desktop:execute', params: { command: 'echo ok' } });
    check("desktop:execute 'echo ok'", echo?.success === true && /\bok\b/.test(String(echo?.stdout || '')), echo);
    if (POSIX) {
      const shEcho = await command({ type: 'desktop:execute', params: { command: 'echo ok', shell: 'sh' } });
      check("desktop:execute via sh -c", shEcho?.success === true && /\bok\b/.test(String(shEcho?.stdout || '')) && shEcho?.shell === 'sh', shEcho);
    }
    const blockedCmd = await command({ type: 'desktop:execute', params: { command: 'rm -rf /' } });
    check('rm -rf / is blocked', blockedCmd?.success === false && !!blockedCmd?.blocked, blockedCmd);

    // ── path guard (POSIX) ──
    if (POSIX) {
      const shadow = await command({ type: 'desktop:file:pull', params: { path: '/etc/shadow' } });
      check('/etc/shadow denied', shadow?.success === false && /denied|Cannot read/i.test(String(shadow?.error || '')), shadow);
      const environ = await command({ type: 'desktop:file:pull', params: { path: '/proc/self/environ' } });
      check('/proc/self/environ denied', environ?.success === false && /denied|Cannot read/i.test(String(environ?.error || '')), environ);
      const sudoers = await command({ type: 'desktop:file:pull', params: { path: '/etc/sudoers' } });
      check('/etc/sudoers denied', sudoers?.success === false && /denied|Cannot read/i.test(String(sudoers?.error || '')), sudoers);

      // a normal file still pulls fine — over-blocking is also a failure
      const okPath = join(tmpdir(), `e3-smoke-ok-${process.pid}.txt`);
      writeFileSync(okPath, 'readable\n');
      const pull = await command({ type: 'desktop:file:pull', params: { path: okPath } });
      check('normal /tmp file pulls fine', pull?.success === true && !!pull?.data, pull);
      try { rmSync(okPath); } catch {}
    }

    // ── clean shutdown ──
    console.log('[smoke] sending SIGTERM…');
    child.kill('SIGTERM');
    const stopDeadline = Date.now() + 10_000;
    while (exited === null && Date.now() < stopDeadline) await wait(200);
    check('SIGTERM exits within 10s', exited !== null, 'still running');
    if (POSIX) check('exit code 0 on SIGTERM', exited?.code === 0 || exited?.signal === 'SIGTERM', exited);
  } finally {
    if (exited === null) { try { child.kill('SIGKILL'); } catch {} }
    await wait(300);
    try { rmSync(stateHome, { recursive: true, force: true }); } catch {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n[smoke] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('[smoke] FAILED:', failed.map(f => f.name).join(', '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[smoke] fatal:', e?.stack || e);
  process.exit(1);
});
