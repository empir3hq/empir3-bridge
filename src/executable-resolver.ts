/**
 * In-process executable resolution — the single source of truth for "where is
 * CLI <x> installed".
 *
 * Why not just `where.exe` / `which`? Those run with the *daemon's* PATH, which
 * a tray / GUI-launched process inherits in a stripped, stale form: winget edits
 * the user PATH after the daemon already started, node-version-managers expose
 * their bins only in the interactive shell's PATH, etc. The symptom is a CLI
 * that resolves fine from the user's terminal but reads NOT INSTALLED in the
 * bridge (real incident: a winget-installed `gh`).
 *
 * The fix (mirrors open-design's runtimes/executables.ts): never shell out.
 * Split `process.env.PATH` in-process, walk `PATHEXT`, and *augment* the search
 * with a list of well-known user-toolchain dirs where global CLIs actually land
 * — plus a per-CLI env override (`CLAUDE_BIN`, `GH_BIN`, …) as an escape hatch.
 * One resolver, used by every CLI, so no detection path can drift again.
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { delimiter, join, extname } from 'path';
import { homedir } from 'os';

// Per-CLI explicit override: point detection at an exact binary when the
// conventional locations miss. Keyed by the bare CLI name we probe for.
const BIN_ENV_OVERRIDE: Record<string, string> = {
  claude: 'CLAUDE_BIN',
  codex: 'CODEX_BIN',
  gemini: 'GEMINI_BIN',
  grok: 'GROK_BIN',
  gh: 'GH_BIN',
  higgsfield: 'HIGGSFIELD_BIN',
  agy: 'AGY_BIN',
};

function pathExts(): string[] {
  if (process.platform !== 'win32') return [''];
  // Append '' so an extensionless native-installer binary (e.g. a unix-style
  // `claude` shim) is still found on Windows.
  const fromEnv = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(s => s.trim()).filter(Boolean);
  return [...fromEnv, ''];
}

function pathDirs(): string[] {
  return (process.env.PATH || '').split(delimiter).map(s => s.trim()).filter(Boolean);
}

// ── Well-known user-toolchain bin dirs ──────────────────────────────
// Cross-platform list of places a user-installed global CLI lands beyond the
// daemon's PATH. Cached briefly — the node-version-manager enumeration touches
// the filesystem, and detection runs on every settings-state load.
const TOOLCHAIN_CACHE_TTL_MS = 5000;
let cachedDirs: string[] | null = null;
let cachedHome: string | null = null;
let cachedAt = 0;

export function wellKnownToolchainDirs(): string[] {
  const home = homedir();
  const now = Date.now();
  if (cachedDirs && cachedHome === home && now - cachedAt < TOOLCHAIN_CACHE_TTL_MS) {
    return cachedDirs;
  }
  const env = process.env;
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const roamingAppData = env.APPDATA || join(home, 'AppData', 'Roaming');
  const dirs: string[] = [];

  // Explicit npm prefix wins — matches npm's own resolution (env > .npmrc >
  // default). On Windows the global shims sit directly in <prefix>; on POSIX
  // they live in <prefix>/bin, so push both.
  const npmPrefix = (env.NPM_CONFIG_PREFIX || env.npm_config_prefix || '').trim();
  if (npmPrefix) dirs.push(npmPrefix, join(npmPrefix, 'bin'));

  // Windows global package-manager + shim locations.
  dirs.push(
    join(roamingAppData, 'npm'),                              // npm global (default)
    join(localAppData, 'Microsoft', 'WinGet', 'Links'),       // winget shims
    join(localAppData, 'Volta', 'bin'),                       // Volta (Windows)
    join(localAppData, 'Yarn', 'bin'),                        // Yarn classic (Windows)
    join(home, 'scoop', 'shims'),                             // Scoop
  );
  if (env.PNPM_HOME) dirs.push(env.PNPM_HOME);                // pnpm

  // Cross-platform home-relative toolchains.
  dirs.push(
    join(home, '.local', 'bin'),                              // native installers (e.g. Claude)
    // Claude Code "local installer" target (`claude migrate-installer`, also
    // what the VS Code extension can set up). NOT on PATH — `where claude`
    // misses it, but the extension spawns it by absolute path, so it works in
    // VS Code yet read NOT INSTALLED in the bridge until we scan here.
    join(home, '.claude', 'local'),
    join(home, '.claude', 'local', 'node_modules', '.bin'),
    join(home, '.bun', 'bin'),                                // bun
    join(home, '.deno', 'bin'),                               // deno
    join(home, '.cargo', 'bin'),                              // cargo
    join(home, '.volta', 'bin'),                              // Volta (POSIX)
    join(home, '.yarn', 'bin'),                               // Yarn (POSIX)
    join(home, '.npm-global', 'bin'),                         // common sudo-free npm prefix
    join(home, '.npm-packages', 'bin'),                       // ditto, second variant
  );

  // POSIX system bins (a GUI app's PATH often lacks these).
  if (process.platform !== 'win32') {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  }

  // Per-version Node toolchains — npm-global CLIs hide inside the *active*
  // node version's bin dir, which never makes it into a GUI app's PATH.
  for (const { root, segments } of [
    { root: join(home, '.nvm', 'versions', 'node'), segments: ['bin'] },
    { root: join(home, '.fnm', 'node-versions'), segments: ['installation', 'bin'] },
    { root: join(home, '.local', 'share', 'fnm', 'node-versions'), segments: ['installation', 'bin'] },
    { root: join(localAppData, 'fnm_multishells'), segments: [] },
  ]) {
    try {
      for (const entry of readdirSync(root)) {
        dirs.push(join(root, entry, ...segments));
      }
    } catch { /* root absent — contributes nothing */ }
  }

  cachedDirs = dirs;
  cachedHome = home;
  cachedAt = now;
  return dirs;
}

// ── Name-specific install locations ─────────────────────────────────
// A few CLIs land somewhere no generic toolchain-dir scan would reach. Kept
// name-keyed so the generic resolver stays clean.

// Scan the winget Packages tree (%LOCALAPPDATA%\Microsoft\WinGet\Packages\
// <id>\(bin\)?<exe>). The package-id dir rarely matches the binary name, so
// probe each package's root + bin. The daemon's PATH usually lacks this dir.
function wingetPackageCandidates(baseName: string): string[] {
  if (process.platform !== 'win32') return [];
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const packages = join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  const out: string[] = [];
  try {
    for (const dir of readdirSync(packages)) {
      for (const exe of [`${baseName}.exe`, `${baseName}.cmd`]) {
        out.push(join(packages, dir, 'bin', exe), join(packages, dir, exe));
      }
    }
  } catch { /* no winget Packages dir */ }
  return out;
}

// Candidates that must be tried BEFORE PATH (the Microsoft Store Codex app
// exposes a WindowsApps PATH alias that throws EPERM when spawned by Node, so
// the real per-user binary has to win).
function priorityCandidates(baseName: string): string[] {
  if (process.platform !== 'win32') return [];
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  if (baseName === 'codex') {
    const out = [
      join(localAppData, 'OpenAI', 'Codex', 'bin', 'codex.cmd'),
      join(localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    ];
    const packagesDir = join(localAppData, 'Packages');
    try {
      for (const dir of readdirSync(packagesDir)) {
        if (/^OpenAI\.Codex_/i.test(dir)) {
          out.push(
            join(packagesDir, dir, 'LocalCache', 'Local', 'OpenAI', 'Codex', 'bin', 'codex.cmd'),
            join(packagesDir, dir, 'LocalCache', 'Local', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
          );
        }
      }
    } catch {}
    const windowsApps = join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps');
    try {
      for (const dir of readdirSync(windowsApps)) {
        if (/^OpenAI\.Codex_/i.test(dir)) {
          out.push(
            join(windowsApps, dir, 'app', 'resources', 'codex.cmd'),
            join(windowsApps, dir, 'app', 'resources', 'codex.exe'),
            join(windowsApps, dir, 'app', 'resources', 'codex'),
          );
        }
      }
    } catch {}
    return out;
  }
  return [];
}

// Candidates tried AFTER PATH + toolchain dirs — installer-specific homes and
// winget Packages.
function fallbackCandidates(baseName: string): string[] {
  const home = homedir();
  const out: string[] = [];
  if (baseName === 'grok') {
    // xAI installer drops grok at ~/.grok/bin/grok[.exe] (not an npm package).
    for (const f of ['grok.exe', 'grok.cmd', 'grok']) out.push(join(home, '.grok', 'bin', f));
  }
  if (baseName === 'gh') {
    out.push(
      join(process.env['ProgramFiles'] || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
      join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'GitHub CLI', 'gh.exe'),
      join(process.env['LOCALAPPDATA'] || '', 'GitHub CLI', 'gh.exe'),
    );
  }
  if (baseName === 'agy') {
    // Antigravity's headless CLI installs to %LOCALAPPDATA%\agy\bin (Windows)
    // or ~/.local/bin (POSIX) and is not added to PATH.
    const lad = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    out.push(join(lad, 'agy', 'bin', 'agy.exe'), join(home, '.local', 'bin', 'agy'));
  }
  if (baseName === 'claude') {
    out.push(...editorBundledClaudeCandidates(home));
  }
  out.push(...wingetPackageCandidates(baseName));
  return out;
}

// The Claude Code VS Code / Cursor extension bundles a full, headless-capable
// native `claude` (verified: `--version` → "2.1.x (Claude Code)") at
// <ext>/resources/native-binary/claude[.exe], but never adds it to PATH — so
// `where claude` misses it even though Claude works in the editor. Detected as
// a last resort (a real standalone install ranks ahead via PATH / npm). Newest
// extension version wins.
function editorBundledClaudeCandidates(home: string): string[] {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const roots = [
    join(home, '.vscode', 'extensions'),
    join(home, '.vscode-insiders', 'extensions'),
    join(home, '.cursor', 'extensions'),
    join(home, '.windsurf', 'extensions'),
  ];
  const extDirs: string[] = [];
  for (const root of roots) {
    try {
      for (const d of readdirSync(root)) {
        if (/^anthropic\.claude-code-/i.test(d)) extDirs.push(join(root, d));
      }
    } catch { /* no such editor / extensions dir */ }
  }
  extDirs.sort(compareExtDirVersionDesc);
  return extDirs.map(d => join(d, 'resources', 'native-binary', exe));
}

// Sort `anthropic.claude-code-2.1.161-win32-x64` dirs newest-first by their
// x.y.z version; fall back to reverse string order when no version parses.
function compareExtDirVersionDesc(a: string, b: string): number {
  const parse = (s: string): number[] => {
    const m = /claude-code-(\d+)\.(\d+)\.(\d+)/i.exec(s);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [];
  };
  const va = parse(a), vb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (vb[i] ?? -1) - (va[i] ?? -1);
    if (d !== 0) return d;
  }
  return b.localeCompare(a);
}

function looksExecutableOnWindows(filePath: string): boolean {
  const ext = extname(filePath).trim().toUpperCase();
  if (!ext) return false;
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map(s => s.trim().toUpperCase()).filter(Boolean);
  return exts.includes(ext);
}

// Resolve a per-CLI env override (CLAUDE_BIN, GH_BIN, …) to an absolute,
// existing, executable file. Returns null when unset/invalid.
function envOverridePath(baseName: string): string | null {
  const key = BIN_ENV_OVERRIDE[baseName];
  if (!key) return null;
  const raw = (process.env[key] || '').trim();
  if (!raw) return null;
  try {
    if (!statSync(raw).isFile()) return null;
    if (process.platform === 'win32' && !looksExecutableOnWindows(raw)) return null;
  } catch {
    return null;
  }
  return raw;
}

/**
 * Ordered, de-duplicated list of existing executable paths for `name`. Order:
 *   1. env override (e.g. CLAUDE_BIN)
 *   2. name-specific priority dirs (codex real binary before its PATH alias)
 *   3. PATH × PATHEXT (in-process — no `where.exe` / `which`)
 *   4. well-known user-toolchain dirs × PATHEXT
 *   5. name-specific fallbacks (installer homes, winget Packages)
 */
export function resolveExecutableCandidates(name: string): string[] {
  const baseName = name.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  const exts = pathExts();
  const candidates: string[] = [];

  const override = envOverridePath(baseName);
  if (override) candidates.push(override);

  candidates.push(...priorityCandidates(baseName));

  for (const dir of pathDirs()) {
    for (const ext of exts) candidates.push(join(dir, baseName + ext));
  }
  for (const dir of wellKnownToolchainDirs()) {
    for (const ext of exts) candidates.push(join(dir, baseName + ext));
  }

  candidates.push(...fallbackCandidates(baseName));

  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = c.toLowerCase();
    if (seen.has(key) || !existsSync(c)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Single best executable path for `name`, preferring a `.cmd` shim over `.exe`
 * on Windows (the .cmd wrapper sets up the right interpreter), else the first
 * resolved candidate. Null when nothing is found.
 */
export function resolveExecutable(name: string): string | null {
  const candidates = resolveExecutableCandidates(name);
  if (!candidates.length) return null;
  if (process.platform === 'win32') {
    return candidates.find(p => p.toLowerCase().endsWith('.cmd'))
      || candidates.find(p => p.toLowerCase().endsWith('.exe'))
      || candidates[0];
  }
  return candidates[0];
}
