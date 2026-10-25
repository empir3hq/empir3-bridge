/**
 * runProcess — spawn a child, capture its output, enforce a timeout, and
 * settle honestly when the child exits but a detached grandchild keeps the
 * output pipes open (Work Board 24fafb79).
 *
 * Node's 'close' event waits for every stdio pipe to close. A script that
 * starts a background server with inherited stdout (PowerShell
 * `Start-Process -RedirectStandardOutput … -PassThru`, `nohup cmd &`, …)
 * exits promptly, but the pipe stays open for as long as the grandchild
 * lives — so execute:run used to hang to the PC-side time limit, kill the
 * tree (including the server the user just started), and report a timeout
 * for work that had finished fine.
 *
 * Now: on 'exit' we give the pipes a short grace to drain and close. If they
 * do not, we resolve with the exit code we already have, mark
 * `shellHeldByChild: true`, leave the grandchild running, and hand back
 * `cleanupPending` for callers that must wait for the pipes anyway.
 */

import { spawn, type ChildProcess } from 'child_process';
import { basename } from 'path';
import { registerOwnedCliProcess, terminateCliProcessTree } from './cli-process-tree.js';

export interface RunProcessOptions {
  timeoutMs?: number;
  input?: string;
  maxBytes?: number;
  cwd?: string;
  verbatim?: boolean;
  /** How long to wait for stdio to close after the child exits (default 1500ms). */
  exitCloseGraceMs?: number;
}

export interface RunProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The command exited but a process it started still holds its output stream. */
  shellHeldByChild?: boolean;
  cleanupPending?: Promise<void>;
}

export const EXIT_CLOSE_GRACE_MS = 1500;

export function runProcess(file: string, args: string[] = [], options: RunProcessOptions = {}): Promise<RunProcessResult> {
  return new Promise((resolveRun) => {
    let child: ChildProcess;
    try {
      child = registerOwnedCliProcess(spawn(file, args, {
        cwd: options.cwd,
        windowsHide: true,
        windowsVerbatimArguments: options.verbatim === true,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      }), `process:${basename(file)}`);
    } catch (e: any) {
      resolveRun({ code: -4, stdout: '', stderr: e?.message || String(e), timedOut: false });
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    const maxBytes = options.maxBytes || 8 * 1024 * 1024;
    let closed = false;
    let exitGrace: ReturnType<typeof setTimeout> | null = null;
    const closedPromise = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
    const stop = async (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitGrace) clearTimeout(exitGrace);
      await terminateCliProcessTree(child, { signal: 'SIGKILL', reason: timedOut ? 'runProcess timeout' : 'runProcess output cap' });
      if (!closed) {
        let closeTimer: ReturnType<typeof setTimeout>;
        await Promise.race([closedPromise, new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 1000); })]);
        clearTimeout(closeTimer!);
      }
      resolveRun({ code: timedOut ? -2 : -3, stdout, stderr, timedOut,
        ...(!closed ? { cleanupPending: closedPromise } : {}) });
    };
    const timer = setTimeout(() => {
      void stop(true);
    }, options.timeoutMs || 30000);

    // Decode incrementally: a pipe chunk may end inside a Unicode character.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', d => {
      if (settled) return;
      if (Buffer.byteLength(stdout) < maxBytes) stdout += d.toString();
      if (Buffer.byteLength(stdout) >= maxBytes) {
        void stop(false);
      }
    });
    child.stderr?.on('data', d => {
      if (settled) return;
      if (Buffer.byteLength(stderr) < maxBytes) stderr += d.toString();
      if (Buffer.byteLength(stderr) >= maxBytes) void stop(false);
    });
    // The command itself is done here. Its pipes may still be held by a
    // detached grandchild; wait briefly for them, then report what we know
    // instead of blocking until the timeout kills a process the user wanted.
    child.on('exit', code => {
      if (settled || closed) return;
      const grace = Number.isFinite(options.exitCloseGraceMs) ? Number(options.exitCloseGraceMs) : 1500 /* EXIT_CLOSE_GRACE_MS */;
      exitGrace = setTimeout(() => {
        if (settled || closed) return;
        settled = true;
        clearTimeout(timer);
        resolveRun({ code, stdout, stderr, timedOut: false, shellHeldByChild: true, cleanupPending: closedPromise });
      }, grace);
    });
    child.on('close', code => {
      if (exitGrace) clearTimeout(exitGrace);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut: false });
    });
    child.on('error', e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitGrace) clearTimeout(exitGrace);
      resolveRun({ code: -4, stdout, stderr: e.message, timedOut: false });
    });
    if (options.input !== undefined) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }
  });
}

/** Sentence appended to execute:run output when the shell was held open by a detached child. */
export const SHELL_HELD_BY_CHILD_NOTE = 'The command finished (its exit code is above); a process it started is still holding the output stream, so the command was NOT killed and its output may be incomplete. Verify the background process directly if it matters.';
