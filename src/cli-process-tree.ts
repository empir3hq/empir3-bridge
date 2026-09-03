import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';

type KillSignal = 'SIGTERM' | 'SIGKILL';

export interface CliProcessOwner {
  pid?: number | null;
  kill?: (signal?: any) => unknown;
  once?: (event: string, listener: (...args: any[]) => void) => unknown;
  exitCode?: number | null;
}

export interface CliProcessTerminationResult {
  ok: boolean;
  pid: number | null;
  reason?: 'not_owned' | 'invalid_pid' | 'kill_failed';
  error?: string;
}

interface OwnedCliProcess {
  owner: CliProcessOwner;
  label: string;
  startedAt: number;
}

const ownedCliProcesses = new Map<number, OwnedCliProcess>();
const terminationTelemetry = {
  attempts: 0,
  succeeded: 0,
  rejectedUnowned: 0,
  failed: 0,
  lastReason: '',
  lastError: '',
  lastAt: 0,
};

function validOwnedPid(raw: unknown): number | null {
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return null;
  return pid;
}

/**
 * Registers the exact process object returned by a Bridge-owned spawn. The
 * object identity check prevents a stale/reused pid from authorizing a kill.
 */
export function registerOwnedCliProcess<T extends CliProcessOwner>(owner: T, label = 'cli'): T {
  const pid = validOwnedPid(owner?.pid);
  if (pid === null) return owner;

  ownedCliProcesses.set(pid, {
    owner,
    label: String(label || 'cli').slice(0, 80),
    startedAt: Date.now(),
  });

  if (typeof owner.once === 'function') {
    owner.once('close', () => unregisterOwnedCliProcess(owner));
  }
  return owner;
}

export function unregisterOwnedCliProcess(owner: CliProcessOwner): void {
  const pid = validOwnedPid(owner?.pid);
  if (pid === null) return;
  if (ownedCliProcesses.get(pid)?.owner === owner) ownedCliProcesses.delete(pid);
}

function taskkillPath(): string {
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || '').trim();
  return systemRoot ? join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
}

export function windowsTreeKillArgs(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F'];
}

function runWindowsTreeKill(pid: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    let killer: ChildProcess;
    try {
      killer = spawn(taskkillPath(), windowsTreeKillArgs(pid), {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error: any) {
      resolve({ ok: false, error: error?.message || String(error) });
      return;
    }
    killer.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
      if (stderr.length > 1024) stderr = stderr.slice(-1024);
    });
    killer.once('error', (error: Error) => resolve({ ok: false, error: error.message }));
    killer.once('close', (code) => {
      resolve(code === 0
        ? { ok: true }
        : { ok: false, error: stderr.trim() || `taskkill exited ${code ?? -1}` });
    });
  });
}

/**
 * Terminates only a currently registered Bridge-owned process tree. Windows
 * uses taskkill with an exact numeric pid and argument-array spawning so a
 * `.cmd`/`.bat` wrapper cannot leave its real CLI descendant behind. POSIX
 * keeps the native signal/grace behavior.
 */
export async function terminateCliProcessTree(
  owner: CliProcessOwner,
  options: { signal?: KillSignal; reason?: string } = {},
): Promise<CliProcessTerminationResult> {
  const pid = validOwnedPid(owner?.pid);
  if (pid === null) {
    terminationTelemetry.rejectedUnowned++;
    return { ok: false, pid: null, reason: 'invalid_pid' };
  }

  const record = ownedCliProcesses.get(pid);
  if (!record || record.owner !== owner) {
    terminationTelemetry.rejectedUnowned++;
    return { ok: false, pid, reason: 'not_owned' };
  }

  terminationTelemetry.attempts++;
  terminationTelemetry.lastReason = String(options.reason || 'unspecified').slice(0, 120);
  terminationTelemetry.lastAt = Date.now();

  try {
    if (process.platform === 'win32') {
      const result = await runWindowsTreeKill(pid);
      if (!result.ok) throw new Error(result.error || 'taskkill failed');
      // node-pty owns native pipe/pseudoconsole handles in addition to the
      // child pid. Exact taskkill closes the process tree, then IPty.kill()
      // releases those local handles so the Bridge itself cannot retain a
      // dead ConPTY session (and its event-loop handles) indefinitely.
      if (typeof (owner as any).onExit === 'function' && typeof owner.kill === 'function') {
        try { owner.kill(); } catch { /* the process tree is already gone */ }
      }
    } else {
      if (typeof owner.kill !== 'function') throw new Error('owned process has no kill method');
      owner.kill(options.signal || 'SIGTERM');
    }
    terminationTelemetry.succeeded++;
    return { ok: true, pid };
  } catch (error: any) {
    // A process may exit naturally between the ownership check and taskkill.
    // Treat that race as success when the owner reports a settled exit code.
    if (owner.exitCode !== undefined && owner.exitCode !== null) {
      terminationTelemetry.succeeded++;
      return { ok: true, pid };
    }
    terminationTelemetry.failed++;
    terminationTelemetry.lastError = String(error?.message || error).slice(0, 300);
    return { ok: false, pid, reason: 'kill_failed', error: terminationTelemetry.lastError };
  }
}

export function getCliProcessTelemetry(): {
  active: Array<{ pid: number; label: string; ageMs: number }>;
  termination: typeof terminationTelemetry;
} {
  const now = Date.now();
  return {
    active: Array.from(ownedCliProcesses.entries()).map(([pid, record]) => ({
      pid,
      label: record.label,
      ageMs: Math.max(0, now - record.startedAt),
    })),
    termination: { ...terminationTelemetry },
  };
}
