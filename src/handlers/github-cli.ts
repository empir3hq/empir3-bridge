/**
 * GitHub CLI handler.
 *
 * Same mental model as cli-runner.ts / higgsfield-cli.ts: the user already
 * authenticated `gh` locally; the bridge is a permission gate + execution
 * surface, NOT a GitHub API client. This lets a REMOTE empir3 team agent
 * (Koba / Vincent) act on GitHub as the user through the user's local gh
 * auth, with NO token handoff — exactly parallel to lending Claude Max.
 *
 * Surface: remote / empir3 only (the `github:exec` relay command). It is
 * deliberately NOT exposed as a local MCP tool — local coding agents already
 * run `gh` straight from the shell, so a local wrapper would add nothing.
 *
 * ── This file is the SAFETY BOUNDARY ──────────────────────────────────────
 * Every `gh` invocation is classified into a *scope* (read / pr / issue /
 * repo / release / workflow / admin / api_write). The scope must be enabled
 * in `settings.githubScopes` or the call is refused. A small set of
 * subcommands are HARD-BLOCKED regardless of scopes because they defeat the
 * permission model itself (token exfil, de-auth, arbitrary-code aliases &
 * extensions). Unrecognized commands default-DENY.
 *
 * The consumer (empir3-server choosing to send `github:exec`) is DORMANT
 * until the server-side routing lands (other repo). Shipping this behind
 * `lendGitHubCli` (default OFF) is safe: nothing can invoke it yet.
 *
 * Spawn is argv-only (shell:false), so shell metacharacters inside a gh
 * argument are literal and cannot inject — the classifier only has to reason
 * about which gh subcommand is being run, never about shell quoting.
 */

import { spawn } from 'child_process';
import { resolveExecutable } from '../executable-resolver.js';

const STATUS_TIMEOUT_MS = 10 * 1000;
const EXEC_TIMEOUT_MS = 90 * 1000;
const SIGTERM_GRACE_MS = 5000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 65536;

export type GhScope =
  | 'read' | 'pr' | 'issue' | 'repo' | 'release' | 'workflow' | 'admin' | 'api_write';

export const GH_SCOPES: GhScope[] = [
  'read', 'pr', 'issue', 'repo', 'release', 'workflow', 'admin', 'api_write',
];

// Default scope matrix when the lend is first switched on — the
// "write minus account-destroying" baseline. workflow/admin/api_write are
// off until the user opts in (they spend CI, touch secrets, or do raw
// writes). Mirrored by the settings UI defaults.
export function defaultGhScopes(): Record<GhScope, boolean> {
  return {
    read: true, pr: true, issue: true, repo: true, release: true,
    workflow: false, admin: false, api_write: false,
  };
}

export function normalizeGhScopes(raw: any): Record<GhScope, boolean> {
  const base = defaultGhScopes();
  if (raw && typeof raw === 'object') {
    for (const s of GH_SCOPES) {
      if (typeof raw[s] === 'boolean') base[s] = raw[s];
    }
  }
  return base;
}

// ── Binary discovery ────────────────────────────────────────────
//
// Centralized in executable-resolver.ts — an in-process PATH + well-known-dir
// scan (incl. the GitHub CLI install dir, winget Links/Packages, and a GH_BIN
// override) that doesn't depend on the daemon's inherited PATH. This avoids the
// class of bug where a winget-installed `gh` resolved from the user's shell but
// not from the tray-launched daemon's `where gh`.
function findGhBinary(): string | null {
  return resolveExecutable('gh');
}

// ── Spawn helper ────────────────────────────────────────────────
interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut: boolean;
}

function spawnCapture(bin: string, argv: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise(resolve => {
    const start = Date.now();
    let child;
    try {
      const isWinShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
      if (isWinShim) {
        // Node 18.20+/20.12+ refuse to spawn .cmd directly on Windows
        // (CVE-2024-27980). Wrap via cmd.exe with shell:false so each arg
        // is passed literally.
        child = spawn('cmd.exe', ['/d', '/s', '/c', bin, ...argv], { windowsHide: true });
      } else {
        child = spawn(bin, argv, { windowsHide: true });
      }
    } catch (e: any) {
      resolve({ exitCode: -1, stdout: '', stderr: `spawn failed: ${e?.message || String(e)}`, elapsedMs: Date.now() - start, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, SIGTERM_GRACE_MS);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_BUFFER_BYTES) stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_BUFFER_BYTES) stderr += chunk.toString('utf-8');
    });
    child.on('error', (err: any) => {
      stderr += `\n[spawn error] ${err?.message || String(err)}`;
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({
        exitCode: killed ? -1 : (code ?? -1),
        stdout,
        stderr,
        elapsedMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

function clamp(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `${s.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated, ${s.length} total chars)`;
}

// ── Argv normalization ──────────────────────────────────────────
//
// Accept argv as a string[] (preferred — no ambiguity) or a single command
// string (tokenized quote-aware). A leading "gh" token is stripped so both
// ["gh","pr","list"] and ["pr","list"] work. Because the spawn is argv-only
// (shell:false), quote-tokenization only affects *which* gh subcommand we
// classify; it can never produce shell injection.
function toArgv(input: unknown): { argv: string[] | null; error?: string } {
  let argv: string[];
  if (Array.isArray(input)) {
    argv = input.map(x => String(x));
  } else if (typeof input === 'string') {
    argv = tokenize(input);
  } else {
    return { argv: null, error: 'github:exec requires `args` as a string[] (preferred) or a command string' };
  }
  argv = argv.filter(a => a.length > 0);
  if (argv.length && argv[0].toLowerCase() === 'gh') argv = argv.slice(1);
  if (!argv.length) return { argv: null, error: 'github:exec: empty gh command' };
  return { argv };
}

function tokenize(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

// ── Scope classification — the safety boundary ──────────────────

export interface GhClassification {
  decision: 'allow' | 'block';
  scope?: GhScope;
  reason?: string;
}

// Read verbs that are non-mutating across most command groups.
const READ_VERBS = new Set([
  'list', 'view', 'status', 'diff', 'checks', 'download', 'watch', 'browse', 'get', 'ls',
]);

// Subcommands that defeat the permission model itself — refused regardless
// of any scope. Token exfil + de-auth + identity swap + arbitrary code.
function hardBlock(argv: string[]): string | null {
  const [cmd, verb] = [argv[0], argv[1]];
  if (cmd === 'auth') {
    if (verb === 'status') return null; // read-only, allowed under `read`
    return 'gh auth ' + (verb || '') + ' is blocked: it can print/rotate/revoke the access token or swap the active identity. This is never lent.';
  }
  if (cmd === 'alias') {
    if (verb === 'list') return null;
    return 'gh alias is blocked: aliases can embed shell commands (`!...`) and run arbitrary code.';
  }
  if (cmd === 'extension' || cmd === 'extensions' || cmd === 'ext') {
    if (verb === 'list') return null;
    return 'gh extension is blocked: installing/running an extension executes arbitrary third-party code.';
  }
  return null;
}

function apiIsWrite(argv: string[]): boolean {
  // `gh api` defaults to GET. It becomes a write when an explicit non-GET
  // method is set, or when fields/body are supplied (gh auto-switches to
  // POST). Treat anything that isn't unambiguously a GET as api_write.
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-X' || a === '--method') {
      const m = (argv[i + 1] || '').toUpperCase();
      if (m && m !== 'GET') return true;
    } else if (/^--method=/i.test(a)) {
      if (a.split('=')[1]?.toUpperCase() !== 'GET') return true;
    } else if (/^-X./.test(a)) {
      // Combined short form, e.g. -XPOST
      if (a.slice(2).toUpperCase() !== 'GET') return true;
    } else if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a) || /^--(field|raw-field|input)=/.test(a)) {
      return true; // fields/body present → gh sends POST
    }
  }
  return false;
}

export function classifyGhCommand(argv: string[]): GhClassification {
  const blocked = hardBlock(argv);
  if (blocked) return { decision: 'block', reason: blocked };

  const cmd = argv[0];
  const verb = argv[1] || '';

  // Meta / always-read commands.
  if (['version', '--version', 'help', '--help', 'status', 'search', 'auth'].includes(cmd)) {
    return { decision: 'allow', scope: 'read' };
  }

  const isRead = READ_VERBS.has(verb);

  switch (cmd) {
    case 'pr':
      return { decision: 'allow', scope: isRead ? 'read' : 'pr' };
    case 'issue':
      if (verb === 'delete') return { decision: 'allow', scope: 'admin' };
      return { decision: 'allow', scope: isRead ? 'read' : 'issue' };
    case 'release':
      return { decision: 'allow', scope: isRead ? 'read' : 'release' };
    case 'repo':
      if (verb === 'delete') return { decision: 'allow', scope: 'admin' };
      return { decision: 'allow', scope: isRead ? 'read' : 'repo' };
    case 'run':
      // workflow runs: cancel/rerun/delete spend or mutate CI
      return { decision: 'allow', scope: isRead ? 'read' : 'workflow' };
    case 'workflow':
      return { decision: 'allow', scope: isRead ? 'read' : 'workflow' };
    case 'cache':
      return { decision: 'allow', scope: isRead ? 'read' : 'workflow' };
    case 'label':
    case 'project':
    case 'gist':
      return { decision: 'allow', scope: isRead ? 'read' : 'repo' };
    case 'api':
      return { decision: 'allow', scope: apiIsWrite(argv) ? 'api_write' : 'read' };
    case 'secret':
    case 'variable':
    case 'org':
    case 'ssh-key':
    case 'gpg-key':
    case 'codespace':
    case 'ruleset':
    case 'config':
      // Account/infra surface. Reads still gated behind admin to keep the
      // surface small — these are off by default anyway.
      if (isRead && (cmd === 'config' || cmd === 'ruleset')) return { decision: 'allow', scope: 'read' };
      return { decision: 'allow', scope: 'admin' };
    case 'browse':
      return { decision: 'allow', scope: 'read' };
    default:
      return { decision: 'block', reason: `gh ${cmd} is not a recognized command in the lend allowlist — refused (default-deny).` };
  }
}

// ── Public handlers ─────────────────────────────────────────────

export interface GithubStatusResult {
  installed: boolean;
  version?: string | null;
  authenticated?: boolean;
  account?: string | null;     // active GitHub login, for the empir3 capability report
  accounts?: string[];         // all logged-in logins
}

export async function githubStatus(_params: Record<string, unknown> = {}): Promise<{ success: true; result: GithubStatusResult }> {
  const bin = findGhBinary();
  if (!bin) return { success: true, result: { installed: false, authenticated: false } };

  const ver = await spawnCapture(bin, ['--version'], STATUS_TIMEOUT_MS);
  const vMatch = /gh version (\S+)/i.exec(ver.stdout || '');

  // `gh auth status` exits 0 iff logged in. Parse the login(s); never surface
  // the token (gh self-masks it as gho_*** anyway, but we don't echo that
  // line regardless).
  const auth = await spawnCapture(bin, ['auth', 'status'], STATUS_TIMEOUT_MS);
  const authedText = `${auth.stdout}\n${auth.stderr}`;
  const accounts: string[] = [];
  const re = /Logged in to \S+ account (\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(authedText)) !== null) accounts.push(m[1]);
  // Active account: the login whose block carries "Active account: true".
  let active: string | null = accounts[0] || null;
  const activeBlock = /account (\S+)[^]*?Active account:\s*true/i.exec(authedText);
  if (activeBlock) active = activeBlock[1];

  return {
    success: true,
    result: {
      installed: true,
      version: vMatch?.[1] || null,
      authenticated: auth.exitCode === 0 && accounts.length > 0,
      account: active,
      accounts,
    },
  };
}

export interface GithubExecParams {
  args?: string[] | string;
  scopes?: Record<string, boolean>;
  cwd?: string;
}

/**
 * Run a gh command on behalf of a remote/team agent, gated by the scope
 * matrix. The caller (server dispatch) MUST have already confirmed the
 * master `lendGitHubCli` opt-in; this function enforces the per-scope layer.
 */
export async function githubExec(params: GithubExecParams): Promise<any> {
  const bin = findGhBinary();
  if (!bin) return { success: false, error: 'gh (GitHub CLI) not installed', stage: 'not_installed' };

  const { argv, error } = toArgv(params?.args);
  if (!argv) return { success: false, error, stage: 'bad_args' };

  const scopes = normalizeGhScopes(params?.scopes);
  const klass = classifyGhCommand(argv);
  if (klass.decision === 'block') {
    return { success: false, error: klass.reason || 'gh command refused', stage: 'blocked', command: argv.join(' ') };
  }
  const scope = klass.scope as GhScope;
  if (!scopes[scope]) {
    return {
      success: false,
      stage: 'scope_disabled',
      scope,
      error: `gh ${argv[0]} maps to the "${scope}" scope, which is not enabled for this device. Turn it on in the bridge GitHub CLI settings.`,
      command: argv.join(' '),
    };
  }

  const r = await spawnCapture(bin, argv, EXEC_TIMEOUT_MS);
  if (r.timedOut) {
    return { success: false, stage: 'timeout', scope, error: `gh timed out after ${r.elapsedMs}ms`, command: argv.join(' ') };
  }
  return {
    success: r.exitCode === 0,
    scope,
    command: argv.join(' '),
    exitCode: r.exitCode,
    stdout: clamp(r.stdout),
    stderr: clamp(r.stderr),
    durationMs: r.elapsedMs,
    ...(r.exitCode === 0 ? {} : { stage: 'cli_error', error: (r.stderr.trim() || r.stdout.trim() || `gh exited ${r.exitCode}`).slice(0, 2000) }),
  };
}

/** Lightweight presence/auth probe for the capability announcement + UI row. */
export async function probeGithubCli(deviceOptedIn: boolean, scopes: Record<GhScope, boolean>) {
  const status = await githubStatus();
  const r = status.result;
  return {
    available: !!r.installed,
    path: findGhBinary(),
    version: r.version || null,
    authenticated: !!r.authenticated,
    account: r.account || null,
    accounts: r.accounts || [],
    device_opted_in: deviceOptedIn,
    scopes,
  };
}
