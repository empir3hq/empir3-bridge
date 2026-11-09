import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { CliTurnJournal, CliTurnReceipt } from './cli-turn-journal.js';
import { validNativeStopProof } from './cli-job-evidence.js';

export interface CliJobControl {
  cancel(): void;
  waitForStop(): Promise<void>;
}
export interface CliJobLaunch extends CliJobControl {
  command: string;
  args: string[];
  attach(owner: object): void;
  discardLaunch(): void;
}
export type CliJobFactory = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }, receipt: CliTurnReceipt, attemptNonce: string) => CliJobLaunch;
const jobs = new WeakMap<object, CliJobControl>();
const recoveryHelpers = new Map<string, ChildProcess>();
export const getCliJobControl = (owner: object): CliJobControl | undefined => jobs.get(owner);

function writePrivate(file: string, value: unknown): void {
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value)); fsyncSync(fd); }
  finally { closeSync(fd); }
}

/** This is an owned-provider lifecycle boundary, not an arbitrary-code sandbox.
 * Only kernel-confirmed empty-job receipts count. PID absence, helper exit and
 * elapsed time are deliberately insufficient, including after a daemon crash. */
export function createWindowsCliSupervisor(settings: { helperPath: string; root: string; timeoutMs?: number }): CliJobFactory {
  const helper = resolve(settings.helperPath), root = resolve(settings.root);
  const timeoutMs = settings.timeoutMs ?? 3_600_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw Error('Invalid CLI job deadline');
  return (command, args, options, receipt, nonce) => {
    if (process.platform !== 'win32') throw Error('Windows CLI containment is unavailable');
    const helperInfo = lstatSync(helper);
    if (!helperInfo.isFile() || helperInfo.isSymbolicLink()) throw Error('CLI supervisor is missing or invalid');
    if (!/^[a-f0-9-]{36}$/i.test(receipt.generation) || !/^[a-f0-9-]{36}$/i.test(receipt.nonce)) throw Error('Invalid original CLI receipt');
    const cwd = resolve(options.cwd || process.cwd());
    const env = options.env || process.env;
    const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
    const candidates = isAbsolute(command) ? [command] : /[\\/]/.test(command) ? [resolve(cwd, command)]
      : pathValue.split(delimiter).filter(Boolean).flatMap(dir => [join(dir.replace(/^"|"$/g, ''), command), join(dir.replace(/^"|"$/g, ''), command + '.exe')]);
    const executable = candidates.find(file => { try { return isAbsolute(file) && lstatSync(file).isFile(); } catch { return false; } });
    if (!executable) throw Error('CLI executable could not be resolved for containment');
    // One immutable namespace per admitted turn; no prompt/argument content in
    // its binding. Keep receipts for restart reconciliation, never age them out.
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const rootInfo = lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error('Invalid CLI job directory');
    const directory = join(root, `${receipt.generation}-${receipt.nonce}`);
    try { mkdirSync(directory, { mode: 0o700 }); } catch (e: any) { if (e?.code !== 'EEXIST') throw e; }
    const identity = lstatSync(directory);
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw Error('Invalid CLI job identity directory');
    if (!/^[a-f0-9]{64}$/.test(nonce)) throw Error('Invalid original CLI attempt');
    const file = join(directory, `cli-job-${nonce}.json`);
    writePrivate(file + '.binding', { version: 1, mechanism: 'windows-job-v1', nonce, receipt });
    const config = JSON.stringify({ version: 1, nonce, command: executable, args, cwd, timeoutMs });
    if (Buffer.byteLength(config) > 1024 * 1024) throw Error('CLI launch configuration exceeds its bound');
    writePrivate(file, config);
    const saved = openCliJobControl(root, receipt, nonce);
    const control: CliJobLaunch = {
      ...saved,
      command: helper, args: [file],
      attach(owner: any) {
        jobs.set(owner, control);
        if (typeof owner.onExit === 'function') {
          // node-pty 1.1.0 leaves its ConPTY pipe worker referenced after normal
          // exit. Its public kill() enumerates console PIDs and may target a
          // reused PID. Dispose only this captured agent's local pipe resources
          // after its exit event (output has drained); no process enumeration.
          // Keep node-pty pinned and exercise this contract with a real ConPTY.
          const agent = owner._agent, worker = agent?._conoutSocketWorker, input = agent?._inSocket;
          if (agent?._useConpty !== true || typeof worker?.dispose !== 'function' || typeof input?.destroy !== 'function') throw Error('Unsupported CLI terminal cleanup contract');
          let disposed = false;
          owner.onExit(() => {
            if (disposed) return; disposed = true;
            input.destroy(); worker.dispose();
          });
        }
        if (typeof owner.once === 'function' && typeof owner.onExit !== 'function') {
          // A spawn error can leave the configuration unread. Remove only this
          // private launch file while retaining its permanent cancellation.
          owner.once('error', () => { try { control.discardLaunch(); } catch { /* unresolved evidence stays retained */ } });
          owner.once('close', () => { try { control.discardLaunch(); } catch { /* keep uncertainty on any cleanup failure */ } });
        }
      },
    };
    return control;
  };
}

/** Reopen only the exact nonce namespace committed before spawn. No directory
 * scan, PID lookup, current device selection or recreated missing evidence. */
export function openCliJobControl(rootInput: string, receipt: CliTurnReceipt, nonce: string) {
  if (!/^[a-f0-9-]{36}$/i.test(receipt.generation) || !/^[a-f0-9-]{36}$/i.test(receipt.nonce) || !/^[a-f0-9]{64}$/.test(nonce)) throw Error('Invalid original CLI job identity');
  const root = resolve(rootInput), directory = join(root, `${receipt.generation}-${receipt.nonce}`), file = join(directory, `cli-job-${nonce}.json`);
  const rootInfo = lstatSync(root), identity = lstatSync(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !identity.isDirectory() || identity.isSymbolicLink()) throw Error('Invalid CLI job directory');
  const assertDirectory = () => {
    const current = lstatSync(directory), parent = lstatSync(root);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
      || parent.dev !== rootInfo.dev || parent.ino !== rootInfo.ino || parent.isSymbolicLink()) throw Error('CLI job directory changed');
    const info = lstatSync(file + '.binding');
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw Error('Invalid CLI job binding');
    const binding = JSON.parse(readFileSync(file + '.binding', 'utf8'));
    if (binding.version !== 1 || binding.nonce !== nonce || binding.mechanism !== 'windows-job-v1'
      || ['generation', 'binding', 'provider', 'id', 'requestHash', 'nonce'].some(key => binding.receipt?.[key] !== receipt[key])) throw Error('CLI job binding changed');
  };
  const readStop = () => {
    assertDirectory();
    let info;
    try { info = lstatSync(file + '.result'); } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw Error('Invalid CLI stop receipt');
    const result = JSON.parse(readFileSync(file + '.result', 'utf8'));
    if (!validNativeStopProof(result, nonce)) throw Error('CLI stop identity or evidence changed');
    return result;
  };
  const cancel = () => {
    assertDirectory(); if (readStop()) return;
    try { writePrivate(file + '.cancel', nonce); }
    catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      const info = lstatSync(file + '.cancel');
      if (!info.isFile() || info.isSymbolicLink() || info.size !== nonce.length || readFileSync(file + '.cancel', 'utf8') !== nonce) throw Error('CLI cancellation identity changed');
    }
  };
  const recoverUnconsumed = (helperPath: string) => {
    cancel();
    if (readStop() || recoveryHelpers.has(file) || recoveryHelpers.size >= 32) return;
    let config;
    try { config = lstatSync(file); } catch (e: any) { if (e?.code === 'ENOENT') return; throw e; }
    if (!config.isFile() || config.isSymbolicLink() || config.size > 1024 * 1024) throw Error('Invalid unconsumed CLI configuration');
    if (process.platform !== 'win32' || !isAbsolute(helperPath)) throw Error('Invalid native recovery helper');
    const helper = lstatSync(helperPath);
    if (!helper.isFile() || helper.isSymbolicLink()) throw Error('Native recovery helper is missing or invalid');
    // This native mode has no provider-process creation path. It can prove a
    // never-started attempt only by exclusively consuming the original config;
    // a racing original helper then fails its own required consume-before-run.
    const child = spawn(helperPath, ['--recover-cancelled', file], { stdio: 'ignore', windowsHide: true, detached: true, timeout: 10_000 });
    recoveryHelpers.set(file, child);
    const release = () => { if (recoveryHelpers.get(file) === child) recoveryHelpers.delete(file); };
    child.once('error', release); child.once('close', release); child.unref();
  };
  assertDirectory();
  return { cancel, readStop, recoverUnconsumed, async waitForStop() {
    const deadline = Date.now() + 16_000;
    while (!readStop()) { if (Date.now() >= deadline) throw Error('CLI job termination remains uncertain'); await new Promise(r => setTimeout(r, 25)); }
  }, discardLaunch() { cancel(); try { unlinkSync(file); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; } } };
}

export function recoverWindowsCliAttempts(store: CliTurnJournal, root: string, binding: string, provider: string, id: string, requestHash: string, stop = false, helperPath?: string): void {
  const saved = store.recovery(binding, provider, id, requestHash, stop);
  if (!saved.contained || !saved.sealed) return;
  for (const attempt of saved.attempts) {
    if (attempt.phase === 'stopped') continue;
    try {
      const control = openCliJobControl(root, saved.receipt, attempt.nonce);
      // Sealed turns cannot restart. Cancellation is also appropriate for an
      // old attachment attempt left running after the final attempt finished.
      control.cancel();
      const proof = control.readStop();
      if (proof) store.recordNativeStop(saved.receipt, attempt.nonce, proof);
      else if (helperPath) control.recoverUnconsumed(helperPath);
    } catch { /* Missing native/storage evidence keeps this exact attempt held. */ }
  }
}
