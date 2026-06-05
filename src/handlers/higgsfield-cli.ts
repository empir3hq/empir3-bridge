/**
 * Higgsfield CLI handler.
 *
 * Same mental model as cli-runner.ts: the user already pays / authenticates
 * with Higgsfield; we shell out to their local `higgsfield` binary instead
 * of being a Higgsfield API client. The bridge is a permission gate + tool
 * surface, not an upstream integration.
 *
 * Spec lives at docs/handoff_bridge_higgsfield_cli.md. Verified facts encoded
 * inline so a future maintainer doesn't re-probe the CLI.
 *
 * Pre-decided defaults (from the handoff doc — see header comment per item):
 *   #1  Result URL extraction — generic path-priority parser, no per-model
 *       upfront probing. Logs the full parsed JSON every call so shape
 *       surprises become a polish item.
 *   #2  Per-model param naming — handler is pass-through via `extra: {...}`.
 *       MCP-calling agent owns CLI flag naming, no translation here.
 *   #3  Concurrency — single-job FIFO queue at the handler level. Avoids
 *       CLI credential lock contention without per-model awareness.
 *   #4  Cost cap — none for v1. Per-tool permission (defaults OFF for
 *       _generate) + global execute gate carry the safety load.
 *   #5  Token re-auth — regex-scan stderr for known auth-error patterns,
 *       surface as { stage: 'auth_expired', recoverable: true } so agents
 *       can prompt the user. No probe-by-invalidation.
 *   #6  Tray menu wording — see tray.py change; matches existing voice.
 *   #7  bridge-settings.json schema — generic `handlers: { [name]: { enabled } }`
 *       so future handlers (Replicate, Runway, Suno) drop in without
 *       migration. Gate logic mirrored in server.ts dispatcher.
 *   #8  Output contract — return BOTH parsed result and fetched bytes.
 *       Handler does spawn -> parse JSON -> extract URL -> HTTP GET ->
 *       save to ~/.empir3-bridge/artifacts/higgsfield/<stamp>-<uuid>.<ext>.
 *   #9  _list subcommand shape — probed once via `higgsfield generate --help`
 *       on first run; result cached in-process.
 *   #10 waitTimeoutMs ceiling — hard cap 20 min. Bridge ceiling, not CLI.
 */

import { spawn } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync } from 'fs';
import { join, extname } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const STATUS_TIMEOUT_MS = 10 * 1000;
const LIST_TIMEOUT_MS = 30 * 1000;
const HELP_TIMEOUT_MS = 5 * 1000;
const GENERATE_TIMEOUT_MS = 25 * 60 * 1000; // matches --wait-timeout 20m + grace
const SIGTERM_GRACE_MS = 5000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const ARTIFACT_FETCH_TIMEOUT_MS = 60 * 1000;
const MAX_PROMPT_LOG_CHARS = 80;

const ARTIFACT_DIR = join(homedir(), '.empir3-bridge', 'artifacts', 'higgsfield');

// Patterns scanned in stderr to translate raw CLI errors into structured
// recoverable stages. See default #5.
const AUTH_ERROR_PATTERNS: RegExp[] = [
  /not authenticated/i,
  /auth(?:enticate)?.{0,30}expired/i,
  /token.{0,20}expired/i,
  /token.{0,20}invalid/i,
  /please run.*auth.*(?:login|signin|sign in)/i,
  /unauthorized/i,
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /too many requests/i,
];

const QUOTA_PATTERNS: RegExp[] = [
  /quota/i,
  /insufficient (?:credits|balance|funds)/i,
];

// ── Binary discovery ────────────────────────────────────────────
//
// Verified install paths: `higgsfield` on PATH (POSIX + Windows when
// %APPDATA%\npm is on PATH), or %APPDATA%\npm\higgsfield.cmd (the npm-global
// shim) on Windows. Don't hunt anywhere else — if neither resolves, return
// null and let _status report installed:false cleanly.
function findHiggsfieldBinary(): string | null {
  const onPath = whichSync('higgsfield');
  if (onPath) return onPath;
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || '';
    if (appdata) {
      const cmdShim = join(appdata, 'npm', 'higgsfield.cmd');
      if (existsSync(cmdShim)) return cmdShim;
    }
  }
  return null;
}

function whichSync(name: string): string | null {
  try {
    const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    const { execSync } = require('child_process') as typeof import('child_process');
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });
    const lines = out.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
    if (!lines.length) return null;
    if (process.platform === 'win32') {
      const cmdShim = lines.find((l: string) => l.toLowerCase().endsWith('.cmd'));
      if (cmdShim) return cmdShim;
    }
    return lines[0];
  } catch {
    return null;
  }
}

// ── Spawn helper ────────────────────────────────────────────────
//
// argv-only (no shell). Mirrors cli-runner.ts: SIGTERM, then SIGKILL after
// SIGTERM_GRACE_MS. Captures stdout/stderr as utf-8 strings with a hard
// MAX_BUFFER_BYTES ceiling so a runaway CLI doesn't OOM the bridge.
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
        // (CVE-2024-27980). Spawn cmd.exe with the shim as an arg instead.
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

// ── Error classification ────────────────────────────────────────

function parseHiggsfieldError(r: SpawnResult): { error: string; stage: string; recoverable: boolean } {
  const text = `${r.stderr}\n${r.stdout}`;
  if (r.timedOut) return { error: `higgsfield timed out after ${r.elapsedMs}ms`, stage: 'timeout', recoverable: true };
  for (const p of AUTH_ERROR_PATTERNS) {
    if (p.test(text)) return { error: 'higgsfield CLI is not authenticated — run `higgsfield auth login`', stage: 'auth_expired', recoverable: true };
  }
  for (const p of RATE_LIMIT_PATTERNS) {
    if (p.test(text)) return { error: 'higgsfield CLI rate-limited', stage: 'rate_limit', recoverable: true };
  }
  for (const p of QUOTA_PATTERNS) {
    if (p.test(text)) return { error: 'higgsfield CLI quota exhausted', stage: 'quota', recoverable: false };
  }
  const trimmed = (r.stderr.trim() || r.stdout.trim() || `higgsfield exited ${r.exitCode}`).slice(0, 2000);
  return { error: trimmed, stage: 'cli_error', recoverable: false };
}

function lastNonEmptyLine(s: string): string {
  const lines = s.split(/\r?\n/).filter(l => l.trim().length > 0);
  return lines.length ? lines[lines.length - 1] : '';
}

function safeJsonParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    // CLIs sometimes emit a progress line before the final JSON; fall back
    // to parsing only the last non-empty line.
    try { return JSON.parse(lastNonEmptyLine(s)); } catch { return null; }
  }
}

// Default #1 — generic URL extractor, returns first matching path.
// The Higgsfield CLI as of v0.1.40 actually returns an array of job
// objects with a top-level `result_url` field (not the nested shapes
// the original priority list assumed). Try the real-world shapes
// first, keep the speculative ones as fallbacks.
function extractArtifactUrl(parsed: any): string | null {
  if (!parsed) return null;
  // Array-of-jobs shape (verified against `higgsfield generate create
  // z_image --json` on 2026-05-28).
  const firstJob = Array.isArray(parsed) ? parsed[0] : null;
  const candidates: any[] = [
    firstJob?.result_url,
    firstJob?.results?.[0]?.url,
    firstJob?.results?.raw?.url,
    parsed?.result_url,
    parsed?.result?.url,
    parsed?.result?.video?.url,
    parsed?.result?.image?.url,
    parsed?.results?.[0]?.url,
    parsed?.results?.[0]?.result_url,
    parsed?.jobs?.[0]?.result_url,
    parsed?.jobs?.[0]?.results?.raw?.url,
    parsed?.url,
    parsed?.video?.url,
    parsed?.image?.url,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c)) return c;
  }
  return null;
}

function extFromUrl(url: string, contentType: string | null): string {
  if (contentType) {
    const ct = contentType.split(';')[0].trim().toLowerCase();
    if (ct === 'video/mp4') return '.mp4';
    if (ct === 'video/webm') return '.webm';
    if (ct === 'image/jpeg') return '.jpg';
    if (ct === 'image/png') return '.png';
    if (ct === 'image/webp') return '.webp';
    if (ct === 'image/gif') return '.gif';
  }
  try {
    const u = new URL(url);
    const ext = extname(u.pathname);
    if (ext && ext.length <= 6) return ext;
  } catch {}
  return '.bin';
}

async function fetchToArtifact(url: string): Promise<{ path: string; bytes: number } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ARTIFACT_FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = extFromUrl(url, res.headers.get('content-type'));
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(ARTIFACT_DIR, `${stamp}-${randomUUID()}${ext}`);
    writeFileSync(path, buf);
    return { path, bytes: buf.length };
  } catch {
    return null;
  }
}

// Default #3 — single-job FIFO queue.
let generateQueue: Promise<any> = Promise.resolve();
function enqueueGenerate<T>(fn: () => Promise<T>): Promise<T> {
  const next = generateQueue.then(fn, fn);
  generateQueue = next.then(() => undefined, () => undefined);
  return next;
}

// Default #9 — probe `generate --help` once, cache for the process lifetime.
let listProbeCache: { subcommand: string[] | null; probedAt: number } | null = null;

async function resolveListInvocation(bin: string): Promise<string[] | null> {
  if (listProbeCache) return listProbeCache.subcommand;
  const help = await spawnCapture(bin, ['generate', '--help'], HELP_TIMEOUT_MS);
  let subcommand: string[] | null = null;
  if (help.exitCode === 0) {
    const text = `${help.stdout}\n${help.stderr}`.toLowerCase();
    if (/\blist\b/.test(text)) subcommand = ['generate', 'list'];
  }
  listProbeCache = { subcommand, probedAt: Date.now() };
  return subcommand;
}

// ── Public handlers ─────────────────────────────────────────────

export interface HiggsfieldStatusResult {
  installed: boolean;
  version?: string | null;
  authenticated?: boolean;
  credentialsPath?: string;
}

export async function higgsfieldStatus(_params: Record<string, unknown> = {}): Promise<{ success: true; result: HiggsfieldStatusResult }> {
  const bin = findHiggsfieldBinary();
  if (!bin) {
    return { success: true, result: { installed: false, authenticated: false } };
  }
  const version = await spawnCapture(bin, ['--version'], STATUS_TIMEOUT_MS);
  const m = /^higgsfield\s+(\S+)/i.exec((version.stdout || '').trim());
  const tok = await spawnCapture(bin, ['auth', 'token'], STATUS_TIMEOUT_MS);
  // Auth iff exit 0 AND stdout matches /^hf_\S+\s*$/. Never log or surface
  // the token value itself.
  const authed = tok.exitCode === 0 && /^hf_\S+\s*$/.test(tok.stdout.trim());
  return {
    success: true,
    result: {
      installed: true,
      version: m?.[1] || null,
      authenticated: authed,
      // Surfaced for user reference only — handler never opens it.
      credentialsPath: join(homedir(), '.config', 'higgsfield', 'credentials.json'),
    },
  };
}

export interface HiggsfieldGenerateParams {
  model: string;
  prompt: string;
  image?: string | Buffer | { data?: string; path?: string };
  extra?: Record<string, string | number | boolean>;
  waitTimeoutMs?: number;
}

export async function higgsfieldGenerate(params: HiggsfieldGenerateParams): Promise<any> {
  if (!params || typeof params.model !== 'string' || !params.model.trim()) {
    return { success: false, error: 'higgsfield_generate: `model` is required' };
  }
  if (typeof params.prompt !== 'string' || !params.prompt.trim()) {
    return { success: false, error: 'higgsfield_generate: `prompt` is required' };
  }
  const bin = findHiggsfieldBinary();
  if (!bin) return { success: false, error: 'higgsfield CLI not installed' };

  // Default #10 — hard-cap 20 min on the wait window.
  const timeoutMin = Math.min(
    Math.max(Math.floor((params.waitTimeoutMs || 20 * 60_000) / 60_000), 1),
    20,
  );

  return enqueueGenerate(async () => {
    mkdirSync(ARTIFACT_DIR, { recursive: true });

    let imagePath: string | null = null;
    let tempImageToCleanup: string | null = null;
    try {
      if (params.image !== undefined && params.image !== null) {
        const resolved = resolveImageInput(params.image);
        if (resolved.tempPath) tempImageToCleanup = resolved.tempPath;
        imagePath = resolved.path;
      }

      const extraArgs: string[] = [];
      if (params.extra && typeof params.extra === 'object') {
        for (const [k, v] of Object.entries(params.extra)) {
          if (!/^[a-z0-9][a-z0-9_-]*$/i.test(k)) continue; // ignore obviously-bogus keys
          extraArgs.push(`--${k}`, String(v));
        }
      }

      const argv = [
        'generate', 'create', params.model,
        '--prompt', params.prompt,
        ...(imagePath ? ['--image', imagePath] : []),
        '--wait',
        '--wait-timeout', `${timeoutMin}m`,
        '--wait-interval', '5s',
        '--json',
        ...extraArgs,
      ];

      const r = await spawnCapture(bin, argv, GENERATE_TIMEOUT_MS);
      if (r.exitCode !== 0) {
        const parsed = parseHiggsfieldError(r);
        return {
          success: false,
          error: parsed.error,
          stage: parsed.stage,
          recoverable: parsed.recoverable,
          durationMs: r.elapsedMs,
        };
      }

      const parsed = safeJsonParse(r.stdout);
      const url = extractArtifactUrl(parsed);
      let artifactPath: string | null = null;
      let artifactBytes: number | null = null;
      if (url) {
        const saved = await fetchToArtifact(url);
        if (saved) {
          artifactPath = saved.path;
          artifactBytes = saved.bytes;
        }
      }

      // Default #1 — log full parsed JSON shape so the user can see new
      // result shapes and ask for a priority bump later. Truncate the
      // prompt in input echoes to MAX_PROMPT_LOG_CHARS (acceptance #5).
      const promptEcho = params.prompt.length > MAX_PROMPT_LOG_CHARS
        ? params.prompt.slice(0, MAX_PROMPT_LOG_CHARS) + '…'
        : params.prompt;
      try {
        console.error('[higgsfield] generate ok', JSON.stringify({
          model: params.model,
          promptPreview: promptEcho,
          durationMs: r.elapsedMs,
          urlFound: !!url,
          resultKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : null,
        }));
      } catch {}

      return {
        success: true,
        result: {
          raw: parsed,
          url,
          artifactPath,
          artifactBytes,
          durationMs: r.elapsedMs,
        },
      };
    } finally {
      if (tempImageToCleanup) {
        try { unlinkSync(tempImageToCleanup); } catch {}
      }
    }
  });
}

// ── empir3-channel lending bridge ───────────────────────────────
//
// The Empir3 server lends the user's local higgsfield CLI for image/video
// gen over the empir3 WebSocket (HiggsfieldClient.runCli on the server side).
// Wire contract (server ⇄ bridge), mirrors claude:cli / codex:cli:
//
//   server → bridge:  higgsfield:cli:gen  {id, kind, prompt, model, params, input_image?, timeout_sec}
//   bridge → server:  higgsfield:cli:progress {id, status}        (optional)
//                     higgsfield:cli:done     {id, exit_code, mime_type, bytes_base64, duration_sec}
//                     higgsfield:cli:error    {id, stage, error}
//   server → bridge:  higgsfield:cli:abort {id}                   (cancel — no mid-flight hook, acked)
//
// This is the ONLY thing that was missing for CLI-mode videogen: the local
// executeCommand path (higgsfield_generate) was wired, but the empir3 channel
// never routed higgsfield:cli:* — so server requests dead-ended and timed out
// as "upstream returned no video". generate_image worked only because its
// route resolves to a direct API provider (Imagen), never touching the bridge.
//
// Param fidelity: server sends model-native snake_case params (video:
// { aspect_ratio, duration }). We forward them verbatim as --flag value (no
// translation — per default #2 the caller owns flag naming). Note veo3_1
// constrains duration to 4/6/8; the caller must send a valid value.
function mimeForArtifact(path: string, kind?: string): string {
  switch (extname(path).toLowerCase()) {
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return kind === 'video' ? 'video/mp4' : 'image/png';
  }
}

// Per-model param schema cache (`higgsfield model get <model> --json` →
// params[]). Separate from modelsCache (that one is `model list`, no params).
const MODEL_PARAMS_TTL_MS = 5 * 60 * 1000;
const modelParamsCache = new Map<string, { at: number; params: any[] | null }>();

async function getModelParams(model: string): Promise<any[] | null> {
  const cached = modelParamsCache.get(model);
  if (cached && (Date.now() - cached.at) < MODEL_PARAMS_TTL_MS) return cached.params;
  const bin = findHiggsfieldBinary();
  if (!bin) return null;
  try {
    const r = await spawnCapture(bin, ['model', 'get', model, '--json'], LIST_TIMEOUT_MS);
    const parsed = r.exitCode === 0 ? safeJsonParse(r.stdout) : null;
    const params = parsed && Array.isArray(parsed.params) ? parsed.params : null;
    modelParamsCache.set(model, { at: Date.now(), params });
    return params;
  } catch {
    modelParamsCache.set(model, { at: Date.now(), params: null });
    return null;
  }
}

// Snap caller params to what the model actually accepts, using the live schema.
// The server clamps videogen duration to 1-15 and sends it raw, but each model
// constrains it differently (veo3_1 duration ∈ {4,6,8}, aspect_ratio ∈
// {16:9,9:16}; kling3_0 duration is a free integer). Without this, a 5s veo3_1
// request — or a 1:1 aspect — CLI-errors. Rules: drop params the model doesn't
// list (unknown --flags error the CLI); snap enum values (nearest for numeric
// enums, model default otherwise); round integer params. Best-effort — if the
// schema can't be read we pass params through so generation is never blocked.
async function normalizeParamsForModel(
  model: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const specs = await getModelParams(model);
  if (!specs) return { ...params };
  const byName = new Map<string, any>();
  for (const s of specs) if (s && typeof s.name === 'string') byName.set(s.name, s);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    const spec = byName.get(key);
    if (!spec) {
      console.error(`[higgsfield] drop unsupported param --${key} for ${model}`);
      continue;
    }
    let v: unknown = value;
    const enumVals: any[] | null = Array.isArray(spec.enum) && spec.enum.length ? spec.enum : null;
    if (enumVals && !enumVals.map(String).includes(String(v))) {
      const numericEnum = enumVals.every((e) => Number.isFinite(Number(e)));
      const want = Number(v);
      if (numericEnum && Number.isFinite(want)) {
        // Snap to nearest; on a tie prefer the larger value (e.g. 5s → 6s).
        let best = enumVals[0];
        let bestD = Infinity;
        for (const e of enumVals) {
          const d = Math.abs(Number(e) - want);
          if (d < bestD || (d === bestD && Number(e) > Number(best))) { best = e; bestD = d; }
        }
        v = best;
      } else {
        v = spec.default != null ? spec.default : enumVals[0];
      }
      console.error(`[higgsfield] snap --${key} ${String(value)} → ${String(v)} for ${model}`);
    } else if (!enumVals && spec.type === 'integer') {
      const n = Number(v);
      if (Number.isFinite(n) && !Number.isInteger(n)) v = Math.round(n);
    }
    out[key] = v;
  }
  return out;
}

export async function handleHiggsfieldCliCommand(
  action: string,
  payload: any,
  send: (eventType: string, eventPayload: any) => void,
): Promise<void> {
  const id = payload?.id || '';

  // No mid-flight cancel hook (single-shot CLI --wait). Ack silently so the
  // server's abort path is satisfied; the watchdog will reconcile.
  if (action === 'abort') return;

  if (action !== 'gen') {
    send('higgsfield:cli:error', { id, stage: 'unknown_action', error: `higgsfield:cli:${action} is not supported` });
    return;
  }

  const kind = typeof payload?.kind === 'string' ? payload.kind : undefined;
  const model = typeof payload?.model === 'string' ? payload.model.trim() : '';
  const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
  if (!model) { send('higgsfield:cli:error', { id, stage: 'bad_request', error: 'higgsfield:cli:gen missing model' }); return; }
  if (!prompt) { send('higgsfield:cli:error', { id, stage: 'bad_request', error: 'higgsfield:cli:gen missing prompt' }); return; }

  // Server params (model-native names) → CLI --flag value. Snap to the model's
  // live schema first (duration enum, aspect_ratio enum, integer rounding,
  // drop-unknowns), then keep only scalars.
  const rawParams = payload?.params && typeof payload.params === 'object' ? payload.params : {};
  const params = await normalizeParamsForModel(model, rawParams);
  const extra: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') extra[k] = v;
  }

  // Optional input image for image-to-video / img2img — base64 { mime_type, data }.
  let image: HiggsfieldGenerateParams['image'] | undefined;
  if (payload?.input_image && typeof payload.input_image === 'object' && typeof payload.input_image.data === 'string') {
    image = { data: payload.input_image.data };
  }

  const timeoutSec = Number(payload?.timeout_sec);
  const waitTimeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : undefined;

  send('higgsfield:cli:progress', { id, status: 'spawning' });

  let out: any;
  try {
    out = await higgsfieldGenerate({ model, prompt, image, extra, waitTimeoutMs });
  } catch (e: any) {
    send('higgsfield:cli:error', { id, stage: 'spawn', error: e?.message || String(e) });
    return;
  }

  if (!out || out.success !== true) {
    send('higgsfield:cli:error', {
      id,
      stage: out?.stage || 'generate_failed',
      error: out?.error || 'higgsfield generate failed',
    });
    return;
  }

  const artifactPath: string | undefined = out.result?.artifactPath;
  if (!artifactPath || !existsSync(artifactPath)) {
    // CLI reported success but bytes weren't fetched — most often a result-URL
    // shape we didn't recognize. Surface the URL so the server can fall back.
    send('higgsfield:cli:error', {
      id,
      stage: 'no_artifact',
      error: out.result?.url
        ? `higgsfield generated but artifact fetch failed (url=${out.result.url})`
        : 'higgsfield produced no downloadable artifact',
    });
    return;
  }

  let bytesBase64: string;
  try {
    bytesBase64 = readFileSync(artifactPath).toString('base64');
  } catch (e: any) {
    send('higgsfield:cli:error', { id, stage: 'read_artifact', error: e?.message || 'failed to read artifact' });
    return;
  }

  send('higgsfield:cli:done', {
    id,
    exit_code: 0,
    mime_type: mimeForArtifact(artifactPath, kind),
    bytes_base64: bytesBase64,
    duration_sec: Number(extra.duration) || undefined,
    duration_ms: out.result?.durationMs,
  });
}

export interface HiggsfieldListParams {
  limit?: number;
}

export async function higgsfieldList(params: HiggsfieldListParams = {}): Promise<any> {
  const bin = findHiggsfieldBinary();
  if (!bin) return { success: false, error: 'higgsfield CLI not installed' };

  const subcommand = await resolveListInvocation(bin);
  if (!subcommand) {
    return {
      success: false,
      error: 'higgsfield generate --help did not advertise a `list` subcommand on this CLI version',
      stage: 'unsupported',
      recoverable: false,
    };
  }

  // The higgsfield CLI (v0.1.40) `generate list` does NOT accept a `--limit`
  // flag — passing it errors with `unknown flag: --limit`. So we never forward
  // it; instead we fetch the full list and trim client-side after parsing.
  const argv = [...subcommand, '--json'];

  const r = await spawnCapture(bin, argv, LIST_TIMEOUT_MS);
  if (r.exitCode !== 0) {
    const parsed = parseHiggsfieldError(r);
    return { success: false, error: parsed.error, stage: parsed.stage, recoverable: parsed.recoverable };
  }
  let parsed = safeJsonParse(r.stdout);
  const limit = (typeof params?.limit === 'number' && Number.isFinite(params.limit) && params.limit > 0)
    ? Math.floor(params.limit)
    : null;
  if (limit !== null && Array.isArray(parsed)) {
    parsed = parsed.slice(0, limit);
  }
  return { success: true, result: { raw: parsed ?? r.stdout.trim(), durationMs: r.elapsedMs } };
}

export interface HiggsfieldModelsParams {
  type?: string; // 'image' | 'video' | 'text' (optional filter)
}

// Live model discovery so a controlling LLM never has to guess a job_set_type.
// `higgsfield model list --json` is the source of truth (the catalog changes as
// Higgsfield adds models), filtered optionally by media type. Cached per-process
// (~5 min) — the list is stable within a session and the CLI call is ~1s.
const modelsCache = new Map<string, { at: number; data: any[] }>();
const MODELS_TTL_MS = 5 * 60 * 1000;

export async function higgsfieldModels(params: HiggsfieldModelsParams = {}): Promise<any> {
  const bin = findHiggsfieldBinary();
  if (!bin) return { success: false, error: 'higgsfield CLI not installed' };
  const typeRaw = typeof params?.type === 'string' ? params.type.toLowerCase().trim() : '';
  const type = ['image', 'video', 'text'].includes(typeRaw) ? typeRaw : '';
  const cacheKey = type || 'all';
  const cached = modelsCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < MODELS_TTL_MS) {
    return { success: true, result: { models: cached.data, type: type || 'all', count: cached.data.length, cached: true } };
  }
  const argv = ['model', 'list', '--json'];
  if (type) argv.splice(2, 0, `--${type}`); // -> model list --image --json
  const r = await spawnCapture(bin, argv, LIST_TIMEOUT_MS);
  if (r.exitCode !== 0) {
    const parsed = parseHiggsfieldError(r);
    return { success: false, error: parsed.error, stage: parsed.stage, recoverable: parsed.recoverable };
  }
  const parsed = safeJsonParse(r.stdout);
  const models = Array.isArray(parsed)
    ? parsed
        .map((m: any) => ({ job_set_type: m.job_set_type, name: m.display_name, type: m.type }))
        .filter((m: any) => m.job_set_type)
    : [];
  modelsCache.set(cacheKey, { at: Date.now(), data: models });
  return { success: true, result: { models, type: type || 'all', count: models.length } };
}

// ── Helpers ─────────────────────────────────────────────────────

function resolveImageInput(input: HiggsfieldGenerateParams['image']): { path: string | null; tempPath: string | null } {
  if (input == null) return { path: null, tempPath: null };
  if (Buffer.isBuffer(input)) return writeTempImage(input);

  if (typeof input === 'string') {
    // Heuristic: if it's a real path on disk, use it directly. Otherwise treat
    // it as base64 image bytes (common JSON-transport encoding from agents).
    if (existsSync(input)) return { path: input, tempPath: null };
    try {
      const buf = Buffer.from(stripDataUri(input), 'base64');
      if (buf.length > 0) return writeTempImage(buf);
    } catch {}
    return { path: null, tempPath: null };
  }

  if (typeof input === 'object') {
    if (typeof input.path === 'string' && input.path && existsSync(input.path)) {
      return { path: input.path, tempPath: null };
    }
    if (typeof input.data === 'string' && input.data) {
      try {
        const buf = Buffer.from(stripDataUri(input.data), 'base64');
        if (buf.length > 0) return writeTempImage(buf);
      } catch {}
    }
  }
  return { path: null, tempPath: null };
}

function stripDataUri(s: string): string {
  const m = /^data:[^;]+;base64,(.*)$/i.exec(s.trim());
  return m ? m[1] : s.trim();
}

function writeTempImage(buf: Buffer): { path: string; tempPath: string } {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  // Default extension is .bin; auto-upload doesn't care. Pick by magic for
  // common formats so the CLI's content-type inference (if any) is happy.
  const ext = sniffExt(buf);
  const path = join(ARTIFACT_DIR, `upload-${randomUUID()}${ext}`);
  writeFileSync(path, buf);
  return { path, tempPath: path };
}

function sniffExt(buf: Buffer): string {
  if (buf.length >= 4) {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return '.webp';
  }
  return '.bin';
}
