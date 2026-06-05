/**
 * Shared "which exe is the product?" resolver.
 *
 * Background: once the native Go
 * bootstrapper spawns Node as a subprocess, `process.execPath` inside any JS is
 * `node.exe`, NOT `Empir3Setup.exe`. So nothing may use `process.execPath` to
 * register, advertise, or relaunch "the installer" anymore. Every such call
 * site resolves the bootstrap exe through this one function instead.
 *
 * Resolution order (matches the Go stub's resolver):
 *   1. process.env.EMPIR3_BOOTSTRAP_EXE  (set by the Go stub for its Node child)
 *   2. %APPDATA%/Empir3/bridge-bootstrap.json → bootstrapPath
 *   3. stable %APPDATA%/Empir3/Empir3Setup.exe (if present)
 *   4. process.execPath — ONLY for a genuine old Node-SEA process (isSea()),
 *      where execPath really is Empir3Setup.exe. Never fires under spawned Node.
 *   5. null → caller must FAIL CLOSED (skip the registration; never write
 *      node.exe as the product path).
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

function appDataEmpir3Dir(): string {
  const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(roaming, 'Empir3');
}

/** True only inside a genuine Node Single-Executable-Application (the old SEA
 *  bootstrapper). Under the Go stub's spawned node.exe this is false. Falls
 *  back to a basename check if node:sea is unavailable on this runtime. */
function isGenuineSeaBootstrap(): boolean {
  try {
    // node:sea exists on Node 20+. isSea() is true only in a SEA binary.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sea = require('node:sea');
    if (sea && typeof sea.isSea === 'function') return Boolean(sea.isSea());
  } catch {
    /* node:sea not present — fall through to basename heuristic */
  }
  return basename(process.execPath).toLowerCase() === 'empir3setup.exe';
}

/**
 * Resolve the bootstrap exe to use for registration / relaunch.
 * Returns an absolute path that exists, or null when nothing trustworthy
 * resolves (caller must fail closed).
 */
export function resolveBootstrapExe(): string | null {
  const fromEnv = (process.env.EMPIR3_BOOTSTRAP_EXE || '').trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const pointer = join(appDataEmpir3Dir(), 'bridge-bootstrap.json');
  try {
    const data = JSON.parse(readFileSync(pointer, 'utf8'));
    const p = String(data?.bootstrapPath || '').trim();
    if (p && existsSync(p)) return p;
  } catch {
    /* no/invalid pointer — continue */
  }

  const stable = join(appDataEmpir3Dir(), 'Empir3Setup.exe');
  if (existsSync(stable)) return stable;

  if (isGenuineSeaBootstrap() && existsSync(process.execPath)) {
    return process.execPath;
  }

  return null;
}
