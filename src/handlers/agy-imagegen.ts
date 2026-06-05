/**
 * Antigravity (`agy`) image generation over the empir3 channel.
 *
 * Unlike Higgsfield's purpose-built media CLI (`higgsfield generate create …`
 * → deterministic bytes), agy is an agentic coding CLI whose Nano Banana Pro 2
 * model generates images during a `--print` turn and WRITES them to a file.
 * So the contract is FILE-BASED, not stdout-based: agy 1.0.3's print mode does
 * not flush stdout in a non-TTY (verified), but it DOES write the requested
 * output file and exit 0. We spawn agy with a prompt telling it to save the
 * image into an empty temp working dir, poll that dir for an image file to
 * appear and stabilize, then read the bytes back.
 *
 * Wire contract (mirrors higgsfield:cli:gen):
 *   server → bridge:  agy:cli:gen        {id, prompt, timeout_sec}
 *   bridge → server:  agy:cli:gen:progress {id, status}                 (optional)
 *                     agy:cli:gen:done     {id, exit_code, mime_type, bytes_base64, duration_ms}
 *                     agy:cli:gen:error    {id, stage, error}
 *
 * No `--dangerously-skip-permissions`: a live test confirmed plain `-p` mode
 * runs agy's built-in imagegen and writes the file without a permission prompt
 * (least-privilege; we never want a lent CLI auto-approving arbitrary tools).
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const ARTIFACT_DIR = join(homedir(), '.empir3-bridge', 'artifacts', 'agy');
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const HARD_CAP_MS = 20 * 60 * 1000;
const MIN_TIMEOUT_MS = 30 * 1000;
const POLL_INTERVAL_MS = 1000;
const STABLE_CHECKS = 2; // file size unchanged across N polls ⇒ finished writing

// Same resolution as AGY_PTY_CLI_SPEC.fallbackBinPath in server.ts.
export function findAgyBinary(): string | null {
  const candidate = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
    : join(homedir(), '.local', 'bin', 'agy');
  return existsSync(candidate) ? candidate : null;
}

function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 4) {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  }
  return 'image/png';
}

// agy may name the file itself (it wrote a `.png` that was actually JPEG in
// testing), so we don't trust a fixed filename — we scan the (initially empty)
// work dir for any image file and take the newest.
function findOutputImage(dir: string): string | null {
  let best: string | null = null;
  let bestM = -1;
  try {
    for (const f of readdirSync(dir)) {
      if (!/\.(png|jpe?g|webp|gif)$/i.test(f)) continue;
      const p = join(dir, f);
      try {
        const m = statSync(p).mtimeMs;
        if (m > bestM) { bestM = m; best = p; }
      } catch { /* file vanished mid-scan */ }
    }
  } catch { /* dir gone */ }
  return best;
}

export interface AgyGenResult {
  bytes: Buffer;
  mimeType: string;
  durationMs: number;
}

// Flat shape (not a discriminated union) so consumers don't depend on
// discriminant narrowing, which the bridge tsconfig doesn't apply.
export interface AgyGenOutcome {
  success: boolean;
  result?: AgyGenResult;
  stage?: string;
  error?: string;
}

export async function agyGenerateImage(params: { prompt: string; timeoutMs?: number }): Promise<AgyGenOutcome> {
  const prompt = typeof params?.prompt === 'string' ? params.prompt.trim() : '';
  if (!prompt) return { success: false, stage: 'bad_request', error: 'agy imagegen: prompt is required' };
  const bin = findAgyBinary();
  if (!bin) return { success: false, stage: 'not_installed', error: 'agy (Antigravity) CLI not installed' };

  const timeoutMs = Math.min(Math.max(params.timeoutMs || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS), HARD_CAP_MS);
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const workDir = join(ARTIFACT_DIR, `gen-${randomUUID()}`);
  mkdirSync(workDir, { recursive: true });

  const fullPrompt =
    `${prompt}\n\nUse your built-in image generation (Nano Banana) to create this image and SAVE it as a file in the current working directory ` +
    `(e.g. image.png). Output only the saved file path when done. Do not ask any questions.`;

  const startedAt = Date.now();
  const cleanup = () => { try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ } };

  return await new Promise<AgyGenOutcome>((resolve) => {
    let settled = false;
    let lastSize = -1;
    let stableCount = 0;

    const child = spawn(bin, ['-p', fullPrompt, '--add-dir', workDir], {
      cwd: workDir,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const done = (r: AgyGenOutcome) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(watchdog);
      try { child.kill(); } catch { /* ignore */ }
      resolve(r);
    };

    const tryHarvest = (): boolean => {
      const out = findOutputImage(workDir);
      if (!out) return false;
      let size = 0;
      try { size = statSync(out).size; } catch { return false; }
      if (size > 0 && size === lastSize) {
        stableCount++;
        if (stableCount >= STABLE_CHECKS) {
          try {
            const bytes = readFileSync(out);
            const mimeType = sniffImageMime(bytes);
            cleanup();
            done({ success: true, result: { bytes, mimeType, durationMs: Date.now() - startedAt } });
          } catch (e: any) {
            cleanup();
            done({ success: false, stage: 'read', error: e?.message || 'failed to read agy output file' });
          }
          return true;
        }
      } else {
        lastSize = size;
        stableCount = 0;
      }
      return false;
    };

    const watchdog = setTimeout(() => {
      cleanup();
      done({ success: false, stage: 'timeout', error: `agy imagegen timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    const poller = setInterval(() => { if (!settled) tryHarvest(); }, POLL_INTERVAL_MS);

    child.on('error', (e: any) => {
      cleanup();
      done({ success: false, stage: 'spawn', error: e?.message || String(e) });
    });

    // If agy exits, give the poller a couple cycles to catch a just-written
    // file (stable-size check), then fail if nothing landed.
    child.on('exit', (code) => {
      setTimeout(() => {
        if (settled) return;
        if (!findOutputImage(workDir)) {
          cleanup();
          done({ success: false, stage: 'no_output', error: `agy exited (code=${code}) without writing an image file` });
        }
        // else: poller harvests once the file is size-stable
      }, POLL_INTERVAL_MS * (STABLE_CHECKS + 1));
    });
  });
}
