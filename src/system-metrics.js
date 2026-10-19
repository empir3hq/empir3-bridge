/**
 * System metrics — the fleet health collector. SHELL-FREE PURE NODE.
 *
 * The existing sysinfo path shells to PowerShell `Get-Counter
 * -SampleInterval 1` per call: Windows-only, stalls a full second, and spawns
 * a process per beat — unacceptable for a 60s heartbeat across a fleet.
 * This module reads everything from Node built-ins and /proc:
 *
 *   cpu       os.cpus() tick deltas between calls (real %, not a snapshot)
 *   memory    /proc/meminfo MemAvailable on Linux (freemem() lies there —
 *             it ignores reclaimable page cache); os.freemem() elsewhere
 *   swap      /proc/meminfo
 *   disks     fs.promises.statfs over real mounts (/proc/mounts on Linux)
 *   processes /proc numeric-dir count on Linux (null elsewhere — no shelling)
 *   battery   /sys/class/power_supply on Linux (null elsewhere)
 *
 * Failure contract: every collector is independently try/caught. A failed
 * collector contributes `null` fields plus a named entry in `errors[]` and
 * sets `partial: true` — "alive but disk stat failed" must never read as
 * silence. sysinfo.js stays untouched for the rich on-demand pull.
 */

'use strict';

const os = require('os');
const fs = require('fs');

const GB = 1024 * 1024 * 1024;

/** Real-filesystem types worth reporting (Linux /proc/mounts filter). */
const REAL_FS_TYPES = new Set([
  'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'jfs', 'reiserfs',
  'ntfs', 'ntfs3', 'exfat', 'vfat', 'apfs', 'hfsplus',
]);

// ── CPU: tick deltas between calls ──────────────────────────────────────────

let lastCpuTimes = null;

function sampleCpuTimes() {
  const cpus = os.cpus();
  let idle = 0; let total = 0;
  for (const c of cpus) {
    for (const [k, v] of Object.entries(c.times)) {
      total += v;
      if (k === 'idle') idle += v;
    }
  }
  return { idle, total };
}

/**
 * CPU% since the previous call (or over a short first-call window).
 * Persistent between calls, so a 60s beat measures the whole interval.
 */
async function cpuPercent() {
  const now = sampleCpuTimes();
  if (!lastCpuTimes) {
    lastCpuTimes = now;
    await new Promise(r => setTimeout(r, 250));
    return cpuPercent();
  }
  const dTotal = now.total - lastCpuTimes.total;
  const dIdle = now.idle - lastCpuTimes.idle;
  lastCpuTimes = now;
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 1000) / 10));
}

// ── Memory + swap ────────────────────────────────────────────────────────────

function readMeminfo() {
  const out = {};
  const text = fs.readFileSync('/proc/meminfo', 'utf8');
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) out[m[1]] = Number(m[2]) * 1024;
  }
  return out;
}

function memoryStats() {
  const totalBytes = os.totalmem();
  let availBytes = os.freemem();
  let swapPercent = null;
  if (process.platform === 'linux') {
    try {
      const mi = readMeminfo();
      if (mi.MemAvailable) availBytes = mi.MemAvailable;
      if (mi.SwapTotal > 0) {
        swapPercent = Math.round(((mi.SwapTotal - mi.SwapFree) / mi.SwapTotal) * 1000) / 10;
      }
    } catch { /* fall back to os.freemem() */ }
  }
  return {
    memPercent: Math.round(((totalBytes - availBytes) / totalBytes) * 1000) / 10,
    memTotalGb: Math.round((totalBytes / GB) * 100) / 100,
    swapPercent,
  };
}

// ── Disks ────────────────────────────────────────────────────────────────────

function linuxMounts() {
  const seenDevices = new Set();
  const mounts = [];
  const text = fs.readFileSync('/proc/mounts', 'utf8');
  for (const line of text.split('\n')) {
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const [device, mount, fstype] = parts;
    if (!REAL_FS_TYPES.has(fstype)) continue;
    if (!device.startsWith('/dev/')) continue;
    if (seenDevices.has(device)) continue; // bind mounts / btrfs subvols
    seenDevices.add(device);
    // \040 is how /proc/mounts escapes spaces
    mounts.push(mount.replace(/\\040/g, ' '));
  }
  return mounts.length ? mounts : ['/'];
}

async function diskStats() {
  const statfs = fs.promises.statfs;
  if (typeof statfs !== 'function') return []; // Node < 18.15
  const targets = process.platform === 'linux' ? linuxMounts()
    : process.platform === 'win32' ? [(process.env.SystemDrive || 'C:') + '\\']
    : ['/'];
  const disks = [];
  for (const mount of targets.slice(0, 8)) {
    try {
      const st = await statfs(mount);
      const totalBytes = Number(st.blocks) * Number(st.bsize);
      const availBytes = Number(st.bavail) * Number(st.bsize);
      if (!(totalBytes > 0)) continue;
      disks.push({
        mount,
        totalGb: Math.round((totalBytes / GB) * 10) / 10,
        freeGb: Math.round((availBytes / GB) * 10) / 10,
        percent: Math.round(((totalBytes - availBytes) / totalBytes) * 1000) / 10,
      });
    } catch { /* per-mount failure is fine; others still report */ }
  }
  return disks;
}

// ── Processes + battery (Linux; null elsewhere — never shell out) ───────────

function processCount() {
  if (process.platform !== 'linux') return null;
  return fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).length;
}

function batteryPercent() {
  if (process.platform !== 'linux') return null;
  const base = '/sys/class/power_supply';
  for (const entry of fs.readdirSync(base)) {
    try {
      const type = fs.readFileSync(`${base}/${entry}/type`, 'utf8').trim();
      if (type !== 'Battery') continue;
      const cap = Number(fs.readFileSync(`${base}/${entry}/capacity`, 'utf8').trim());
      if (Number.isFinite(cap)) return cap;
    } catch { /* try the next supply */ }
  }
  return null;
}

// ── The snapshot ─────────────────────────────────────────────────────────────

/**
 * Collect one health snapshot. Never throws; failures surface as null fields
 * + named `errors[]` + `partial: true`.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.includeDisks=true]
 * @param {boolean} [opts.includeProcessCount=true]
 * @param {number}  [opts.budgetMs=5000]  soft budget — disks are the only
 *   await, and a statfs that hangs past it yields a partial report.
 */
async function collectHealthSnapshot(opts = {}) {
  const includeDisks = opts.includeDisks !== false;
  const includeProcessCount = opts.includeProcessCount !== false;
  const budgetMs = Math.max(1000, opts.budgetMs || 5000);

  const errors = [];
  const grab = (label, fn, fallback = null) => {
    try { return fn(); } catch (e) { errors.push(`${label}: ${(e && e.message) || e}`); return fallback; }
  };

  const mem = grab('memory', memoryStats, { memPercent: null, memTotalGb: null, swapPercent: null });

  let cpu = null;
  try { cpu = await cpuPercent(); } catch (e) { errors.push(`cpu: ${(e && e.message) || e}`); }

  let disks = [];
  if (includeDisks) {
    try {
      disks = await Promise.race([
        diskStats(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('disk stat exceeded budget')), budgetMs)),
      ]);
    } catch (e) {
      errors.push(`disks: ${(e && e.message) || e}`);
    }
  }

  return {
    cpuPercent: cpu,
    memPercent: mem.memPercent,
    memTotalGb: mem.memTotalGb,
    swapPercent: mem.swapPercent,
    disks,
    processCount: includeProcessCount ? grab('processes', processCount) : null,
    batteryPercent: grab('battery', batteryPercent),
    uptimeSec: Math.round(os.uptime()),
    hostname: os.hostname(),
    arch: process.arch,
    partial: errors.length > 0,
    errors,
  };
}

module.exports = { collectHealthSnapshot, cpuPercent, memoryStats, diskStats, processCount, batteryPercent };
