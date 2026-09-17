/**
 * Bridge jobs — heavy work an Empir3 agent hands to the user's OWN computer
 * (compute-placement Tier 1, empir3 epic 2f7057cf).
 *
 * The app server runs each agent shell command inside a small budget; anything
 * that needs longer, more than one core, or a process that outlives the call
 * runs here instead, in the project's local mirror folder, on the user's CPU.
 * This module is the job registry + runner. It has NO transport and NO
 * settings access: server.ts injects the pieces it needs (`JobDeps`) so the
 * whole lifecycle is unit-testable with a fake spawn.
 *
 * Contract (the server side mirrors it in CompanionToolService 'job' tools):
 *   start  { projectId, projectName?, command, shell?, timeoutMs?, waitMs?,
 *            outputs?: string[] }   → the job record once it ended, or a
 *            still-running snapshot after waitMs (poll with status)
 *   status { jobId }                → record snapshot
 *   logs   { jobId, tailBytes? }    → transcript tail
 *   cancel { jobId }                → kills the whole process tree
 *
 * Every job is registered in the owned-process registry, so a Bridge restart
 * or shutdown terminates it; a job can never outlive the Bridge.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, type WriteStream } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type JobStatus = 'running' | 'done' | 'error' | 'timeout' | 'cancelled';

export interface JobLimits {
  maxConcurrent: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  /** Bytes of stdout/stderr kept in memory per stream for the result. */
  tailBytes: number;
  /** Bytes the transcript file may grow to before the job is stopped. */
  transcriptMaxBytes: number;
  outputsMaxFiles: number;
  outputsMaxFileBytes: number;
  outputsMaxTotalBytes: number;
  registryMax: number;
}

export const JOB_LIMITS: JobLimits = {
  maxConcurrent: 2,
  defaultTimeoutMs: 10 * 60_000,
  maxTimeoutMs: 60 * 60_000,
  tailBytes: 64 * 1024,
  transcriptMaxBytes: 64 * 1024 * 1024,
  outputsMaxFiles: 200,
  outputsMaxFileBytes: 10 * 1024 * 1024, // the server's sync:local:file cap
  outputsMaxTotalBytes: 200 * 1024 * 1024,
  registryMax: 50,
};

export interface JobStartParams {
  projectId: string;
  projectName?: string;
  command: string;
  shell?: string;
  timeoutMs?: number;
  /** Relative globs (posix style) of files to push back to the server
   *  workspace when the job ends. */
  outputs?: string[];
}

export interface JobOutputsReceipt {
  requested: string[];
  matched: number;
  pushed: number;
  skipped: number;
  bytes: number;
  files: string[];
  note?: string;
}

export interface JobRecord {
  id: string;
  projectId: string;
  projectName: string;
  cwd: string;
  command: string;
  shell: string;
  status: JobStatus;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  transcriptPath: string;
  stdoutTail: string;
  stderrTail: string;
  bytesOut: number;
  bytesErr: number;
  outputs: JobOutputsReceipt | null;
  placement: 'my-bridge';
}

export interface JobDeps {
  /** Directory for transcripts (created on demand). */
  jobsDir: string;
  /** Project mirror folder for (projectName, projectId). */
  resolveCwd(projectName: string, projectId: string): string;
  /** Interpreter for this platform (server.ts resolveExecShell). */
  resolveShell(requested: string, command: string): { file: string; args: string[]; shell: string };
  /** Owned-process registry hooks (cli-process-tree). */
  register<T>(child: T, label: string): T;
  terminate(child: ChildProcess, opts: { signal: 'SIGTERM' | 'SIGKILL'; reason: string }): Promise<unknown>;
  /** Push one finished output file to the server workspace; resolves true when sent. */
  pushOutputFile?(file: { projectId: string; projectName: string; relPath: string; absPath: string; size: number }): Promise<boolean>;
  spawn?: typeof nodeSpawn;
  now?: () => number;
  log?: (line: string) => void;
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.e3home', '__pycache__', '.cache', '.empir3-trash']);

/** Posix-style glob → RegExp. Supports `**`, `*`, `?`; everything else literal. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` matches the rest.
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(re + '$');
}

/** A relative glob may not escape the project folder. */
export function isSafeOutputGlob(glob: unknown): glob is string {
  if (typeof glob !== 'string') return false;
  const g = glob.trim().replace(/\\/g, '/');
  if (!g || g.startsWith('/') || /^[a-zA-Z]:/.test(g)) return false;
  return !g.split('/').some((seg) => seg === '..');
}

/** Files under `root` matching any glob, bounded by the limits. */
export function collectOutputs(root: string, globs: string[], limits: JobLimits = JOB_LIMITS): { files: Array<{ relPath: string; absPath: string; size: number }>; skipped: number } {
  const matchers = globs.filter(isSafeOutputGlob).map(globToRegExp);
  const files: Array<{ relPath: string; absPath: string; size: number }> = [];
  let skipped = 0;
  let total = 0;
  if (matchers.length === 0 || !existsSync(root)) return { files, skipped };
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (files.length >= limits.outputsMaxFiles) return;
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(name)) walk(abs);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(root, abs).split(sep).join('/');
      if (!matchers.some((m) => m.test(rel))) continue;
      if (st.size > limits.outputsMaxFileBytes || total + st.size > limits.outputsMaxTotalBytes) { skipped += 1; continue; }
      total += st.size;
      files.push({ relPath: rel, absPath: abs, size: st.size });
    }
  };
  walk(root);
  return { files, skipped };
}

export function clampJobTimeout(requested: unknown, limits: JobLimits = JOB_LIMITS): number {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return limits.defaultTimeoutMs;
  return Math.min(limits.maxTimeoutMs, Math.max(1000, Math.floor(n)));
}

function newJobId(now: number): string {
  return `job-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface LiveJob {
  record: JobRecord;
  child: ChildProcess | null;
  transcript: WriteStream | null;
  transcriptBytes: number;
  deadline: ReturnType<typeof setTimeout> | null;
  waiters: Array<() => void>;
  settled: boolean;
}

export class BridgeJobRunner {
  private readonly jobs = new Map<string, LiveJob>();
  private readonly limits: JobLimits;
  private readonly deps: JobDeps;

  constructor(deps: JobDeps, limits: Partial<JobLimits> = {}) {
    this.deps = deps;
    this.limits = { ...JOB_LIMITS, ...limits };
  }

  get running(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.record.status === 'running') n += 1;
    return n;
  }

  list(): JobRecord[] {
    return Array.from(this.jobs.values()).map((j) => snapshot(j.record));
  }

  status(id: string): JobRecord | null {
    const j = this.jobs.get(String(id || ''));
    return j ? snapshot(j.record) : null;
  }

  logs(id: string, tailBytes = this.limits.tailBytes): { jobId: string; status: JobStatus; transcriptPath: string; tail: string } | null {
    const j = this.jobs.get(String(id || ''));
    if (!j) return null;
    let tail = '';
    try {
      const buf = readFileSync(j.record.transcriptPath);
      const cap = Math.max(1024, Math.min(tailBytes, 1024 * 1024));
      tail = buf.subarray(Math.max(0, buf.length - cap)).toString('utf8');
    } catch { tail = j.record.stdoutTail + (j.record.stderrTail ? `\n${j.record.stderrTail}` : ''); }
    return { jobId: j.record.id, status: j.record.status, transcriptPath: j.record.transcriptPath, tail };
  }

  cancel(id: string): { ok: boolean; status?: JobStatus; error?: string } {
    const j = this.jobs.get(String(id || ''));
    if (!j) return { ok: false, error: `Unknown job ${id}` };
    if (j.record.status !== 'running') return { ok: true, status: j.record.status };
    j.record.cancelled = true;
    if (j.child) void this.deps.terminate(j.child, { signal: 'SIGKILL', reason: `job ${j.record.id} cancelled` });
    return { ok: true, status: 'running' };
  }

  /** Starts a job; the returned record is the live snapshot. */
  start(params: JobStartParams): { ok: true; record: JobRecord } | { ok: false; error: string; code: 'bad-request' | 'busy' | 'spawn-failed' } {
    const projectId = String(params?.projectId || '').trim();
    const command = String(params?.command || '').trim();
    if (!projectId) return { ok: false, error: 'projectId is required', code: 'bad-request' };
    if (!command) return { ok: false, error: 'command is required', code: 'bad-request' };
    const badGlob = (params.outputs || []).find((g) => !isSafeOutputGlob(g));
    if (badGlob !== undefined) return { ok: false, error: `outputs glob "${String(badGlob)}" must be a relative path inside the project`, code: 'bad-request' };
    if (this.running >= this.limits.maxConcurrent) {
      return { ok: false, error: `This Bridge is already running ${this.running} job(s); its limit is ${this.limits.maxConcurrent}. Wait for one to finish or cancel it.`, code: 'busy' };
    }
    const now = this.deps.now?.() ?? Date.now();
    const projectName = String(params.projectName || projectId);
    const cwd = this.deps.resolveCwd(projectName, projectId);
    try { mkdirSync(cwd, { recursive: true }); } catch { /* the spawn reports it */ }
    try { mkdirSync(this.deps.jobsDir, { recursive: true }); } catch { /* transcript becomes memory-only */ }
    const id = newJobId(now);
    const timeoutMs = clampJobTimeout(params.timeoutMs, this.limits);
    const { file, args, shell } = this.deps.resolveShell(String(params.shell || ''), command);
    const record: JobRecord = {
      id, projectId, projectName, cwd, command, shell,
      status: 'running', startedAt: now, endedAt: null, durationMs: 0,
      exitCode: null, timedOut: false, cancelled: false, truncated: false,
      transcriptPath: join(this.deps.jobsDir, `${id}.log`),
      stdoutTail: '', stderrTail: '', bytesOut: 0, bytesErr: 0,
      outputs: null, placement: 'my-bridge',
    };
    const live: LiveJob = { record, child: null, transcript: null, transcriptBytes: 0, deadline: null, waiters: [], settled: false };
    this.jobs.set(id, live);
    this.trim();

    try { live.transcript = createWriteStream(record.transcriptPath, { flags: 'a' }); live.transcript.on('error', () => { live.transcript = null; }); }
    catch { live.transcript = null; }
    try {
      live.transcript?.write(`# empir3 job ${id}\n# project ${projectName} (${projectId})\n# cwd ${cwd}\n# shell ${shell}\n# started ${new Date(now).toISOString()}\n# $ ${command}\n\n`);
    } catch { /* transcript is best-effort */ }

    const spawnFn = this.deps.spawn || nodeSpawn;
    let child: ChildProcess;
    try {
      child = this.deps.register(spawnFn(file, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, E3_JOB_ID: id, E3_JOB_PLACEMENT: 'my-bridge' },
      }), `job:${id}`);
    } catch (e: any) {
      record.status = 'error';
      record.stderrTail = `spawn failed: ${e?.message || String(e)}`;
      this.settle(live, null);
      return { ok: false, error: record.stderrTail, code: 'spawn-failed' };
    }
    live.child = child;
    const onChunk = (stream: 'out' | 'err', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (stream === 'out') { record.bytesOut += chunk.length; record.stdoutTail = keepTail(record.stdoutTail + text, this.limits.tailBytes); }
      else { record.bytesErr += chunk.length; record.stderrTail = keepTail(record.stderrTail + text, this.limits.tailBytes); }
      if (live.transcript) {
        live.transcriptBytes += chunk.length;
        if (live.transcriptBytes > this.limits.transcriptMaxBytes) {
          if (!record.truncated) {
            record.truncated = true;
            try { live.transcript.write('\n# transcript cap reached — job stopped\n'); } catch { /* best-effort */ }
            void this.deps.terminate(child, { signal: 'SIGKILL', reason: `job ${id} transcript cap` });
          }
          return;
        }
        try { live.transcript.write(chunk); } catch { /* best-effort */ }
      }
    };
    child.stdout?.on('data', (c: Buffer) => onChunk('out', c));
    child.stderr?.on('data', (c: Buffer) => onChunk('err', c));
    child.once('error', (e: Error) => {
      record.stderrTail = keepTail(`${record.stderrTail}\n[job error] ${e.message}`, this.limits.tailBytes);
      record.status = 'error';
      this.settle(live, null);
    });
    child.once('close', (code: number | null) => { this.settle(live, code); });
    live.deadline = setTimeout(() => {
      if (live.settled) return;
      record.timedOut = true;
      void this.deps.terminate(child, { signal: 'SIGKILL', reason: `job ${id} timeout after ${timeoutMs} ms` });
    }, timeoutMs);
    this.deps.log?.(`[Jobs] started ${id} in ${cwd} (${shell}, ${timeoutMs} ms): ${command.slice(0, 120)}`);
    // Outputs are attached to the live record so settle() can push them.
    (live as any).outputs = (params.outputs || []).filter(isSafeOutputGlob);
    return { ok: true, record: snapshot(record) };
  }

  /** Resolves with the record when the job ends, or with the running snapshot after waitMs. */
  wait(id: string, waitMs: number): Promise<JobRecord | null> {
    const j = this.jobs.get(String(id || ''));
    if (!j) return Promise.resolve(null);
    if (j.record.status !== 'running' && j.settled) return Promise.resolve(snapshot(j.record));
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(snapshot(j.record)); };
      const timer = setTimeout(finish, Math.max(0, waitMs));
      j.waiters.push(finish);
    });
  }

  private settle(live: LiveJob, code: number | null): void {
    if (live.settled) return;
    const record = live.record;
    if (live.deadline) { clearTimeout(live.deadline); live.deadline = null; }
    record.endedAt = this.deps.now?.() ?? Date.now();
    record.durationMs = Math.max(0, record.endedAt - record.startedAt);
    record.exitCode = record.timedOut || record.cancelled ? null : code;
    if (record.status === 'running') {
      record.status = record.cancelled ? 'cancelled' : record.timedOut ? 'timeout' : (code === 0 ? 'done' : 'error');
    }
    try { live.transcript?.write(`\n# ended ${new Date(record.endedAt).toISOString()} status=${record.status} exit=${record.exitCode}\n`); } catch { /* best-effort */ }
    try { live.transcript?.end(); } catch { /* best-effort */ }
    live.transcript = null;
    this.deps.log?.(`[Jobs] ${record.id} ${record.status} exit=${record.exitCode} ${record.durationMs} ms out=${record.bytesOut}B err=${record.bytesErr}B`);
    const outputs: string[] = (live as any).outputs || [];
    const release = () => {
      live.settled = true;
      const waiters = live.waiters.splice(0);
      for (const w of waiters) { try { w(); } catch { /* waiter errors are theirs */ } }
    };
    if (outputs.length === 0 || !this.deps.pushOutputFile) { release(); return; }
    void this.pushOutputs(record, outputs).finally(release);
  }

  private async pushOutputs(record: JobRecord, globs: string[]): Promise<void> {
    const { files, skipped } = collectOutputs(record.cwd, globs, this.limits);
    const receipt: JobOutputsReceipt = { requested: globs, matched: files.length, pushed: 0, skipped, bytes: 0, files: [] };
    for (const f of files) {
      try {
        const sent = await this.deps.pushOutputFile!({ projectId: record.projectId, projectName: record.projectName, relPath: f.relPath, absPath: f.absPath, size: f.size });
        if (sent) { receipt.pushed += 1; receipt.bytes += f.size; receipt.files.push(f.relPath); }
        else receipt.skipped += 1;
      } catch { receipt.skipped += 1; }
    }
    if (receipt.skipped > 0) receipt.note = `${receipt.skipped} file(s) not pushed (over the ${Math.round(this.limits.outputsMaxFileBytes / 1024 / 1024)} MB per-file / ${Math.round(this.limits.outputsMaxTotalBytes / 1024 / 1024)} MB total cap, or the Bridge was offline)`;
    record.outputs = receipt;
  }

  private trim(): void {
    if (this.jobs.size <= this.limits.registryMax) return;
    const finished = Array.from(this.jobs.values()).filter((j) => j.record.status !== 'running').sort((a, b) => a.record.startedAt - b.record.startedAt);
    for (const j of finished.slice(0, this.jobs.size - this.limits.registryMax)) this.jobs.delete(j.record.id);
  }
}

function keepTail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

function snapshot(record: JobRecord): JobRecord {
  return { ...record, outputs: record.outputs ? { ...record.outputs, files: [...record.outputs.files] } : null };
}
