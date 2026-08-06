/**
 * Antigravity (`agy`) image generation over the empir3 channel.
 *
 * agy is an agentic coding CLI whose built-in image model (Nano Banana)
 * generates an image during a `--print` turn and WRITES it to a file. The
 * contract is FILE-BASED, not stdout-based: agy's print mode does not flush
 * stdout in a non-TTY (verified), but it DOES write the image file and exit.
 * We spawn agy with a prompt, poll for the image to appear and stabilize, then
 * read the bytes back.
 *
 * WHERE agy writes the image (verified against agy 1.0.10, 2026-06-22):
 *   agy's Nano Banana tool saves the generated image into the PER-CONVERSATION
 *   "brain" directory — ~/.gemini/antigravity-cli/brain/<conversationId>/ —
 *   NOT the spawn cwd. Whether a copy also lands in cwd is model-behaviour-
 *   dependent: the agentic model only writes one there if it decides to follow
 *   a "save to the working directory" instruction, which is unreliable. agy
 *   1.0.3 used to land the image in cwd; the 1.0.10 auto-update changed this,
 *   which broke the old cwd-only harvest (the symptom was "Image generation
 *   returned no image"). So we harvest from the brain dir (the deterministic
 *   location), scoped to the NEW conversation dir this spawn creates so we
 *   never grab a stale or concurrent run's image, and still scan cwd as a
 *   bonus in case a future agy version writes there again.
 *
 * Wire contract (mirrors higgsfield:cli:gen):
 *   server → bridge:  agy:cli:gen        {id, prompt, timeout_sec, input_image_base64?, input_mime?}
 *   bridge → server:  agy:cli:gen:progress {id, status}                 (optional)
 *                     agy:cli:gen:done     {id, exit_code, mime_type, bytes_base64, duration_ms}
 *                     agy:cli:gen:error    {id, stage, error}
 *
 * IMAGE INPUT (edits): agy's `generate_image` tool natively takes an
 * `ImagePaths` argument (verified against agy 1.1.10, 2026-08-06 — a
 * reference-file edit reproduced the source image pixel-faithfully with only
 * the requested change). We write the input image into the spawn cwd as
 * `reference.<ext>` and prompt agy to edit THAT file; the reference is
 * hard-excluded from harvest so a failed edit can never return the unedited
 * input as if it were the result.
 *
 * No `--dangerously-skip-permissions`: a live test confirmed plain `-p` mode
 * runs agy's built-in imagegen and writes the file without a permission prompt
 * (least-privilege; we never want a lent CLI auto-approving arbitrary tools).
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const ARTIFACT_DIR = join(homedir(), '.empir3-bridge', 'artifacts', 'agy');
// agy's per-conversation working store. Its Nano Banana image tool writes
// generated images under <conversationId>/ here, so this — not the spawn cwd —
// is the reliable place to harvest the bytes from. Matches the path agy logs
// at runtime (~/.gemini/antigravity-cli/brain).
const AGY_BRAIN_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'brain');
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const HARD_CAP_MS = 20 * 60 * 1000;
const MIN_TIMEOUT_MS = 30 * 1000;
const POLL_INTERVAL_MS = 1000;
const STABLE_CHECKS = 2; // file size unchanged across N polls ⇒ finished writing
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

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

// Names of the conversation dirs that already exist under the brain dir.
// Snapshotted BEFORE spawning so we can attribute the image agy writes to the
// NEW conversation this turn creates — robust even if another agy run is active
// concurrently. Returns an empty set if the brain dir doesn't exist yet.
function listBrainConvDirs(): Set<string> {
  try { return new Set(readdirSync(AGY_BRAIN_DIR)); } catch { return new Set(); }
}

// Recursively collect image files under `dir` (bounded depth — brain conv dirs
// are shallow: <image> at the root plus a .system_generated/logs subtree).
// `excludePath` drops the input reference file we planted in the cwd.
function collectImages(dir: string, acc: Array<{ path: string; mtimeMs: number }>, depth = 0, excludePath?: string): void {
  if (depth > 4) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; /* dir gone / unreadable */ }
  for (const name of entries) {
    const p = join(dir, name);
    if (excludePath && p === excludePath) continue;
    let st;
    try { st = statSync(p); } catch { continue; /* vanished mid-scan */ }
    if (st.isDirectory()) collectImages(p, acc, depth + 1, excludePath);
    else if (IMAGE_RE.test(name)) acc.push({ path: p, mtimeMs: st.mtimeMs });
  }
}

// The newest image agy produced for THIS turn. Scans the spawn cwd (a fresh
// dir containing at most our planted reference, which is excluded) plus any
// brain conversation dir that did NOT exist before we spawned (the Nano Banana
// artifact lives there). Newest mtime wins so we read the just-written image
// rather than a leftover.
export function findHarvestImage(workDir: string, preBrainConvs: Set<string>, excludePath?: string): string | null {
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  collectImages(workDir, candidates, 0, excludePath);
  let convs: string[] = [];
  try { convs = readdirSync(AGY_BRAIN_DIR); } catch { /* brain dir absent */ }
  for (const conv of convs) {
    if (preBrainConvs.has(conv)) continue; // pre-existing — not from this turn
    collectImages(join(AGY_BRAIN_DIR, conv), candidates, 0, excludePath);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].path;
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

// Single-job FIFO queue — serialize agy image gens on this bridge so two
// concurrent turns can't race on agy's shared brain dir or CLI auth/config
// (mirrors higgsfield-cli.ts default #3). Each gen is short (we kill agy as
// soon as the image is harvested), so the wait is bounded.
let genQueue: Promise<unknown> = Promise.resolve();
function enqueueGen<T>(fn: () => Promise<T>): Promise<T> {
  const next = genQueue.then(fn, fn);
  genQueue = next.then(() => undefined, () => undefined);
  return next;
}

// Max input image we accept for an edit — matches typical generated-asset
// sizes with headroom; a larger payload is refused rather than truncated.
const MAX_INPUT_IMAGE_BYTES = 16 * 1024 * 1024;

function extForMime(mime: string): string {
  if (/jpe?g/i.test(mime)) return 'jpg';
  if (/webp/i.test(mime)) return 'webp';
  if (/gif/i.test(mime)) return 'gif';
  return 'png';
}

export async function agyGenerateImage(params: {
  prompt: string;
  timeoutMs?: number;
  inputImageBase64?: string;
  inputImageMime?: string;
}): Promise<AgyGenOutcome> {
  const prompt = typeof params?.prompt === 'string' ? params.prompt.trim() : '';
  if (!prompt) return { success: false, stage: 'bad_request', error: 'agy imagegen: prompt is required' };
  // Validate the input image BEFORE the binary check so the request contract
  // holds (and is testable) on hosts without agy installed.
  let inputImage: { bytes: Buffer; ext: string } | undefined;
  if (typeof params.inputImageBase64 === 'string' && params.inputImageBase64.length > 0) {
    let bytes: Buffer;
    try { bytes = Buffer.from(params.inputImageBase64, 'base64'); }
    catch { return { success: false, stage: 'bad_request', error: 'agy imagegen: input image is not valid base64' }; }
    if (!bytes.length) return { success: false, stage: 'bad_request', error: 'agy imagegen: input image decoded to zero bytes' };
    if (bytes.length > MAX_INPUT_IMAGE_BYTES) {
      return { success: false, stage: 'bad_request', error: `agy imagegen: input image exceeds ${Math.round(MAX_INPUT_IMAGE_BYTES / 1024 / 1024)}MB` };
    }
    inputImage = { bytes, ext: extForMime(params.inputImageMime || '') };
  }
  const bin = findAgyBinary();
  if (!bin) return { success: false, stage: 'not_installed', error: 'agy (Antigravity) CLI not installed' };
  return enqueueGen(() => runAgyGenerate(bin, prompt, params.timeoutMs, inputImage));
}

function runAgyGenerate(
  bin: string,
  prompt: string,
  timeoutMsRaw?: number,
  inputImage?: { bytes: Buffer; ext: string },
): Promise<AgyGenOutcome> {
  const timeoutMs = Math.min(Math.max(timeoutMsRaw || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS), HARD_CAP_MS);
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const workDir = join(ARTIFACT_DIR, `gen-${randomUUID()}`);
  mkdirSync(workDir, { recursive: true });

  // Snapshot existing brain conversation dirs so we can isolate the one this
  // spawn creates (must happen BEFORE the child runs).
  const preBrainConvs = listBrainConvDirs();

  // Edit mode: plant the reference in the spawn cwd and point the prompt at
  // it. agy's generate_image tool passes the file via its ImagePaths argument
  // (verified 1.1.10 — the output derives from the reference pixels). The
  // planted file is excluded from harvest, so "agy did nothing" fails loud
  // instead of echoing the input back.
  let referencePath: string | undefined;
  if (inputImage) {
    referencePath = join(workDir, `reference.${inputImage.ext}`);
    writeFileSync(referencePath, inputImage.bytes);
  }

  const fullPrompt = referencePath
    ? `In the current working directory there is an image file reference.${inputImage!.ext}. EDIT THIS EXACT IMAGE as instructed:\n${prompt}\n\n` +
      `Use your built-in image generation (Nano Banana) with reference.${inputImage!.ext} as the INPUT image — pass its full path in ImagePaths, do not generate from scratch — ` +
      `and save the edited result as a new image file. Output only the saved file path when done. Do not ask any questions.`
    : `${prompt}\n\nUse your built-in image generation (Nano Banana) to create this image and SAVE it as a file in the current working directory ` +
      `(e.g. image.png). Output only the saved file path when done. Do not ask any questions.`;

  const startedAt = Date.now();
  // Best-effort removal of the spawn cwd. On Windows the workDir IS the agy
  // child's cwd, so it can't be removed until the (killed) process releases the
  // handle — retry a few times. Always called AFTER child.kill() (in done()).
  const cleanup = () => {
    let tries = 0;
    const attempt = () => {
      try { rmSync(workDir, { recursive: true, force: true }); }
      catch { if (++tries < 10) setTimeout(attempt, 200); }
    };
    attempt();
  };

  return new Promise<AgyGenOutcome>((resolve) => {
    let settled = false;
    let lastSize = -1;
    let stableCount = 0;
    let lastPath: string | null = null;

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
      cleanup(); // after kill so the cwd handle is released (Windows lock)
      resolve(r);
    };

    const tryHarvest = (): boolean => {
      const out = findHarvestImage(workDir, preBrainConvs, referencePath);
      if (!out) return false;
      // If the candidate path changed between polls (newest image moved), reset
      // the stability counter so we don't read a half-written newer file.
      if (out !== lastPath) { lastPath = out; lastSize = -1; stableCount = 0; }
      let size = 0;
      try { size = statSync(out).size; } catch { return false; }
      if (size > 0 && size === lastSize) {
        stableCount++;
        if (stableCount >= STABLE_CHECKS) {
          try {
            const bytes = readFileSync(out);
            const mimeType = sniffImageMime(bytes);
            done({ success: true, result: { bytes, mimeType, durationMs: Date.now() - startedAt } });
          } catch (e: any) {
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
      done({ success: false, stage: 'timeout', error: `agy imagegen timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    const poller = setInterval(() => { if (!settled) tryHarvest(); }, POLL_INTERVAL_MS);

    child.on('error', (e: any) => {
      done({ success: false, stage: 'spawn', error: e?.message || String(e) });
    });

    // If agy exits, give the poller a couple cycles to catch a just-written
    // file (stable-size check), then fail if nothing landed.
    child.on('exit', (code) => {
      setTimeout(() => {
        if (settled) return;
        if (!findHarvestImage(workDir, preBrainConvs, referencePath)) {
          done({ success: false, stage: 'no_output', error: `agy exited (code=${code}) without writing an image file` });
        }
        // else: poller harvests once the file is size-stable
      }, POLL_INTERVAL_MS * (STABLE_CHECKS + 1));
    });
  });
}
