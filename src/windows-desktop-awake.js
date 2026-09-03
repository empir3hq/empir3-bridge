'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_IDLE_RELEASE_MS = 2 * 60 * 1000;

// One-shot wake probe. SwitchDesktop is used only as the documented secure-
// desktop test: it succeeds for the ordinary interactive desktop and fails
// for the Windows lock/sign-in desktop. The Bridge never attempts to cross
// that boundary.
const WINDOWS_DESKTOP_WAKE_PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3DesktopWake {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SwitchDesktop(IntPtr desktop);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, out bool value, uint flags);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);

  public static bool InputDesktopAvailable() {
    const uint DESKTOP_SWITCHDESKTOP = 0x0100;
    IntPtr desktop = OpenInputDesktop(0, false, DESKTOP_SWITCHDESKTOP);
    if (desktop == IntPtr.Zero) return false;
    try { return SwitchDesktop(desktop); }
    finally { CloseDesktop(desktop); }
  }

  public static uint IdleMilliseconds() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return 0;
    return unchecked((uint)Environment.TickCount - info.dwTime);
  }

  public static void PulseDisplay() { SetThreadExecutionState(0x00000003); }
  public static void SendF15() {
    keybd_event(0x7E, 0, 0, UIntPtr.Zero);
    keybd_event(0x7E, 0, 0x0002, UIntPtr.Zero);
  }
}
"@

$unlocked = [Empir3DesktopWake]::InputDesktopAvailable()
if (-not $unlocked) {
  [pscustomobject]@{ unlocked=$false; woke=$false; secureDesktop=$true; error='Windows is password-locked on the secure desktop.' } | ConvertTo-Json -Compress
  exit 0
}

$running = $false
[void][Empir3DesktopWake]::SystemParametersInfo(114, 0, [ref]$running, 0)
$idleMs = [Empir3DesktopWake]::IdleMilliseconds()
[Empir3DesktopWake]::PulseDisplay()
$nudged = $running -or $idleMs -ge 10000
if ($nudged) { [Empir3DesktopWake]::SendF15() }
Start-Sleep -Milliseconds 350
$runningAfter = $false
[void][Empir3DesktopWake]::SystemParametersInfo(114, 0, [ref]$runningAfter, 0)
[pscustomobject]@{
  unlocked=$true
  secureDesktop=$false
  screenSaverWasRunning=$running
  screenSaverRunning=$runningAfter
  idleMs=[long]$idleMs
  nudged=$nudged
  woke=(-not $runningAfter)
} | ConvertTo-Json -Compress
`;

function keepAwakeScript(parentPid) {
  return String.raw`
$ErrorActionPreference = 'Stop'
$parentPid = ${Number(parentPid)}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3DesktopKeepAwake {
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SwitchDesktop(IntPtr desktop);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  public static bool InputDesktopAvailable() {
    IntPtr desktop = OpenInputDesktop(0, false, 0x0100);
    if (desktop == IntPtr.Zero) return false;
    try { return SwitchDesktop(desktop); }
    finally { CloseDesktop(desktop); }
  }
  public static void SendF15() {
    keybd_event(0x7E, 0, 0, UIntPtr.Zero);
    keybd_event(0x7E, 0, 0x0002, UIntPtr.Zero);
  }
}
"@
try {
  while (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) {
    if (-not [Empir3DesktopKeepAwake]::InputDesktopAvailable()) { break }
    [void][Empir3DesktopKeepAwake]::SetThreadExecutionState(0x80000003)
    [Empir3DesktopKeepAwake]::SendF15()
    Start-Sleep -Seconds 20
  }
} finally {
  [void][Empir3DesktopKeepAwake]::SetThreadExecutionState(0x80000000)
}
`;
}

function createWindowsDesktopAwakeController(options = {}) {
  const platform = options.platform || process.platform;
  const spawnProcess = options.spawnProcess || spawn;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const parentPid = Number(options.parentPid || process.pid);
  const configuredIdleMs = Number(options.idleReleaseMs || process.env.EMPIR3_DESKTOP_AWAKE_IDLE_MS || DEFAULT_IDLE_RELEASE_MS);
  const idleReleaseMs = Number.isFinite(configuredIdleMs) ? Math.max(10_000, configuredIdleMs) : DEFAULT_IDLE_RELEASE_MS;
  let child = null;
  let idleTimer = null;
  let lastActivityAt = 0;

  function release() {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = null;
    const current = child;
    child = null;
    if (current) {
      try { current.kill(); } catch {}
    }
  }

  function startLease() {
    if (platform !== 'win32') return false;
    if (!child) {
      const proc = spawnProcess('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', keepAwakeScript(parentPid),
      ], { windowsHide: true, stdio: 'ignore' });
      child = proc;
      proc.once?.('exit', () => { if (child === proc) child = null; });
      proc.once?.('error', () => { if (child === proc) child = null; });
      proc.unref?.();
    }
    lastActivityAt = Date.now();
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = setTimer(release, idleReleaseMs);
    idleTimer?.unref?.();
    return true;
  }

  async function ensureAwake(runPowerShellJson) {
    if (platform !== 'win32') return { supported: false, unlocked: true };
    const state = await runPowerShellJson(WINDOWS_DESKTOP_WAKE_PS, 10_000);
    if (!state?.unlocked || state?.secureDesktop) {
      release();
      const error = new Error('Windows is password-locked on the secure desktop. The Bridge cannot capture or inject input until the user unlocks the machine.');
      error.code = 'desktop_locked';
      throw error;
    }
    if (state?.screenSaverRunning) {
      release();
      const error = new Error('Windows remained on the screensaver after the Bridge wake nudge. Unlock the machine locally if sign-in is required.');
      error.code = 'desktop_wake_failed';
      throw error;
    }
    startLease();
    return { supported: true, ...state, keepAwakeIdleMs: idleReleaseMs };
  }

  function status() {
    return {
      supported: platform === 'win32',
      active: !!child,
      idleReleaseMs,
      lastActivityAt: lastActivityAt || null,
    };
  }

  return { ensureAwake, startLease, release, status };
}

module.exports = {
  DEFAULT_IDLE_RELEASE_MS,
  WINDOWS_DESKTOP_WAKE_PS,
  createWindowsDesktopAwakeController,
  keepAwakeScript,
};
