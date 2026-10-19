import { readdir, readFile, rm, rmdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, join, win32 } from 'path';

/**
 * Retention sweep for lent-CLI turn transcripts at rest.
 *
 * Every lent Claude turn writes a full transcript (system prompt including the
 * user's contact block, conversation, tool results) to
 * `~/.claude/projects/<cwd-slug>/*.jsonl`, accumulating indefinitely across
 * ALL users routed through this Bridge. The Bridge's own `cli-runs` directory
 * keeps a prompt + transcript JSON per lent run as well. Neither is a
 * cross-user leak on its own, but both are a growing concentration of every
 * user's conversation data on one machine.
 *
 * The sweep deletes transcript files older than the retention window from ONLY
 * the directories the Bridge itself sends lent turns into:
 *   - the payload root (relay turns spawn with cwd = the payload dir; every
 *     versioned payload dir shares the payload root's slug prefix);
 *   - the configured Empir3 home/project directory (cli_run's default cwd);
 *   - the Bridge's own cli-runs transcript directory.
 * Explicit-cwd runs into real project directories are deliberately NOT swept —
 * transcripts there are indistinguishable from the owner's own CLI activity,
 * and deleting the owner's history is worse than retaining a transcript.
 *
 * Grok needs no sweep: each lent turn runs in an ephemeral turn home that is
 * removed at cleanup, so no per-turn session state accumulates. Codex, Gemini,
 * and Antigravity session stores are shared with the owner's own usage and are
 * assessed separately (Work Board 1cd76d23).
 */

export const DEFAULT_LENT_TRANSCRIPT_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 365;

/** Claude Code's project-directory naming: every non-alphanumeric character of
 * the working directory becomes '-'. */
export function claudeProjectSlug(cwd: string): string {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

/** Slug variants that tolerate Windows drive-letter case normalization. */
function slugVariants(cwd: string): string[] {
  const raw = String(cwd || '');
  const variants = new Set<string>([claudeProjectSlug(raw)]);
  if (/^[A-Za-z]:/.test(raw)) {
    variants.add(claudeProjectSlug(raw[0].toLowerCase() + raw.slice(1)));
    variants.add(claudeProjectSlug(raw[0].toUpperCase() + raw.slice(1)));
  }
  return [...variants].filter(Boolean);
}

export function normalizeRetentionDays(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_LENT_TRANSCRIPT_RETENTION_DAYS;
  if (parsed <= 0) return 0; // explicit 0 (or negative) disables the sweep
  return Math.min(MAX_RETENTION_DAYS, Math.max(1, Math.floor(parsed)));
}

export interface LentTranscriptSweepOptions {
  /** ~/.claude/projects (overridable for tests). */
  claudeProjectsDir?: string;
  /** Bridge cli-runs transcript directory; skipped when absent. */
  cliRunsDir?: string;
  /** Exact lent-turn working directories (configured home directory, cwd). */
  lentCwds: string[];
  /** Directories whose EVERY versioned child is a lent-turn cwd (payload root). */
  lentCwdRoots?: string[];
  retentionDays?: number;
  now?: number;
}

export interface LentTranscriptSweepResult {
  enabled: boolean;
  scannedDirs: number;
  deletedFiles: number;
  retentionDays: number;
  /** Swept project dirs removed because the sweep left them empty — the
   * cli-see pattern creates one single-transcript dir per caption call, so
   * without pruning the dir count itself grows without bound. */
  prunedDirs?: number;
}

async function sweepDirForOldFiles(dir: string, cutoffMs: number, extensions: string[] | null): Promise<{ scanned: boolean; deleted: number }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { scanned: false, deleted: 0 };
  }
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
    const filePath = join(dir, entry.name);
    try {
      const info = await stat(filePath);
      if (info.mtimeMs < cutoffMs) {
        await rm(filePath, { force: true });
        deleted += 1;
      }
    } catch { /* raced with concurrent writer/cleanup */ }
  }
  return { scanned: true, deleted };
}

export async function sweepLentTranscripts(options: LentTranscriptSweepOptions): Promise<LentTranscriptSweepResult> {
  const retentionDays = normalizeRetentionDays(options.retentionDays);
  if (retentionDays === 0) {
    return { enabled: false, scannedDirs: 0, deletedFiles: 0, retentionDays };
  }
  const now = options.now ?? Date.now();
  const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
  const projectsDir = options.claudeProjectsDir ?? join(homedir(), '.claude', 'projects');

  const exactSlugs = new Set<string>();
  for (const cwd of options.lentCwds) for (const slug of slugVariants(cwd)) exactSlugs.add(slug);
  const slugPrefixes = (options.lentCwdRoots ?? [])
    .flatMap((root) => slugVariants(root))
    .map((slug) => `${slug}-`);

  let scannedDirs = 0;
  let deletedFiles = 0;
  let prunedDirs = 0;

  let projectDirs: string[] = [];
  try {
    projectDirs = (await readdir(projectsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch { /* no claude project store on this machine */ }

  for (const name of projectDirs) {
    const isLentDir = exactSlugs.has(name) || slugPrefixes.some((prefix) => name.startsWith(prefix));
    if (!isLentDir) continue;
    const dirPath = join(projectsDir, name);
    const swept = await sweepDirForOldFiles(dirPath, cutoffMs, ['.jsonl']);
    if (swept.scanned) scannedDirs += 1;
    deletedFiles += swept.deleted;
    if (swept.deleted > 0) {
      // rmdir removes only an EMPTY directory; anything remaining (fresh
      // transcripts, non-jsonl files, subdirs) makes it a harmless no-op.
      try { await rmdir(dirPath); prunedDirs += 1; } catch { /* not empty */ }
    }
  }

  if (options.cliRunsDir) {
    const swept = await sweepDirForOldFiles(options.cliRunsDir, cutoffMs, null);
    if (swept.scanned) scannedDirs += 1;
    deletedFiles += swept.deleted;
  }

  return { enabled: true, scannedDirs, deletedFiles, retentionDays, prunedDirs };
}

/** True when `cwd` sits directly under a versioned payload root, in which case
 * the ROOT should be swept by prefix so transcripts from earlier payload
 * versions age out too. */
export function payloadRootOf(cwd: string): string | null {
  // Release and retention checks can inspect a Windows payload path while
  // running on Linux or macOS. Native path helpers treat backslashes as
  // ordinary characters there, so select Windows semantics from the value
  // rather than from the host running the Bridge.
  const pathApi = win32.isAbsolute(cwd) ? win32 : { basename, dirname };
  const parent = pathApi.dirname(cwd);
  return pathApi.basename(parent) === 'payload' ? parent : null;
}

export async function readCliRunCwds(cliRunsDir: string, limit = 200): Promise<string[]> {
  // Currently unused by the sweep (arbitrary recorded cwds are deliberately
  // not swept) but kept for the console/debug surface: it lists where lent
  // cli_run turns have actually been writing transcripts.
  const cwds = new Set<string>();
  let entries: string[] = [];
  try {
    entries = (await readdir(cliRunsDir)).filter((name) => name.endsWith('.json')).slice(-limit);
  } catch {
    return [];
  }
  for (const name of entries) {
    try {
      const parsed = JSON.parse(await readFile(join(cliRunsDir, name), 'utf-8'));
      if (typeof parsed?.cwd === 'string' && parsed.cwd) cwds.add(parsed.cwd);
    } catch { /* partial write or non-transcript json */ }
  }
  return [...cwds];
}
