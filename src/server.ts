/**
 * Empir3 Browser Bridge — HTTP Wrapper
 *
 * Wraps the CDP bridge (src/bridge.ts) with a clean HTTP + WebSocket API:
 * chat, recording, visual feedback. The MCP server and CLI both talk here.
 *
 * Architecture:
 *   - This wrapper on :3006 (HTTP + WebSocket)
 *   - CDP bridge on :9867 (Chrome control via HTTP API)
 *   - Overlay injected via the CDP bridge's /evaluate endpoint
 *   - Recordings use element refs from the accessibility tree
 *   - Playback uses element refs first, coordinate fallback second
 *
 * Run: npx tsx src/server.ts [--launch]
 *   --launch: auto-launch the CDP bridge (default: connect to running instance)
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync, unlinkSync, statSync, symlinkSync } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import { spawn, ChildProcess } from 'child_process';
import { hostname, homedir, cpus, totalmem, freemem, uptime, release, type as osType, version as osVersion, networkInterfaces } from 'os';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { resolveBootstrapExe } from './bootstrap-exe';
import type { IDisposable, IPty } from 'node-pty';
import { streamChat, listConversations, readConversation, type ChatEvent } from './chat.js';
import { loadConfig, saveConfig, publicConfig, type BridgeConfig } from './config.js';
import { TOOL_META, TOOL_FAMILY } from './tool-defaults.js';
import { higgsfieldStatus, higgsfieldGenerate, higgsfieldList, higgsfieldModels, handleHiggsfieldCliCommand } from './handlers/higgsfield-cli.js';
import { agyGenerateImage } from './handlers/agy-imagegen.js';
import { githubStatus, githubExec, probeGithubCli, normalizeGhScopes, type GhScope } from './handlers/github-cli.js';
import { resolveExecutableCandidates, resolveExecutable } from './executable-resolver.js';

const HOST = process.env.EMPIR3_BRIDGE_HOST || '127.0.0.1';
const PORT = parseInt(process.env.PW_PORT || '3006');
const EMPIR3_BRIDGE_PORT = parseInt(process.env.EMPIR3_BRIDGE_PORT || '9867');
const BRIDGE_URL = `http://127.0.0.1:${EMPIR3_BRIDGE_PORT}`;
const BRIDGE_NONCE = process.env.EMPIR3_BRIDGE_NONCE || randomBytes(8).toString('hex');
// Bridge-owned CDP overlay injection is the only overlay transport: the bridge
// pushes inbound via window.__empir3_inbox and drains window.__empir3_outbox
// over CDP, which works on every page (including https) with no extension.

function isLocalBridgeOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return u.protocol === 'http:'
      && ['localhost', '127.0.0.1', '::1'].includes(host)
      && port === String(PORT);
  } catch {
    return false;
  }
}

function requestNonce(req: IncomingMessage, url?: URL): string {
  const header = req.headers['x-empir3-nonce'];
  const raw = Array.isArray(header) ? header[0] : header;
  return String(raw || url?.searchParams.get('nonce') || '');
}

function validBridgeNonce(value: string): boolean {
  if (!value || !BRIDGE_NONCE || value.length !== BRIDGE_NONCE.length) return false;
  try {
    return timingSafeEqual(Buffer.from(value), Buffer.from(BRIDGE_NONCE));
  } catch {
    return false;
  }
}

function mutatingMethod(method: string | undefined): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
}

function browserOriginNeedsNonce(req: IncomingMessage): boolean {
  const origin = String(req.headers.origin || '');
  if (!origin) return false;
  return !isLocalBridgeOrigin(origin);
}

function requestHasBridgeNonce(req: IncomingMessage, url?: URL): boolean {
  return validBridgeNonce(requestNonce(req, url));
}

function trustedOverlayScriptRequest(req: IncomingMessage): boolean {
  const origin = String(req.headers.origin || '');
  const referer = String(req.headers.referer || '');
  let refererOrigin = '';
  try { if (referer) refererOrigin = new URL(referer).origin; } catch {}
  return isLocalBridgeOrigin(origin)
    || isLocalBridgeOrigin(refererOrigin);
}

function applyCors(req: IncomingMessage, res: ServerResponse, url?: URL) {
  const origin = String(req.headers.origin || '');
  if (!origin) return;
  const requestedHeaders = String(req.headers['access-control-request-headers'] || '').toLowerCase();
  const nonceHeaderRequested = requestedHeaders.split(',').map(s => s.trim()).includes('x-empir3-nonce');
  const allow = isLocalBridgeOrigin(origin)
    || origin.startsWith('chrome-extension://')
    || nonceHeaderRequested
    || requestHasBridgeNonce(req, url);
  if (!allow) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Empir3-Nonce');
}
const FEEDBACK_DIR = resolve(__dirname, '..', 'feedback');
const RECORDINGS_DIR = resolve(__dirname, '..', 'recordings');
const CONTEXT_FILE = resolve(FEEDBACK_DIR, 'session-context.json');
const BRIDGE_VERSION = process.env.EMPIR3_BRIDGE_PAYLOAD_VERSION || readPackageVersion();
// Per-bridge chat log so a parallel bridge on a non-default port doesn't smash
// the main bridge's history. Default port keeps the legacy filename so existing
// dev data isn't orphaned.
const CHAT_LOG = resolve(
  FEEDBACK_DIR,
  PORT === 3006 ? 'chat.jsonl' : `chat-${PORT}.jsonl`,
);

// ─── Empir3 Server Connection (for direct Koba edits) ────────
const SETTINGS_DIR = join(process.env.APPDATA || join(homedir(), '.empir3'), 'Empir3');
const AUTH_FILE = join(SETTINGS_DIR, 'bridge-auth.json');
const SETTINGS_FILE = join(SETTINGS_DIR, 'bridge-settings.json');
const BRIDGE_LOG_FILE = join(SETTINGS_DIR, 'bridge.log');
const TRAY_LOG_FILE = join(SETTINGS_DIR, 'tray.log');
// Public manifest the tray polls for version updates. Mirrors tray.py's
// VERSION_MANIFEST_URL so the welcome-page command center hits the same source.
const VERSION_MANIFEST_URL = `${(process.env.EMPIR3_SERVER || 'https://app.empir3.com').replace(/\/+$/, '')}/downloads/bridge-version.json`;
const STANDALONE_MARKER = join(homedir(), '.empir3-bridge', 'standalone-mode');
const DEFAULT_EMPIR3_SERVER = 'https://app.empir3.com';
const LOCAL_DEV_EMPIR3_SERVER = 'http://localhost:3005';
const EMPIR3_SERVER = normalizeEmpir3Server(process.env.EMPIR3_SERVER || bridgeAuthServerUrl() || DEFAULT_EMPIR3_SERVER);
const EMPIR3_WS_URL = process.env.EMPIR3_WS_URL || bridgeAuthWsUrl() || defaultEmpir3WsUrl(EMPIR3_SERVER); // e.g. wss://app.empir3.com/ws
const EMPIR3_AUTH_TOKEN = process.env.EMPIR3_AUTH_TOKEN || bridgeAuthToken(); // JWT or legacy token
const EMPIR3_PROJECT_ID = process.env.EMPIR3_PROJECT_ID || ''; // active project
const EMPIR3_DIRECT_AGENT = process.env.EMPIR3_DIRECT_AGENT || 'designer'; // koba by default
const COMPANION_FILES_ROOT = join(homedir(), 'Empir3', 'Files');
const COMPANION_PROJECTS_ROOT = join(homedir(), 'Empir3', 'Projects');
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_PULL_MAX_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_SIZE = 1024 * 1024;
const MAX_SHELL_OUTPUT = 65536;
const CLI_CACHE_TTL_MS = 30 * 60 * 1000;

const APP_ALIASES: Record<string, string> = {
  notepad: 'notepad.exe',
  calculator: 'calc.exe',
  calc: 'calc.exe',
  paint: 'mspaint.exe',
  explorer: 'explorer.exe',
  chrome: 'chrome',
  firefox: 'firefox',
  edge: 'msedge',
  code: 'code',
  vscode: 'code',
  terminal: 'wt.exe',
  cmd: 'cmd.exe',
  powershell: 'powershell.exe',
  spotify: 'spotify',
  discord: 'discord',
  slack: 'slack',
  zoom: 'zoom',
};

type AppLaunchCandidate = {
  command: string;
  args?: string[];
  processNeedle?: string;
  mustVerify?: boolean;
};

function dedupeLaunchCandidates(candidates: AppLaunchCandidate[]): AppLaunchCandidate[] {
  const seen = new Set<string>();
  const out: AppLaunchCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.command}\0${(c.args || []).join('\0')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function appLaunchCandidates(name: string): AppLaunchCandidate[] {
  const lower = String(name || '').trim().toLowerCase();
  const candidates: AppLaunchCandidate[] = [];
  if (process.platform === 'win32' && lower === 'spotify') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    for (const p of [
      join(appData, 'Spotify', 'Spotify.exe'),
      join(localAppData, 'Microsoft', 'WindowsApps', 'Spotify.exe'),
    ]) {
      if (existsSync(p)) candidates.push({ command: p, processNeedle: 'spotify', mustVerify: true });
    }
  }
  const alias = APP_ALIASES[lower] || name;
  candidates.push({ command: alias, processNeedle: lower || alias });
  return dedupeLaunchCandidates(candidates);
}

const PROTECTED_PROCESSES = new Set([
  'csrss.exe', 'lsass.exe', 'smss.exe', 'services.exe', 'svchost.exe',
  'wininit.exe', 'winlogon.exe', 'dwm.exe', 'system', 'registry',
  'explorer.exe', 'taskmgr.exe', 'spoolsv.exe',
]);

const BLOCKED_SHELL_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+-rf\b/i, 'recursive force delete (rm -rf)'],
  [/\brm\s+-r\b/i, 'recursive delete (rm -r)'],
  [/\bRemove-Item\b(?=[^\r\n;]*\b-Recurse\b)(?=[^\r\n;]*\b-Force\b)/i, 'recursive force delete (Remove-Item -Recurse -Force)'],
  [/\bRemove-Item\b[^\r\n;]*(?:[A-Z]:\\(?:\s|$)|[A-Z]:\\\*)/i, 'drive-root delete (Remove-Item)'],
  [/\bdel\s+\/[sS]\b/i, 'recursive delete (del /s)'],
  [/\brmdir\s+\/[sS]\b/i, 'recursive directory removal (rmdir /s)'],
  [/\bformat\s+[a-zA-Z]:/i, 'disk format'],
  [/\brd\s+\/[sS]\b/i, 'recursive directory removal (rd /s)'],
  [/\bRestart-Computer\b/i, 'system restart'],
  [/\bStop-Computer\b/i, 'system shutdown'],
  [/\bshutdown\b/i, 'system shutdown'],
  [/\bclear-disk\b/i, 'disk wipe'],
  [/\bClear-RecycleBin\b/i, 'recycle bin clear'],
  [/\bDisable-NetAdapter\b/i, 'network adapter disable'],
  [/\breg\s+delete\b/i, 'registry deletion'],
  [/\bRemove-ItemProperty\b.*Registry/i, 'registry manipulation'],
  [/\bnet\s+user\b.*\/add/i, 'user account creation'],
  [/\bnet\s+localgroup\b.*administrators.*\/add/i, 'admin privilege escalation'],
  [/\bSet-ExecutionPolicy\b.*Unrestricted/i, 'execution policy bypass'],
  [/\btaskkill\s+\/f\s+\/im\s+(svchost|csrss|lsass|winlogon)/i, 'critical process kill'],
  [/\bStop-Process\b.*-Name\s+(svchost|csrss|lsass|winlogon)/i, 'critical process kill'],
  [/\bdiskpart\b/i, 'disk partition tool'],
  [/\bbcdedit\b/i, 'boot configuration edit'],
  [/\bInvoke-WebRequest\b.*-OutFile.*\.(exe|bat|ps1|cmd)/i, 'download and save executable'],
  [/\bcurl\b.*-o\s.*\.(exe|bat|ps1|cmd)/i, 'download executable'],
  [/:\(\)\{.*\|.*\}/, 'fork bomb'],
  [/%0\|%0/, 'fork bomb (batch)'],
];

const BLOCKED_EXT_WRITE = new Set(['.exe', '.bat', '.ps1', '.cmd', '.vbs', '.scr', '.msi', '.com', '.pif', '.wsf', '.wsh', '.inf', '.reg']);
const BLOCKED_EXT_READ = new Set(['.sys', '.dll', '.drv', '.ocx', '.dat', '.db', '.sqlite', '.ldb']);
const BLOCKED_PATH_PREFIXES = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
  'C:\\ProgramData', 'C:\\$Recycle.Bin', 'C:\\System Volume Information',
].map(s => s.toLowerCase());
const BLOCKED_PATH_FRAGMENTS = [
  '/.aws/credentials', '\\.aws\\credentials', '/.npmrc', '\\.npmrc',
  '/.bashrc', '\\.bashrc', '/.bash_profile', '\\.bash_profile',
  '/.zshrc', '\\.zshrc', '/.git/config', '\\.git\\config',
  '/.ssh/config', '\\.ssh\\config', '/.docker/config.json', '\\.docker\\config.json',
  '/.kube/config', '\\.kube\\config', '/.netrc', '\\.netrc', '/.pgpass', '\\.pgpass',
];
const BLOCKED_FILENAME = /(\.pem|\.key|\.pfx|\.p12|\.jks|\.keystore|id_rsa|id_ed25519|\.ssh|known_hosts|authorized_keys|shadow|passwd|ntds\.dit|SAM|SECURITY|SYSTEM)/i;
const BLOCKED_FILENAME_DOTENV = /^\.env(\.|$)/i;
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

const CLI_CANDIDATES: Array<[string, string[]]> = [
  ['claude', ['claude', '--version']],
  ['codex', ['codex', '--version']],
  ['ffmpeg', ['ffmpeg', '-version']],
  ['git', ['git', '--version']],
  ['gh', ['gh', '--version']],
  ['node', ['node', '--version']],
  ['python', ['python', '--version']],
  ['pip', ['pip', '--version']],
  ['7z', ['7z', '--help']],
  ['pandoc', ['pandoc', '--version']],
  ['magick', ['magick', '--version']],
  ['convert', ['convert', '--version']],
  ['curl', ['curl', '--version']],
  ['yt-dlp', ['yt-dlp', '--version']],
  ['jq', ['jq', '--version']],
  ['docker', ['docker', '--version']],
  ['npm', ['npm', '--version']],
  ['yarn', ['yarn', '--version']],
  ['code', ['code', '--version']],
  ['wkhtmltopdf', ['wkhtmltopdf', '--version']],
  ['sqlite3', ['sqlite3', '--version']],
  ['ssh', ['ssh', '-V']],
  ['tar', ['tar', '--version']],
  ['powershell', ['powershell', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']],
];

const COM_CANDIDATES: Array<[string, string]> = [
  ['Excel.Application', 'Microsoft Excel'],
  ['Word.Application', 'Microsoft Word'],
  ['PowerPoint.Application', 'Microsoft PowerPoint'],
  ['Outlook.Application', 'Microsoft Outlook'],
  ['Shell.Application', 'Windows Shell'],
  ['SAPI.SpVoice', 'Text-to-Speech'],
  ['WScript.Shell', 'Windows Script Host'],
];

// ─── Types ───────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  from: 'user' | 'claude';
  text: string;
  timestamp: string;
  channel?: 'mcp' | 'empir3';
  projectId?: string;
  agent?: string;
  agentName?: string;
  screenshot?: string;
  selector?: string;
  elementHtml?: string;
  url?: string;
}

interface BridgeCommand {
  [key: string]: any;
  action?: string;
  type: string;
  // navigate
  url?: string;
  // click / type / highlight (CSS selector — legacy)
  selector?: string;
  text?: string;
  // click_ref / type_ref (Empir3 Bridge element ref)
  ref?: string;
  // scroll / click_xy
  x?: number;
  y?: number;
  // desktop actions
  monitor?: string;
  space?: 'desktop' | 'monitor';
  double?: boolean;
  button?: 'left' | 'right' | 'middle';
  toX?: number;
  toY?: number;
  durationMs?: number;
  steps?: number;
  // evaluate
  script?: string;
  // chat
  message?: string;
  // snapshot
  filter?: string;  // 'all' | 'interactive' (default: 'interactive')
  format?: string;  // 'compact' | 'json' (default: 'compact')
  // play
  recording?: string;
  speed?: number;
  variables?: Record<string, string>;
  // playback transport control (playback_seek)
  step?: number;
}

const COMPANION_COMMAND_PREFIXES = new Set([
  'app',
  'capabilities',
  'clipboard',
  'execute',
  'file',
  'gui',
  'notify',
  'sysinfo',
  'window',
]);

function canonicalCompanionType(type: string, action?: string): string {
  if (!type) return type;
  if (type.startsWith('desktop:')) return type;
  const parts = type.split(':');
  if (COMPANION_COMMAND_PREFIXES.has(parts[0])) {
    if (parts.length > 1) return `desktop:${type}`;
    if (action && !String(action).includes(':')) return `desktop:${type}:${action}`;
    return `desktop:${type}`;
  }
  return type;
}

function normalizeCommand(raw: any): BridgeCommand {
  const originalType = raw?.type || raw?.action;
  const type = canonicalCompanionType(String(originalType || ''), raw?.action);
  if (!type) throw new Error('command type required');
  return { ...raw, type } as BridgeCommand;
}

interface RecordedAction {
  action: 'click' | 'type' | 'press' | 'navigate' | 'scroll' | 'wait' | 'assert' | 'tab_focus';
  // Empir3 Bridge element ref (preferred for playback)
  ref?: string;
  refLabel?: string;  // human-readable label from a11y tree
  refRole?: string;   // role from a11y tree
  // Fallback coordinates + CSS selector
  x?: number;
  y?: number;
  selector?: string;
  // type / press
  text?: string;
  key?: string;
  // navigate
  url?: string;
  // URL the tab was on when this action was recorded (for tab-routing during playback)
  pageUrl?: string;
  // timing
  delay: number;
  // assert
  assertType?: 'contains_text' | 'url_match' | 'element_exists' | 'element_visible';
  assertValue?: string;
  // metadata
  tag?: string;       // variable tag like {{PASSWORD}}
  screenshot?: string;
}

interface Recording {
  name: string;
  description?: string;
  startUrl: string;
  recorded: string;
  duration: number;
  viewport: { width: number; height: number };
  actions: RecordedAction[];
  variables: string[];
  engine: 'empir3';  // distinguish from old Playwright recordings
}

interface SessionContext {
  startedAt: string;
  currentUrl: string;
  messageCount: number;
  feedbackCount: number;
  lastActivity: string;
  pages: string[];
}

interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  bounds?: { x: number; y: number; width: number; height: number };
  [key: string]: any;
}

interface ActionReceipt {
  id: string;
  timestamp: string;
  source: string;
  type: string;
  ok: boolean;
  elapsedMs: number;
  input: Record<string, any>;
  result?: Record<string, any>;
  error?: string;
}

interface BrowserTabTarget {
  targetId: string;
  url: string;
  title: string;
  updatedAt: string;
  source?: string;
}

// ─── State ───────────────────────────────────────────────────

let overlayClients: Set<WebSocket> = new Set();
let cliClients: Set<WebSocket> = new Set();
let bridgeProcess: ChildProcess | null = null;
let bridgeReachable = false;
let cdpConnected = false;
let overlayInjected = false;
let overlayEnsureInFlight: Promise<Record<string, any>> | null = null;
let overlayHealthTimer: ReturnType<typeof setInterval> | null = null;
let lastOverlayEnsureAt = 0;
let currentUrl = '';
let lastKnownUrl = '';
let agentControlTarget: BrowserTabTarget | null = null;
let userFocusTarget: BrowserTabTarget | null = null;
const ACTION_LOG_MAX = 80;
let actionLog: ActionReceipt[] = [];

function pruneOverlayClients(): number {
  for (const ws of Array.from(overlayClients)) {
    if ((ws as any).readyState !== 1 /* OPEN */) overlayClients.delete(ws);
  }
  return overlayClients.size;
}

function overlayDomReady(dom: any): boolean {
  return !!(dom && dom.ok !== false && dom.loaded && dom.bubble && dom.hasMoveCursor);
}

// Tray command queue. The welcome page enqueues lifecycle commands (restart
// tray, quit, uninstall, check updates, toggle auto-update); the Python tray
// drains them on its next status poll and dispatches them. We keep it small
// (drained on every poll) so a backed-up tray can't accumulate commands.
type TrayCommand = { id: string; type: string; params?: Record<string, any>; enqueuedAt: number };
const TRAY_COMMAND_MAX = 16;
let trayCommandQueue: TrayCommand[] = [];
let companionCapabilityCache: any = null;
let companionCapabilityCacheTime = 0;
const activeClaudeCliRuns = new Map<string, ChildProcess>();
const activeCodexCliRuns = new Map<string, ChildProcess>();
const activeGeminiCliRuns = new Map<string, ChildProcess>();
const activeGrokCliRuns = new Map<string, ChildProcess>();
const activeAgyCliRuns = new Map<string, IPty>();
const launchTimestamps: number[] = [];
const executeTimestamps: number[] = [];
const guiTimestamps: number[] = [];
let sessionCtx: SessionContext = {
  startedAt: new Date().toISOString(),
  currentUrl: '',
  messageCount: 0,
  feedbackCount: 0,
  lastActivity: new Date().toISOString(),
  pages: []
};

let isRecording = false;
let recordingActions: RecordedAction[] = [];
let recordingStartTime = 0;
let recordingStartUrl = '';
let lastActionTime = 0;
let recentBridgeRecordedActions: Array<{ action: RecordedAction; at: number }> = [];
let isPlaying = false;

// Live transport state for an in-flight playback. Control commands
// (playback_pause / resume / stop / seek / speed / step) mutate this object;
// the playRecording loop reads it between actions. Because the loop awaits
// (inter-action delays + CDP calls), control commands arriving on a separate
// HTTP/WS request are handled concurrently and take effect on the next tick.
interface PlaybackControl {
  paused: boolean;
  stop: boolean;
  speed: number;
  seekTo: number | null;  // absolute 0-based action index to jump to
  stepOnce: boolean;      // advance exactly one action then re-pause
  current: number;        // current 0-based action index
  total: number;
  name: string;
  action: string;         // current action label (so a synced overlay shows it, not "Starting…")
  ref: string;
}
let playbackControl: PlaybackControl = {
  paused: false, stop: false, speed: 1, seekTo: null, stepOnce: false, current: 0, total: 0, name: '', action: '', ref: '',
};
function resetPlaybackControl() {
  playbackControl = { paused: false, stop: false, speed: 1, seekTo: null, stepOnce: false, current: 0, total: 0, name: '', action: '', ref: '' };
}
/** Snapshot of transport state broadcast to the overlay so it can render the scrubber. */
function transportSnapshot(extra: Record<string, any> = {}) {
  return {
    type: 'playback_transport',
    active: isPlaying,
    paused: playbackControl.paused,
    speed: playbackControl.speed,
    current: playbackControl.current,
    total: playbackControl.total,
    name: playbackControl.name,
    action: playbackControl.action,
    ref: playbackControl.ref,
    ...extra,
  };
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version || 'dev';
  } catch {
    return 'dev';
  }
}

type BridgeAuth = {
  legacyToken?: string;
  token?: string;
  user?: { id?: string; email?: string; name?: string; role?: string };
  channelId?: string | null;
  serverUrl?: string;
  wsUrl?: string;
  environment?: 'production' | 'local-dev' | 'custom';
};

type PairPollState = {
  code: string;
  serverUrl: string;
  environment: 'production' | 'local-dev' | 'custom';
  tries: number;
  lastStatus: string;
  lastError: string | null;
  timer: ReturnType<typeof setInterval> | null;
};

let activePairPoll: PairPollState | null = null;

function normalizeEmpir3Server(input?: string | null): string {
  const raw = String(input || '').trim();
  if (!raw) return DEFAULT_EMPIR3_SERVER;
  const withProtocol = /^https?:\/\//i.test(raw)
    ? raw
    : (/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(raw) ? `http://${raw}` : `https://${raw}`);
  try {
    const u = new URL(withProtocol);
    u.pathname = u.pathname.replace(/\/+$/, '');
    if (u.pathname === '/') u.pathname = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return DEFAULT_EMPIR3_SERVER;
  }
}

function classifyEmpir3Server(serverUrl?: string | null): 'production' | 'local-dev' | 'custom' {
  const normalized = normalizeEmpir3Server(serverUrl);
  const host = (() => {
    try { return new URL(normalized).host.toLowerCase(); } catch { return ''; }
  })();
  if (normalized === DEFAULT_EMPIR3_SERVER || host === 'app.empir3.com') return 'production';
  if (normalized === LOCAL_DEV_EMPIR3_SERVER || host === 'localhost:3005' || host === '127.0.0.1:3005') return 'local-dev';
  return 'custom';
}

function defaultEmpir3WsUrl(serverUrl = EMPIR3_SERVER): string {
  try {
    const u = new URL(normalizeEmpir3Server(serverUrl));
    u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
    u.pathname = '/ws';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return 'wss://app.empir3.com/ws';
  }
}

function normalizeEmpir3WsUrl(wsUrl: string | undefined | null, serverUrl = EMPIR3_SERVER): string {
  const fallback = defaultEmpir3WsUrl(serverUrl);
  if (!wsUrl) return fallback;
  try {
    const u = new URL(wsUrl);
    if (u.pathname.replace(/\/+$/, '') === '/relay') return fallback;
    return u.toString();
  } catch {
    return fallback;
  }
}

function readBridgeAuth(): BridgeAuth | null {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function bridgeAuthToken(): string {
  const auth = readBridgeAuth();
  return auth?.legacyToken || auth?.token || '';
}

function bridgeAuthServerUrl(): string {
  const auth = readBridgeAuth();
  return auth?.serverUrl ? normalizeEmpir3Server(auth.serverUrl) : '';
}

function bridgeAuthWsUrl(): string {
  const auth = readBridgeAuth();
  if (auth?.wsUrl) return normalizeEmpir3WsUrl(auth.wsUrl, auth.serverUrl || EMPIR3_SERVER);
  return auth?.serverUrl ? defaultEmpir3WsUrl(auth.serverUrl) : '';
}

function bridgeAuthEnvironment(): 'production' | 'local-dev' | 'custom' {
  const auth = readBridgeAuth();
  return auth?.environment || classifyEmpir3Server(auth?.serverUrl || EMPIR3_SERVER);
}

function hasBridgeAuth(): boolean {
  return !!bridgeAuthToken();
}

function isStandaloneMode(): boolean {
  return existsSync(STANDALONE_MARKER);
}

function markStandaloneMode() {
  try {
    mkdirSync(join(homedir(), '.empir3-bridge'), { recursive: true });
    writeFileSync(STANDALONE_MARKER, new Date().toISOString());
  } catch {}
}

function clearStandaloneMode() {
  try { unlinkSync(STANDALONE_MARKER); } catch {}
}

function defaultBridgeSettings() {
  return {
    deviceId: `bridge-${randomUUID()}`,
    deviceName: hostname(),
    homeDirectory: join(homedir(), 'Documents', 'Empir3'),
    globalSafety: { read: true, write: false, execute: false },
    empir3Permissions: { read: true, write: false, execute: false },
    desktopSetup: defaultDesktopSetupState(),
    // When true, desktop_select_region regions are persistent ("keep until I
    // release") by default — no idle expiry. Per-call keepOpen/persist flags
    // override this either way.
    desktopFocusKeepOpenDefault: false,
  };
}

function defaultDesktopSetupState() {
  return {
    completed: false,
    completedAt: null,
    updatedAt: null,
    bridgeVersion: BRIDGE_VERSION,
    checklist: {
      overlay: false,
      monitors: false,
      calibration: false,
      recordings: false,
    },
    snapshot: null,
  };
}

function normalizeDesktopSetupState(raw: any = {}) {
  const base = defaultDesktopSetupState();
  const checklist = raw?.checklist && typeof raw.checklist === 'object' ? raw.checklist : {};
  return {
    completed: !!raw?.completed,
    completedAt: typeof raw?.completedAt === 'string' ? raw.completedAt : null,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    bridgeVersion: typeof raw?.bridgeVersion === 'string' ? raw.bridgeVersion : BRIDGE_VERSION,
    checklist: {
      overlay: typeof checklist.overlay === 'boolean' ? checklist.overlay : base.checklist.overlay,
      monitors: typeof checklist.monitors === 'boolean' ? checklist.monitors : base.checklist.monitors,
      calibration: typeof checklist.calibration === 'boolean' ? checklist.calibration : base.checklist.calibration,
      recordings: typeof checklist.recordings === 'boolean' ? checklist.recordings : base.checklist.recordings,
    },
    snapshot: raw?.snapshot && typeof raw.snapshot === 'object' ? raw.snapshot : null,
  };
}

function ensureSettingsFile() {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  if (!existsSync(SETTINGS_FILE)) {
    writeFileSync(SETTINGS_FILE, JSON.stringify(defaultBridgeSettings(), null, 2));
    return;
  }
  try {
    const current = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    let changed = false;
    const next = { ...current };
    if (!next.deviceId || typeof next.deviceId !== 'string') {
      next.deviceId = `bridge-${randomUUID()}`;
      changed = true;
    }
    if (!next.deviceName) {
      next.deviceName = hostname();
      changed = true;
    }
    if (!next.homeDirectory) {
      next.homeDirectory = join(homedir(), 'Documents', 'Empir3');
      changed = true;
    }
    if (!next.globalSafety) {
      next.globalSafety = normalizeRwe(next.permissions, DEFAULT_BRIDGE_SAFETY);
      changed = true;
    }
    if (!next.empir3Permissions) {
      next.empir3Permissions = normalizeRwe(next.permissions, DEFAULT_BRIDGE_SAFETY);
      changed = true;
    }
    if (!next.desktopSetup || typeof next.desktopSetup !== 'object') {
      next.desktopSetup = defaultDesktopSetupState();
      changed = true;
    } else {
      const normalizedSetup = normalizeDesktopSetupState(next.desktopSetup);
      if (JSON.stringify(normalizedSetup) !== JSON.stringify(next.desktopSetup)) {
        next.desktopSetup = normalizedSetup;
        changed = true;
      }
    }
    if (changed) writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  } catch {
    writeFileSync(SETTINGS_FILE, JSON.stringify(defaultBridgeSettings(), null, 2));
  }
}

function saveBridgeAuth(auth: BridgeAuth) {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  const serverUrl = normalizeEmpir3Server(auth.serverUrl || EMPIR3_SERVER);
  writeFileSync(AUTH_FILE, JSON.stringify({
    ...auth,
    serverUrl,
    wsUrl: normalizeEmpir3WsUrl(auth.wsUrl, serverUrl),
    environment: auth.environment || classifyEmpir3Server(serverUrl),
  }, null, 2));
  ensureSettingsFile();
}

function readBridgeSettings(): any {
  ensureSettingsFile();
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch {
    return defaultBridgeSettings();
  }
}

function saveBridgeSettings(settings: any) {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

const DEFAULT_CATEGORY_PERMISSIONS = { browser: true, desktop: true, shell: false };
const DEFAULT_BRIDGE_SAFETY = { read: true, write: false, execute: false };

function normalizeRwe(raw: any, fallback = DEFAULT_BRIDGE_SAFETY) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    read: typeof source.read === 'boolean' ? source.read : !!fallback.read,
    write: typeof source.write === 'boolean' ? source.write : !!fallback.write,
    execute: typeof source.execute === 'boolean' ? source.execute : !!fallback.execute,
  };
}

function bridgeGlobalSafety(settings: any = readBridgeSettings()) {
  return normalizeRwe(settings.globalSafety || settings.permissions, DEFAULT_BRIDGE_SAFETY);
}

function bridgeEmpir3Permissions(settings: any = readBridgeSettings()) {
  return normalizeRwe(settings.empir3Permissions || settings.permissions, DEFAULT_BRIDGE_SAFETY);
}

function validateHomeDirectoryCandidate(input: unknown) {
  const value = String(input || '').trim();
  if (!value) return { ok: false, error: 'Home directory is empty' };
  const target = resolve(value);
  const normalized = target.toLowerCase();
  const userHome = resolve(homedir()).toLowerCase();
  const driveRoot = /^[a-z]:\\?$/i.test(target) || target === dirname(target);
  if (driveRoot) return { ok: false, error: 'Home directory cannot be a drive or filesystem root' };
  if (normalized === userHome) return { ok: false, error: 'Home directory cannot be the entire user profile' };
  const blocked = [
    resolve(process.env.SystemRoot || 'C:\\Windows').toLowerCase(),
    resolve(process.env.ProgramFiles || 'C:\\Program Files').toLowerCase(),
    resolve(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').toLowerCase(),
    join(userHome, 'appdata').toLowerCase(),
    join(userHome, '.ssh').toLowerCase(),
    join(userHome, '.aws').toLowerCase(),
    join(userHome, '.azure').toLowerCase(),
    join(userHome, '.gnupg').toLowerCase(),
  ];
  for (const prefix of blocked) {
    if (normalized === prefix || normalized.startsWith(prefix + '\\')) {
      return { ok: false, error: `Home directory cannot point at protected location: ${target}` };
    }
  }
  return { ok: true, path: target };
}

function publicBridgeSettings(settings: any = readBridgeSettings()) {
  const categoryPermissions = { ...DEFAULT_CATEGORY_PERMISSIONS, ...(settings.categoryPermissions || {}) };
  const globalSafety = bridgeGlobalSafety(settings);
  const empir3Permissions = bridgeEmpir3Permissions(settings);
  return {
    deviceId: settings.deviceId || 'empir3-bridge-local',
    deviceName: settings.deviceName || process.env.COMPUTERNAME || hostname(),
    homeDirectory: settings.homeDirectory || join(homedir(), 'Documents', 'Empir3'),
    globalSafety,
    empir3Permissions,
    // Back-compat for older settings UI code. This is now the global PC
    // safety floor, not the website-managed empir3 policy.
    permissions: globalSafety,
    categoryPermissions: {
      browser: !!categoryPermissions.browser,
      desktop: !!categoryPermissions.desktop,
      shell: !!categoryPermissions.shell,
    },
    autoUpdate: settings.autoUpdate !== false,
    lendClaudeMax: !!settings.lendClaudeMax,
    lendOpenAiCodex: !!settings.lendOpenAiCodex,
    lendGoogleGemini: !!settings.lendGoogleGemini,
    lendXaiGrok: !!settings.lendXaiGrok,
    lendGoogleAntigravity: !!settings.lendGoogleAntigravity,
    lendGitHubCli: !!settings.lendGitHubCli,
    githubScopes: normalizeGhScopes(settings.githubScopes),
    handlers: settings.handlers || {},
    categoryUsage: settings.categoryUsage || {},
    desktopSetup: normalizeDesktopSetupState(settings.desktopSetup),
    desktopFocusKeepOpenDefault: !!settings.desktopFocusKeepOpenDefault,
  };
}

function saveBridgeSettingsPatch(patch: any = {}) {
  const current = readBridgeSettings();
  const next = { ...current };

  if (typeof patch.deviceName === 'string') {
    const trimmed = patch.deviceName.trim();
    if (trimmed) next.deviceName = trimmed;
  }
  if (typeof patch.homeDirectory === 'string') {
    const trimmed = patch.homeDirectory.trim();
    if (trimmed) {
      const validated = validateHomeDirectoryCandidate(trimmed);
      if (!validated.ok) throw new Error(validated.error);
      next.homeDirectory = validated.path;
    }
  }
  if (patch.globalSafety && typeof patch.globalSafety === 'object') {
    next.globalSafety = normalizeRwe(patch.globalSafety, bridgeGlobalSafety(current));
  }
  if (patch.empir3Permissions && typeof patch.empir3Permissions === 'object') {
    next.empir3Permissions = normalizeRwe(patch.empir3Permissions, bridgeEmpir3Permissions(current));
  }
  if (patch.permissions && typeof patch.permissions === 'object') {
    next.globalSafety = normalizeRwe(patch.permissions, bridgeGlobalSafety(current));
  }
  if (patch.categoryPermissions && typeof patch.categoryPermissions === 'object') {
    const cur = { ...DEFAULT_CATEGORY_PERMISSIONS, ...(current.categoryPermissions || {}) };
    for (const key of ['browser', 'desktop', 'shell'] as const) {
      if (typeof patch.categoryPermissions[key] === 'boolean') cur[key] = patch.categoryPermissions[key];
    }
    next.categoryPermissions = cur;
  }
  if (typeof patch.autoUpdate === 'boolean') next.autoUpdate = patch.autoUpdate;
  if (typeof patch.desktopFocusKeepOpenDefault === 'boolean') next.desktopFocusKeepOpenDefault = patch.desktopFocusKeepOpenDefault;
  if (typeof patch.lendClaudeMax === 'boolean') next.lendClaudeMax = patch.lendClaudeMax;
  if (typeof patch.lendOpenAiCodex === 'boolean') next.lendOpenAiCodex = patch.lendOpenAiCodex;
  if (typeof patch.lendGoogleGemini === 'boolean') next.lendGoogleGemini = patch.lendGoogleGemini;
  if (typeof patch.lendXaiGrok === 'boolean') next.lendXaiGrok = patch.lendXaiGrok;
  if (typeof patch.lendGoogleAntigravity === 'boolean') next.lendGoogleAntigravity = patch.lendGoogleAntigravity;
  if (typeof patch.lendGitHubCli === 'boolean') next.lendGitHubCli = patch.lendGitHubCli;
  // GitHub CLI scope matrix — fine-grained per-capability gates on top of
  // the lendGitHubCli master toggle. normalizeGhScopes fills any unset
  // scope from the safe default baseline.
  if (patch.githubScopes && typeof patch.githubScopes === 'object') {
    next.githubScopes = normalizeGhScopes({ ...normalizeGhScopes(current.githubScopes), ...patch.githubScopes });
  }
  // Handler-family toggles — same flat schema the tray uses. Welcome
  // console flips higgsfield via this patch instead of the tray menu.
  if (patch.handlers && typeof patch.handlers === 'object') {
    const cur = { ...(current.handlers || {}) };
    for (const [name, entry] of Object.entries(patch.handlers)) {
      if (entry && typeof entry === 'object' && typeof (entry as any).enabled === 'boolean') {
        cur[name] = { ...(cur[name] || {}), enabled: !!(entry as any).enabled };
      }
    }
    next.handlers = cur;
  }
  if (patch.desktopSetup && typeof patch.desktopSetup === 'object') {
    const cur = normalizeDesktopSetupState(current.desktopSetup);
    const incoming = patch.desktopSetup as any;
    const checklist = incoming.checklist && typeof incoming.checklist === 'object'
      ? { ...cur.checklist }
      : cur.checklist;
    if (incoming.checklist && typeof incoming.checklist === 'object') {
      for (const key of ['overlay', 'monitors', 'calibration', 'recordings'] as const) {
        if (typeof incoming.checklist[key] === 'boolean') checklist[key] = incoming.checklist[key];
      }
    }
    const completed = typeof incoming.completed === 'boolean' ? incoming.completed : cur.completed;
    next.desktopSetup = {
      ...cur,
      completed,
      completedAt: completed
        ? (typeof incoming.completedAt === 'string' ? incoming.completedAt : (cur.completedAt || new Date().toISOString()))
        : null,
      updatedAt: new Date().toISOString(),
      bridgeVersion: BRIDGE_VERSION,
      checklist,
      snapshot: incoming.snapshot && typeof incoming.snapshot === 'object' ? incoming.snapshot : cur.snapshot,
    };
  }

  saveBridgeSettings(next);
  companionCapabilityCache = null;
  companionCapabilityCacheTime = 0;
  if (empir3Connected) {
    setTimeout(() => reportEmpir3Device().catch((e: any) => {
      console.warn('[Empir3] Failed to report updated bridge settings:', e?.message || e);
    }), 0);
  }
  return publicBridgeSettings(next);
}

// CLI probes spawn `<cli> --version` for each lent CLI — and some are very
// expensive (agy --version boots a 15-20s runtime; gemini/codex boot Node + load
// large bundles). The welcome console polls /api/settings/state every 10-15s; with
// no cache those ~7 probes re-spawn on every poll, the slow (≈19s) calls OVERLAP,
// and the concurrent runtime-boot processes peg a core and saturate the daemon's
// shared event loop — which is what made /api/status / /api/relay-status take 5-8s
// and the tray show "Daemon not running". Cache the probe results; CLI
// install/version state changes rarely, and install/auth actions bust the cache.
let _cliProbeCache: { at: number; value: any[] } | null = null;
let _cliProbeInFlight: Promise<any[]> | null = null;
const CLI_PROBE_TTL_MS = 60000;
function invalidateCliProbeCache() { _cliProbeCache = null; }
async function probeAllClis(): Promise<any[]> {
  if (_cliProbeCache && Date.now() - _cliProbeCache.at < CLI_PROBE_TTL_MS) {
    return _cliProbeCache.value;
  }
  // Single-flight: while a probe is running (agy alone can take 15-20s), concurrent
  // callers (overlapping welcome-page polls) MUST share the one in-flight probe —
  // otherwise a thundering herd each spawns its own ~7 `--version` processes and the
  // concurrent runtime boots peg the core. The TTL cache then spares the repeats.
  if (_cliProbeInFlight) return _cliProbeInFlight;
  _cliProbeInFlight = (async () => {
    try {
      const value = await Promise.all([
        probeClaudeCli().catch((e: any) => ({ available: false, path: null, version: null, error: e?.message || String(e), device_opted_in: claudeDeviceOptedIn() })),
        probeCodexCli().catch((e: any) => ({ available: false, path: null, version: null, error: e?.message || String(e), device_opted_in: codexDeviceOptedIn() })),
        probeGeminiCli().catch((e: any) => ({ available: false, path: null, version: null, error: e?.message || String(e), device_opted_in: geminiDeviceOptedIn() })),
        probeGrokCli().catch((e: any) => ({ available: false, path: null, version: null, error: e?.message || String(e), device_opted_in: grokDeviceOptedIn() })),
        probeAgyCli().catch((e: any) => ({ available: false, path: null, version: null, error: e?.message || String(e), device_opted_in: agyDeviceOptedIn() })),
        probeHiggsfieldCli().catch((e: any) => ({ available: false, path: null, version: null, error: e?.message || String(e), device_opted_in: false, authenticated: false })),
        probeGithubCli(githubDeviceOptedIn(), githubScopes()).catch((e: any) => ({ available: false, path: null, version: null, error: e?.message || String(e), device_opted_in: githubDeviceOptedIn(), authenticated: false, scopes: githubScopes() })),
      ]);
      _cliProbeCache = { at: Date.now(), value };
      return value;
    } finally {
      _cliProbeInFlight = null;
    }
  })();
  return _cliProbeInFlight;
}

async function buildSettingsState() {
  const auth = readBridgeAuth();
  const paired = !!(EMPIR3_WS_URL && (EMPIR3_AUTH_TOKEN || auth?.legacyToken || auth?.token));
  const [claude, codex, gemini, grok, agy, higgsfield, github] = await probeAllClis();
  // Attach auth signals for CLIs where the probe doesn't already supply
  // one. Higgsfield's probe already includes `authenticated` from the
  // handler. Phase 3 — feeds the per-row Auth-status badge.
  const claudeAuth = claudeAuthSignal();
  const codexAuth = codexAuthSignal();
  const geminiAuth = geminiAuthSignal();
  const grokAuth = grokAuthSignal();
  const agyAuth = agyAuthSignal();
  (claude as any).authenticated = claudeAuth.authenticated;
  (claude as any).auth_via = claudeAuth.via;
  (codex as any).authenticated = codexAuth.authenticated;
  (codex as any).auth_via = codexAuth.via;
  (gemini as any).authenticated = geminiAuth.authenticated;
  (gemini as any).auth_via = geminiAuth.via;
  (grok as any).authenticated = grokAuth.authenticated;
  (grok as any).auth_via = grokAuth.via;
  (agy as any).authenticated = agyAuth.authenticated;
  (agy as any).auth_via = agyAuth.via;
  // Attach platform-resolved install info so a NOT INSTALLED row can render
  // the copy command + Get-it link + Install button without the front-end
  // hard-coding any of it (single source of truth = CLI_INSTALL).
  for (const [id, p] of [['claude', claude], ['codex', codex], ['gemini', gemini], ['grok', grok], ['agy', agy], ['higgsfield', higgsfield], ['github', github]] as const) {
    const info = cliInstallPublic(id);
    if (info && !(p as any).available) (p as any).install = info;
  }
  const customProvidersState = await buildCustomProvidersState();
  const chat = publicConfig();
  // Hide custom_llm from the permissions surface when no provider is
  // configured — same pattern as the higgsfield family-gate. Keeps the
  // welcome console's permissions count honest (no phantom blocked tool
  // with nothing to dispatch to) and matches the MCP tools/list shape.
  if (!customProvidersState || customProvidersState.length === 0) {
    const { custom_llm: _omit, ...rest } = chat.enabledTools;
    (chat as any).enabledTools = rest;
  }
  return {
    ok: true,
    version: BRIDGE_VERSION,
    port: PORT,
    bridgeUrl: BRIDGE_URL,
    paths: {
      chatConfigFile: join(homedir(), '.empir3-bridge', 'config.json'),
      bridgeSettingsFile: SETTINGS_FILE,
      dataDir: SETTINGS_DIR,
    },
    chat,
    bridge: publicBridgeSettings(),
    account: {
      mode: paired ? 'paired' : (isStandaloneMode() ? 'standalone' : 'splash'),
      hasAuth: paired,
      user: auth?.user || null,
      serverUrl: auth?.serverUrl || EMPIR3_SERVER,
      environment: bridgeAuthEnvironment(),
      relayConnected: paired && empir3Connected,
      channelId: auth?.channelId || null,
    },
    providers: {
      claude,
      codex,
      gemini,
      grok,
      agy,
      higgsfield,
      github,
    },
    customProviders: customProvidersState,
  };
}

function hasBridgePermission(kind: 'read' | 'write' | 'execute'): boolean {
  const permissions = bridgeGlobalSafety(readBridgeSettings());
  return !!permissions[kind];
}

function permissionDenied(kind: 'read' | 'write' | 'execute') {
  return { success: false, error: `Permission denied: ${kind[0].toUpperCase()}${kind.slice(1)} disabled` };
}

function hasEmpir3Permission(kind: 'read' | 'write' | 'execute'): boolean {
  const permissions = bridgeEmpir3Permissions(readBridgeSettings());
  return !!permissions[kind];
}

function empir3PermissionDenied(kind: 'read' | 'write' | 'execute') {
  const label = `${kind[0].toUpperCase()}${kind.slice(1)}`;
  return { success: false, error: `empir3 policy denies ${label} — change at app.empir3.com/settings` };
}

const COMMAND_TOOL_MAP: Record<string, string> = {
  status: 'browser_status',
  text: 'browser_text',
  snapshot: 'browser_snapshot',
  screenshot: 'browser_screenshot',
  navigate: 'browser_navigate',
  scroll: 'browser_scroll',
  refresh: 'browser_refresh',
  click: 'browser_click',
  click_ref: 'browser_click_ref',
  click_xy: 'browser_click_xy',
  type: 'browser_type',
  type_ref: 'browser_type_ref',
  press: 'browser_press',
  highlight: 'browser_highlight',
  evaluate: 'browser_evaluate',
  desktop_monitors: 'desktop_monitors',
  desktop_screenshot: 'desktop_screenshot',
  desktop_cursor_position: 'desktop_cursor_position',
  desktop_click: 'desktop_click',
  desktop_hover: 'desktop_hover',
  desktop_drag: 'desktop_drag',
  desktop_snapshot: 'desktop_snapshot',
  desktop_snapshot_som: 'desktop_snapshot_som',
  browser_tab_state: 'browser_tab_state',
  browser_tab_focus: 'browser_tab_focus',
  bridge_tool_advisor: 'bridge_tool_advisor',
  bridge_setup_status: 'bridge_setup_status',
  bridge_setup_save: 'bridge_setup_save',
  overlay_reinject: 'bridge_overlay_reinject',
  bridge_overlay_reinject: 'bridge_overlay_reinject',
  desktop_click_ref: 'desktop_click_ref',
  desktop_hover_ref: 'desktop_hover_ref',
  desktop_overlay: 'desktop_overlay',
  desktop_select_region: 'desktop_select_region',
  desktop_release_focus: 'desktop_release_focus',
  desktop_focus_status: 'desktop_focus_status',
  desktop_pointer_show: 'desktop_pointer_show',
  desktop_pointer_move: 'desktop_pointer_move',
  desktop_pointer_pulse: 'desktop_pointer_pulse',
  desktop_pointer_hide: 'desktop_pointer_hide',
  desktop_pointer_status: 'desktop_pointer_status',
  desktop_calibrate_pointer: 'desktop_calibrate_pointer',
  desktop_calibration_status: 'desktop_calibration_status',
  desktop_screenshot_zoom: 'desktop_screenshot_zoom',
  desktop_click_cell: 'desktop_click_cell',
  desktop_pointer_cell: 'desktop_pointer_cell',
  desktop_focus_grid: 'desktop_focus_grid',
  desktop_pick_point: 'desktop_pick_point',
  desktop_click_page: 'desktop_click_page',
  desktop_pointer_page: 'desktop_pointer_page',
  page_to_screen: 'page_to_screen',
  desktop_toolbar: 'desktop_toolbar',
  record_start: 'browser_record_start',
  record_stop: 'browser_record_stop',
  play: 'browser_play',
  recordings: 'browser_recordings',
  chat: 'browser_chat',
  read_chat: 'browser_read_chat',
  action_log: 'bridge_action_log',
  reliability_status: 'bridge_reliability_status',
  reliability_smoke: 'bridge_reliability_smoke',
  safety_status: 'bridge_safety_status',
  safety_lockdown: 'bridge_revoke_control',
  higgsfield_status: 'higgsfield_status',
  higgsfield_list: 'higgsfield_list',
  higgsfield_models: 'higgsfield_models',
  higgsfield_generate: 'higgsfield_generate',
  cli_run: 'cli_run',
  cli_runs: 'cli_runs',
  cli_run_status: 'cli_run_status',
  cli_status: 'cli_status',
  custom_llm: 'custom_llm',
};

const TOOL_PERMISSION_REQUIREMENTS: Record<string, 'read' | 'write' | 'execute' | null> = {
  bridge_tool_advisor: 'read',
  bridge_setup_status: 'read',
  bridge_setup_save: 'write',
  bridge_overlay_reinject: 'read',
  browser_status: 'read',
  browser_tab_state: 'read',
  browser_tab_focus: 'execute',
  browser_text: 'read',
  browser_snapshot: 'read',
  browser_screenshot: 'read',
  desktop_monitors: 'read',
  desktop_screenshot: 'read',
  desktop_screenshot_zoom: 'read',
  desktop_cursor_position: 'read',
  desktop_snapshot: 'read',
  desktop_snapshot_som: 'read',
  desktop_focus_status: 'read',
  desktop_pointer_status: 'read',
  desktop_calibration_status: 'read',
  browser_navigate: 'read',
  browser_scroll: 'read',
  browser_refresh: 'read',
  browser_click: 'execute',
  browser_click_ref: 'execute',
  browser_click_xy: 'execute',
  browser_type: 'execute',
  browser_type_ref: 'execute',
  browser_press: 'execute',
  browser_highlight: 'execute',
  desktop_click: 'execute',
  desktop_hover: 'execute',
  desktop_drag: 'execute',
  desktop_click_ref: 'execute',
  desktop_hover_ref: 'execute',
  desktop_overlay: 'execute',
  desktop_select_region: 'execute',
  desktop_release_focus: 'execute',
  desktop_pointer_show: 'execute',
  desktop_pointer_move: 'execute',
  desktop_pointer_pulse: 'execute',
  desktop_pointer_hide: 'execute',
  desktop_calibrate_pointer: 'execute',
  desktop_click_cell: 'execute',
  desktop_pointer_cell: 'execute',
  desktop_focus_grid: 'execute',
  desktop_pick_point: 'execute',
  desktop_toolbar: 'execute',
  browser_evaluate: 'execute',
  browser_record_start: 'write',
  browser_record_stop: 'write',
  browser_play: 'execute',
  browser_recordings: 'read',
  browser_chat: 'write',
  browser_read_chat: 'read',
  bridge_action_log: 'read',
  bridge_reliability_status: 'read',
  bridge_reliability_smoke: 'read',
  bridge_safety_status: 'read',
  bridge_revoke_control: 'write',
  higgsfield_status: 'read',
  higgsfield_list: 'read',
  higgsfield_models: 'read',
  higgsfield_generate: 'execute',
  cli_run: 'execute',
  cli_runs: 'read',
  cli_run_status: 'read',
  custom_llm: 'execute',
};

const BROWSER_READ_ACTIONS = new Set(['status', 'snapshot', 'text', 'screenshot', 'navigate', 'scroll', 'refresh', 'read_chat', 'recordings', 'close']);
const BROWSER_WRITE_ACTIONS = new Set(['chat', 'record_start', 'record_stop']);
const DESKTOP_READ_ACTIONS = new Set(['list', 'active', 'status', 'overview', 'quick', 'position', 'screen_size', 'screenshot', 'get', 'read']);

function commandToolName(cmd: BridgeCommand): string | null {
  const direct = COMMAND_TOOL_MAP[String(cmd.type || '')];
  if (direct) return direct;
  const relayStyle = parseRelayStyleDesktopCommand(cmd);
  if (!relayStyle) return null;
  if (relayStyle.base === 'desktop:browse' || relayStyle.base === 'desktop:agent-browser') {
    const action = relayStyle.action || 'status';
    const mapped = COMMAND_TOOL_MAP[action === 'get_text' ? 'text' : action === 'record_play' ? 'play' : action];
    return mapped || null;
  }
  if (relayStyle.base === 'desktop:gui') {
    const action = relayStyle.action || '';
    if (action === 'screenshot') return 'desktop_screenshot';
    if (action === 'click' || action === 'doubleclick') return 'desktop_click';
    if (action === 'move') return 'desktop_hover';
    if (action === 'monitors') return 'desktop_monitors';
    if (action === 'position') return 'desktop_cursor_position';
    if (action === 'snapshot') return 'desktop_snapshot';
    if (action === 'click_ref') return 'desktop_click_ref';
    if (action === 'hover_ref') return 'desktop_hover_ref';
    if (action === 'overlay') return 'desktop_overlay';
    if (action === 'select_region') return 'desktop_select_region';
    if (action === 'release_focus') return 'desktop_release_focus';
    if (action === 'focus_status') return 'desktop_focus_status';
    if (action === 'pointer_show') return 'desktop_pointer_show';
    if (action === 'pointer_move') return 'desktop_pointer_move';
    if (action === 'pointer_pulse') return 'desktop_pointer_pulse';
    if (action === 'pointer_hide') return 'desktop_pointer_hide';
    if (action === 'pointer_status') return 'desktop_pointer_status';
    if (action === 'calibrate_pointer') return 'desktop_calibrate_pointer';
    if (action === 'calibration_status') return 'desktop_calibration_status';
    if (action === 'screenshot_zoom') return 'desktop_screenshot_zoom';
    if (action === 'snapshot_som') return 'desktop_snapshot_som';
    if (action === 'click_cell') return 'desktop_click_cell';
    if (action === 'pointer_cell') return 'desktop_pointer_cell';
    if (action === 'focus_grid') return 'desktop_focus_grid';
    if (action === 'pick_point') return 'desktop_pick_point';
    return null;
  }
  return null;
}

function requiredBridgePermission(cmd: BridgeCommand): 'read' | 'write' | 'execute' | null {
  const type = String(cmd.type || '');
  const toolName = commandToolName(cmd);
  // desktop_toolbar is an execute-gated tool, but its `status` action is pure
  // read-only introspection (is the toolbar process running?). Treat status as
  // read so it works while the rest of the (execute) group is off.
  if (toolName === 'desktop_toolbar' && String((cmd as any).action || 'show').toLowerCase() === 'status') return 'read';
  if (toolName && TOOL_PERMISSION_REQUIREMENTS[toolName] !== undefined) return TOOL_PERMISSION_REQUIREMENTS[toolName];
  // A `:probe` is a read-only capability check (spawns `<cli> --version`,
  // reports lend/auth state) — classify it as 'read' so the website's Execute
  // policy can stay OFF while the server still learns which CLIs are available.
  if (type.startsWith('claude:cli:') || type.startsWith('codex:cli:') || type.startsWith('gemini:cli:') || type.startsWith('grok:cli:') || type.startsWith('agy:cli:')) return /:probe$/.test(type) ? 'read' : 'execute';
  if (type === 'higgsfield_generate') return 'execute';
  if (type === 'higgsfield_status' || type === 'higgsfield_list' || type === 'higgsfield_models') return 'read';
  if (type === 'cli_run') return 'execute';
  if (type === 'cli_runs' || type === 'cli_run_status' || type === 'cli_status') return 'read';
  if (type === 'github:exec') return 'execute';
  if (type === 'github_status') return 'read';
  // custom_llm hits an outbound HTTP endpoint that spends the user's
  // tokens (cloud aggregators) or compute (local LLMs). Execute.
  if (type === 'custom_llm') return 'execute';
  if (['status', 'text', 'snapshot', 'screenshot', 'browser_tab_state', 'desktop_monitors', 'desktop_screenshot', 'desktop_screenshot_zoom', 'desktop_cursor_position', 'desktop_screen_size', 'desktop_snapshot', 'desktop_snapshot_som', 'desktop_focus_status', 'desktop_pointer_status', 'desktop_calibration_status', 'action_log', 'reliability_status', 'reliability_smoke', 'safety_status', 'bridge_tool_advisor', 'bridge_setup_status', 'overlay_reinject', 'bridge_overlay_reinject', 'page_to_screen'].includes(type)) return 'read';
  if (['chat', 'read_chat', 'recordings'].includes(type)) return type === 'read_chat' || type === 'recordings' ? 'read' : 'write';
  if (['record_start', 'record_stop', 'safety_lockdown', 'bridge_setup_save'].includes(type)) return 'write';
  if (['navigate', 'scroll', 'refresh'].includes(type)) return 'read';
  if (['click', 'click_ref', 'click_xy', 'type', 'type_ref', 'press', 'highlight', 'evaluate', 'play', 'browser_tab_focus', 'desktop:browse:show', 'desktop_click', 'desktop_hover', 'desktop_drag', 'desktop_click_ref', 'desktop_hover_ref', 'desktop_overlay', 'desktop_select_region', 'desktop_release_focus', 'desktop_pointer_show', 'desktop_pointer_move', 'desktop_pointer_pulse', 'desktop_pointer_hide', 'desktop_calibrate_pointer', 'desktop_click_cell', 'desktop_pointer_cell', 'desktop_focus_grid', 'desktop_pick_point', 'desktop_click_page', 'desktop_pointer_page', 'desktop_toolbar'].includes(type)) return 'execute';

  const relayStyle = parseRelayStyleDesktopCommand(cmd);
  if (!relayStyle) return null;
  const action = relayStyle.action || '';
  if (relayStyle.base === 'desktop:capabilities' || relayStyle.base === 'desktop:sysinfo') return 'read';
  if (relayStyle.base === 'desktop:file:pull') return 'read';
  if (relayStyle.base === 'desktop:file' || relayStyle.base === 'desktop:project:file' || relayStyle.base === 'desktop:sync:push') return 'write';
  if (relayStyle.base === 'desktop:sync:complete') return 'read';
  if (relayStyle.base === 'desktop:clipboard') return DESKTOP_READ_ACTIONS.has(action || 'read') ? 'read' : 'write';
  if (relayStyle.base === 'desktop:notify') return 'write';
  if (relayStyle.base === 'desktop:window') return DESKTOP_READ_ACTIONS.has(action || 'list') ? 'read' : 'execute';
  if (relayStyle.base === 'desktop:gui') {
    if (action === 'screenshot' || action === 'monitors' || action === 'position' || action === 'screensize' || action === 'snapshot' || action === 'snapshot_som' || action === 'focus_status' || action === 'pointer_status' || action === 'calibration_status') return 'read';
    return 'execute';
  }
  if (relayStyle.base === 'desktop:browse' || relayStyle.base === 'desktop:agent-browser') {
    if (BROWSER_READ_ACTIONS.has(action || 'status')) return 'read';
    if (BROWSER_WRITE_ACTIONS.has(action)) return 'write';
    return 'execute';
  }
  return 'execute';
}

function sourceUsesLocalMcpPolicy(cmd: BridgeCommand, source: string): boolean {
  return cmd.channel === 'mcp' || source === 'mcp' || source.includes('overlay');
}

// Read-only CLI actions (capability probes) must work even when the empir3
// Execute permission is OFF — advertising "this CLI is installed + lent +
// opted-in" runs nothing. Only turn/see/abort/tool:result actually execute.
// Gating the probe behind Execute made the server believe lent CLIs were
// unavailable, so it silently fell back to a server-local CLI instead of the
// user's bridge. Keep the probe ungated; the real run actions stay gated.
const READ_ONLY_CLI_ACTIONS = new Set(['probe']);

function enforceCommandPolicy(cmd: BridgeCommand, source: string) {
  const permission = requiredBridgePermission(cmd);
  if (permission && !hasBridgePermission(permission)) return permissionDenied(permission);
  // Handler-family gate (see TOOL_FAMILY in tool-defaults.ts). Coarse
  // tray-level toggle that disables an entire family regardless of
  // per-tool enabledTools or global R/W/X. Mirrored at MCP tools/list
  // (defense in depth) so a disabled family never appears in any agent's
  // tool inventory.
  const familyDenial = enforceHandlerFamilyGate(cmd);
  if (familyDenial) return familyDenial;
  if (sourceUsesLocalMcpPolicy(cmd, source)) {
    const toolName = commandToolName(cmd);
    if (toolName) {
      const cfg = loadConfig();
      if (cfg.enabledTools?.[toolName] === false) {
        // Allow read-only introspection of the toolbar even when the
        // (execute-gated) tool is disabled, so `desktop_toolbar status` and
        // the standard smoke plan don't error on a disabled group.
        const isReadOnlyToolbarStatus = toolName === 'desktop_toolbar'
          && String((cmd as any).action || 'show').toLowerCase() === 'status';
        if (!isReadOnlyToolbarStatus) {
          return { success: false, error: `MCP tool disabled locally: ${toolName}` };
        }
      }
    }
  }
  return null;
}

function enforceHandlerFamilyGate(cmd: BridgeCommand): { success: false; error: string } | null {
  const toolName = commandToolName(cmd) || String(cmd.type || '');
  const family = TOOL_FAMILY[toolName];
  if (!family) return null;
  const settings = readBridgeSettings();
  const enabled = !!settings?.handlers?.[family]?.enabled;
  if (!enabled) {
    return { success: false, error: `Handler "${family}" is disabled in the tray menu` };
  }
  return null;
}

function normalizeCompanionResult(result: any): any {
  if (!result || typeof result !== 'object') return { success: true, result };
  if (result.success === undefined && result.ok !== undefined) {
    return { ...result, success: !!result.ok, ok: undefined };
  }
  return result;
}

function checkRateLimit(bucket: number[], maxPerMinute: number, label: string): string | null {
  const now = Date.now();
  while (bucket.length && now - bucket[0] > 60_000) bucket.shift();
  if (bucket.length >= maxPerMinute) return `Rate limited: max ${maxPerMinute} ${label} per minute`;
  bucket.push(now);
  return null;
}

function expandUserPath(input: string): string {
  let expanded = String(input || '');
  if (expanded.startsWith('~')) expanded = join(homedir(), expanded.slice(1));
  expanded = expanded.replace(/%([^%]+)%/g, (_m, name) => process.env[name] || '');
  return resolve(expanded);
}

function withinPath(target: string, root: string): boolean {
  const resolvedTarget = resolve(target).toLowerCase();
  const resolvedRoot = resolve(root).toLowerCase();
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + '\\') || resolvedTarget.startsWith(resolvedRoot + '/');
}

function sanitizeRelativePath(input: string): string {
  return String(input || '')
    .replace(/\.\./g, '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function dedupePath(target: string): string {
  if (!existsSync(target)) return target;
  const ext = extname(target);
  const stem = target.slice(0, target.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem}_${i}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${stem}_${Date.now()}${ext}`;
}

function todayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function projectsRoot(): string {
  const configured = readBridgeSettings()?.homeDirectory || COMPANION_PROJECTS_ROOT;
  const leaf = basename(configured).toLowerCase();
  return leaf === 'projects' ? configured : join(configured, 'Projects');
}

const PROJECT_META_FILE = '.empir3-project.json';
const SYNC_IGNORED_NAMES = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache',
  '.turbo', '.vite', '.parcel-cache', '__pycache__', '.empir3-trash',
]);
const SYNC_IGNORED_EXTS = new Set(['.env', '.pem', '.key', '.pfx', '.sqlite', '.db']);
const MAX_SYNC_FILE_BYTES = 10 * 1024 * 1024;
const localSyncSeen = new Map<string, string>();
let localSyncTimer: NodeJS.Timeout | null = null;

function safeProjectFolderName(projectName: string, projectId?: string): string {
  const base = sanitizeRelativePath(projectName || projectId || 'Project')
    .split('/')
    .filter(Boolean)
    .join(' ')
    .replace(UNSAFE_FILENAME_CHARS, '_')
    .trim()
    .slice(0, 80) || 'Project';
  const root = projectsRoot();
  const preferred = join(root, base);
  if (!projectId || !existsSync(preferred)) return base;
  try {
    const meta = readProjectMeta(preferred);
    if (!meta?.projectId || meta.projectId === projectId) return base;
  } catch {}
  return `${base}-${projectId.slice(0, 8)}`;
}

function readProjectMeta(projectDir: string): any | null {
  const metaPath = join(projectDir, PROJECT_META_FILE);
  if (!existsSync(metaPath)) return null;
  try { return JSON.parse(readFileSync(metaPath, 'utf-8')); } catch { return null; }
}

function projectDirFor(projectName: string, projectId?: string): { root: string; projectDir: string; folder: string } {
  const root = projectsRoot();
  mkdirSync(root, { recursive: true });
  if (projectId && existsSync(root)) {
    try {
      for (const item of readdirSync(root)) {
        const full = join(root, item);
        if (!statSync(full).isDirectory()) continue;
        const meta = readProjectMeta(full);
        if (meta?.projectId === projectId) return { root, projectDir: full, folder: item };
      }
    } catch {}
  }
  const folder = safeProjectFolderName(projectName, projectId);
  return { root, projectDir: join(root, folder), folder };
}

function writeProjectMeta(projectDir: string, projectId: string | undefined, projectName: string, revision?: unknown) {
  if (!projectId) return;
  mkdirSync(projectDir, { recursive: true });
  const meta = {
    projectId,
    projectName: projectName || projectId,
    syncRevision: revision || null,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(projectDir, PROJECT_META_FILE), JSON.stringify(meta, null, 2), 'utf-8');
}

function shouldIgnoreSyncPath(relPath: string): boolean {
  const rel = sanitizeRelativePath(relPath);
  if (!rel || rel === PROJECT_META_FILE) return true;
  const parts = rel.split('/').filter(Boolean);
  if (parts.some(part => SYNC_IGNORED_NAMES.has(part))) return true;
  const lowerBase = basename(rel).toLowerCase();
  if (lowerBase === '.env' || lowerBase.startsWith('.env.')) return true;
  if (SYNC_IGNORED_EXTS.has(extname(lowerBase))) return true;
  return false;
}

function fileSha256(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function buildLocalProjectManifest() {
  const root = projectsRoot();
  const manifest: Record<string, { projectId?: string; projectName?: string; files: Array<{ path: string; size: number; mtimeMs: number; hash: string }> }> = {};
  if (!existsSync(root) || !hasBridgePermission('read')) return manifest;

  const walk = (dir: string, prefix: string, files: Array<{ path: string; size: number; mtimeMs: number; hash: string }>) => {
    for (const item of readdirSync(dir)) {
      const rel = prefix ? `${prefix}/${item}` : item;
      if (shouldIgnoreSyncPath(rel)) continue;
      const full = join(dir, item);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full, rel, files);
      } else if (st.isFile() && st.size <= MAX_SYNC_FILE_BYTES) {
        // Do NOT read+sha256 every file on every walk. This loop runs every 5s, and
        // hashing the entire workspace each tick pegged a core and blocked the event
        // loop (so /api/status & /api/relay-status took 5-8s and the tray showed the
        // daemon offline) once the workspace grew. Use size+mtime as the cheap change
        // signal; the sha256 is computed lazily below ONLY for files that changed.
        files.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs, hash: '' });
      }
    }
  };

  for (const folder of readdirSync(root)) {
    const projectDir = join(root, folder);
    if (!statSync(projectDir).isDirectory()) continue;
    const meta = readProjectMeta(projectDir);
    if (!meta?.projectId) continue;
    const files: Array<{ path: string; size: number; mtimeMs: number; hash: string }> = [];
    walk(projectDir, '', files);
    manifest[folder] = { projectId: meta.projectId, projectName: meta.projectName || folder, files };
    manifest[meta.projectId] = manifest[folder];
  }
  return manifest;
}

function startLocalProjectSyncLoop() {
  if (localSyncTimer || !EMPIR3_AUTH_TOKEN) return;
  localSyncSeen.clear();
  const prime = buildLocalProjectManifest();
  const primeEntries = Array.from(new Map(Object.values(prime).filter(entry => entry.projectId).map(entry => [entry.projectId, entry])).values());
  for (const entry of primeEntries) {
    const pid = entry.projectId;
    if (!pid) continue;
    for (const file of entry.files) {
      localSyncSeen.set(`${pid}:${file.path}`, file.hash || `${file.size}:${Math.round(file.mtimeMs)}`);
    }
  }
  localSyncTimer = setInterval(() => {
    if (!empir3Connected || !hasBridgePermission('read') || !hasBridgePermission('write')) return;
    const manifest = buildLocalProjectManifest();
    const currentKeys = new Set<string>();
    const entries = Array.from(new Map(Object.values(manifest).filter(entry => entry.projectId).map(entry => [entry.projectId, entry])).values());
    if (entries.length === 0) return;
    for (const entry of entries) {
      const projectId = entry.projectId;
      if (!projectId) continue;
      const projectDir = projectDirFor(entry.projectName || projectId, projectId).projectDir;
      for (const file of entry.files) {
        const key = `${projectId}:${file.path}`;
        currentKeys.add(key);
        const sig = file.hash || `${file.size}:${Math.round(file.mtimeMs)}`;
        if (localSyncSeen.get(key) === sig) continue;
        localSyncSeen.set(key, sig);
        try {
          const full = join(projectDir, sanitizeRelativePath(file.path));
          const ext = extname(file.path).toLowerCase();
          const binary = /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|eot|mp4|mp3|zip|pdf)$/i.test(ext);
          // Read once and hash ONLY this changed file (not the whole workspace each
          // tick). file.hash is now empty from the walk — compute it here for the payload.
          const buf = readFileSync(full);
          const hash = createHash('sha256').update(buf).digest('hex');
          const content = binary ? buf.toString('base64') : buf.toString('utf-8');
          sendEmpir3('desktop:sync:local:file', {
            projectId,
            projectName: entry.projectName || projectId,
            path: file.path,
            content,
            encoding: binary ? 'base64' : 'utf-8',
            size: file.size,
            mtimeMs: file.mtimeMs,
            hash,
          });
        } catch (e: any) {
          console.log(`[Sync] Local upload skipped for ${file.path}: ${e?.message || e}`);
        }
      }
    }
    for (const key of Array.from(localSyncSeen.keys())) {
      if (currentKeys.has(key)) continue;
      const idx = key.indexOf(':');
      if (idx <= 0) continue;
      const projectId = key.slice(0, idx);
      const path = key.slice(idx + 1);
      localSyncSeen.delete(key);
      sendEmpir3('desktop:sync:local:delete', { projectId, path });
    }
    // Re-walk every 30s, not 5s. Even hash-free, stat-walking a large synced
    // workspace is a few hundred ms-to-seconds of synchronous fs work that briefly
    // blocks the shared event loop; at 5s it kept a core ~50% busy with a stutter
    // each tick. 30s keeps local-file sync latency fine while idling the daemon.
  }, 30000);
}

function trimOutput(text: string): string {
  const normalized = (text || '').trim();
  if (normalized.length <= MAX_SHELL_OUTPUT) return normalized;
  return `${normalized.slice(0, MAX_SHELL_OUTPUT)}\n... (truncated, ${normalized.length} total chars)`;
}

function runProcess(file: string, args: string[] = [], options: { timeoutMs?: number; input?: string; maxBytes?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveRun) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        windowsHide: true,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      resolveRun({ code: -4, stdout: '', stderr: e?.message || String(e), timedOut: false });
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    const maxBytes = options.maxBytes || 8 * 1024 * 1024;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolveRun({ code: -2, stdout, stderr, timedOut: true });
    }, options.timeoutMs || 30000);

    child.stdout?.on('data', d => {
      if (Buffer.byteLength(stdout) < maxBytes) stdout += d.toString();
      if (Buffer.byteLength(stdout) >= maxBytes) {
        try { child.kill('SIGKILL'); } catch {}
      }
    });
    child.stderr?.on('data', d => stderr += d.toString());
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut: false });
    });
    child.on('error', e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code: -4, stdout, stderr: e.message, timedOut: false });
    });
    if (options.input !== undefined) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }
  });
}

async function runPowerShellText(script: string, timeoutMs = 30000, input?: string): Promise<{ success: boolean; stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  if (process.platform !== 'win32') {
    return { success: false, stdout: '', stderr: 'Desktop tools are currently available on Windows only.', code: -1, timedOut: false };
  }
  const ps = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = await runProcess(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeoutMs, input });
  return { success: result.code === 0 && !result.timedOut, ...result };
}

function buildMcpSnippet() {
  // Resolve the product exe explicitly — under the Go bootstrapper, the daemon
  // runs as a spawned node.exe, so process.execPath would wrongly advertise
  // node.exe as the MCP command. Never emit node.exe: fall back to the
  // conventional stable install path rather than process.execPath.
  const exe = resolveBootstrapExe()
    || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Empir3', 'Empir3Setup.exe');
  return {
    mcpServers: {
      'empir3-bridge': {
        type: 'stdio',
        command: exe,
        args: ['--mcp'],
      },
    },
  };
}

function clearBridgeAuth() {
  try { unlinkSync(AUTH_FILE); } catch {}
}

function readRequestBody(req: any): Promise<any> {
  return new Promise((resolveBody) => {
    let body = '';
    req.on('data', (c: Buffer) => body += c.toString());
    req.on('end', () => {
      try { resolveBody(JSON.parse(body)); } catch { resolveBody({}); }
    });
  });
}

function requestJson(method: string, urlStr: string, body?: any, extraHeaders: Record<string, string | number> = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolvePromise, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const data = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string | number> = { 'User-Agent': 'empir3-bridge-install', ...extraHeaders };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = lib({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method,
      headers,
    }, (response) => {
      let chunks = '';
      response.on('data', c => chunks += c);
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(chunks); } catch {}
        resolvePromise({ status: response.statusCode || 0, body: parsed, raw: chunks });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function isVersionNewer(remote: string, local: string): boolean {
  if (!remote || remote === local) return false;
  const norm = (s: string) => (s || '').replace(/^v/, '').split('.').map(p => parseInt(p, 10) || 0);
  const r = norm(remote);
  const l = norm(local);
  const max = Math.max(r.length, l.length);
  for (let i = 0; i < max; i++) {
    const a = r[i] || 0;
    const b = l[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

function stopPairPoll() {
  if (activePairPoll?.timer) {
    try { clearInterval(activePairPoll.timer); } catch {}
    activePairPoll.timer = null;
  }
  setTimeout(() => {
    if (activePairPoll && !activePairPoll.timer) activePairPoll = null;
  }, 30_000);
}

function restartAfterPairing() {
  // In production the Empir3 tray respawns the bridge after exit, so a hard
  // process.exit picks up the new auth file on the next module load. In dev
  // (npm start / npx tsx) nothing respawns — exiting would leave the user
  // with a dead wrapper. Skip the exit there; the welcome page reload still
  // refreshes the visible UI, and the operator can manually restart the
  // bridge to fully re-init the empir3 WebSocket.
  const isDev = !!process.env.npm_lifecycle_event;
  if (isDev) {
    console.log('[Empir3] Pairing changed — dev mode: skipping process.exit, restart manually to fully re-init empir3 connection.');
    return;
  }
  setTimeout(() => process.exit(0), 500);
}

function startPairPoll(code: string, serverUrl = EMPIR3_SERVER, environment = classifyEmpir3Server(serverUrl)) {
  stopPairPoll();
  const normalizedServer = normalizeEmpir3Server(serverUrl);
  const state: PairPollState = {
    code,
    serverUrl: normalizedServer,
    environment,
    tries: 0,
    lastStatus: 'pending',
    lastError: null,
    timer: null,
  };
  activePairPoll = state;

  const tick = async () => {
    state.tries++;
    try {
      const r = await requestJson('GET', `${normalizedServer}/api/auth/pairing-sessions/${encodeURIComponent(code)}`);
      if (r.status === 404) {
        state.lastStatus = 'expired';
        stopPairPoll();
        return;
      }
      if (r.body?.status === 'pending') {
        state.lastStatus = 'pending';
        if (state.tries > 300) {
          state.lastStatus = 'timed_out';
          stopPairPoll();
        }
        return;
      }
      if (r.body?.status === 'claimed') {
        state.lastStatus = 'claimed';
        const auth: BridgeAuth = {
          legacyToken: r.body.token,
          user: {
            id: r.body.userId,
            email: r.body.email,
            name: r.body.name,
            role: r.body.role,
          },
          channelId: r.body.channelId || null,
          serverUrl: r.body.serverUrl || normalizedServer,
          wsUrl: normalizeEmpir3WsUrl(r.body.wsUrl || r.body.relayUrl, r.body.serverUrl || normalizedServer),
          environment: classifyEmpir3Server(r.body.serverUrl || normalizedServer),
        };
        saveBridgeAuth(auth);
        clearStandaloneMode();
        stopPairPoll();
        restartAfterPairing();
      }
    } catch (e: any) {
      state.lastError = e?.message || String(e);
    }
  };

  state.timer = setInterval(tick, 2000);
  setTimeout(tick, 50);
}

// Cache last snapshot for element ref enrichment during recording
let lastSnapshot: SnapshotElement[] = [];
let lastSnapshotTime = 0;
const SNAPSHOT_CACHE_TTL = 2000; // 2s

// ─── Empir3 Server Connection (Direct Agent Edits) ──────────────

let empir3Ws: WebSocket | null = null;
let empir3Connected = false;
let empir3ResponseBuffer = '';  // accumulates streamed chunks
let activeEmpir3ProjectId = EMPIR3_PROJECT_ID;
let activeEmpir3ProjectName = '';
const empir3StreamBuffers = new Map<string, string>();
const mirroredEmpir3MessageIds = new Set<string>();
let empir3Heartbeat: NodeJS.Timeout | null = null;
let empir3ReconnectTimer: NodeJS.Timeout | null = null;
// Liveness clock for the heartbeat. We ws.ping() every 2s; the server's ws lib
// auto-pongs. If pongs stop for this long the socket is half-open (e.g. srv-01
// restarted on deploy but nginx held the /ws connection open via its 3600s
// read timeout — no close ever reaches us), so we terminate + reconnect.
let empir3LastPong = 0;
const EMPIR3_PONG_TIMEOUT_MS = 12000;
let empir3LastCloseCode = 0;
let empir3LastCloseReason = '';
let empir3AuthRejectedAt = 0;

function clearEmpir3Heartbeat() {
  if (empir3Heartbeat) {
    clearInterval(empir3Heartbeat);
    empir3Heartbeat = null;
  }
}

function sendEmpir3(type: string, payload: any = {}) {
  if (!empir3Ws || empir3Ws.readyState !== WebSocket.OPEN) return false;
  const raw = JSON.stringify({ type, payload });
  try {
    empir3Ws.send(raw, (err?: Error) => {
      if (err) console.warn(`[Empir3] send failed for ${type} (${raw.length} chars): ${err.message}`);
    });
    return true;
  } catch (e: any) {
    console.warn(`[Empir3] send threw for ${type} (${raw.length} chars): ${e?.message || e}`);
    return false;
  }
}

function rememberEmpir3Project(projectId?: string, name?: string) {
  const next = String(projectId || '').trim();
  if (next) activeEmpir3ProjectId = next;
  if (name) activeEmpir3ProjectName = String(name).slice(0, 120);
}

function normalizeEmpir3Message(raw: any, fallbackProjectId = ''): ChatMessage | null {
  const msg = raw?.message || raw;
  if (!msg) return null;
  const content = String(msg.content || msg.text || '').trim();
  if (!content) return null;
  const projectId = String(msg.projectId || msg.project_id || fallbackProjectId || '').trim();
  const role = String(msg.role || msg.from || '').toLowerCase();
  const from: 'user' | 'claude' = role === 'user' ? 'user' : 'claude';
  return {
    id: String(msg.id || raw?.messageId || `empir3-${projectId || 'project'}-${from}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
    from,
    text: content,
    timestamp: String(msg.createdAt || msg.created_at || raw?.createdAt || new Date().toISOString()),
    channel: 'empir3',
    projectId,
    agent: msg.agentId || msg.agent_id || raw?.agentId || raw?.agent_id,
    agentName: msg.agentName || raw?.agentName,
  };
}

function writeMirroredChat(messages: ChatMessage[], projectId?: string, projectName?: string) {
  const clean = messages.filter(Boolean);
  writeFileSync(CHAT_LOG, clean.map(m => JSON.stringify(m)).join('\n') + (clean.length ? '\n' : ''));
  mirroredEmpir3MessageIds.clear();
  clean.forEach(m => mirroredEmpir3MessageIds.add(m.id));
  if (projectId) rememberEmpir3Project(projectId, projectName);
  sessionCtx.messageCount = clean.length;
  saveSessionContext();
  broadcastToOverlay({ type: 'chat_replace', messages: clean, projectId: projectId || activeEmpir3ProjectId, projectName: projectName || activeEmpir3ProjectName });
}

function appendMirroredChat(message: ChatMessage, shouldBroadcast = true) {
  if (!message?.id || mirroredEmpir3MessageIds.has(message.id)) return;
  mirroredEmpir3MessageIds.add(message.id);
  appendFileSync(CHAT_LOG, JSON.stringify(message) + '\n');
  sessionCtx.messageCount++;
  saveSessionContext();
  if (shouldBroadcast) broadcastToOverlay({ type: 'claude_chat', message });
}

async function mirrorEmpir3Project(projectId: string, projectName = '') {
  if (!projectId || !EMPIR3_AUTH_TOKEN) return;
  rememberEmpir3Project(projectId, projectName);
  try {
    const r = await requestJson('GET', `${EMPIR3_SERVER}/api/projects/${encodeURIComponent(projectId)}?limit=80`, undefined, {
      Authorization: `Bearer ${EMPIR3_AUTH_TOKEN}`,
    });
    if (r.status < 200 || r.status >= 300 || !r.body) throw new Error(`HTTP ${r.status}`);
    const messages = Array.isArray(r.body.messages)
      ? r.body.messages.map((m: any) => normalizeEmpir3Message(m, projectId)).filter(Boolean) as ChatMessage[]
      : [];
    writeMirroredChat(messages, projectId, r.body.project?.name || projectName);
    console.log(`[Empir3] Mirrored ${messages.length} message(s) from project ${projectId.slice(0, 8)}`);
  } catch (e: any) {
    console.log(`[Empir3] Project mirror failed for ${projectId.slice(0, 8)}: ${e?.message || e}`);
  }
}

async function reportEmpir3Device() {
  const settings = readBridgeSettings();
  sendEmpir3('device:settings:report', {
    deviceId: settings.deviceId || 'empir3-bridge-local',
    deviceName: settings.deviceName || process.env.COMPUTERNAME || hostname(),
    permissions: bridgeEmpir3Permissions(settings),
    globalSafety: bridgeGlobalSafety(settings),
    homeDirectory: settings.homeDirectory || join(homedir(), 'Documents', 'Empir3'),
  });

  const caps = await buildDesktopCapabilities('quick').catch((e: any) => ({
    success: false,
    error: e?.message || String(e),
  }));
  sendEmpir3('desktop:capabilities:report', caps);
}

function connectToEmpir3() {
  if (!EMPIR3_WS_URL || !EMPIR3_AUTH_TOKEN) {
    console.log('[Empir3] No EMPIR3_WS_URL or EMPIR3_AUTH_TOKEN — direct edit forwarding disabled');
    return;
  }
  if (empir3Ws && (empir3Ws.readyState === WebSocket.OPEN || empir3Ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (empir3ReconnectTimer) {
    clearTimeout(empir3ReconnectTimer);
    empir3ReconnectTimer = null;
  }

  const settings = readBridgeSettings();
  const deviceId = settings.deviceId || 'empir3-bridge-local';
  const deviceName = settings.deviceName || process.env.COMPUTERNAME || hostname();
  const url = EMPIR3_WS_URL.includes('?')
    ? `${EMPIR3_WS_URL}&role=desktop&token=${encodeURIComponent(EMPIR3_AUTH_TOKEN)}&deviceId=${encodeURIComponent(deviceId)}&deviceName=${encodeURIComponent(deviceName)}`
    : `${EMPIR3_WS_URL}?role=desktop&token=${encodeURIComponent(EMPIR3_AUTH_TOKEN)}&deviceId=${encodeURIComponent(deviceId)}&deviceName=${encodeURIComponent(deviceName)}`;

  console.log(`[Empir3] Connecting to ${EMPIR3_WS_URL}...`);
  const ws = new WebSocket(url);
  empir3Ws = ws;

  ws.on('open', () => {
    if (empir3Ws !== ws) return;
    empir3Connected = false;
    console.log('[Empir3] WebSocket opened; waiting for relay authorization');
    clearEmpir3Heartbeat();
    empir3LastPong = Date.now(); // seed the liveness clock on a fresh socket
    empir3Heartbeat = setInterval(() => {
      if (empir3Ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      // Half-open detection: the server auto-pongs our pings, so a gap this
      // long means the peer is gone (dead srv-01 behind an nginx /ws socket
      // that's still open). Terminate → 'close' fires → we reconnect to the
      // fresh server and re-register the companion. The old code pinged forever
      // without checking pongs, so the bridge sat "connected" until a manual
      // restart and browser_control / lent-CLI reported offline.
      if (Date.now() - empir3LastPong > EMPIR3_PONG_TIMEOUT_MS) {
        console.warn(`[Empir3] No pong for ${EMPIR3_PONG_TIMEOUT_MS}ms — socket half-open, terminating to force reconnect`);
        try { ws.terminate(); } catch {}
        return;
      }
      try { ws.ping(); } catch {}
    }, 2000);
    empir3Heartbeat.unref?.();
    reportEmpir3Device().catch((e: any) => console.error('[Empir3] Device report failed:', e?.message || e));
    sendEmpir3('state:sync', {});
    if (hasBridgePermission('read')) {
      sendEmpir3('desktop:sync:request', { manifest: buildLocalProjectManifest() });
    }
    startLocalProjectSyncLoop();
    if (activeEmpir3ProjectId) mirrorEmpir3Project(activeEmpir3ProjectId).catch(() => {});
  });

  ws.on('pong', () => {
    if (empir3Ws === ws) empir3LastPong = Date.now();
  });

  ws.on('message', (data) => {
    // Any inbound frame proves the peer is alive — treat it as liveness too, so
    // a busy connection never trips the pong-timeout mid-work.
    if (empir3Ws === ws) empir3LastPong = Date.now();
    try {
      const msg = JSON.parse(data.toString());
      handleEmpir3Message(msg);
    } catch (e: any) {
      console.error('[Empir3] Parse error:', e.message);
    }
  });

  ws.on('close', (code, reason) => {
    if (empir3Ws === ws) empir3Ws = null;
    empir3Connected = false;
    clearEmpir3Heartbeat();
    const why = reason?.length ? ` reason=${reason.toString()}` : '';
    empir3LastCloseCode = code;
    empir3LastCloseReason = reason?.toString() || '';
    empir3AuthRejectedAt = (code === 4001 || /unauthorized/i.test(empir3LastCloseReason)) ? Date.now() : 0;
    console.log(`[Empir3] Disconnected (code=${code}${why}) — reconnecting in 5s...`);
    empir3ReconnectTimer = setTimeout(() => {
      empir3ReconnectTimer = null;
      connectToEmpir3();
    }, 5000);
    empir3ReconnectTimer.unref?.();
  });

  ws.on('error', (e) => {
    console.error('[Empir3] WebSocket error:', e.message);
  });
}

// Detection is centralized in executable-resolver.ts — an in-process PATH +
// well-known-toolchain-dir scan (no `where.exe` / `which` subprocess, so it's
// immune to the stale PATH a tray-launched daemon inherits). These thin async
// wrappers preserve the historical call-site signatures.
async function findExecutableCandidates(name: string): Promise<string[]> {
  return resolveExecutableCandidates(name);
}

async function findExecutable(name: string): Promise<string | null> {
  return resolveExecutable(name);
}

async function findPreferredExecutable(name: string): Promise<string | null> {
  return resolveExecutable(name);
}

async function probeCli(name: string, args: string[]) {
  const found = await findExecutable(name);
  if (!found) return { available: false, path: null, version: null };
  const version = await runProcess(args[0], args.slice(1), { timeoutMs: 3000, maxBytes: 256 * 1024 });
  const text = (version.stdout + version.stderr).split(/\r?\n/).map(s => s.trim()).find(Boolean);
  return { available: true, path: found, version: (text || 'installed').slice(0, 120) };
}

async function scanPythonPackages() {
  if (!(await findExecutable('pip'))) return [];
  const notable = new Set([
    'pillow', 'pil', 'openpyxl', 'xlrd', 'xlsxwriter', 'python_docx', 'docx',
    'pandas', 'numpy', 'scipy', 'matplotlib', 'seaborn', 'plotly',
    'requests', 'httpx', 'aiohttp', 'beautifulsoup4', 'bs4', 'lxml',
    'pdfplumber', 'pypdf2', 'reportlab', 'pyyaml', 'toml', 'tomli',
    'chardet', 'charset_normalizer', 'cryptography', 'pyautogui', 'pyperclip', 'psutil',
    'pywin32', 'pypiwin32', 'watchdog', 'rich', 'colorama', 'click', 'typer',
    'fastapi', 'flask', 'django', 'sqlalchemy', 'sqlite_utils', 'jinja2',
    'markdown', 'pygments', 'paramiko',
  ]);
  const result = await runProcess('pip', ['list', '--format=json'], { timeoutMs: 8000, maxBytes: 8 * 1024 * 1024 });
  if (result.code !== 0) return [];
  let rows: any[] = [];
  try { rows = JSON.parse(result.stdout || '[]'); } catch { return []; }
  const seen = new Set<string>();
  return rows
    .filter(p => {
      const key = String(p.name || '').toLowerCase().replace(/-/g, '_');
      if (!notable.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(p => ({ name: p.name, version: p.version }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function scanComObjects() {
  const out = [];
  for (const [progId, description] of COM_CANDIDATES) {
    const result = await runPowerShellText(
      `try { $o = New-Object -ComObject ${psString(progId)}; [System.Runtime.InteropServices.Marshal]::ReleaseComObject($o) | Out-Null; 'ok' } catch { 'fail' }`,
      4000,
    );
    out.push({ prog_id: progId, description, available: result.stdout.trim() === 'ok' });
  }
  return out;
}

function desktopCapabilitySystemInfo() {
  const home = homedir();
  return {
    os: process.platform === 'win32' ? 'Windows' : process.platform,
    os_version: release(),
    arch: process.arch,
    python_version: 'see clis.python.version',
    python_executable: '',
    home_dir: home,
    downloads_dir: join(home, 'Downloads'),
    desktop_dir: join(home, 'Desktop'),
    documents_dir: join(home, 'Documents'),
    node_version: process.version,
  };
}

async function buildDesktopCapabilities(scanType = 'quick', name = '') {
  if (scanType === 'check_cli') {
    const cliName = String(name || '').trim();
    if (!cliName) return { success: false, error: 'No CLI name provided' };
    const candidate = CLI_CANDIDATES.find(([n]) => n === cliName);
    const probed = await probeCli(cliName, candidate ? candidate[1] : [cliName, '--version']);
    return { success: true, name: cliName, ...probed };
  }

  if (scanType === 'quick' && companionCapabilityCache && Date.now() - companionCapabilityCacheTime < CLI_CACHE_TTL_MS) {
    return { ...companionCapabilityCache, cached: true };
  }

  const started = Date.now();
  const clis: Record<string, any> = {};
  await Promise.all(CLI_CANDIDATES.map(async ([cliName, args]) => {
    clis[cliName] = await probeCli(cliName, args);
  }));
  const [packages, comObjects] = scanType === 'scan'
    ? await Promise.all([scanPythonPackages(), scanComObjects()])
    : [await scanPythonPackages(), []];

  const result = {
    success: true,
    clis,
    python_packages: packages,
    com_objects: comObjects,
    system: desktopCapabilitySystemInfo(),
    scan_type: scanType === 'scan' ? 'full' : 'quick',
    scan_time_ms: Date.now() - started,
  };
  companionCapabilityCache = result;
  companionCapabilityCacheTime = Date.now();
  return result;
}

function claudeDeviceOptedIn(): boolean {
  try {
    return !!readBridgeSettings().lendClaudeMax;
  } catch {
    return false;
  }
}

function setClaudeDeviceOptIn(value: boolean) {
  const settings = readBridgeSettings();
  settings.lendClaudeMax = !!value;
  saveBridgeSettings(settings);
  companionCapabilityCache = null;
  companionCapabilityCacheTime = 0;
  return { optedIn: !!value };
}

// GitHub CLI lend — master opt-in (mirrors lendClaudeMax) plus the
// per-scope matrix enforced inside the github-cli handler.
function githubDeviceOptedIn(): boolean {
  try {
    return !!readBridgeSettings().lendGitHubCli;
  } catch {
    return false;
  }
}

function githubScopes(): Record<GhScope, boolean> {
  try {
    return normalizeGhScopes(readBridgeSettings().githubScopes);
  } catch {
    return normalizeGhScopes(undefined);
  }
}

function setGithubDeviceOptIn(value: boolean) {
  const settings = readBridgeSettings();
  settings.lendGitHubCli = !!value;
  saveBridgeSettings(settings);
  companionCapabilityCache = null;
  companionCapabilityCacheTime = 0;
  return { optedIn: !!value };
}

async function probeClaudeCli() {
  const found = await findPreferredExecutable('claude');
  if (!found) {
    return { available: false, path: null, version: null, device_opted_in: claudeDeviceOptedIn() };
  }

  let version = 'installed';
  try {
    const probePath = normalizeCliShim(found);
    const child = await runSpawnedCliForText(probePath, ['--version'], 5000);
    const text = (child.stdout + child.stderr).split(/\r?\n/).map(s => s.trim()).find(Boolean);
    version = (text || version).slice(0, 120);
  } catch {
    version = 'installed';
  }

  return {
    available: true,
    path: found,
    version,
    device_opted_in: claudeDeviceOptedIn(),
  };
}

function normalizeCliShim(command: string): string {
  let cliPath = command;
  if (process.platform === 'win32' && !/\.(cmd|exe|bat|ps1)$/i.test(cliPath) && existsSync(cliPath + '.cmd')) {
    cliPath = cliPath + '.cmd';
  }
  return cliPath;
}

function spawnCli(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; stdio?: any[] } = {}): ChildProcess {
  const cliPath = normalizeCliShim(command);
  const isWinShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath);
  const spawnOptions = {
    env: options.env || { ...process.env },
    cwd: options.cwd,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  } as any;
  if (isWinShim) {
    // `.cmd`/`.bat` shims can't be spawned directly on Node 18.20+/20.12+
    // (CVE-2024-27980). The previous workaround used `shell: true` which
    // tells Node to concatenate args into the command line WITHOUT
    // escaping — fine for short flags, but a long positional like
    // `@image.png Describe everything in detail...` gets word-split by
    // cmd.exe into many separate args (the `:see` flow was getting a
    // shredded prompt; Claude saw fragments and replied "It looks like
    // your message got cut off"). Invoke cmd.exe directly with
    // `/d /s /c` and `shell: false` so Node applies its normal
    // argv-escaping rules to each arg individually.
    return spawn('cmd.exe', ['/d', '/s', '/c', cliPath, ...args], { ...spawnOptions, shell: false });
  }
  return spawn(cliPath, args, spawnOptions);
}

function runSpawnedCliForText(command: string, args: string[], timeoutMs = 5000): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveRun) => {
    let child: ChildProcess;
    try {
      child = spawnCli(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      resolveRun({ code: -4, stdout: '', stderr: e?.message || String(e), timedOut: false });
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolveRun({ code: -2, stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.stdout?.on('data', d => stdout += d.toString());
    child.stderr?.on('data', d => stderr += d.toString());
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut: false });
    });
    child.on('error', e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code: -4, stdout, stderr: e.message, timedOut: false });
    });
  });
}

function claudeCliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // This route is intended to use the device owner's Claude Code login.
  // Avoid accidentally billing a server/API-key credential inherited by the daemon.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  for (const key of Object.keys(env)) {
    if (key.startsWith('EMPIR3_BRIDGE_')) delete env[key];
  }
  return env;
}

// ── Claude CLI MCP shim (M2.2b) ────────────────────────────────────────────
//
// When the server sends `claude:cli:turn` with a non-empty tools array,
// we spin up a tiny localhost HTTP MCP server so the spawned `claude --print`
// can call those tools. Each tools/call HTTP request blocks on a server
// round-trip: the bridge emits `claude:cli:tool:call` (with a callId), and
// the server replies with `claude:cli:tool:result` carrying the same callId.
// `resolveClaudeCliToolResult` is wired into the `claude:cli:tool:result`
// action below so the JSON-RPC response can resolve.
//
// Tools the server passes are exposed under namespace `mcp__<bridgeName>__<tool>`.
// Server-side allowlist matches this format in ClaudeCliStrategy.

interface CliMcpShim {
  url: string;
  serverHandle: import('http').Server;
  bridgeName: string;
  /** Wire-prefix the shim emits on (`claude` / `gemini` / `grok`). Determines
   *  which `<prefix>:cli:tool:call` event type the per-tool round-trip
   *  publishes — keeps shims isolated when multiple CLIs run concurrently. */
  wirePrefix: string;
  // Tool definitions (mirrors MCP tools/list result shape).
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
}

interface PendingMcpCall {
  resolve: (content: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

// Per-turn maps. Key is turn id (globally unique — adapters tag each id
// with a CLI-specific prefix so cross-CLI collisions can't happen).
const cliMcpShims = new Map<string, CliMcpShim>();
const cliPendingToolCalls = new Map<string, Map<string, PendingMcpCall>>();
// Aliases kept temporarily for the in-flight Claude path; collapse once
// Gemini/Grok land and the rename can be verified end-to-end.
const claudeCliMcpShims = cliMcpShims;
const claudeCliPendingToolCalls = cliPendingToolCalls;

// Default tool-call timeout (ms). 20 min matches the per-turn cap so the
// MCP HTTP request doesn't expire before a long sub-dispatch finishes.
const MCP_TOOL_CALL_TIMEOUT_MS = 20 * 60 * 1000;

const CLAUDE_CLI_DISALLOWED_BUILTINS = [
  // Mirror server-side DISALLOWED_BUILTINS — the model must only reach our
  // Invocables via MCP, never the CLI's built-in file/web/shell tools.
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch',
  'Task', 'Agent', 'NotebookEdit', 'TodoWrite', 'BashOutput', 'KillShell',
  'ExitPlanMode', 'SlashCommand',
];

function resolveCliToolResult(payload: any) {
  const id = String(payload?.id || '');
  const callId = String(payload?.callId || '');
  if (!id || !callId) return;
  const turnCalls = cliPendingToolCalls.get(id);
  if (!turnCalls) return;
  const pending = turnCalls.get(callId);
  if (!pending) return;
  turnCalls.delete(callId);
  clearTimeout(pending.timer);
  const content = typeof payload?.content === 'string'
    ? payload.content
    : JSON.stringify(payload?.content ?? '');
  pending.resolve(content);
}
const resolveClaudeCliToolResult = resolveCliToolResult;

function teardownCliMcpShim(id: string) {
  const shim = cliMcpShims.get(id);
  if (shim) {
    try { shim.serverHandle.close(); } catch { /* ignore */ }
    cliMcpShims.delete(id);
  }
  const turnCalls = cliPendingToolCalls.get(id);
  if (turnCalls) {
    for (const pending of turnCalls.values()) {
      clearTimeout(pending.timer);
      try { pending.reject(new Error('bridge MCP shim torn down')); } catch { /* ignore */ }
    }
    cliPendingToolCalls.delete(id);
  }
}
const teardownClaudeCliMcpShim = teardownCliMcpShim;

async function startCliMcpShim(
  wirePrefix: string,
  id: string,
  bridgeName: string,
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
  emit: (type: string, payload: any) => void,
): Promise<CliMcpShim> {
  const normalized = tools.map(t => ({
    name: String(t.name),
    description: typeof t.description === 'string' ? t.description : undefined,
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
  }));
  const pending = new Map<string, PendingMcpCall>();
  cliPendingToolCalls.set(id, pending);

  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain', 'Allow': 'POST' });
      res.end('Method Not Allowed');
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let rpc: any;
      try { rpc = JSON.parse(body); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      const reqs = Array.isArray(rpc) ? rpc : [rpc];
      const responses: any[] = [];
      const isLongRunning = reqs.some(r => r?.method === 'tools/call');
      let heartbeat: NodeJS.Timeout | null = null;
      if (isLongRunning) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        });
        // Heartbeat whitespace bytes every 30s so intermediate proxies and
        // the CLI's own HTTP client don't time out idle connections during
        // long sub-dispatches. JSON parsers tolerate leading whitespace,
        // so this is a no-op once the real response is written.
        heartbeat = setInterval(() => {
          try { res.write(' '); } catch { /* socket gone */ }
        }, 30_000);
      }
      try {
        for (const r of reqs) {
          const respId = r?.id ?? null;
          try {
            switch (r?.method) {
              case 'initialize':
                if (respId !== undefined && respId !== null) {
                  responses.push({
                    jsonrpc: '2.0', id: respId,
                    result: {
                      protocolVersion: '2024-11-05',
                      capabilities: { tools: { listChanged: false } },
                      serverInfo: { name: bridgeName, version: '1.0.0' },
                    },
                  });
                }
                break;
              case 'notifications/initialized':
              case 'ping':
                if (respId !== undefined && respId !== null) {
                  responses.push({ jsonrpc: '2.0', id: respId, result: {} });
                }
                break;
              case 'tools/list':
                if (respId !== undefined && respId !== null) {
                  responses.push({
                    jsonrpc: '2.0', id: respId,
                    result: { tools: normalized },
                  });
                }
                break;
              case 'tools/call': {
                if (respId === undefined || respId === null) break;
                const name = String(r?.params?.name || '');
                const args = (r?.params?.arguments && typeof r.params.arguments === 'object')
                  ? r.params.arguments
                  : {};
                if (!name || !normalized.some(t => t.name === name)) {
                  responses.push({ jsonrpc: '2.0', id: respId, error: { code: -32601, message: `Unknown tool: ${name}` } });
                  break;
                }
                // Round-trip the call to the server. callId uniquely matches
                // the eventual `claude:cli:tool:result`. Resolve OR reject
                // closes the wait.
                const callId = `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const content = await new Promise<string>((resolve, reject) => {
                  const timer = setTimeout(() => {
                    pending.delete(callId);
                    reject(new Error(`tool ${name} timed out waiting for server result`));
                  }, MCP_TOOL_CALL_TIMEOUT_MS);
                  pending.set(callId, { resolve, reject, timer });
                  emit(`${wirePrefix}:cli:tool:call`, { id, callId, name, args });
                }).catch((err: Error) => `Tool ${name} failed: ${err.message}`);
                responses.push({
                  jsonrpc: '2.0', id: respId,
                  result: { content: [{ type: 'text', text: content }] },
                });
                break;
              }
              default:
                if (respId !== undefined && respId !== null) {
                  responses.push({ jsonrpc: '2.0', id: respId, error: { code: -32601, message: `Method not found: ${r?.method}` } });
                }
            }
          } catch (err: any) {
            if (respId !== undefined && respId !== null) {
              responses.push({ jsonrpc: '2.0', id: respId, error: { code: -32000, message: err?.message || String(err) } });
            }
          }
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      if (responses.length === 0) {
        if (!res.headersSent) res.writeHead(204);
        res.end();
        return;
      }
      const payload = JSON.stringify(Array.isArray(rpc) ? responses : responses[0]);
      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
      }
      res.end(payload);
    });
  });
  // Match server-side McpBridge: disable Node http timeouts so a long
  // sub-dispatch tool call (Vincent → Koba → Write, often 5+ min) doesn't
  // get cut off by the framework before the upstream completes.
  server.timeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 30 * 60 * 1000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as import('net').AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  const shim: CliMcpShim = { url, serverHandle: server, bridgeName, wirePrefix, tools: normalized };
  cliMcpShims.set(id, shim);
  return shim;
}
async function startClaudeCliMcpShim(
  id: string,
  bridgeName: string,
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
  emit: (type: string, payload: any) => void,
): Promise<CliMcpShim> {
  return startCliMcpShim('claude', id, bridgeName, tools, emit);
}

function escapeCliXml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Build the stream-json stdin for a `claude:cli:turn`.
//
// Serialised as a SINGLE `user` message (mirrors the server-side local
// ClaudeCliStrategy.buildStdin). `--input-format stream-json` only accepts
// `user`/`control` lines — an `assistant` line is rejected ("Expected message
// type 'user' or 'control'") and multiple `user` lines each run as a separate
// model turn (verified 2.1.31, 2026-06-15). So prior turns are folded into a
// `<conversation_history>` block and the current ask into `<current_request>`,
// all inside one user message → exactly one model turn.
//
// Single-call vision: Claude CLI silently drops base64 image blocks fed via
// stdin (verified 2.1.31) but reads an `@<abs-path>` reference fine. Each
// inline image block is written to `imageTempDir` and referenced with `@<path>`
// placed at the FRONT of the message (refs that don't lead the prompt segment
// are skipped by the CLI's reference parser). The image thus rides the reply
// turn instead of a separate `:see` caption pre-pass. Returns the temp dir so
// the caller can clean it up after the child exits.
async function buildClaudeCliStdin(system: string, messages: any[]): Promise<{ stdin: string; imageTempDir: string | null }> {
  const sys = String(system || '').trim();
  let imageTempDir: string | null = null;
  let imgIdx = 0;
  const refs: string[] = [];

  // Pull plain text from a message's content, materialising any image blocks
  // to temp files and collecting their `@<path>` refs into `refs`.
  const extractText = async (content: any): Promise<string> => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const texts: string[] = [];
    for (const b of content) {
      if (b && b.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string' && b.source.data) {
        if (!imageTempDir) {
          const fsp = await import('fs/promises');
          imageTempDir = await fsp.mkdtemp(join(require('os').tmpdir(), 'empir3-cli-turn-img-'));
        }
        const ext = (String(b.source.media_type || 'image/png').split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
        const p = join(imageTempDir, `img_${imgIdx++}.${ext}`);
        const fsp = await import('fs/promises');
        await fsp.writeFile(p, Buffer.from(b.source.data, 'base64'));
        refs.push('@' + p.replace(/\\/g, '/'));
      } else if (b && b.type === 'text' && typeof b.text === 'string' && b.text) {
        texts.push(b.text);
      } else if (b && b.type === 'tool_result') {
        texts.push(`[tool result] ${b.content || ''}`);
      } else if (b && b.type === 'tool_use') {
        texts.push(`[tool use] ${b.name || ''} ${JSON.stringify(b.input || {})}`);
      } else if (b && typeof b.text === 'string' && b.text) {
        texts.push(b.text);
      }
    }
    return texts.join('\n');
  };

  // Split off the current request (last user message) from prior history.
  let lastUserText = '';
  const history: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    const text = await extractText(m?.content);
    if (i === messages.length - 1 && role === 'user') {
      lastUserText = text;
    } else if (text.trim()) {
      history.push(`<${role}_message>${escapeCliXml(text)}</${role}_message>`);
    }
  }

  let body = '';
  if (sys) {
    body += `<system_instructions>\n${sys}\n</system_instructions>\nUse these system instructions for the rest of this turn.\n\n`;
  }
  if (history.length > 0) {
    body += `<conversation_history>\n${history.join('\n')}\n</conversation_history>\n\n`;
  }
  body += `<current_request>\n${lastUserText}\n</current_request>`;

  // `@refs` lead the whole message so the CLI's reference parser sees them.
  const finalText = refs.length ? `${refs.join(' ')}\n${body}` : body;
  const stdin = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: finalText }] },
  }) + '\n';
  return { stdin, imageTempDir };
}

async function startClaudeCliTurn(payload: any, emit: (type: string, payload: any) => void) {
  const id = String(payload?.id || `claude-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  if (!claudeDeviceOptedIn()) {
    emit('claude:cli:error', {
      id,
      stage: 'declined',
      error: 'Device owner has not opted in. Enable "Lend Empir3 my Claude Max" in the bridge tray before routing agent turns through this PC.',
    });
    return { success: false, id, error: 'device opted out' };
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (messages.length === 0) {
    emit('claude:cli:error', { id, stage: 'invalid_payload', error: 'claude:cli:turn requires a non-empty `messages` array' });
    return { success: false, id, error: 'messages required' };
  }

  const command = await findPreferredExecutable('claude');
  if (!command) {
    emit('claude:cli:error', { id, stage: 'spawn', error: 'claude CLI not found on PATH' });
    return { success: false, id, error: 'claude CLI not found' };
  }
  if (activeClaudeCliRuns.has(id)) {
    emit('claude:cli:error', { id, stage: 'duplicate', error: 'claude turn id already active' });
    return { success: false, id, error: 'duplicate turn id' };
  }

  const model = String(payload?.model || 'claude-sonnet-4-5');
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
  ];
  if (model) args.push('--model', model);
  if (Array.isArray(payload?.extra_args)) {
    for (const arg of payload.extra_args) {
      if (typeof arg === 'string' && arg.trim()) args.push(arg);
    }
  }

  // M2.2b — if the turn carries tools, spin up our MCP shim and tell the
  // CLI about it. Tool calls round-trip back through the server. When tools
  // is empty (text-only turn) we stay on the M2.2a fast path and skip this.
  let mcpConfigPath: string | null = null;
  let mcpConfigDir: string | null = null;
  // Single-call vision: inline image blocks in the turn payload get written
  // to this temp dir as files the CLI reads via `@<path>` (see
  // buildClaudeCliStdin). Cleaned in the child `close` handler.
  let imageTempDir: string | null = null;
  let stdinPayload = '';
  const turnTools = Array.isArray(payload?.tools) ? payload.tools : [];
  const bridgeName = String(payload?.bridge_name || 'empir3').replace(/[^A-Za-z0-9_-]/g, '') || 'empir3';
  if (turnTools.length > 0) {
    let shim: CliMcpShim;
    try {
      shim = await startClaudeCliMcpShim(id, bridgeName, turnTools, emit);
    } catch (e: any) {
      emit('claude:cli:error', { id, stage: 'mcp_shim', error: e?.message || String(e) });
      return { success: false, id, error: `mcp shim: ${e?.message || String(e)}` };
    }
    try {
      const tmp = await import('fs/promises').then(m => m.mkdtemp(join(require('os').tmpdir(), 'empir3-bridge-mcp-')));
      mcpConfigDir = tmp;
      mcpConfigPath = join(tmp, 'mcp-config.json');
      const cfg = {
        mcpServers: {
          [bridgeName]: {
            type: 'http',
            url: shim.url,
            timeout: MCP_TOOL_CALL_TIMEOUT_MS,
          },
        },
      };
      writeFileSync(mcpConfigPath, JSON.stringify(cfg), 'utf-8');
      const allowed = shim.tools.map(t => `mcp__${bridgeName}__${t.name}`);
      args.push('--mcp-config', mcpConfigPath);
      if (allowed.length > 0) args.push('--allowedTools', allowed.join(','));
      args.push('--disallowedTools', CLAUDE_CLI_DISALLOWED_BUILTINS.join(','));
      args.push('--permission-mode', 'acceptEdits');
    } catch (e: any) {
      teardownClaudeCliMcpShim(id);
      emit('claude:cli:error', { id, stage: 'mcp_config', error: e?.message || String(e) });
      return { success: false, id, error: `mcp config: ${e?.message || String(e)}` };
    }
  }

  const turnEnv = claudeCliEnv();
  if (turnTools.length > 0) {
    // Bump the CLI's MCP tool-call timeout to match our long-sub-dispatch
    // ceiling. The CLI defaults to ~60s for tools called via stdio MCP;
    // for our HTTP transport the per-server `timeout` in mcp-config covers
    // it, but the env vars do no harm and protect against version drift.
    turnEnv.MCP_TIMEOUT = String(MCP_TOOL_CALL_TIMEOUT_MS);
    turnEnv.MCP_TOOL_TIMEOUT = String(MCP_TOOL_CALL_TIMEOUT_MS);
  }

  // Build the stream-json stdin up-front. This writes any inline image blocks
  // to a temp dir and rewrites them as `@<path>` refs — done before spawn so a
  // write failure never leaves an orphaned child waiting on stdin.
  try {
    const built = await buildClaudeCliStdin(String(payload?.system || ''), messages);
    stdinPayload = built.stdin;
    imageTempDir = built.imageTempDir;
  } catch (e: any) {
    if (mcpConfigDir) {
      try { require('fs').rmSync(mcpConfigDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    teardownClaudeCliMcpShim(id);
    emit('claude:cli:error', { id, stage: 'build_stdin', error: e?.message || String(e) });
    return { success: false, id, error: e?.message || String(e) };
  }

  let child: ChildProcess;
  try {
    child = spawnCli(command, args, {
      env: turnEnv,
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    if (mcpConfigDir) {
      try { require('fs').rmSync(mcpConfigDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (imageTempDir) {
      try { require('fs').rmSync(imageTempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    teardownClaudeCliMcpShim(id);
    emit('claude:cli:error', { id, stage: 'spawn', error: e?.message || String(e) });
    return { success: false, id, error: e?.message || String(e) };
  }

  activeClaudeCliRuns.set(id, child);
  const startedAt = Date.now();
  const timeoutSec = Number.isFinite(payload?.timeout_sec) && payload.timeout_sec > 0
    ? Math.min(Number(payload.timeout_sec), 60 * 60)
    : 20 * 60;
  const timeoutMs = timeoutSec * 1000;
  let seq = 0;
  let lineBuffer = '';
  let stderrTail = '';
  let timedOut = false;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref?.();
  }, timeoutMs);

  child.stdout?.on('data', (chunk: Buffer) => {
    lineBuffer += chunk.toString('utf-8');
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      emit('claude:cli:chunk', { id, seq: seq++, data: line });
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail += chunk.toString('utf-8');
    if (stderrTail.length > 8192) stderrTail = stderrTail.slice(-8192);
  });

  child.on('close', (code) => {
    clearTimeout(timeoutHandle);
    activeClaudeCliRuns.delete(id);
    if (lineBuffer.trim()) emit('claude:cli:chunk', { id, seq: seq++, data: lineBuffer });
    teardownClaudeCliMcpShim(id);
    if (mcpConfigDir) {
      try { require('fs').rmSync(mcpConfigDir, { recursive: true, force: true }); } catch { /* ignore */ }
      mcpConfigDir = null;
      mcpConfigPath = null;
    }
    if (imageTempDir) {
      try { require('fs').rmSync(imageTempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      imageTempDir = null;
    }
    const duration_ms = Date.now() - startedAt;
    if (timedOut) {
      emit('claude:cli:error', {
        id,
        stage: 'timeout',
        exit_code: code ?? -1,
        duration_ms,
        error: `claude CLI exceeded ${timeoutSec}s`,
        stderr_tail: stderrTail.slice(-512),
      });
      return;
    }
    emit('claude:cli:done', {
      id,
      exit_code: code ?? -1,
      duration_ms,
      stderr_tail: stderrTail.slice(-512),
    });
  });

  child.on('error', (e: Error) => {
    if (!activeClaudeCliRuns.has(id)) return;
    emit('claude:cli:error', { id, stage: 'spawn', error: e.message });
  });

  try {
    child.stdin?.write(stdinPayload);
    child.stdin?.end();
  } catch (e: any) {
    emit('claude:cli:error', { id, stage: 'stdin', error: e?.message || String(e) });
    try { child.kill('SIGTERM'); } catch {}
    activeClaudeCliRuns.delete(id);
    return { success: false, id, error: e?.message || String(e) };
  }

  return { success: true, id, model, timeout_sec: timeoutSec };
}

function abortClaudeCliTurn(payload: any, emit: (type: string, payload: any) => void) {
  const id = String(payload?.id || '');
  const child = id ? activeClaudeCliRuns.get(id) : null;
  if (!child) {
    emit('claude:cli:error', { id: id || 'unknown', stage: 'aborted', error: 'no active claude run for this turn id' });
    return { success: false, id, error: 'no active run' };
  }
  try {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (activeClaudeCliRuns.has(id)) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 5000).unref?.();
  } catch (e: any) {
    emit('claude:cli:error', { id, stage: 'abort', error: e?.message || String(e) });
    return { success: false, id, error: e?.message || String(e) };
  }
  return { success: true, id };
}

async function handleClaudeCliCommand(action: string, payload: any, emit: (type: string, payload: any) => void) {
  switch (action) {
    case 'probe': {
      const result = await probeClaudeCli();
      emit('claude:cli:probe:result', { id: payload?.id || '', ...result });
      return result;
    }
    case 'opted_in':
      return { optedIn: claudeDeviceOptedIn() };
    case 'set_opted_in':
      return setClaudeDeviceOptIn(!!payload?.value);
    case 'turn':
      return startClaudeCliTurn(payload, emit);
    case 'abort':
      return abortClaudeCliTurn(payload, emit);
    case 'tool:result':
      // Resolves the pending HTTP MCP `tools/call` for {id, callId}.
      // Async fire-and-forget — no response needed.
      resolveClaudeCliToolResult(payload);
      return { success: true };
    case 'see':
      return runClaudeCliSee(payload, emit);
    default:
      return { success: false, error: `Unknown claude:cli action: ${action}` };
  }
}

function codexDeviceOptedIn(): boolean {
  try {
    return !!readBridgeSettings().lendOpenAiCodex;
  } catch {
    return false;
  }
}

function setCodexDeviceOptIn(value: boolean) {
  const settings = readBridgeSettings();
  settings.lendOpenAiCodex = !!value;
  saveBridgeSettings(settings);
  companionCapabilityCache = null;
  companionCapabilityCacheTime = 0;
  return { optedIn: !!value };
}

async function probeCodexCli() {
  const found = await findPreferredExecutable('codex');
  if (!found) {
    return { available: false, path: null, version: null, device_opted_in: codexDeviceOptedIn() };
  }
  let version = 'installed';
  try {
    const probePath = normalizeCliShim(found);
    const child = await runSpawnedCliForText(probePath, ['--version'], 5000);
    const text = (child.stdout + child.stderr).split(/\r?\n/).map(s => s.trim()).find(Boolean);
    version = (text || version).slice(0, 120);
  } catch {
    version = 'installed';
  }
  return {
    available: true,
    path: found,
    version,
    device_opted_in: codexDeviceOptedIn(),
    tool_mcp_supported: true,
  };
}

// ── Gemini CLI (Google) ──────────────────────────────────────────
// Lend-and-probe pattern mirrors Claude/Codex. Settings field:
// `lendGoogleGemini`. CLI binary name: `gemini` (Google's official
// `@google/gemini-cli` npm package as of late 2025).

function geminiDeviceOptedIn(): boolean {
  try {
    return !!readBridgeSettings().lendGoogleGemini;
  } catch {
    return false;
  }
}

function setGeminiDeviceOptIn(value: boolean) {
  const settings = readBridgeSettings();
  settings.lendGoogleGemini = !!value;
  saveBridgeSettings(settings);
  companionCapabilityCache = null;
  companionCapabilityCacheTime = 0;
  return { optedIn: !!value };
}

async function probeGeminiCli() {
  const found = await findPreferredExecutable('gemini');
  if (!found) {
    return { available: false, path: null, version: null, device_opted_in: geminiDeviceOptedIn() };
  }
  let version = 'installed';
  try {
    const probePath = normalizeCliShim(found);
    const child = await runSpawnedCliForText(probePath, ['--version'], 5000);
    const text = (child.stdout + child.stderr).split(/\r?\n/).map(s => s.trim()).find(Boolean);
    version = (text || version).slice(0, 120);
  } catch {
    version = 'installed';
  }
  return {
    available: true,
    path: found,
    version,
    device_opted_in: geminiDeviceOptedIn(),
  };
}

// ── Antigravity CLI (`agy`, Google) ──────────────────────────────
// Google's successor to Gemini CLI for AI Pro/Ultra subscribers; Gemini
// CLI retires for that tier on 2026-06-18. Binary name `agy`. OAuth-only
// auth per upstream issue #78 — credentials live at
// `~/.config/agy/credentials.json` (Linux/macOS) or the equivalent
// roaming-profile path on Windows. Settings field: `lendGoogleAntigravity`.

function agyDeviceOptedIn(): boolean {
  try {
    return !!readBridgeSettings().lendGoogleAntigravity;
  } catch {
    return false;
  }
}

function setAgyDeviceOptIn(value: boolean) {
  const settings = readBridgeSettings();
  settings.lendGoogleAntigravity = !!value;
  saveBridgeSettings(settings);
  companionCapabilityCache = null;
  companionCapabilityCacheTime = 0;
  return { optedIn: !!value };
}

async function probeAgyCli() {
  // Check the installer's documented home first on the hot probe path.
  // `findPreferredExecutable()` can be slow on large Windows PATHs, while
  // Antigravity's installer normally lands exactly here.
  let found: string | null = null;
  const candidate = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
    : join(homedir(), '.local', 'bin', 'agy');
  if (existsSync(candidate)) found = candidate;
  if (!found) found = await findPreferredExecutable('agy');
  if (!found) {
    return { available: false, path: null, version: null, device_opted_in: agyDeviceOptedIn() };
  }
  // `agy --version` can take 15-20s on Windows because it boots the same
  // Antigravity runtime used for prompt mode. Capability probes sit on the
  // hot routing path, so report install/opt-in state without shelling out.
  return {
    available: true,
    path: found,
    version: 'installed',
    device_opted_in: agyDeviceOptedIn(),
  };
}

function agyAuthSignal(): { authenticated: boolean; via: 'keyring' | 'creds_file' | 'install_marker' | 'env' | 'none' } {
  // Antigravity uses a chained auth source — verified live by tailing
  // `~/.gemini/antigravity-cli/cli.log` from a real `agy -p` invocation:
  //   "ChainedAuth: authenticated via keyring (effective: keyring)"
  //   "OAuth: authenticated successfully as <email>"
  //
  // On Windows the keyring is the Windows Credential Manager; the entry
  // is `LegacyGeneric:target=gemini:antigravity`. There is NO
  // credentials.json file on disk — checking for one (the obvious
  // pattern Claude/Codex/Gemini use) reports `authenticated:false`
  // even when the CLI is fully signed in.
  //
  // Order of detection (cheapest first, no spawn unless needed):
  //   1. Cross-platform creds-file paths (in case a future agy build
  //      writes one)
  //   2. Env-var fallback (GOOGLE_AI_API_KEY / GEMINI_API_KEY)
  //   3. The `installation_id` marker at
  //      `~/.gemini/antigravity-cli/installation_id` — proves agy has
  //      completed its first-run setup (which on Windows means the
  //      keyring entry was provisioned)
  //   4. Windows-only: spawn `cmdkey /list` and grep for
  //      `gemini:antigravity` — authoritative but slow (~50-100ms)
  const credsCandidates = [
    join(homedir(), '.config', 'agy', 'credentials.json'),
    join(homedir(), '.agy', 'credentials.json'),
    join(homedir(), '.antigravity', 'credentials.json'),
  ];
  for (const c of credsCandidates) if (existsSync(c)) return { authenticated: true, via: 'creds_file' };

  if (process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    return { authenticated: true, via: 'env' };
  }

  // Install marker — agy writes `~/.gemini/antigravity-cli/installation_id`
  // on first run. It survives a keyring wipe and is also written when first-run
  // setup completes WITHOUT a successful OAuth, so on Windows it is only a weak
  // fallback: cmdkey (below) is the real authority. On POSIX the keychain isn't
  // cheaply introspectable, so the marker stands in as a best-effort yes.
  const installMarker = join(homedir(), '.gemini', 'antigravity-cli', 'installation_id');
  if (existsSync(installMarker)) {
    // On Windows, verify with cmdkey for an honest answer — the install
    // marker doesn't prove keyring is intact (user could have wiped it
    // via Credential Manager). On POSIX, install marker is sufficient
    // since macOS keychain / libsecret aren't introspectable as cheaply.
    if (process.platform === 'win32') {
      try {
        const { spawnSync } = require('child_process') as typeof import('child_process');
        const result = spawnSync('cmdkey', ['/list'], { encoding: 'utf-8', timeout: 3000 });
        if (result.status === 0) {
          // cmdkey ran successfully — its output is AUTHORITATIVE. The install
          // marker persists even after the keyring is wiped, or when first-run
          // setup completed without a successful OAuth (exactly the state that
          // makes a lent agy pop a browser login on every routed turn), so it
          // must NOT override a clean "no entry" result here.
          return /gemini:antigravity/i.test(result.stdout || '')
            ? { authenticated: true, via: 'keyring' }
            : { authenticated: false, via: 'none' };
        }
      } catch { /* cmdkey unavailable — fall through to the weak marker */ }
      // cmdkey couldn't run (missing/timed out) — fall back to the install
      // marker as a weak yes so a healthy install isn't false-negatived.
      return { authenticated: true, via: 'install_marker' };
    }
    return { authenticated: true, via: 'install_marker' };
  }

  return { authenticated: false, via: 'none' };
}

// ── Grok CLI (xAI) ──────────────────────────────────────────────
// xAI's Grok Build CLI installs to ~/.grok/bin/grok via the shell
// installer (curl -fsSL x.ai/cli/install.sh | bash on macOS/Linux,
// irm x.ai/cli/install.ps1 | iex on Windows PowerShell). Not an npm
// package, so no .cmd shim — just an executable binary on PATH.
// Auth lives at ~/.grok/auth.json after the first browser OIDC flow,
// or the GROK_CODE_XAI_API_KEY env var for headless mode.

function grokDeviceOptedIn(): boolean {
  try {
    return !!readBridgeSettings().lendXaiGrok;
  } catch {
    return false;
  }
}

function setGrokDeviceOptIn(value: boolean) {
  const settings = readBridgeSettings();
  settings.lendXaiGrok = !!value;
  saveBridgeSettings(settings);
  companionCapabilityCache = null;
  companionCapabilityCacheTime = 0;
  return { optedIn: !!value };
}

async function probeGrokCli() {
  // PATH first; fall back to the installer's documented home
  // (~/.grok/bin/grok[.exe]). Don't hunt other locations.
  let found = await findPreferredExecutable('grok');
  if (!found) {
    const grokHome = join(homedir(), '.grok', 'bin');
    const candidate = join(grokHome, process.platform === 'win32' ? 'grok.exe' : 'grok');
    if (existsSync(candidate)) found = candidate;
  }
  if (!found) {
    return { available: false, path: null, version: null, device_opted_in: grokDeviceOptedIn() };
  }
  let version = 'installed';
  try {
    const probePath = normalizeCliShim(found);
    const child = await runSpawnedCliForText(probePath, ['--version'], 5000);
    const text = (child.stdout + child.stderr).split(/\r?\n/).map(s => s.trim()).find(Boolean);
    version = (text || version).slice(0, 120);
  } catch {
    version = 'installed';
  }
  return {
    available: true,
    path: found,
    version,
    device_opted_in: grokDeviceOptedIn(),
  };
}

function grokAuthSignal(): { authenticated: boolean; via: 'auth_file' | 'env' | 'none' } {
  // No documented `grok auth status` subcommand as of 2026-05. Pragmatic
  // check: auth.json from the browser OIDC flow OR the headless env var.
  if (existsSync(join(homedir(), '.grok', 'auth.json'))) return { authenticated: true, via: 'auth_file' };
  if (process.env.GROK_CODE_XAI_API_KEY || process.env.XAI_API_KEY) return { authenticated: true, via: 'env' };
  return { authenticated: false, via: 'none' };
}

function geminiAuthSignal(): { authenticated: boolean; via: 'creds_file' | 'env' | 'none' } {
  // Gemini CLI stores OAuth creds under ~/.gemini or ~/.config/gemini.
  // Use the env var as the alternative signal (GEMINI_API_KEY or
  // GOOGLE_API_KEY).
  const candidates = [
    join(homedir(), '.gemini', 'oauth_creds.json'),
    join(homedir(), '.gemini', 'credentials.json'),
    join(homedir(), '.config', 'gemini', 'credentials.json'),
  ];
  for (const c of candidates) if (existsSync(c)) return { authenticated: true, via: 'creds_file' };
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return { authenticated: true, via: 'env' };
  return { authenticated: false, via: 'none' };
}

function claudeAuthSignal(): { authenticated: boolean; via: 'creds_file' | 'env' | 'none' } {
  // Claude Code stores OAuth creds at ~/.claude/.credentials.json after
  // login. ANTHROPIC_API_KEY env var is the alternative signal.
  if (existsSync(join(homedir(), '.claude', '.credentials.json'))) return { authenticated: true, via: 'creds_file' };
  if (process.env.ANTHROPIC_API_KEY) return { authenticated: true, via: 'env' };
  return { authenticated: false, via: 'none' };
}

function codexAuthSignal(): { authenticated: boolean; via: 'creds_file' | 'env' | 'none' } {
  // Codex (OpenAI) stores auth at ~/.codex/auth.json after login.
  if (existsSync(join(homedir(), '.codex', 'auth.json'))) return { authenticated: true, via: 'creds_file' };
  if (process.env.OPENAI_API_KEY) return { authenticated: true, via: 'env' };
  return { authenticated: false, via: 'none' };
}

// ── Higgsfield CLI (probe wrapper around the handler) ───────────
// Reuses higgsfieldStatus from the handler so the auth check stays in
// one place. Family-gate state is surfaced as the lend equivalent.

async function probeHiggsfieldCli() {
  const familyEnabled = !!readBridgeSettings()?.handlers?.higgsfield?.enabled;
  try {
    const res = await higgsfieldStatus({});
    const r = (res as any)?.result || {};
    return {
      available: !!r.installed,
      path: null, // higgsfield handler discovers internally; surface null here
      version: r.version || null,
      authenticated: !!r.authenticated,
      device_opted_in: familyEnabled,
      credentialsPath: r.credentialsPath || null,
    };
  } catch (e: any) {
    return { available: false, path: null, version: null, authenticated: false, device_opted_in: familyEnabled, error: e?.message || String(e) };
  }
}

// ── cli_run — MCP one-shot lent-CLI runner ──────────────────────
//
// The MCP-facing counterpart to the relay `<model>:cli:turn` handlers (which
// are WebSocket/event-driven and Empir3-server-fed). cli_run lets the *agent in
// the loop* call another model's lent CLI directly with a prompt and get text
// back — the bridge owns the per-model invocation matrix (validated 2026-06-01)
// so an orchestrator doesn't hand-roll PowerShell per model. Governance: each
// run is refused unless that CLI's lend toggle is on. Does NOT touch the relay
// turn handlers — separate consumer, separate path.

const CLI_RUN_DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;
const CLI_RUN_MAX_TIMEOUT_MS = 20 * 60 * 1000;
const CLI_RUN_BIG_PROMPT_CHARS = 8000; // above this, route via file/stdin not argv
const CLI_RUNS_DIR = join(homedir(), '.empir3-bridge', 'cli-runs');
const CLI_RUN_REGISTRY_MAX = 50;

// Isolated HOME for lent grok runs. xAI's grok CLI is a Claude-Code-compatible
// drop-in: it resolves the user's ~/.claude tree (settings.json hooks + the
// global CLAUDE.md) off the home/profile env vars. Two unwanted effects when we
// spawn it: (1) it fires the user's PreToolUse hooks — extension-less scripts
// that Windows ShellExecute can't launch, so each search pops a "Select an app
// to open…" dialog; (2) it loads the user's global CLAUDE.md (their infra map)
// into grok's context and ships it to xAI on every run. Fix: give grok a private
// home dir that carries a junction to the real ~/.grok (auth, config, history
// preserved and shared with interactive grok) but has NO .claude — so grok finds
// its own state and zero Claude config. Best-effort: any failure returns null and
// the caller leaves the inherited env untouched (grok still runs, just unisolated).
function grokIsolatedHome(): string | null {
  try {
    const real = homedir();
    const grokHome = join(real, '.empir3-bridge', 'grok-home');
    mkdirSync(grokHome, { recursive: true });
    const realGrok = join(real, '.grok');
    const linkGrok = join(grokHome, '.grok');
    // Only link when the real ~/.grok exists; if the user authed via the
    // GROK_CODE_XAI_API_KEY env var instead, there's nothing to link and grok
    // falls back to that key (passed through untouched).
    if (existsSync(realGrok) && !existsSync(linkGrok)) {
      // Junction on Windows needs no admin/developer-mode; dir symlink elsewhere.
      symlinkSync(realGrok, linkGrok, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return grokHome;
  } catch {
    return null;
  }
}

const CLI_RUN_MODELS: Record<string, { label: string; lend: () => boolean; find: () => Promise<string | null> }> = {
  codex:  { label: 'OpenAI Codex',  lend: codexDeviceOptedIn,  find: () => findPreferredExecutable('codex') },
  grok:   { label: 'xAI Grok',      lend: grokDeviceOptedIn,   find: findGrokBinary },
  // gemini-cli removed (0.3.23): Google killed the individual gemini-cli tier.
  // agy (Antigravity) is a separate slug and stays. See CLI_ROWS / cli_run.
  claude: { label: 'Claude Code',   lend: claudeDeviceOptedIn, find: () => findPreferredExecutable('claude') },
  agy:    { label: 'Google Antigravity', lend: agyDeviceOptedIn, find: () => findPreferredExecutable('agy') },
};

// The resolver already folds in the xAI installer's ~/.grok/bin location, so
// this is now just an alias kept for the CLI_RUN_MODELS find() signature.
async function findGrokBinary(): Promise<string | null> {
  return findPreferredExecutable('grok');
}

interface CliRunRecord {
  id: string; model: string; status: 'running' | 'done' | 'error' | 'timeout';
  startedAt: number; endedAt?: number; cwd?: string; mode: string;
  exitCode?: number; text?: string; transcriptPath?: string; tail?: string; error?: string;
}
const cliRunRegistry = new Map<string, CliRunRecord>();

function trimCliRunRegistry() {
  if (cliRunRegistry.size <= CLI_RUN_REGISTRY_MAX) return;
  const old = Array.from(cliRunRegistry.values()).sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, cliRunRegistry.size - CLI_RUN_REGISTRY_MAX);
  for (const r of old) cliRunRegistry.delete(r.id);
}

function newCliRunId() { return `clirun-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }

function runCliCapture(cliPath: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number }): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; elapsedMs: number }> {
  return new Promise(resolve => {
    const start = Date.now();
    const stdio: any[] = [opts.stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'];
    let child: ChildProcess;
    try {
      child = spawnCli(cliPath, args, { cwd: opts.cwd, env: opts.env, stdio });
    } catch (e: any) {
      resolve({ stdout: '', stderr: `spawn failed: ${e?.message || String(e)}`, exitCode: -1, timedOut: false, elapsedMs: Date.now() - start });
      return;
    }
    let stdout = '', stderr = '', killed = false, timedOut = false, outBytes = 0, errBytes = 0;
    const MAXB = 8 * 1024 * 1024;
    const timer = setTimeout(() => {
      timedOut = true; killed = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 4000);
    }, opts.timeoutMs);
    child.stdout?.on('data', (c: Buffer) => { outBytes += c.length; if (outBytes <= MAXB) stdout += c.toString('utf-8'); });
    child.stderr?.on('data', (c: Buffer) => { errBytes += c.length; if (errBytes <= MAXB) stderr += c.toString('utf-8'); });
    child.on('error', (e: any) => { stderr += `\n[spawn error] ${e?.message || String(e)}`; });
    if (opts.stdin != null) { try { child.stdin?.write(opts.stdin); child.stdin?.end(); } catch {} }
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: killed ? -1 : (code ?? -1), timedOut, elapsedMs: Date.now() - start });
    });
  });
}

// ConPTY sibling of runCliCapture for TTY-gated CLIs. Some CLIs (notably agy /
// Antigravity) render their response via an in-place terminal "drip" animation
// and write NOTHING to a non-TTY pipe — so runCliCapture returns empty stdout
// even though the model generated a full answer (verified: agy's cli.log shows
// streamGenerateContent succeeding while the pipe stays empty). Spawning under a
// pseudo-console makes the CLI believe it has a real terminal, so it emits the
// same bytes it would interactively; we strip the ANSI back to clean text. Same
// return shape as runCliCapture (stderr folds into stdout — a pty is one stream).
async function runCliCapturePty(cliPath: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number }): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; elapsedMs: number }> {
  const start = Date.now();
  let nodePty: typeof import('node-pty');
  try { nodePty = await import('node-pty'); }
  catch (e: any) { return { stdout: '', stderr: `node-pty load failed: ${e?.message || String(e)}`, exitCode: -1, timedOut: false, elapsedMs: Date.now() - start }; }
  return new Promise(resolve => {
    const shape = buildPtySpawnShape(cliPath, args);
    let proc: IPty;
    try {
      proc = nodePty.spawn(shape.file, shape.args, {
        name: 'xterm-256color', cols: 120, rows: 30,
        cwd: opts.cwd || process.cwd(),
        env: { ...(opts.env || process.env) } as any,
        ...(process.platform === 'win32' ? { useConpty: true } : {}),
      });
    } catch (e: any) {
      resolve({ stdout: '', stderr: `pty spawn failed: ${e?.message || String(e)}`, exitCode: -1, timedOut: false, elapsedMs: Date.now() - start });
      return;
    }
    let raw = '', killed = false, timedOut = false, done = false, bytes = 0;
    const MAXB = 8 * 1024 * 1024;
    const timer = setTimeout(() => {
      timedOut = true; killed = true;
      try { proc.kill(); } catch {}
    }, opts.timeoutMs);
    if (opts.stdin != null) { try { proc.write(opts.stdin); } catch {} }
    const dataSub = proc.onData((d) => { const s = String(d || ''); bytes += s.length; if (bytes <= MAXB) raw += s; });
    proc.onExit((ev) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { dataSub.dispose(); } catch {}
      const clean = stripAnsiForBridge(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      resolve({ stdout: clean, stderr: '', exitCode: killed ? -1 : (ev.exitCode ?? -1), timedOut, elapsedMs: Date.now() - start });
    });
  });
}

// codex exec --json emits JSONL events; the assistant's final text is an
// agent_message. Collect the last one; fall back to raw stdout if shapes differ.
function parseCodexJsonOutput(stdout: string): string {
  let best = '';
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let ev: any; try { ev = JSON.parse(t); } catch { continue; }
    const cand =
      (ev?.item?.type === 'agent_message' ? (ev.item.text || ev.item.message) : '') ||
      (ev?.msg?.type === 'agent_message' ? (ev.msg.message || ev.msg.text) : '') ||
      (ev?.type === 'agent_message' ? (ev.text || ev.message) : '') ||
      ev?.agent_message || '';
    if (typeof cand === 'string' && cand.trim()) best = cand;
  }
  return best.trim();
}

// Gemini CLI spews terminal-setup chatter on stderr/stdout; strip the known noise.
function stripCliNoise(s: string): string {
  return s.split(/\r?\n/)
    .filter(l => !/256.?color|Ripgrep not available|^\s*\[dotenv|DeprecationWarning|ExperimentalWarning|Loaded cached credentials/i.test(l))
    .join('\n');
}

async function cliRun(cmd: any): Promise<any> {
  const model = String(cmd?.model || '').toLowerCase().trim();
  const spec = CLI_RUN_MODELS[model];
  if (!spec) return { success: false, error: `cli_run: unknown model "${cmd?.model}". Use one of: ${Object.keys(CLI_RUN_MODELS).join(', ')}` };
  if (!spec.lend()) return { success: false, error: `cli_run: ${spec.label} is not lent — turn on its toggle in the bridge's API & CLIs pane first.`, stage: 'lend_disabled', recoverable: true };

  let promptText = typeof cmd?.prompt === 'string' ? cmd.prompt : '';
  const promptFileIn = typeof cmd?.promptFile === 'string' ? cmd.promptFile : '';
  if (!promptText && promptFileIn) {
    try { promptText = readFileSync(promptFileIn, 'utf-8'); } catch (e: any) { return { success: false, error: `cli_run: cannot read promptFile: ${e?.message || e}` }; }
  }
  if (!promptText.trim()) return { success: false, error: 'cli_run: a non-empty prompt (or promptFile) is required' };

  const bin = await spec.find();
  if (!bin) return { success: false, error: `cli_run: ${spec.label} CLI not found on this machine.` };

  // Default the run cwd to the bridge's configured Home Directory (Daemon pane,
  // ~/Documents/Empir3) so lent CLIs land in the approved workspace — matching
  // the interactive launcher and the relay :cli:turn path. An explicit cmd.cwd
  // overrides per-run; if neither resolves to a real dir, leave it to spawn's
  // default (daemon process dir). (Added 2026-06-02.)
  const settingsHome = readBridgeSettings()?.homeDirectory;
  const cwd = (typeof cmd?.cwd === 'string' && cmd.cwd)
    ? cmd.cwd
    : (typeof settingsHome === 'string' && settingsHome && existsSync(settingsHome) ? settingsHome : undefined);
  const mode = cmd?.mode === 'agentic' ? 'agentic' : 'text';
  const modelId = typeof cmd?.modelId === 'string' ? cmd.modelId.trim() : '';
  const timeoutMs = Math.min(CLI_RUN_MAX_TIMEOUT_MS, Math.max(10_000, Number(cmd?.timeoutMs) || CLI_RUN_DEFAULT_TIMEOUT_MS));
  const background = !!cmd?.background;
  const big = promptText.length > CLI_RUN_BIG_PROMPT_CHARS;

  const id = newCliRunId();
  mkdirSync(CLI_RUNS_DIR, { recursive: true });
  const tmpPromptFile = join(CLI_RUNS_DIR, `${id}.prompt.txt`);

  let argv: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env };
  let stdin: string | undefined;
  let parse: 'codex-json' | 'text' = 'text';

  if (model === 'codex') {
    // Prompt on stdin (trailing '-') avoids arg-length + escaping issues.
    argv = ['exec', '--json', '--skip-git-repo-check', '--sandbox', mode === 'agentic' ? 'workspace-write' : 'read-only'];
    if (cwd) argv.push('--cd', cwd);
    if (modelId) argv.push('-m', modelId);
    argv.push('-');
    stdin = promptText;
    parse = 'codex-json';
  } else if (model === 'grok') {
    // Always prompt-file — a plain -p with a large prompt errors exit-2.
    writeFileSync(tmpPromptFile, promptText, 'utf-8');
    argv = ['--prompt-file', tmpPromptFile, '--output-format', 'plain'];
    // grok-build is agentic-first: any tool call (todo/web/file) blocks on an
    // approval prompt that never arrives headlessly → empty stdout AND no file
    // written (verified 2026-06-02). Auto-approve so the run completes; in
    // agentic mode this lets it actually write in cwd.
    argv.push('--always-approve');
    if (cwd) argv.push('--cwd', cwd);
    // Isolate grok from the user's global ~/.claude (hooks + CLAUDE.md) by
    // pointing every home/profile var it might resolve `~` from at a private dir
    // (see grokIsolatedHome). APPDATA/LOCALAPPDATA are left untouched so caches
    // and per-user app data are unaffected — only `~`-relative lookups move.
    const gh = grokIsolatedHome();
    if (gh) {
      env.HOME = gh;
      if (process.platform === 'win32') {
        env.USERPROFILE = gh;
        env.HOMEDRIVE = gh.slice(0, 2);
        env.HOMEPATH = gh.slice(2);
      }
    }
  } else if (model === 'gemini') {
    env.GEMINI_CLI_TRUST_WORKSPACE = 'true'; // headless in untrusted dir → exit-55 without this
    if (big) { argv = []; stdin = promptText; } else { argv = ['-p', promptText]; }
    // Without this gemini runs read-only and reports "write_file … not available"
    // when asked to write (verified 2026-06-02). yolo auto-approves all tools.
    if (mode === 'agentic') argv.push('--yolo');
  } else if (model === 'claude') {
    if (big) { argv = ['-p']; stdin = promptText; } else { argv = ['-p', promptText]; }
    // Default headless permission mode auto-DENIES Write, yet the model still
    // reports success — a silent false-write (verified 2026-06-02). acceptEdits
    // lets it actually create/edit files in the spawn cwd.
    if (mode === 'agentic') argv.push('--permission-mode', 'acceptEdits');
  } else if (model === 'agy') {
    // Antigravity. Mirrors the proven relay agy:cli:turn invocation:
    // `agy --dangerously-skip-permissions -p @<promptfile>`. The skip-permissions
    // flag is required even for plain prompts — without it agy blocks on per-tool
    // confirmation and hangs in a headless spawn (upstream issue #78). Prompt is
    // delivered via agy's @<file> reference syntax (no argv length limit).
    writeFileSync(tmpPromptFile, promptText, 'utf-8');
    argv = ['--dangerously-skip-permissions', '-p', '@' + tmpPromptFile];
  }

  const runOnce = async (): Promise<CliRunRecord> => {
    const rec: CliRunRecord = { id, model, status: 'running', startedAt: Date.now(), cwd, mode };
    cliRunRegistry.set(id, rec);
    // agy (Antigravity) is TTY-gated — its print-mode answer never flushes to a
    // plain pipe, so it must run under a ConPTY to emit anything. Other CLIs
    // flush fine to a pipe and keep the lighter runCliCapture path.
    const r = model === 'agy'
      ? await runCliCapturePty(normalizeCliShim(bin), argv, { cwd, env, stdin, timeoutMs })
      : await runCliCapture(normalizeCliShim(bin), argv, { cwd, env, stdin, timeoutMs });
    rec.exitCode = r.exitCode;
    rec.endedAt = Date.now();
    const text = parse === 'codex-json'
      ? (parseCodexJsonOutput(r.stdout) || stripCliNoise(r.stdout).trim())
      : stripCliNoise(r.stdout).trim();
    rec.text = text;
    rec.tail = text.slice(-2000);
    if (r.timedOut) { rec.status = 'timeout'; rec.error = `timed out after ${r.elapsedMs}ms`; }
    else if (r.exitCode !== 0 && !text) { rec.status = 'error'; rec.error = (stripCliNoise(r.stderr).trim() || `exit ${r.exitCode}`).slice(0, 2000); }
    else rec.status = 'done';
    try {
      const tp = join(CLI_RUNS_DIR, `${id}.json`);
      writeFileSync(tp, JSON.stringify({ id, model, mode, cwd, startedAt: rec.startedAt, endedAt: rec.endedAt, exitCode: r.exitCode, durationMs: r.elapsedMs, prompt: promptText, text, stderr: stripCliNoise(r.stderr).slice(0, 20000) }, null, 2));
      rec.transcriptPath = tp;
    } catch {}
    try { if (existsSync(tmpPromptFile)) unlinkSync(tmpPromptFile); } catch {}
    trimCliRunRegistry();
    return rec;
  };

  if (background) {
    runOnce().catch(e => { const rec = cliRunRegistry.get(id); if (rec) { rec.status = 'error'; rec.error = e?.message || String(e); rec.endedAt = Date.now(); } });
    return { success: true, result: { id, model, mode, status: 'running', background: true, message: 'Run started; poll cli_run_status(id) or list with cli_runs.', transcriptDir: CLI_RUNS_DIR } };
  }
  const rec = await runOnce();
  return {
    success: rec.status === 'done',
    result: {
      id, model, mode, status: rec.status, exitCode: rec.exitCode,
      durationMs: (rec.endedAt || 0) - rec.startedAt,
      text: rec.text, transcriptPath: rec.transcriptPath,
      ...(rec.error ? { error: rec.error } : {}),
    },
  };
}

function cliRunsList(): any {
  const runs = Array.from(cliRunRegistry.values())
    .sort((a, b) => b.startedAt - a.startedAt).slice(0, 30)
    .map(r => ({ id: r.id, model: r.model, status: r.status, startedAt: new Date(r.startedAt).toISOString(), durationMs: (r.endedAt || Date.now()) - r.startedAt, cwd: r.cwd, transcriptPath: r.transcriptPath }));
  return { success: true, result: { runs, count: runs.length } };
}

// cli_status — discovery for the driving agent: which lent CLIs can it actually
// use right now, and why not. Lets the agent route work without trial-and-error
// "X is not lent" refusals. Reuses the same lend/find primitives cli_run gates on.
async function cliRunRoster(): Promise<any> {
  const authByModel: Record<string, () => boolean> = {
    codex: () => codexAuthSignal().authenticated,
    grok: () => grokAuthSignal().authenticated,
    claude: () => claudeAuthSignal().authenticated,
    agy: () => agyAuthSignal().authenticated,
  };
  const models = await Promise.all(Object.entries(CLI_RUN_MODELS).map(async ([model, spec]) => {
    let path: string | null = null;
    try { path = await spec.find(); } catch {}
    const available = !!path;
    const lent = !!spec.lend();
    const authenticated = available ? (authByModel[model]?.() ?? false) : false;
    const install = !available ? cliInstallPublic(model) : null;
    return {
      model,
      label: spec.label,
      available,
      lent,
      authenticated,
      ready: available && lent && authenticated,
      // null when ready; otherwise the first thing blocking a run.
      blocker: !available ? 'cli_not_installed'
             : !lent ? 'not_lent'
             : !authenticated ? 'not_signed_in'
             : null,
      // When not installed, the exact command to install it. Lets a user just
      // say "install grok" and have the driving agent run this with its shell.
      ...(install ? { installCommand: install.command, installUrl: install.docsUrl } : {}),
    };
  }));
  return {
    success: true,
    result: {
      models,
      readyCount: models.filter(m => m.ready).length,
      hint: 'Drive a ready:true model with cli_run({model, prompt, mode}). mode:"agentic" lets it write files in cwd (defaults to the bridge Home Directory). A cli_not_installed model carries installCommand — if the user asks you to install it, run that command with your own shell, then re-check. not_lent models are refused until the user enables that CLI on the bridge\'s API & CLIs pane. For image/video generation use the higgsfield_* tools instead.',
    },
  };
}

function cliRunStatus(cmd: any): any {
  const id = String(cmd?.id || '');
  const r = cliRunRegistry.get(id);
  if (!r) return { success: false, error: `cli_run_status: no run with id "${id}" (it may have aged out — keeps the last ${CLI_RUN_REGISTRY_MAX}).` };
  return {
    success: true,
    result: {
      id: r.id, model: r.model, mode: r.mode, status: r.status, exitCode: r.exitCode,
      startedAt: new Date(r.startedAt).toISOString(),
      durationMs: (r.endedAt || Date.now()) - r.startedAt,
      transcriptPath: r.transcriptPath, tail: r.tail,
      ...(r.error ? { error: r.error } : {}),
      ...(r.status !== 'running' ? { text: r.text } : {}),
    },
  };
}

// ── Auth launch — Phase 3 ───────────────────────────────────────
// Spawn the CLI's auth flow in a detached console window. Each CLI
// owns its own browser OIDC redirect; we just kick it off. Returns
// `{ launched: true }` immediately — the user finishes in the browser.

interface AuthLaunchSpec {
  bin: string;
  args: string[];
  notes?: string;
}

function authLaunchSpec(provider: string): AuthLaunchSpec | { error: string } {
  switch (provider) {
    case 'claude':
      return { bin: 'claude', args: ['/login'], notes: 'Opens the Claude Code login flow.' };
    case 'codex':
      return { bin: 'codex', args: ['login'], notes: 'Opens the Codex CLI login flow.' };
    case 'higgsfield':
      return { bin: 'higgsfield', args: ['auth', 'login'], notes: 'Opens the Higgsfield CLI login flow.' };
    case 'github':
      return { bin: 'gh', args: ['auth', 'login'], notes: 'Opens the GitHub CLI login flow.' };
    case 'gemini':
      return { bin: 'gemini', args: ['auth', 'login'], notes: 'Opens the Gemini CLI login flow.' };
    case 'grok':
      // First run launches browser OIDC. No subcommand.
      return { bin: 'grok', args: [], notes: 'Opens the Grok CLI (first run triggers browser OIDC).' };
    case 'agy':
      // Antigravity is OAuth-only as of upstream issue #78 — first run
      // triggers a browser OIDC redirect. No login subcommand exists.
      return { bin: 'agy', args: [], notes: 'Opens the Antigravity CLI (first run triggers browser OIDC).' };
    default:
      return { error: `Unknown provider: ${provider}` };
  }
}

async function launchProviderAuth(provider: string): Promise<{ ok: boolean; launched?: boolean; error?: string }> {
  const spec = authLaunchSpec(provider);
  if ('error' in spec) return { ok: false, error: spec.error };

  // Resolve the binary path the same way the probes do — PATH first,
  // then the provider's known fallback location.
  let bin: string | null = await findPreferredExecutable(spec.bin);
  if (!bin && provider === 'grok') {
    const candidate = join(homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
    if (existsSync(candidate)) bin = candidate;
  }
  if (!bin && provider === 'higgsfield' && process.platform === 'win32') {
    const candidate = join(process.env.APPDATA || '', 'npm', 'higgsfield.cmd');
    if (existsSync(candidate)) bin = candidate;
  }
  if (!bin && provider === 'github' && process.platform === 'win32') {
    const candidate = join(process.env['ProgramFiles'] || 'C:\\Program Files', 'GitHub CLI', 'gh.exe');
    if (existsSync(candidate)) bin = candidate;
  }
  if (!bin && provider === 'agy') {
    const candidate = process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
      : join(homedir(), '.local', 'bin', 'agy');
    if (existsSync(candidate)) bin = candidate;
  }
  if (!bin) return { ok: false, error: `${spec.bin} CLI not installed — install it first` };

  try {
    const cliPath = normalizeCliShim(bin);
    if (process.platform === 'win32') {
      // Get a fresh console window by combining `detached: true` +
      // `stdio: 'ignore'` + `windowsHide: false` — Windows gives a
      // detached child process with no inherited handles its own
      // console. This avoids the `start ""` title-quoting quirk that
      // mangled .cmd-shim invocations (gemini.cmd, higgsfield.cmd,
      // claude.cmd) on the previous attempt.
      const isShim = /\.(cmd|bat)$/i.test(cliPath);
      // cwd = the bridge's approved project root (configured on the
      // Daemon pane, defaults to ~/Documents/Empir3). Keeps CLIs scoped
      // to the empir3 workspace instead of the user's whole profile —
      // matters for Gemini's first-run "trust this folder?" gate, which
      // should ask about the project root, not C:\Users\<user>\.
      // Falls back to homedir() only if the setting is missing/invalid.
      const projectRoot = readBridgeSettings().homeDirectory;
      const launchCwd = (typeof projectRoot === 'string' && projectRoot && existsSync(projectRoot))
        ? projectRoot : homedir();
      if (provider === 'agy') {
        // Antigravity's CLI is TTY-gated. The generic detached + stdio:'ignore'
        // launch points agy's std handles at NUL, so isatty()=false: agy reports
        // "CLI ready for user input", immediately reads EOF on the NUL stdin, and
        // exits with "not logged into Antigravity" WITHOUT ever rendering its
        // sign-in screen or opening the browser. (Other CLIs survive NUL stdio
        // because they just fire a browser + localhost callback; agy needs a real
        // terminal.) `start` opens a FRESH console and wires the child's stdio to
        // it, so agy sees a true TTY, renders its sign-in flow, opens the browser
        // OIDC, and stays alive to catch the callback that writes the keyring.
        // agy.exe is a real exe (not a .cmd shim), so the `start ""` title-quoting
        // quirk that bit the shim CLIs doesn't apply — and we pass an explicit
        // window title so a quoted cliPath is never mistaken for the title.
        spawn('cmd.exe', ['/d', '/s', '/c', 'start', 'Antigravity sign-in', cliPath, ...spec.args], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
          cwd: launchCwd,
        }).unref();
      } else if (isShim) {
        // CVE-2024-27980 blocks direct .cmd spawn on Node 18.20+/20.12+.
        // Wrap through cmd.exe like cli-runner.ts does. Node escapes
        // each arg correctly when shell:false.
        spawn('cmd.exe', ['/d', '/s', '/c', cliPath, ...spec.args], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
          cwd: launchCwd,
        }).unref();
      } else {
        spawn(cliPath, spec.args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
          cwd: launchCwd,
        }).unref();
      }
    } else {
      // macOS/Linux: best-effort — spawn detached. If a terminal app isn't
      // already in PATH the user sees nothing visible; that's a Windows-
      // primary product so this branch is rarely hit.
      const projectRoot = readBridgeSettings().homeDirectory;
      const launchCwd = (typeof projectRoot === 'string' && projectRoot && existsSync(projectRoot))
        ? projectRoot : homedir();
      spawn(cliPath, spec.args, { detached: true, stdio: 'ignore', cwd: launchCwd }).unref();
    }
    return { ok: true, launched: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ── CLI install catalog ─────────────────────────────────────────
// Single source of truth for "how do I get this CLI". Drives three things:
//   1. the NOT INSTALLED row in the API & CLIs pane (copy command + Get-it link)
//   2. the in-bridge "Install" button (launchProviderInstall runs the line in a
//      visible console so the user watches it, then clicks Re-scan)
//   3. the `installCommand` hint in cli_status, so a user can just tell their
//      driving agent "install gemini" and it runs the right command itself.
interface CliInstallSpec {
  copyWin: string;        // command shown/copied on Windows
  copyNix: string;        // command shown/copied on macOS/Linux
  docsUrl: string;        // "Get it →" official page
  runWin?: { shell: 'cmd' | 'pwsh'; line: string };  // what the Install button runs on Windows
  runNix?: { line: string };                         // what it runs on macOS/Linux (best-effort)
  note?: string;          // one-liner shown under the command (e.g. "needs Node 18+")
}

const CLI_INSTALL: Record<string, CliInstallSpec> = {
  claude: {
    copyWin: 'npm install -g @anthropic-ai/claude-code',
    copyNix: 'npm install -g @anthropic-ai/claude-code',
    docsUrl: 'https://claude.com/claude-code',
    runWin: { shell: 'cmd', line: 'npm install -g @anthropic-ai/claude-code' },
    runNix: { line: 'npm install -g @anthropic-ai/claude-code' },
    note: 'Or the native installer: irm https://claude.ai/install.ps1 | iex',
  },
  codex: {
    copyWin: 'npm install -g @openai/codex',
    copyNix: 'npm install -g @openai/codex',
    docsUrl: 'https://github.com/openai/codex',
    runWin: { shell: 'cmd', line: 'npm install -g @openai/codex' },
    runNix: { line: 'npm install -g @openai/codex' },
  },
  gemini: {
    copyWin: 'npm install -g @google/gemini-cli',
    copyNix: 'npm install -g @google/gemini-cli',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    runWin: { shell: 'cmd', line: 'npm install -g @google/gemini-cli' },
    runNix: { line: 'npm install -g @google/gemini-cli' },
  },
  grok: {
    copyWin: 'irm https://x.ai/cli/install.ps1 | iex',
    copyNix: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    docsUrl: 'https://docs.x.ai/docs/cli',
    runWin: { shell: 'pwsh', line: 'irm https://x.ai/cli/install.ps1 | iex' },
    runNix: { line: 'curl -fsSL https://x.ai/cli/install.sh | bash' },
    note: 'xAI installer — drops grok into ~/.grok/bin (not an npm package).',
  },
  higgsfield: {
    copyWin: 'npm install -g higgsfield-cli --ignore-scripts',
    copyNix: 'npm install -g higgsfield-cli --ignore-scripts',
    docsUrl: 'https://www.npmjs.com/package/higgsfield-cli',
    runWin: { shell: 'cmd', line: 'npm install -g higgsfield-cli --ignore-scripts' },
    runNix: { line: 'npm install -g higgsfield-cli --ignore-scripts' },
  },
  github: {
    copyWin: 'winget install --id GitHub.cli -e',
    copyNix: 'brew install gh',
    docsUrl: 'https://cli.github.com',
    runWin: { shell: 'cmd', line: 'winget install --id GitHub.cli -e --source winget' },
    runNix: { line: 'brew install gh' },
  },
  agy: {
    copyWin: 'Download Antigravity, then run: agy install',
    copyNix: 'Download Antigravity, then run: agy install',
    docsUrl: 'https://antigravity.google',
    // No clean one-line installer — the headless `agy` CLI ships with the
    // Antigravity download. The Install button opens the download page.
    runWin: { shell: 'cmd', line: 'start "" https://antigravity.google' },
    runNix: { line: 'open https://antigravity.google || xdg-open https://antigravity.google' },
    note: 'Antigravity (Gemini) headless CLI. The IDE launcher `antigravity-ide` is not the same — the bridge needs the `agy` CLI (has -p/--print). After install, run `agy install` to wire up PATH.',
  },
};

// Platform-resolved install info for the UI / cli_status. Returns null for
// CLIs we don't have a recipe for (custom providers etc).
function cliInstallPublic(id: string): { command: string; docsUrl: string; note?: string } | null {
  const spec = CLI_INSTALL[id];
  if (!spec) return null;
  return {
    command: process.platform === 'win32' ? spec.copyWin : spec.copyNix,
    docsUrl: spec.docsUrl,
    ...(spec.note ? { note: spec.note } : {}),
  };
}

// Run a CLI's install command in a fresh, visible console window so the user
// watches it succeed or fail, then comes back and clicks Re-scan. Mirrors
// launchProviderAuth's detached-console approach. We deliberately do NOT
// capture/auto-confirm — global installs and winget can prompt, and the user
// should see exactly what's running on their machine.
async function launchProviderInstall(provider: string): Promise<{ ok: boolean; launched?: boolean; command?: string; error?: string }> {
  const spec = CLI_INSTALL[provider];
  if (!spec) return { ok: false, error: `No install recipe for "${provider}".` };
  try {
    if (process.platform === 'win32') {
      const run = spec.runWin;
      if (!run) return { ok: false, error: `No Windows install recipe for "${provider}".` };
      if (run.shell === 'pwsh') {
        // -NoExit keeps the window open on the result; -Command runs the line.
        spawn('powershell.exe', ['-NoExit', '-NoProfile', '-Command', run.line], {
          detached: true, stdio: 'ignore', windowsHide: false, cwd: homedir(),
        }).unref();
      } else {
        // cmd /k runs the line then keeps the console open so output stays visible.
        spawn('cmd.exe', ['/k', run.line], {
          detached: true, stdio: 'ignore', windowsHide: false, cwd: homedir(),
        }).unref();
      }
      return { ok: true, launched: true, command: run.line };
    }
    const run = spec.runNix;
    if (!run) return { ok: false, error: `No install recipe for "${provider}" on this platform.` };
    // macOS/Linux: best-effort detached run; no guaranteed visible terminal on
    // a headless box. Windows-primary product, so this branch is rarely hit.
    spawn('bash', ['-lc', run.line], { detached: true, stdio: 'ignore', cwd: homedir() }).unref();
    return { ok: true, launched: true, command: run.line };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ── Custom OpenAI-compatible providers ─────────────────────────
//
// V1: local-only. Lets the user paste a JSON definition so any
// OpenAI-compatible endpoint
// (Ollama, LM Studio, llama-server, OpenRouter, Groq Cloud, Together,
// vLLM, etc) becomes a routable inference target for local MCP clients
// via the custom_llm tool. Empir3 server-side relay does NOT yet route
// through these — that's a v2 piece that requires server-side work in
// a separate repo. Bridge-only for v1.

interface CustomProvider {
  slug: string;
  name: string;
  apiBaseUrl: string;     // e.g. http://localhost:11434/v1
  models?: string[];      // auto-populated from /models if empty
  apiKey?: string;        // optional — Ollama doesn't need one, OpenRouter does
  lend?: boolean;         // future: when true, bridge will offer it to empir3 relay
}

const PROVIDER_PROBE_TIMEOUT_MS = 4000;
const PROVIDER_CHAT_TIMEOUT_MS = 5 * 60 * 1000;

function readCustomProviders(): CustomProvider[] {
  try {
    const list = readBridgeSettings().customProviders;
    if (!Array.isArray(list)) return [];
    return list.filter(isValidProviderEntry);
  } catch {
    return [];
  }
}

function saveCustomProviders(next: CustomProvider[]): void {
  const settings = readBridgeSettings();
  settings.customProviders = next;
  saveBridgeSettings(settings);
}

function isValidProviderEntry(p: any): p is CustomProvider {
  return !!p && typeof p === 'object'
    && typeof p.slug === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(p.slug)
    && typeof p.name === 'string' && p.name.trim().length > 0
    && typeof p.apiBaseUrl === 'string' && /^https?:\/\//i.test(p.apiBaseUrl);
}

function validateProviderJson(raw: any): { ok: true; provider: CustomProvider } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Definition must be a JSON object' };
  const slug = String(raw.slug || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) return { ok: false, error: '`slug` must be alphanumeric (with - or _)' };
  const name = String(raw.name || '').trim();
  if (!name) return { ok: false, error: '`name` is required' };
  const apiBaseUrl = String(raw.apiBaseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(apiBaseUrl)) return { ok: false, error: '`apiBaseUrl` must be a http(s) URL' };
  const provider: CustomProvider = { slug, name, apiBaseUrl };
  if (Array.isArray(raw.models)) {
    provider.models = raw.models.map((m: any) => String(m)).filter(Boolean);
  }
  if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) {
    provider.apiKey = raw.apiKey.trim();
  }
  if (typeof raw.lend === 'boolean') provider.lend = raw.lend;
  return { ok: true, provider };
}

async function probeCustomProvider(p: CustomProvider): Promise<{ available: boolean; authError?: boolean; models?: string[]; error?: string; ms: number }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_PROBE_TIMEOUT_MS);
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (p.apiKey) headers['Authorization'] = `Bearer ${p.apiKey}`;
    const res = await fetch(`${p.apiBaseUrl.replace(/\/+$/, '')}/models`, { headers, signal: controller.signal });
    clearTimeout(timer);
    const ms = Date.now() - start;
    if (res.status === 401 || res.status === 403) return { available: true, authError: true, ms };
    if (!res.ok) return { available: false, error: `HTTP ${res.status}`, ms };
    const body: any = await res.json().catch(() => null);
    // Common shape: { object: 'list', data: [{id, ...}] }. Some runtimes
    // (Ollama via /api/tags, lm-studio) return slightly different — we
    // normalize anything that looks like a list of objects-with-ids.
    let models: string[] = [];
    if (body && Array.isArray(body.data)) {
      models = body.data.map((m: any) => String(m?.id || m?.name || '')).filter(Boolean);
    } else if (Array.isArray(body)) {
      models = body.map((m: any) => String(m?.id || m?.name || m)).filter(Boolean);
    }
    return { available: true, models, ms };
  } catch (e: any) {
    return { available: false, error: e?.message || String(e), ms: Date.now() - start };
  }
}

async function buildCustomProvidersState() {
  const providers = readCustomProviders();
  const probes = await Promise.all(providers.map(async (p) => {
    const probe = await probeCustomProvider(p);
    // If the user didn't supply a model list and the probe returned one,
    // surface the auto-detected list in the response (don't auto-save
    // — keep settings.json clean of derived state).
    const effectiveModels = (p.models && p.models.length) ? p.models : probe.models;
    return {
      slug: p.slug,
      name: p.name,
      apiBaseUrl: p.apiBaseUrl,
      apiKeySet: !!p.apiKey,
      lend: !!p.lend,
      available: probe.available,
      authError: !!probe.authError,
      models: effectiveModels || [],
      probeMs: probe.ms,
      error: probe.error,
    };
  }));
  return probes;
}

async function chatWithCustomProvider(opts: { slug: string; model: string; prompt: string; system?: string }): Promise<{ ok: boolean; text?: string; error?: string; raw?: any }> {
  const provider = readCustomProviders().find(p => p.slug === opts.slug);
  if (!provider) return { ok: false, error: `Unknown provider: ${opts.slug}` };
  if (!opts.model) return { ok: false, error: '`model` is required' };
  if (!opts.prompt) return { ok: false, error: '`prompt` is required' };
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
  const messages: any[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_CHAT_TIMEOUT_MS);
    const res = await fetch(`${provider.apiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: opts.model, messages, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 500)}` };
    }
    const body: any = await res.json().catch(() => null);
    const text = body?.choices?.[0]?.message?.content || '';
    return { ok: true, text, raw: body };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function codexMessageText(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: any) => {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text') return block.text || '';
    // Image blocks carry no text — single-call vision delivers them out-of-band
    // (codex via `--image <file>`, gemini/agy via a `@<path>` ref on the prompt;
    // see materializeTurnImages). Drop them here so they don't leave a stray
    // "[image omitted]" line that contradicts the image the model actually got.
    if (block.type === 'image') return '';
    if (block.type === 'tool_result') return `[tool result] ${block.content || ''}`;
    if (block.type === 'tool_use') return `[tool use] ${block.name || ''} ${JSON.stringify(block.input || {})}`;
    return block.text || '';
  }).filter(Boolean).join('\n');
}

// Materialise inline image content blocks from turn messages to temp files the
// lent CLI can read, returning `@<abs-path>` refs + the temp dir to clean up.
// Single-call vision: the image rides the reply turn instead of a separate
// `:see` caption pre-pass. (Claude has its own materialiser inside
// buildClaudeCliStdin; this one serves the codex / gemini / agy turn handlers.)
// Forward-slash absolute paths — the CLIs' @-ref parsers want them.
async function materializeTurnImages(messages: any[]): Promise<{ refs: string[]; absPaths: string[]; tempDir: string | null }> {
  let tempDir: string | null = null;
  let idx = 0;
  const refs: string[] = [];
  const absPaths: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string' && b.source.data) {
        if (!tempDir) {
          const fsp = await import('fs/promises');
          tempDir = await fsp.mkdtemp(join(require('os').tmpdir(), 'empir3-cli-turn-img-'));
        }
        const ext = (String(b.source.media_type || 'image/png').split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
        const p = join(tempDir, `img_${idx++}.${ext}`);
        const fsp = await import('fs/promises');
        await fsp.writeFile(p, Buffer.from(b.source.data, 'base64'));
        const abs = p.replace(/\\/g, '/');
        absPaths.push(abs);
        refs.push('@' + abs);
      }
    }
  }
  return { refs, absPaths, tempDir };
}

function buildCodexBridgePrompt(system: string, messages: any[]): string {
  const parts = [
    system || 'You are an Empir3 team agent. Reply with the assigned agent voice and stay concise.',
    '',
    'You are running on the user-owned local Codex CLI through Empir3 Bridge.',
    'When Empir3 MCP tools are available, use them for real work instead of claiming work happened in text.',
    '',
    '<conversation>',
  ];
  for (const message of messages) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    parts.push(`<${role}>`, codexMessageText(message), `</${role}>`);
  }
  parts.push('</conversation>');
  return parts.join('\n');
}

function cliTomlStringValue(value: string): string {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function startCodexCliTurn(payload: any, emit: (type: string, payload: any) => void) {
  const id = String(payload?.id || `codex-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  if (!codexDeviceOptedIn()) {
    emit('codex:cli:error', {
      id,
      stage: 'declined',
      error: 'Device owner has not opted in. Enable "Lend my OpenAI Codex" in the bridge tray before routing agent turns through this PC.',
    });
    return { success: false, id, error: 'device opted out' };
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (messages.length === 0) {
    emit('codex:cli:error', { id, stage: 'invalid_payload', error: 'codex:cli:turn requires a non-empty `messages` array' });
    return { success: false, id, error: 'messages required' };
  }

  const command = await findPreferredExecutable('codex');
  if (!command) {
    emit('codex:cli:error', { id, stage: 'spawn', error: 'codex CLI not found on PATH' });
    return { success: false, id, error: 'codex CLI not found' };
  }
  if (activeCodexCliRuns.has(id)) {
    emit('codex:cli:error', { id, stage: 'duplicate', error: 'codex turn id already active' });
    return { success: false, id, error: 'duplicate turn id' };
  }

  const model = String(payload?.model || 'gpt-5.4');
  const prompt = buildCodexBridgePrompt(String(payload?.system || ''), messages);
  // Single-call vision: inline images become `--image <file>` flags (Codex's
  // native image input; verified the flag does not consume the trailing stdin
  // `-`). Temp dir cleaned in the close handler.
  const { absPaths: imageAbsPaths, tempDir: imageTempDir } = await materializeTurnImages(messages);
  const turnTools = Array.isArray(payload?.tools) ? payload.tools : [];
  const bridgeName = String(payload?.bridge_name || 'empir3').replace(/[^A-Za-z0-9_-]/g, '') || 'empir3';
  let mcpShim: CliMcpShim | null = null;
  if (turnTools.length > 0) {
    try {
      mcpShim = await startCliMcpShim('codex', id, bridgeName, turnTools, emit);
    } catch (e: any) {
      emit('codex:cli:error', { id, stage: 'mcp_shim', error: e?.message || String(e) });
      return { success: false, id, error: `mcp shim: ${e?.message || String(e)}` };
    }
  }

  const args = [
    'exec',
    '--json',
    '--ephemeral',
    ...(turnTools.length > 0 ? ['--ignore-user-config'] : []),
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '--cd',
    process.cwd(),
    '--skip-git-repo-check',
    '--model',
    model,
  ];
  if (mcpShim) {
    args.push(
      '-c',
      `mcp_servers.${bridgeName}.url="${cliTomlStringValue(mcpShim.url)}"`,
      '-c',
      `mcp_servers.${bridgeName}.tool_timeout_sec=${Math.ceil(MCP_TOOL_CALL_TIMEOUT_MS / 1000)}`,
      '-c',
      `mcp_servers.${bridgeName}.default_tools_approval_mode="approve"`,
    );
  }
  if (Array.isArray(payload?.extra_args)) {
    for (const arg of payload.extra_args) {
      if (typeof arg === 'string' && arg.trim()) args.push(arg);
    }
  }
  // `--image <file>` per inlined image, before the trailing `-` (stdin prompt).
  for (const abs of imageAbsPaths) args.push('--image', abs);
  args.push('-');

  const useShell = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd');
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: useShell,
    });
  } catch (e: any) {
    teardownCliMcpShim(id);
    if (imageTempDir) { try { require('fs').rmSync(imageTempDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    emit('codex:cli:error', { id, stage: 'spawn', error: e?.message || String(e) });
    return { success: false, id, error: e?.message || String(e) };
  }

  activeCodexCliRuns.set(id, child);
  child.stdin?.on('error', () => {});
  child.stdin?.end(prompt);
  const startedAt = Date.now();
  const timeoutSec = Number.isFinite(payload?.timeout_sec) && payload.timeout_sec > 0
    ? Math.min(Number(payload.timeout_sec), 60 * 60)
    : 20 * 60;
  const timeoutMs = timeoutSec * 1000;
  let seq = 0;
  let lineBuffer = '';
  let stderrTail = '';
  let timedOut = false;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref?.();
  }, timeoutMs);

  child.stdout?.on('data', (chunk: Buffer) => {
    lineBuffer += chunk.toString('utf-8');
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      emit('codex:cli:chunk', { id, seq: seq++, data: line });
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail += chunk.toString('utf-8');
    if (stderrTail.length > 8192) stderrTail = stderrTail.slice(-8192);
  });

  child.on('close', (code) => {
    clearTimeout(timeoutHandle);
    activeCodexCliRuns.delete(id);
    if (lineBuffer.trim()) emit('codex:cli:chunk', { id, seq: seq++, data: lineBuffer });
    teardownCliMcpShim(id);
    if (imageTempDir) { try { require('fs').rmSync(imageTempDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    const duration_ms = Date.now() - startedAt;
    if (timedOut) {
      emit('codex:cli:error', {
        id,
        stage: 'timeout',
        exit_code: code ?? -1,
        duration_ms,
        error: `codex CLI exceeded ${timeoutSec}s`,
        stderr_tail: stderrTail.slice(-512),
      });
      return;
    }
    emit('codex:cli:done', {
      id,
      exit_code: code ?? -1,
      duration_ms,
      stderr_tail: stderrTail.slice(-512),
    });
  });

  child.on('error', (e: Error) => {
    if (!activeCodexCliRuns.has(id)) return;
    emit('codex:cli:error', { id, stage: 'spawn', error: e.message });
  });

  return { success: true, id, model, timeout_sec: timeoutSec };
}

function abortCodexCliTurn(payload: any, emit: (type: string, payload: any) => void) {
  const id = String(payload?.id || '');
  const child = id ? activeCodexCliRuns.get(id) : null;
  if (!child) {
    emit('codex:cli:error', { id: id || 'unknown', stage: 'aborted', error: 'no active codex run for this turn id' });
    return { success: false, id, error: 'no active run' };
  }
  try {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (activeCodexCliRuns.has(id)) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 5000).unref?.();
  } catch (e: any) {
    emit('codex:cli:error', { id, stage: 'abort', error: e?.message || String(e) });
    return { success: false, id, error: e?.message || String(e) };
  }
  return { success: true, id };
}

async function handleCodexCliCommand(action: string, payload: any, emit: (type: string, payload: any) => void) {
  switch (action) {
    case 'probe': {
      const result = await probeCodexCli();
      emit('codex:cli:probe:result', { id: payload?.id || '', ...result });
      return result;
    }
    case 'opted_in':
      return { optedIn: codexDeviceOptedIn() };
    case 'set_opted_in':
      return setCodexDeviceOptIn(!!payload?.value);
    case 'turn':
      return startCodexCliTurn(payload, emit);
    case 'abort':
      return abortCodexCliTurn(payload, emit);
    case 'tool:result':
      resolveCliToolResult(payload);
      return { success: true };
    case 'see':
      return runCodexCliSee(payload, emit);
    default:
      return { success: false, error: `Unknown codex:cli action: ${action}` };
  }
}

// ── One-shot vision dispatch — `<prefix>:cli:see` ──────────────────────
//
// Server-side `see_image` + auto-captioner route an image through the
// user-lent local CLI when admin's vision route is set to mode=cli, so the
// vision call bills against the user's plan instead of our funded key.
// Wire shape is intentionally simple — not a turn (no tools, no
// conversation state); one image + one prompt → one text response.
//
//   server → bridge: {type:'<prefix>:cli:see', payload:{id, prompt, system?,
//                                                       image:{base64,mimeType},
//                                                       model, timeout_sec}}
//   bridge → server: {type:'<prefix>:cli:see:done',  payload:{id, text, exit_code, duration_ms,
//                                                              usage?:{input,output}}}
//                    {type:'<prefix>:cli:see:error', payload:{id, stage, error}}
//
// Per-CLI strategy:
//   Claude → `claude --print --input-format stream-json --output-format
//     stream-json --model <m>` with stdin one stream-json user message
//     carrying an `image` content block (Claude CLI 2.x native).
//   Codex  → `codex exec <prompt> --image <tempfile> --json --model <m>`.
//     Important: Codex's repeatable `--image <FILE>...` flag greedily
//     consumes later argv values, so the prompt must come before `--image`.
//   Gemini → write image to temp file, spawn `gemini -y --skip-trust -p
//     "@<tempfile> <prompt>" --model <m>`. The `@<path>` syntax is
//     Gemini's documented file-reference shape.

interface CliSeeRunSpec {
  cliName: string;
  wirePrefix: 'claude' | 'codex' | 'gemini' | 'agy';
  optedInCheck: () => boolean;
  optedOutMessage: string;
  fallbackBinPath?: () => string | null;
  /** Directory under which the per-call working dir is mkdtemp'd. Defaults to
   *  os.tmpdir(). Claude points this at ~/.empir3-bridge so its image + prompt
   *  files live in a stable, owner-controlled dir (not system TEMP, which AV /
   *  cleanup tools can purge mid-run). The runner mkdirs it before mkdtemp. */
  tempRoot?: () => string;
  /** Per-CLI invocation builder. Returns the spawn shape; the runner
   *  handles the rest (stdout capture, error wiring, cleanup). */
  buildInvocation: (ctx: {
    prompt: string;
    system: string;
    imageBase64: string;
    mimeType: string;
    model: string;
    tempDir: string;
  }) => Promise<{ args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; parseText: (stdout: string) => string }>;
}

async function runCliSee(
  payload: any,
  emit: (type: string, payload: any) => void,
  spec: CliSeeRunSpec,
): Promise<{ success: boolean; id: string; error?: string }> {
  const errType = `${spec.wirePrefix}:cli:see:error`;
  const doneType = `${spec.wirePrefix}:cli:see:done`;
  const id = String(payload?.id || `${spec.wirePrefix}-see-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const receivedAt = Date.now();

  if (!spec.optedInCheck()) {
    emit(errType, { id, stage: 'declined', error: spec.optedOutMessage });
    return { success: false, id, error: 'device opted out' };
  }

  const prompt = String(payload?.prompt || '').trim();
  const system = String(payload?.system || '').trim();
  const imageBase64 = String(payload?.image?.base64 || '');
  const mimeType = String(payload?.image?.mimeType || 'image/png');
  const model = String(payload?.model || '').trim();
  if (!imageBase64) {
    emit(errType, { id, stage: 'invalid_payload', error: 'image.base64 required' });
    return { success: false, id, error: 'image required' };
  }
  if (!prompt) {
    emit(errType, { id, stage: 'invalid_payload', error: 'prompt required' });
    return { success: false, id, error: 'prompt required' };
  }

  const resolveStartedAt = Date.now();
  let command = await findPreferredExecutable(spec.cliName);
  if (!command && spec.fallbackBinPath) command = spec.fallbackBinPath();
  const resolvedAt = Date.now();
  if (!command) {
    emit(errType, { id, stage: 'spawn', error: `${spec.cliName} CLI not found on PATH` });
    return { success: false, id, error: `${spec.cliName} CLI not found` };
  }

  const fsp = await import('fs/promises');
  const osm = await import('os');
  const tempRoot = spec.tempRoot ? spec.tempRoot() : osm.tmpdir();
  try { await fsp.mkdir(tempRoot, { recursive: true }); } catch {}
  const tempDir = await fsp.mkdtemp(join(tempRoot, `empir3-${spec.wirePrefix}-see-`));

  const buildStartedAt = Date.now();
  let invocation: { args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; parseText: (stdout: string) => string };
  try {
    invocation = await spec.buildInvocation({ prompt, system, imageBase64, mimeType, model, tempDir });
  } catch (e: any) {
    try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch {}
    emit(errType, { id, stage: 'build_invocation', error: e?.message || String(e) });
    return { success: false, id, error: e?.message || String(e) };
  }
  const builtAt = Date.now();

  // Default 120s — CLI cold-start on Windows + image upload + vision
  // model reasoning can run 15-30s under load. Caller-side timeouts
  // (90s for see_image, 60s for caption pre-pass) clamp lower as
  // needed.
  const timeoutSec = Number.isFinite(payload?.timeout_sec) && payload.timeout_sec > 0
    ? Math.min(Number(payload.timeout_sec), 60 * 60)
    : 120;
  const timeoutMs = timeoutSec * 1000;

  let child: ChildProcess;
  try {
    // stdin = 'ignore' (NUL) unless this invocation actually feeds stdin.
    // ROOT CAUSE of the daemon-only :see hang: claude `--print` in TEXT mode
    // reads stdin and waits for EOF. With a piped stdin, our `child.stdin.end()`
    // delivers that EOF instantly in a quiet process, but under the busy daemon
    // event loop the EOF was delayed indefinitely → claude blocked the full
    // timeout (verified 2026-06-06: piped-no-EOF HANGs >45s, 'ignore' completes
    // in ~11s). A null stdin gives immediate EOF, so the CLI never waits.
    const stdinMode: 'ignore' | 'pipe' = invocation.stdin ? 'pipe' : 'ignore';
    child = spawnCli(command, invocation.args, {
      env: { ...process.env, ...(invocation.env ?? {}) },
      cwd: invocation.cwd ?? process.cwd(),
      stdio: [stdinMode, 'pipe', 'pipe'],
    });
  } catch (e: any) {
    try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch {}
    emit(errType, { id, stage: 'spawn', error: e?.message || String(e) });
    return { success: false, id, error: e?.message || String(e) };
  }

  const startedAt = Date.now();
  let stdoutBuf = '';
  let stderrTail = '';
  let timedOut = false;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref?.();
  }, timeoutMs);

  child.stdout?.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString('utf-8'); });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail += chunk.toString('utf-8');
    if (stderrTail.length > 8192) stderrTail = stderrTail.slice(-8192);
  });

  child.on('close', async (code) => {
    clearTimeout(timeoutHandle);
    try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch {}
    const duration_ms = Date.now() - startedAt;
    if (timedOut) {
      emit(errType, { id, stage: 'timeout', exit_code: code ?? -1, duration_ms, error: `${spec.cliName} CLI exceeded ${timeoutSec}s`, stderr_tail: stderrTail.slice(-512) });
      return;
    }
    if ((code ?? -1) !== 0) {
      emit(errType, { id, stage: 'exit', exit_code: code ?? -1, duration_ms, error: `${spec.cliName} CLI exited with code ${code}`, stderr_tail: stderrTail.slice(-512) });
      return;
    }
    let text = '';
    try { text = invocation.parseText(stdoutBuf); } catch (e: any) {
      emit(errType, { id, stage: 'parse', exit_code: code ?? -1, duration_ms, error: e?.message || String(e), stderr_tail: stderrTail.slice(-512) });
      return;
    }
    emit(doneType, {
      id,
      text,
      exit_code: code ?? 0,
      duration_ms,
      total_ms: Date.now() - receivedAt,
      stage_ms: {
        precheck: resolveStartedAt - receivedAt,
        resolve: resolvedAt - resolveStartedAt,
        build: builtAt - buildStartedAt,
        spawn_to_close: duration_ms,
      },
      stderr_tail: stderrTail.slice(-512),
    });
  });

  child.on('error', (e: Error) => {
    emit(errType, { id, stage: 'spawn', error: e.message });
  });

  try {
    if (invocation.stdin) {
      child.stdin?.write(invocation.stdin);
    }
    child.stdin?.end();
  } catch (e: any) {
    emit(errType, { id, stage: 'stdin', error: e?.message || String(e) });
    try { child.kill('SIGTERM'); } catch {}
    return { success: false, id, error: e?.message || String(e) };
  }

  return { success: true, id };
}

async function runClaudeCliSee(payload: any, emit: (type: string, payload: any) => void) {
  return runCliSee(payload, emit, {
    cliName: 'claude',
    wirePrefix: 'claude',
    optedInCheck: () => claudeDeviceOptedIn(),
    optedOutMessage: 'Device owner has not opted in. Enable "Lend Empir3 my Claude Max" in the bridge tray before routing vision through this PC.',
    // Keep the image + prompt files under ~/.empir3-bridge, not system TEMP.
    tempRoot: () => join(homedir(), '.empir3-bridge', 'cli-see'),
    buildInvocation: async ({ prompt, system, imageBase64, mimeType, tempDir }) => {
      // Claude CLI 2.x silently drops `{type:'image', source:base64}` blocks
      // sent via stream-json stdin (verified 2.1.31). The `@<path>` file-ref
      // syntax works — write the image to a file and reference it.
      //
      // ROOT CAUSE of the daemon :see hallucination (claude describing a
      // "Claude Code terminal" instead of the real picture), fixed 0.3.23:
      // the old shape passed the WHOLE prompt — `@<img> <system> <prompt>` —
      // as a single positional argv to `claude -p "<...>"`. Real Empir3 see
      // prompts run ~10 KB; the bridge spawns the claude `.cmd` shim through
      // `cmd.exe /d /s /c`, whose command line caps at ~8191 chars. A 10 KB
      // positional either errors ("The command line is too long.") or, just
      // under the cap, cmd.exe word-splits/truncates it — dropping the leading
      // `@<img>` ref. Claude then runs with NO image and hallucinates. Verified
      // 2026-06-26: a 10 358-char inline positional → exit 1 "command line too
      // long"; the SAME content written to a prompt file and passed as a short
      // `@<promptfile>` arg → correct description of the real image.
      //
      // Fix (mirrors the proven cli_run / agy `@<file>` path): write the full
      // prompt — with the `@<image>` ref on its FIRST line — to a prompt file,
      // and pass a short `@<promptfile>` positional. Claude resolves the nested
      // `@<image>` ref inside the loaded prompt file (verified). The `@<img>`
      // MUST stay on the first line of the file or the @-parser skips it.
      const fsp = await import('fs/promises');
      // Defensive: strip a `data:<mime>;base64,` prefix if a payload ever sends
      // a data URI — feeding the prefix to Buffer.from yields a corrupt file
      // and claude returns 400 "Could not process image" (verified 2026-06-26).
      const b64 = imageBase64.replace(/^data:[^;,]*;base64,/i, '').replace(/^data:[^,]*,/i, '');
      const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
      const imagePath = join(tempDir, `image.${ext}`);
      await fsp.writeFile(imagePath, Buffer.from(b64, 'base64'));
      // Absolute forward-slash @ref — a bare relative `@image.png` is unreliable
      // on Claude CLI 2.x (verified). Keep it on the FIRST line of the file.
      const imageRef = imagePath.replace(/\\/g, '/');
      const instruction = system ? `${system} ` : '';
      const fullPrompt = `@${imageRef} ${instruction}${prompt}`;
      const promptPath = join(tempDir, 'prompt.txt');
      await fsp.writeFile(promptPath, fullPrompt, 'utf-8');
      const promptRef = promptPath.replace(/\\/g, '/');
      // --strict-mcp-config: skip loading the owner's global MCP servers
      //   (empir3-bridge itself is an `Empir3Setup.exe --mcp` spawn → tens of
      //   seconds cold). A one-shot caption needs zero tools.
      // --dangerously-skip-permissions: lets the `@<promptfile>` + nested
      //   `@<image>` read through without a headless permission gate (matches
      //   the proven agy / cli_run file-ref path).
      const args = ['--dangerously-skip-permissions', '-p', '--strict-mcp-config', `@${promptRef}`];
      // Claude OAuth path — scrub env keys (mirrors startClaudeCliTurn).
      const env = claudeCliEnv();
      return {
        args,
        cwd: tempDir,
        env,
        parseText: (stdout: string): string => stdout.trim(),
      };
    },
  });
}

async function runCodexCliSee(payload: any, emit: (type: string, payload: any) => void) {
  return runCliSee(payload, emit, {
    cliName: 'codex',
    wirePrefix: 'codex',
    optedInCheck: () => codexDeviceOptedIn(),
    optedOutMessage: 'Device owner has not opted in. Enable "Lend my OpenAI Codex" in the bridge tray before routing vision through this PC.',
    buildInvocation: async ({ prompt, system, imageBase64, mimeType, model, tempDir }) => {
      const fsp = await import('fs/promises');
      const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
      const imagePath = join(tempDir, `image.${ext}`);
      await fsp.writeFile(imagePath, Buffer.from(imageBase64, 'base64'));
      const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
      const args = [
        'exec',
        '--json',
        '--ephemeral',
        '--ignore-rules',
        '--sandbox', 'read-only',
        '--cd', tempDir,
        '--skip-git-repo-check',
      ];
      if (model) args.push('--model', model);
      // Prompt goes via STDIN, not a positional argv. On Windows the codex shim
      // is codex.cmd, spawned through `cmd.exe /d /s /c codex.cmd …`; cmd.exe
      // mangles a multi-line positional prompt (newlines + the JSON-shape quotes
      // get word-split), so codex never associates the --image and replies
      // {"error":"missing_target","message":"Provide a screenshot…"} — the image
      // delivered fine but the locator instruction was shredded. `codex exec`
      // reads the prompt from stdin ("Reading prompt from stdin…") when no
      // positional is given; that path is immune to cmd.exe arg-splitting.
      // Verified 2026-06-28: positional → missing_target; stdin → exact 0px JSON.
      args.push('--image', imagePath);
      return {
        args,
        cwd: tempDir,
        stdin: fullPrompt,
        parseText: (stdout: string): string => {
          // Codex --json emits JSONL events. `item.completed` with
          // item.type='agent_message' carries the final text.
          let text = '';
          for (const line of stdout.split('\n')) {
            const t = line.trim();
            if (!t || !t.startsWith('{')) continue;
            try {
              const ev = JSON.parse(t);
              if (ev?.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
                text = ev.item.text;
              }
            } catch { /* skip */ }
          }
          return text.trim();
        },
      };
    },
  });
}

async function runAgyCliSee(payload: any, emit: (type: string, payload: any) => void) {
  // agy's child_process :see path (runCliSee) returned EMPTY stdout: agy 1.0.x
  // doesn't flush stdout in a non-TTY `-p` spawn — the same root cause that
  // already forced agy :turn and :gen (imagegen) onto node-pty. Route :see
  // through the proven node-pty turn runner (AGY_PTY_CLI_SPEC) too: synthesize a
  // one-shot user turn carrying the image + prompt, accumulate the streamed
  // chunks, and re-emit the joined text as agy:cli:see:done {text}.
  const id = String(payload?.id || `agy-see-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const prompt = String(payload?.prompt || '').trim();
  const system = String(payload?.system || '').trim();
  // Strip a `data:<mime>;base64,` prefix defensively (see runClaudeCliSee).
  const imageBase64 = String(payload?.image?.base64 || '').replace(/^data:[^;,]*;base64,/i, '').replace(/^data:[^,]*,/i, '');
  const mimeType = String(payload?.image?.mimeType || 'image/png');
  if (!imageBase64) {
    emit('agy:cli:see:error', { id, stage: 'invalid_payload', error: 'image.base64 required' });
    return { success: false, id, error: 'image required' };
  }
  if (!prompt) {
    emit('agy:cli:see:error', { id, stage: 'invalid_payload', error: 'prompt required' });
    return { success: false, id, error: 'prompt required' };
  }

  // Shape the see request as a one-shot agy turn. The image rides as a base64
  // image content block — startPtyCliTurn → materializeTurnImages writes it to a
  // temp file and leads the -p value with an `@<path>` ref (the exact mechanism
  // agy :turn uses for inline images; codexMessageText drops the image block so
  // no base64 leaks into the prompt text). No tools → no MCP shim; a caption
  // needs none.
  const turnPayload = {
    id,
    system,
    model: typeof payload?.model === 'string' ? payload.model : '',
    timeout_sec: Number.isFinite(payload?.timeout_sec) && payload.timeout_sec > 0 ? payload.timeout_sec : 120,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  };

  // Bridge the turn wire events to the :see wire shape. startPtyCliTurn streams
  // agy:cli:chunk {data} and ends with agy:cli:done / agy:cli:error; accumulate
  // the chunk text and surface it as agy:cli:see:done {text}.
  let acc = '';
  const seeEmit = (type: string, p: any) => {
    if (type === 'agy:cli:chunk') {
      if (typeof p?.data === 'string') acc += p.data;
      return;
    }
    if (type === 'agy:cli:done') {
      emit('agy:cli:see:done', {
        id,
        text: acc.trim(),
        exit_code: p?.exit_code ?? 0,
        duration_ms: p?.duration_ms,
        stderr_tail: p?.stderr_tail,
      });
      return;
    }
    if (type === 'agy:cli:error') {
      emit('agy:cli:see:error', { ...p, id });
      return;
    }
    emit(type, p); // pass through anything unexpected
  };

  return startPtyCliTurn(turnPayload, seeEmit, AGY_PTY_CLI_SPEC);
}

async function runGeminiCliSee(payload: any, emit: (type: string, payload: any) => void) {
  return runCliSee(payload, emit, {
    cliName: 'gemini',
    wirePrefix: 'gemini',
    optedInCheck: () => geminiDeviceOptedIn(),
    optedOutMessage: 'Device owner has not opted in. Enable "Lend Empir3 my Gemini CLI" in the bridge tray before routing vision through this PC.',
    buildInvocation: async ({ prompt, system, imageBase64, mimeType, model, tempDir }) => {
      const fsp = await import('fs/promises');
      const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
      const imageName = `image.${ext}`;
      const imagePath = join(tempDir, imageName);
      await fsp.writeFile(imagePath, Buffer.from(imageBase64, 'base64'));
      // Gemini's @<path> file-reference syntax. Use the ABSOLUTE path —
      // a bare relative filename is unreliable on the current CLI
      // generation (see runClaudeCliSee note). Forward-slash, first line.
      // Gemini doesn't have a separate --system-prompt flag, so
      // system intent is folded after the @ ref + user prompt.
      const imageRef = imagePath.replace(/\\/g, '/');
      const fullPrompt = system
        ? `@${imageRef} ${prompt}\n\n${system}`
        : `@${imageRef} ${prompt}`;
      const args = ['-y', '--skip-trust', '-p', fullPrompt];
      if (model) args.push('--model', model);
      return {
        args,
        cwd: tempDir,
        parseText: (stdout: string): string => stdout.trim(),
      };
    },
  });
}

// ── Generic plain-CLI turn runner (Gemini + Grok) ───────────────────
//
// Both CLIs emit plain text (not stream-json), take a `-p <prompt>` flag
// for non-interactive mode, and load MCP servers from a per-CLI config
// file (Gemini: per-cwd `.gemini/settings.json`; Grok: user-global
// `~/.grok/config.toml`). When the turn payload carries a non-empty
// `tools` array we spin up the same HTTP MCP shim that backs Claude's
// M2.2b path, point the CLI's config at it, and round-trip each
// `tools/call` back to the server via `<prefix>:cli:tool:call` →
// `<prefix>:cli:tool:result`. Text-only turns skip the shim entirely.
//
// Spec captures what's different between the two CLIs:
//   - baseArgs: invocation flags (e.g. ['-y', '-p'] for gemini)
//   - modelFlag: how to add the model id
//   - mcpSetup: per-CLI config-file writer + spawn-flag builder; returns
//     a cleanup hook the close handler runs unconditionally
//   - prompt is appended as the final positional arg
interface PlainCliMcpHandle {
  /** Extra CLI args this CLI needs when MCP is wired up — Gemini's
   *  `--allowed-mcp-server-names empir3` etc. Appended to `args` after
   *  baseArgs + model + extra_args. */
  extraArgs: string[];
  /** Optional cwd for the spawn (Gemini reads per-cwd settings.json). */
  cwd?: string;
  /** Optional extra env vars for the spawn. */
  env?: NodeJS.ProcessEnv;
  /** Idempotent teardown — removes temp dirs, restores user config, etc.
   *  Called on every turn-close path (success, error, abort). */
  cleanup: () => Promise<void>;
}

interface BaseCliTurnSpec<TProcess> {
  wirePrefix: 'gemini' | 'grok' | 'agy';
  cliName: string;                       // 'gemini' | 'grok' | 'agy'
  baseArgs: string[];                    // ['-y', '-p'] | ['-p']
  modelFlag?: { flag: string; required: boolean };
  optedInCheck: () => boolean;
  optedOutMessage: string;
  activeRunMap: Map<string, TProcess>;
  /** Optional fallback path lookup when `findPreferredExecutable` misses
   *  (e.g. ~/.grok/bin/grok). */
  fallbackBinPath?: () => string | null;
  /** Optional extra env vars for the spawn (token passthrough, etc). */
  extraEnv?: () => NodeJS.ProcessEnv;
  /** When the turn carries tools, this writes the per-CLI MCP config
   *  file pointing at the shim URL and returns the spawn shape the CLI
   *  needs to discover it. Omitted → caller falls back to text-only. */
  mcpSetup?: (turnId: string, bridgeName: string, shimUrl: string) => Promise<PlainCliMcpHandle>;
}

type PlainCliPromptTransport =
  | { mode: 'argv'; placement?: 'afterBaseArgs' | 'end' }
  | { mode: 'stdin'; args: string[]; placement?: 'afterBaseArgs' | 'end' }
  | { mode: 'file'; flag: string; filename?: string; placement?: 'afterBaseArgs' | 'end' };

interface PlainCliTurnSpec extends BaseCliTurnSpec<ChildProcess> {
  /** How the prompt reaches the CLI. Prefer stdin or a native prompt-file
   *  flag for specialist build prompts, which can exceed Windows argv
   *  limits once full Koba context and tool descriptions are included. */
  promptTransport?: PlainCliPromptTransport;
}

interface PtyCliTurnSpec extends BaseCliTurnSpec<IPty> {
  pty?: {
    cols?: number;
    rows?: number;
    name?: string;
  };
  /** Some PTY-backed CLIs hit Windows command-line limits with full
   *  specialist prompts. Write the prompt to a temp file and pass a
   *  file-reference arg such as `@C:\...\prompt.txt` instead. */
  promptFile?: {
    prefix?: string;
    filename?: string;
  };
  /** For CLIs whose prompt flag consumes the next argv token, the prompt
   *  must be inserted before later flags such as MCP allowlists. */
  promptPlacement?: 'afterBaseArgs' | 'end';
}

function buildPlainCliPrompt(system: string, messages: any[], tools: Array<{ name?: string }> = []): string {
  // Single-string prompt: leading system block, then a flat <conversation>
  // dialogue mirroring buildCodexBridgePrompt. The CLIs see this as one
  // user message, but the role wrapping keeps Gemini/Grok in role-aware
  // assistant voice instead of summarizing the whole conversation.
  const toolNames = Array.from(new Set(
    tools
      .map(t => typeof t?.name === 'string' ? t.name.trim() : '')
      .filter(Boolean),
  ));
  const lines = [
    system || 'You are an Empir3 specialist agent. Reply with the assigned agent voice and stay concise.',
    '',
    'You are running on the user-owned local CLI through Empir3 Bridge.',
  ];
  if (toolNames.length > 0) {
    lines.push(
      'Empir3 MCP tools are available for real project work.',
      `Available Empir3 MCP tools: ${toolNames.join(', ')}.`,
      'For project files, call the Empir3 MCP Write/Edit/Bash tools with workspace-relative paths like "index.html" or "images/hero.png".',
      'Do not use the CLI client local filesystem/project tools for deliverables; those write only to the Bridge PC and are not visible in the Empir3 project workspace.',
      'Do not claim a page, file, or build is live unless an Empir3 MCP tool result confirms the server workspace file exists.',
    );
  } else {
    lines.push('This route returns text only. Do not claim to use Empir3 tools unless tool results are present in the conversation.');
  }
  lines.push('', '<conversation>');
  for (const message of messages) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    // Reuse codexMessageText — same content-block flattening contract.
    lines.push(`<${role}>`, codexMessageText(message), `</${role}>`);
  }
  lines.push('</conversation>');
  return lines.join('\n');
}

async function startPlainCliTurn(payload: any, emit: (type: string, payload: any) => void, spec: PlainCliTurnSpec) {
  const errType = `${spec.wirePrefix}:cli:error`;
  const id = String(payload?.id || `${spec.wirePrefix}-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  if (!spec.optedInCheck()) {
    emit(errType, { id, stage: 'declined', error: spec.optedOutMessage });
    return { success: false, id, error: 'device opted out' };
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (messages.length === 0) {
    emit(errType, { id, stage: 'invalid_payload', error: `${spec.wirePrefix}:cli:turn requires a non-empty messages array` });
    return { success: false, id, error: 'messages required' };
  }

  let command = await findPreferredExecutable(spec.cliName);
  if (!command && spec.fallbackBinPath) command = spec.fallbackBinPath();
  if (!command) {
    emit(errType, { id, stage: 'spawn', error: `${spec.cliName} CLI not found on PATH` });
    return { success: false, id, error: `${spec.cliName} CLI not found` };
  }
  if (spec.activeRunMap.has(id)) {
    emit(errType, { id, stage: 'duplicate', error: `${spec.wirePrefix} turn id already active` });
    return { success: false, id, error: 'duplicate turn id' };
  }

  // MCP shim — only when this turn carries tools AND the spec knows how
  // to wire its CLI's MCP discovery. Falls back to text-only otherwise.
  const turnTools = Array.isArray(payload?.tools) ? payload.tools : [];
  const bridgeName = String(payload?.bridge_name || 'empir3').replace(/[^A-Za-z0-9_-]/g, '') || 'empir3';
  let mcpHandle: PlainCliMcpHandle | null = null;
  if (turnTools.length > 0 && spec.mcpSetup) {
    let shim: CliMcpShim;
    try {
      shim = await startCliMcpShim(spec.wirePrefix, id, bridgeName, turnTools, emit);
    } catch (e: any) {
      emit(errType, { id, stage: 'mcp_shim', error: e?.message || String(e) });
      return { success: false, id, error: `mcp shim: ${e?.message || String(e)}` };
    }
    try {
      mcpHandle = await spec.mcpSetup(id, bridgeName, shim.url);
    } catch (e: any) {
      teardownCliMcpShim(id);
      emit(errType, { id, stage: 'mcp_config', error: e?.message || String(e) });
      return { success: false, id, error: `mcp config: ${e?.message || String(e)}` };
    }
  }

  const model = typeof payload?.model === 'string' ? payload.model : '';
  const prompt = buildPlainCliPrompt(String(payload?.system || ''), messages, turnTools);
  // Single-call vision: inline images become `@<path>` refs that LEAD the CLI's
  // -p value (verified — gemini reads the image from the -p value while the
  // real conversation streams on stdin). Temp dir cleaned in cleanupMcp.
  const { refs: imageRefs, tempDir: imageTempDir } = await materializeTurnImages(messages);
  const imageRefPrefix = imageRefs.length ? `${imageRefs.join(' ')} ` : '';
  const args = [...spec.baseArgs];
  const promptTransport = spec.promptTransport || { mode: 'argv' as const, placement: 'end' as const };
  let promptAttached = false;
  let stdinPrompt: string | null = null;
  let cleanupPromptFile: (() => Promise<void>) | null = null;
  const attachPrompt = async () => {
    if (promptAttached) return;
    promptAttached = true;
    if (promptTransport.mode === 'stdin') {
      // Lead the -p hint value with image refs so the CLI sees the image; the
      // real conversation still streams on stdin.
      const stdinArgs = [...promptTransport.args];
      if (imageRefPrefix && stdinArgs.length > 0) {
        stdinArgs[stdinArgs.length - 1] = `${imageRefPrefix}${stdinArgs[stdinArgs.length - 1]}`;
      }
      args.push(...stdinArgs);
      stdinPrompt = prompt;
      return;
    }
    if (promptTransport.mode === 'file') {
      const fsp = await import('fs/promises');
      const osm = await import('os');
      const dir = await fsp.mkdtemp(join(osm.tmpdir(), `empir3-${spec.wirePrefix}-prompt-`));
      const filename = (promptTransport.filename || 'prompt.txt').replace(/[^A-Za-z0-9._-]/g, '_') || 'prompt.txt';
      const promptPath = join(dir, filename);
      await fsp.writeFile(promptPath, prompt, 'utf-8');
      args.push(promptTransport.flag, promptPath);
      cleanupPromptFile = async () => {
        try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
      };
      return;
    }
    args.push(`${imageRefPrefix}${prompt}`);
  };
  try {
    if (promptTransport.placement === 'afterBaseArgs') await attachPrompt();
  } catch (e: any) {
    if (mcpHandle) {
      try { await mcpHandle.cleanup(); } catch {}
      mcpHandle = null;
    }
    teardownCliMcpShim(id);
    emit(errType, { id, stage: 'prompt_file', error: e?.message || String(e) });
    return { success: false, id, error: `prompt file: ${e?.message || String(e)}` };
  }
  if (spec.modelFlag && model) args.push(spec.modelFlag.flag, model);
  if (Array.isArray(payload?.extra_args)) {
    for (const arg of payload.extra_args) {
      if (typeof arg === 'string' && arg.trim()) args.push(arg);
    }
  }
  if (mcpHandle) args.push(...mcpHandle.extraArgs);
  try {
    await attachPrompt();
  } catch (e: any) {
    if (mcpHandle) {
      try { await mcpHandle.cleanup(); } catch {}
      mcpHandle = null;
    }
    teardownCliMcpShim(id);
    emit(errType, { id, stage: 'prompt_file', error: e?.message || String(e) });
    return { success: false, id, error: `prompt file: ${e?.message || String(e)}` };
  }

  const cleanupMcp = async () => {
    if (cleanupPromptFile) {
      try { await cleanupPromptFile(); } catch (e) { console.warn(`[plain-cli ${spec.wirePrefix}] prompt cleanup failed:`, e); }
      cleanupPromptFile = null;
    }
    if (imageTempDir) {
      try { const fsp = await import('fs/promises'); await fsp.rm(imageTempDir, { recursive: true, force: true }); } catch (e) { console.warn(`[plain-cli ${spec.wirePrefix}] image cleanup failed:`, e); }
    }
    if (mcpHandle) {
      try { await mcpHandle.cleanup(); } catch (e) { console.warn(`[plain-cli ${spec.wirePrefix}] mcp cleanup failed:`, e); }
      mcpHandle = null;
    }
    teardownCliMcpShim(id);
  };

  let child: ChildProcess;
  try {
    child = spawnCli(command, args, {
      env: { ...process.env, ...(spec.extraEnv?.() ?? {}), ...(mcpHandle?.env ?? {}) },
      cwd: mcpHandle?.cwd ?? process.cwd(),
      stdio: [stdinPrompt === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    await cleanupMcp();
    emit(errType, { id, stage: 'spawn', error: e?.message || String(e) });
    return { success: false, id, error: e?.message || String(e) };
  }

  spec.activeRunMap.set(id, child);
  if (stdinPrompt !== null) {
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdinPrompt);
  }
  const startedAt = Date.now();
  const timeoutSec = Number.isFinite(payload?.timeout_sec) && payload.timeout_sec > 0
    ? Math.min(Number(payload.timeout_sec), 60 * 60)
    : 20 * 60;
  const timeoutMs = timeoutSec * 1000;
  let seq = 0;
  let stderrTail = '';
  let timedOut = false;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref?.();
  }, timeoutMs);

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf-8');
    if (!text) return;
    emit(`${spec.wirePrefix}:cli:chunk`, { id, seq: seq++, data: text });
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail += chunk.toString('utf-8');
    if (stderrTail.length > 8192) stderrTail = stderrTail.slice(-8192);
  });

  child.on('close', async (code) => {
    clearTimeout(timeoutHandle);
    spec.activeRunMap.delete(id);
    await cleanupMcp();
    const duration_ms = Date.now() - startedAt;
    if (timedOut) {
      emit(errType, {
        id,
        stage: 'timeout',
        exit_code: code ?? -1,
        duration_ms,
        error: `${spec.cliName} CLI exceeded ${timeoutSec}s`,
        stderr_tail: stderrTail.slice(-512),
      });
      return;
    }
    emit(`${spec.wirePrefix}:cli:done`, {
      id,
      exit_code: code ?? -1,
      duration_ms,
      stderr_tail: stderrTail.slice(-512),
    });
  });

  child.on('error', (e: Error) => {
    if (!spec.activeRunMap.has(id)) return;
    emit(errType, { id, stage: 'spawn', error: e.message });
  });

  return { success: true, id, model, timeout_sec: timeoutSec };
}

function abortPlainCliTurn(payload: any, emit: (type: string, payload: any) => void, spec: PlainCliTurnSpec) {
  const errType = `${spec.wirePrefix}:cli:error`;
  const id = String(payload?.id || '');
  const child = id ? spec.activeRunMap.get(id) : null;
  if (!child) {
    emit(errType, { id: id || 'unknown', stage: 'aborted', error: `no active ${spec.wirePrefix} run for this turn id` });
    return { success: false, id, error: 'no active run' };
  }
  try {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (spec.activeRunMap.has(id)) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 5000).unref?.();
  } catch (e: any) {
    emit(errType, { id, stage: 'abort', error: e?.message || String(e) });
    return { success: false, id, error: e?.message || String(e) };
  }
  return { success: true, id };
}

// ── Gemini CLI turn ──────────────────────────────────────────────
// `gemini --skip-trust --approval-mode yolo -p <prompt>` runs
// non-interactively, trusts the temp workspace for the turn, and skips tool
// approval prompts. `-y` is deliberately not used because Gemini 0.44 rejects
// combining it with `--approval-mode`.
//
// MCP wiring: Gemini loads mcpServers from per-cwd `.gemini/settings.json`,
// so the per-turn config writer creates a temp working dir, writes the
// settings file into `<temp>/.gemini/`, and spawns Gemini with cwd=temp.
// The `--allowed-mcp-server-names empir3` flag scopes the tool surface;
// `--approval-mode yolo` skips the per-tool confirmation gate.

function stripAnsiForBridge(text: string): string {
  return text
    // OSC sequences, e.g. title updates: ESC ] ... BEL or ESC ] ... ESC \
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // CSI sequences, e.g. cursor movement / erase / colour.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // Single-character ESC sequences and charset selectors.
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x00/g, '');
}

function buildPtySpawnShape(command: string, args: string[]): { file: string; args: string[] } {
  const cliPath = normalizeCliShim(command);
  const isWinShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath);
  if (isWinShim) {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', cliPath, ...args] };
  }
  return { file: cliPath, args };
}

function killPtyProcess(proc: IPty, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
  try {
    if (process.platform === 'win32') proc.kill();
    else proc.kill(signal);
  } catch {}
}

async function appendPtyPromptArg(args: string[], prompt: string, spec: PtyCliTurnSpec, preferredDir?: string, imageRefPrefix = ''): Promise<() => Promise<void>> {
  if (!spec.promptFile) {
    args.push(`${imageRefPrefix}${prompt}`);
    return async () => {};
  }

  const fsp = await import('fs/promises');
  const osm = await import('os');
  const ownedDir = preferredDir ? null : await fsp.mkdtemp(join(osm.tmpdir(), `empir3-${spec.wirePrefix}-prompt-`));
  const dir = preferredDir || ownedDir!;
  const filename = (spec.promptFile.filename || 'prompt.txt').replace(/[^A-Za-z0-9._-]/g, '_') || 'prompt.txt';
  const promptPath = join(dir, filename);
  await fsp.writeFile(promptPath, prompt, 'utf-8');
  // Single-call vision: image `@<path>` refs lead the -p value so the CLI sees
  // them, e.g. `-p "@<img> @<promptfile>"`. Same @-ref mechanism agy's :see
  // path uses (and identical to the verified gemini route).
  args.push(`${imageRefPrefix}${spec.promptFile.prefix ?? ''}${promptPath}`);

  return async () => {
    try {
      if (ownedDir) await fsp.rm(ownedDir, { recursive: true, force: true });
      else await fsp.rm(promptPath, { force: true });
    } catch {}
  };
}

async function startPtyCliTurn(payload: any, emit: (type: string, payload: any) => void, spec: PtyCliTurnSpec) {
  const errType = `${spec.wirePrefix}:cli:error`;
  const id = String(payload?.id || `${spec.wirePrefix}-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  if (!spec.optedInCheck()) {
    emit(errType, { id, stage: 'declined', error: spec.optedOutMessage });
    return { success: false, id, error: 'device opted out' };
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (messages.length === 0) {
    emit(errType, { id, stage: 'invalid_payload', error: `${spec.wirePrefix}:cli:turn requires a non-empty messages array` });
    return { success: false, id, error: 'messages required' };
  }

  let command = await findPreferredExecutable(spec.cliName);
  if (!command && spec.fallbackBinPath) command = spec.fallbackBinPath();
  if (!command) {
    emit(errType, { id, stage: 'spawn', error: `${spec.cliName} CLI not found on PATH` });
    return { success: false, id, error: `${spec.cliName} CLI not found` };
  }
  if (spec.activeRunMap.has(id)) {
    emit(errType, { id, stage: 'duplicate', error: `${spec.wirePrefix} turn id already active` });
    return { success: false, id, error: 'duplicate turn id' };
  }

  const turnTools = Array.isArray(payload?.tools) ? payload.tools : [];
  const bridgeName = String(payload?.bridge_name || 'empir3').replace(/[^A-Za-z0-9_-]/g, '') || 'empir3';
  let mcpHandle: PlainCliMcpHandle | null = null;
  if (turnTools.length > 0 && spec.mcpSetup) {
    let shim: CliMcpShim;
    try {
      shim = await startCliMcpShim(spec.wirePrefix, id, bridgeName, turnTools, emit);
    } catch (e: any) {
      emit(errType, { id, stage: 'mcp_shim', error: e?.message || String(e) });
      return { success: false, id, error: `mcp shim: ${e?.message || String(e)}` };
    }
    try {
      mcpHandle = await spec.mcpSetup(id, bridgeName, shim.url);
    } catch (e: any) {
      teardownCliMcpShim(id);
      emit(errType, { id, stage: 'mcp_config', error: e?.message || String(e) });
      return { success: false, id, error: `mcp config: ${e?.message || String(e)}` };
    }
  }

  const model = typeof payload?.model === 'string' ? payload.model : '';
  const prompt = buildPlainCliPrompt(String(payload?.system || ''), messages, turnTools);
  // Single-call vision: inline images become `@<path>` refs leading the -p
  // value (see appendPtyPromptArg). Temp dir cleaned in cleanupTurnResources.
  const { refs: imageRefs, tempDir: imageTempDir } = await materializeTurnImages(messages);
  const imageRefPrefix = imageRefs.length ? `${imageRefs.join(' ')} ` : '';
  const args = [...spec.baseArgs];
  let cleanupPromptArg: (() => Promise<void>) | null = null;
  const appendPromptArg = async () => {
    if (cleanupPromptArg) return;
    cleanupPromptArg = await appendPtyPromptArg(args, prompt, spec, mcpHandle?.cwd, imageRefPrefix);
  };
  try {
    if (spec.promptPlacement === 'afterBaseArgs') await appendPromptArg();
  } catch (e: any) {
    if (mcpHandle) {
      try { await mcpHandle.cleanup(); } catch {}
      mcpHandle = null;
    }
    teardownCliMcpShim(id);
    emit(errType, { id, stage: 'prompt_file', error: e?.message || String(e) });
    return { success: false, id, error: `prompt file: ${e?.message || String(e)}` };
  }
  if (spec.modelFlag && model) args.push(spec.modelFlag.flag, model);
  if (Array.isArray(payload?.extra_args)) {
    for (const arg of payload.extra_args) {
      if (typeof arg === 'string' && arg.trim()) args.push(arg);
    }
  }
  if (mcpHandle) args.push(...mcpHandle.extraArgs);
  try {
    await appendPromptArg();
  } catch (e: any) {
    if (mcpHandle) {
      try { await mcpHandle.cleanup(); } catch {}
      mcpHandle = null;
    }
    teardownCliMcpShim(id);
    emit(errType, { id, stage: 'prompt_file', error: e?.message || String(e) });
    return { success: false, id, error: `prompt file: ${e?.message || String(e)}` };
  }

  const cleanupTurnResources = async () => {
    if (cleanupPromptArg) {
      try { await cleanupPromptArg(); } catch (e) { console.warn(`[pty-cli ${spec.wirePrefix}] prompt cleanup failed:`, e); }
      cleanupPromptArg = null;
    }
    if (imageTempDir) {
      try { const fsp = await import('fs/promises'); await fsp.rm(imageTempDir, { recursive: true, force: true }); } catch (e) { console.warn(`[pty-cli ${spec.wirePrefix}] image cleanup failed:`, e); }
    }
    if (mcpHandle) {
      try { await mcpHandle.cleanup(); } catch (e) { console.warn(`[pty-cli ${spec.wirePrefix}] mcp cleanup failed:`, e); }
      mcpHandle = null;
    }
    teardownCliMcpShim(id);
  };

  let ptyProcess: IPty;
  let dataSub: IDisposable | null = null;
  let exitSub: IDisposable | null = null;
  try {
    const nodePty = await import('node-pty');
    const spawnShape = buildPtySpawnShape(command, args);
    ptyProcess = nodePty.spawn(spawnShape.file, spawnShape.args, {
      name: spec.pty?.name || 'xterm-256color',
      cols: spec.pty?.cols || 120,
      rows: spec.pty?.rows || 30,
      cwd: mcpHandle?.cwd ?? process.cwd(),
      env: { ...process.env, ...(spec.extraEnv?.() ?? {}), ...(mcpHandle?.env ?? {}) },
      ...(process.platform === 'win32' ? { useConpty: true } : {}),
    });
  } catch (e: any) {
    await cleanupTurnResources();
    emit(errType, { id, stage: 'spawn', error: e?.message || String(e) });
    return { success: false, id, error: e?.message || String(e) };
  }

  spec.activeRunMap.set(id, ptyProcess);
  const startedAt = Date.now();
  const timeoutSec = Number.isFinite(payload?.timeout_sec) && payload.timeout_sec > 0
    ? Math.min(Number(payload.timeout_sec), 60 * 60)
    : 20 * 60;
  const timeoutMs = timeoutSec * 1000;
  let seq = 0;
  let outputTail = '';
  let timedOut = false;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    killPtyProcess(ptyProcess, 'SIGTERM');
    setTimeout(() => {
      if (spec.activeRunMap.has(id)) killPtyProcess(ptyProcess, 'SIGKILL');
    }, 5000).unref?.();
  }, timeoutMs);

  dataSub = ptyProcess.onData((raw) => {
    const text = stripAnsiForBridge(String(raw || '')).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!text) return;
    outputTail += text;
    if (outputTail.length > 8192) outputTail = outputTail.slice(-8192);
    emit(`${spec.wirePrefix}:cli:chunk`, { id, seq: seq++, data: text });
  });

  exitSub = ptyProcess.onExit(async (ev) => {
    clearTimeout(timeoutHandle);
    dataSub?.dispose();
    exitSub?.dispose();
    spec.activeRunMap.delete(id);
    await cleanupTurnResources();
    const duration_ms = Date.now() - startedAt;
    if (timedOut) {
      emit(errType, {
        id,
        stage: 'timeout',
        exit_code: ev.exitCode ?? -1,
        duration_ms,
        error: `${spec.cliName} CLI exceeded ${timeoutSec}s`,
        stderr_tail: outputTail.slice(-512),
      });
      return;
    }
    emit(`${spec.wirePrefix}:cli:done`, {
      id,
      exit_code: ev.exitCode ?? -1,
      duration_ms,
      stderr_tail: outputTail.slice(-512),
    });
  });

  return { success: true, id, model, timeout_sec: timeoutSec };
}

function abortPtyCliTurn(payload: any, emit: (type: string, payload: any) => void, spec: PtyCliTurnSpec) {
  const errType = `${spec.wirePrefix}:cli:error`;
  const id = String(payload?.id || '');
  const proc = id ? spec.activeRunMap.get(id) : null;
  if (!proc) {
    emit(errType, { id: id || 'unknown', stage: 'aborted', error: `no active ${spec.wirePrefix} run for this turn id` });
    return { success: false, id, error: 'no active run' };
  }
  killPtyProcess(proc, 'SIGTERM');
  setTimeout(() => {
    if (spec.activeRunMap.has(id)) killPtyProcess(proc, 'SIGKILL');
  }, 5000).unref?.();
  return { success: true, id };
}

async function geminiMcpSetup(turnId: string, bridgeName: string, shimUrl: string): Promise<PlainCliMcpHandle> {
  const fsp = await import('fs/promises');
  const osm = await import('os');
  const tempDir = await fsp.mkdtemp(join(osm.tmpdir(), `empir3-gemini-${turnId}-`));
  const geminiDir = join(tempDir, '.gemini');
  await fsp.mkdir(geminiDir, { recursive: true });
  // Carry over the oauth-personal auth selection from the user's global
  // settings so the temp cwd doesn't force a re-login. mcpServers points
  // at the shim. Both `url` and `httpUrl` set defensively across Gemini
  // CLI versions — older builds keyed on one, newer on the other.
  //
  // Gemini only merges workspace `.gemini/settings.json` when the workspace
  // is already trusted. `--skip-trust` skips the prompt, but the settings
  // loader still consults the trusted-folders file before it sees that flag.
  // Give each turn its own trust file so the temp MCP settings load without
  // mutating the user's global `~/.gemini/trustedFolders.json`.
  const trustedFoldersPath = join(tempDir, 'trustedFolders.json');
  const trustedKey = tempDir.replace(/\\/g, '/').toLowerCase();
  await fsp.writeFile(trustedFoldersPath, JSON.stringify({ [trustedKey]: 'TRUST_FOLDER' }, null, 2), 'utf-8');
  const settings = {
    security: { auth: { selectedType: 'oauth-personal' } },
    mcpServers: {
      [bridgeName]: {
        url: shimUrl,
        httpUrl: shimUrl,
        timeout: MCP_TOOL_CALL_TIMEOUT_MS,
      },
    },
  };
  await fsp.writeFile(join(geminiDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
  return {
    extraArgs: ['--allowed-mcp-server-names', bridgeName],
    cwd: tempDir,
    env: { GEMINI_CLI_TRUSTED_FOLDERS_PATH: trustedFoldersPath },
    cleanup: async () => {
      try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch {}
    },
  };
}

const GEMINI_PLAIN_CLI_SPEC: PlainCliTurnSpec = {
  wirePrefix: 'gemini',
  cliName: 'gemini',
  baseArgs: ['--skip-trust', '--approval-mode', 'yolo'],
  modelFlag: { flag: '--model', required: false },
  optedInCheck: () => geminiDeviceOptedIn(),
  optedOutMessage: 'Device owner has not opted in. Enable "Lend Empir3 my Gemini CLI" in the bridge tray before routing agent turns through this PC.',
  activeRunMap: activeGeminiCliRuns,
  mcpSetup: geminiMcpSetup,
  // Gemini treats `-p` as the final prompt/query boundary; later flags can be
  // parsed as prompt text. Keep all model/MCP flags before the short stdin hint.
  promptTransport: { mode: 'stdin', args: ['-p', 'Read the full task from stdin.'], placement: 'end' },
};

async function handleGeminiCliCommand(action: string, payload: any, emit: (type: string, payload: any) => void) {
  switch (action) {
    case 'probe': {
      const result = await probeGeminiCli();
      emit('gemini:cli:probe:result', { id: payload?.id || '', ...result });
      return result;
    }
    case 'opted_in':
      return { optedIn: geminiDeviceOptedIn() };
    case 'set_opted_in':
      return setGeminiDeviceOptIn(!!payload?.value);
    case 'turn':
      return startPlainCliTurn(payload, emit, GEMINI_PLAIN_CLI_SPEC);
    case 'abort':
      return abortPlainCliTurn(payload, emit, GEMINI_PLAIN_CLI_SPEC);
    case 'tool:result':
      // Mirror Claude's tool:result hook — resolves the pending HTTP MCP
      // tools/call for {id, callId}. Fire-and-forget; no response.
      resolveCliToolResult(payload);
      return { success: true };
    case 'see':
      return runGeminiCliSee(payload, emit);
    default:
      return { success: false, error: `Unknown gemini:cli action: ${action}` };
  }
}

// ── Grok CLI turn ────────────────────────────────────────────────
// `grok -p <prompt>` is xAI's documented non-interactive shape. The
// installer puts the binary at ~/.grok/bin/grok — `findPreferredExecutable`
// hits PATH first, falling back to that location.
//
// MCP wiring: Grok only reads `~/.grok/config.toml` (per-cwd configs are
// NOT honored, verified via `grok inspect` under a USERPROFILE override).
// We append a per-turn `[mcp_servers.empir3-<turnId>]` section in place
// and remove it on cleanup. The turn-unique name lets concurrent turns
// share the file without stepping on each other; `--always-approve`
// skips the per-tool confirmation gate that would otherwise hang
// headless.

const GROK_CONFIG_PATH = () => join(homedir(), '.grok', 'config.toml');

async function appendGrokMcpServer(turnId: string, shimUrl: string): Promise<string> {
  const fsp = await import('fs/promises');
  const path = GROK_CONFIG_PATH();
  const serverName = `empir3-${turnId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)}`;
  let current = '';
  try { current = await fsp.readFile(path, 'utf-8'); } catch { /* missing → start empty */ }
  const section = `\n[mcp_servers.${serverName}]\nurl = "${shimUrl.replace(/"/g, '\\"')}"\ntype = "http"\nenabled = true\n`;
  await fsp.writeFile(path, current.replace(/\s+$/, '') + '\n' + section, 'utf-8');
  return serverName;
}

async function removeGrokMcpServer(serverName: string): Promise<void> {
  const fsp = await import('fs/promises');
  const path = GROK_CONFIG_PATH();
  let current: string;
  try { current = await fsp.readFile(path, 'utf-8'); } catch { return; }
  // Strip the named section: header line + body up to (but not including)
  // the next `[…]` header or EOF. Regex is anchored at `[mcp_servers.<name>]`
  // with literal brackets escaped; .name is what the bridge picked so no
  // user input enters the pattern.
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\n*\\[mcp_servers\\.${escaped}\\][^\\[]*(?=\\n\\[|$)`, 'g');
  const next = current.replace(re, '\n');
  await fsp.writeFile(path, next, 'utf-8');
}

async function grokMcpSetup(turnId: string, _bridgeName: string, shimUrl: string): Promise<PlainCliMcpHandle> {
  const fsp = await import('fs/promises');
  const osm = await import('os');
  const tempDir = await fsp.mkdtemp(join(osm.tmpdir(), `empir3-grok-${turnId}-`));
  const serverName = await appendGrokMcpServer(turnId, shimUrl);
  return {
    extraArgs: ['--always-approve'],
    cwd: tempDir,
    cleanup: async () => {
      try { await removeGrokMcpServer(serverName); } finally {
        try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

const GROK_PLAIN_CLI_SPEC: PlainCliTurnSpec = {
  wirePrefix: 'grok',
  cliName: 'grok',
  baseArgs: [],
  // Grok Build CLI currently exposes only its subscription-backed
  // `grok-build` model. Hosted xAI IDs such as `grok-3` are invalid here,
  // so omit --model and let the CLI use its authenticated default.
  optedInCheck: () => grokDeviceOptedIn(),
  optedOutMessage: 'Device owner has not opted in. Enable "Lend Empir3 my Grok Build CLI" in the bridge tray before routing agent turns through this PC.',
  activeRunMap: activeGrokCliRuns,
  fallbackBinPath: () => {
    const candidate = join(homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
    return existsSync(candidate) ? candidate : null;
  },
  mcpSetup: grokMcpSetup,
  promptTransport: { mode: 'file', flag: '--prompt-file', filename: 'empir3-prompt.txt', placement: 'afterBaseArgs' },
};

async function handleGrokCliCommand(action: string, payload: any, emit: (type: string, payload: any) => void) {
  switch (action) {
    case 'probe': {
      const result = await probeGrokCli();
      emit('grok:cli:probe:result', { id: payload?.id || '', ...result });
      return result;
    }
    case 'opted_in':
      return { optedIn: grokDeviceOptedIn() };
    case 'set_opted_in':
      return setGrokDeviceOptIn(!!payload?.value);
    case 'turn':
      return startPlainCliTurn(payload, emit, GROK_PLAIN_CLI_SPEC);
    case 'abort':
      return abortPlainCliTurn(payload, emit, GROK_PLAIN_CLI_SPEC);
    case 'tool:result':
      resolveCliToolResult(payload);
      return { success: true };
    default:
      return { success: false, error: `Unknown grok:cli action: ${action}` };
  }
}

// ── Antigravity CLI turn ─────────────────────────────────────────
// `agy -p <prompt>` mirrors Gemini CLI's non-interactive shape (agy is
// the documented successor for AI Pro/Ultra subscribers). Headless mode
// is gated by `--dangerously-skip-permissions` per upstream issue #78 —
// without it, the CLI prompts for per-tool confirmation and hangs in a
// background spawn.
//
// MCP wiring: per-workspace `<workdir>/.antigravity/settings.json` (same
// per-cwd shape as Gemini's `.gemini/settings.json`). Globally,
// `~/.gemini/config/mcp_config.json` works too, but the per-cwd path is
// turn-isolated and round-trips cleanly without mutating user-global
// state. HTTP transport via `url` / `serverUrl` keys (both set
// defensively across agy versions).

async function agyMcpSetup(turnId: string, bridgeName: string, shimUrl: string): Promise<PlainCliMcpHandle> {
  const fsp = await import('fs/promises');
  const osm = await import('os');
  const tempDir = await fsp.mkdtemp(join(osm.tmpdir(), `empir3-agy-${turnId}-`));
  const agyDir = join(tempDir, '.antigravity');
  await fsp.mkdir(agyDir, { recursive: true });
  const settings = {
    mcpServers: {
      [bridgeName]: {
        url: shimUrl,
        serverUrl: shimUrl,
        httpUrl: shimUrl,
        timeout: MCP_TOOL_CALL_TIMEOUT_MS,
      },
    },
  };
  await fsp.writeFile(join(agyDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
  return {
    // agy 1.0.3 does not support Gemini's --allowed-mcp-server-names flag.
    // It discovers MCP servers from the per-cwd .antigravity/settings.json.
    extraArgs: [],
    cwd: tempDir,
    cleanup: async () => {
      try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch {}
    },
  };
}

const AGY_PTY_CLI_SPEC: PtyCliTurnSpec = {
  wirePrefix: 'agy',
  cliName: 'agy',
  // agy's --help shows no top-level --model flag (Antigravity ships its
  // own model selection internally). We omit modelFlag here — passing
  // --model would error out the spawn. If a future agy version surfaces
  // model selection, switch to { flag: '--model', required: false }.
  baseArgs: ['--dangerously-skip-permissions', '-p'],
  optedInCheck: () => agyDeviceOptedIn(),
  optedOutMessage: 'Device owner has not opted in. Enable "Lend Empir3 my Antigravity CLI" in the bridge tray before routing agent turns through this PC.',
  activeRunMap: activeAgyCliRuns,
  fallbackBinPath: () => {
    const candidate = process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
      : join(homedir(), '.local', 'bin', 'agy');
    return existsSync(candidate) ? candidate : null;
  },
  mcpSetup: agyMcpSetup,
  pty: { cols: 120, rows: 30, name: 'xterm-256color' },
  promptFile: { prefix: '@', filename: 'empir3-prompt.txt' },
  promptPlacement: 'afterBaseArgs',
};

async function handleAgyCliCommand(action: string, payload: any, emit: (type: string, payload: any) => void) {
  switch (action) {
    case 'probe': {
      const result = await probeAgyCli();
      emit('agy:cli:probe:result', { id: payload?.id || '', ...result });
      return result;
    }
    case 'opted_in':
      return { optedIn: agyDeviceOptedIn() };
    case 'set_opted_in':
      return setAgyDeviceOptIn(!!payload?.value);
    case 'turn':
      return startPtyCliTurn(payload, emit, AGY_PTY_CLI_SPEC);
    case 'abort':
      return abortPtyCliTurn(payload, emit, AGY_PTY_CLI_SPEC);
    case 'tool:result':
      resolveCliToolResult(payload);
      return { success: true };
    case 'see':
      return runAgyCliSee(payload, emit);
    case 'gen':
      return runAgyCliImageGen(payload, emit);
    default:
      return { success: false, error: `Unknown agy:cli action: ${action}` };
  }
}

// One-shot imagegen over the empir3 channel — agy's Nano Banana writes a file,
// we read it back. File-based (not stdout) because agy 1.0.3 print mode doesn't
// flush stdout in a non-TTY. Gated by the same execute permission + device
// opt-in as agy turns.
async function runAgyCliImageGen(payload: any, emit: (type: string, payload: any) => void) {
  const id = payload?.id || '';
  if (!agyDeviceOptedIn()) {
    emit('agy:cli:gen:error', {
      id,
      stage: 'opted_out',
      error: 'Device owner has not opted in. Enable "Lend Empir3 my Antigravity CLI" in the bridge tray before routing imagegen through this PC.',
    });
    return { success: false };
  }
  const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
  const timeoutSec = Number(payload?.timeout_sec);
  const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : undefined;

  emit('agy:cli:gen:progress', { id, status: 'spawning' });

  const out = await agyGenerateImage({ prompt, timeoutMs });
  if (out.success && out.result) {
    emit('agy:cli:gen:done', {
      id,
      exit_code: 0,
      mime_type: out.result.mimeType,
      bytes_base64: out.result.bytes.toString('base64'),
      duration_ms: out.result.durationMs,
    });
    return { success: true };
  }
  emit('agy:cli:gen:error', { id, stage: out.stage || 'error', error: out.error || 'agy imagegen failed' });
  return { success: false };
}

function gb(bytes: number) {
  return Math.round((bytes / (1024 ** 3)) * 10) / 10;
}

async function getSystemOverview() {
  const total = totalmem();
  const free = freemem();
  const cpu = cpus();
  return {
    success: true,
    data: {
      os: `${osType()} ${release()} (${typeof osVersion === 'function' ? osVersion() : ''})`,
      hostname: hostname(),
      cpu: { percent: 0, cores: cpu.length, threads: cpu.length, model: cpu[0]?.model || 'unknown' },
      memory: { totalGB: gb(total), usedGB: gb(total - free), percent: Math.round(((total - free) / total) * 100) },
      disk: { totalGB: 0, usedGB: 0, percent: 0 },
      battery: null,
      uptimeHours: Math.round((uptime() / 3600) * 10) / 10,
    },
  };
}

async function getSystemInfo(query: string) {
  if (query === 'overview') return getSystemOverview();
  if (query === 'network') return { success: true, interfaces: networkInterfaces() };
  if (query === 'processes') {
    const rows = await runPowerShellJson(`${desktopPreamble()}
Get-Process | Select-Object -First 50 Id,ProcessName,@{n='memoryMB';e={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Json -Depth 4
`);
    return { success: true, processes: Array.isArray(rows) ? rows : [rows], total: Array.isArray(rows) ? rows.length : 1 };
  }
  if (query === 'disk') {
    const rows = await runPowerShellJson(`${desktopPreamble()}
Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | Select-Object Name,Root,@{n='Used';e={$_.Used}},@{n='Free';e={$_.Free}},@{n='Total';e={$_.Used + $_.Free}} | ConvertTo-Json -Depth 4
`);
    return { success: true, partitions: Array.isArray(rows) ? rows : [rows] };
  }
  if (query === 'battery') {
    const rows = await runPowerShellJson(`${desktopPreamble()}
Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue |
  Select-Object Name,Status,BatteryStatus,EstimatedChargeRemaining,EstimatedRunTime |
  ConvertTo-Json -Depth 4
`);
    const batteries = rows ? (Array.isArray(rows) ? rows : [rows]) : [];
    return { success: true, batteries, present: batteries.length > 0 };
  }
  if (query === 'installed') {
    const rows = await runPowerShellJson(`${desktopPreamble()}
$paths = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$apps = foreach ($p in $paths) {
  Get-ItemProperty $p -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName } |
    Select-Object DisplayName,DisplayVersion,Publisher,InstallDate
}
$apps | Sort-Object DisplayName -Unique | Select-Object -First 500 | ConvertTo-Json -Depth 4
`, 20000);
    const programs = rows ? (Array.isArray(rows) ? rows : [rows]) : [];
    return { success: true, programs, count: programs.length };
  }
  return { success: false, error: `Unknown sysinfo query: ${query}` };
}

async function listDesktopWindows(filter = '') {
  const rows = await runPowerShellJson(`${desktopPreamble()}
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
}
"@
$active = [W]::GetForegroundWindow().ToInt64()
$list = New-Object System.Collections.ArrayList
$cb = {
  param($h, $l)
  if (-not [W]::IsWindowVisible($h)) { return $true }
  $len = [W]::GetWindowTextLength($h)
  if ($len -le 0) { return $true }
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [W]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
  $title = $sb.ToString()
  $rect = New-Object W+RECT
  [W]::GetWindowRect($h, [ref]$rect) | Out-Null
  $list.Add([pscustomobject]@{
    handle = $h.ToInt64(); title = $title; left = $rect.Left; top = $rect.Top;
    width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top;
    isMinimized = [W]::IsIconic($h); isMaximized = [W]::IsZoomed($h); isActive = ($h.ToInt64() -eq $active)
  }) | Out-Null
  return $true
}
[W]::EnumWindows([W+EnumWindowsProc]$cb, [IntPtr]::Zero) | Out-Null
$list | ConvertTo-Json -Depth 5
`);
  let windows = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  if (filter) windows = windows.filter((w: any) => String(w.title || '').toLowerCase().includes(filter.toLowerCase()));
  return { success: true, windows, count: windows.length };
}

async function findProcessesByName(name: string) {
  const needle = String(name || '').trim().toLowerCase().replace(/\.exe$/, '');
  if (!needle) return { success: false, error: 'No app name provided' };
  const rows = await runPowerShellJson(`
$needle = ${psString(needle)}
Get-Process | Where-Object { $_.ProcessName -like "*$needle*" } |
  Select-Object Id,ProcessName |
  ConvertTo-Json -Depth 4
`);
  const processes = rows ? (Array.isArray(rows) ? rows : [rows]) : [];
  return {
    success: true,
    processes: processes.map((p: any) => ({ pid: p.Id, name: `${p.ProcessName}.exe` })),
  };
}

async function stopProcessVerified(target: { pid: number; name: string }, timeoutMs = 6000) {
  const pid = Number(target.pid);
  const name = String(target.name || '');
  const script = `
$ErrorActionPreference = 'Stop'
$targetPid = ${pid}
$targetName = ${psString(name)}
$stopError = ''
$before = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
if (-not $before) {
  [pscustomobject]@{ pid = $targetPid; name = $targetName; stopped = $true; alreadyExited = $true; stillRunning = $false } | ConvertTo-Json -Compress
  exit 0
}
try {
  Stop-Process -Id $targetPid -Force -ErrorAction Stop
} catch {
  $stopError = $_.Exception.Message
}
$deadline = [DateTime]::UtcNow.AddMilliseconds(${timeoutMs})
do {
  Start-Sleep -Milliseconds 200
  $remaining = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
} while ($remaining -and [DateTime]::UtcNow -lt $deadline)
$remaining = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
$stopped = -not [bool]$remaining
[pscustomobject]@{
  pid = $targetPid
  name = $targetName
  stopped = $stopped
  alreadyExited = $false
  stillRunning = -not $stopped
  stopError = $stopError
} | ConvertTo-Json -Compress
if (-not $stopped) { exit 2 }
`;
  const result = await runPowerShellText(script, timeoutMs + 4000);
  const raw = result.stdout.trim();
  let details: any = {};
  if (raw) {
    const candidate = raw.split(/\r?\n/).reverse().find(line => line.trim().startsWith('{')) || raw;
    try { details = JSON.parse(candidate); } catch {}
  }
  const stopped = !!details.stopped || !!details.alreadyExited;
  return {
    success: stopped && !result.timedOut,
    pid,
    name,
    ...details,
    ...(stopped ? {} : {
      error: details.stopError || result.stderr || result.stdout || (result.timedOut ? `Timed out waiting for process ${pid} to exit` : `Process ${pid} still running after Stop-Process`),
      code: result.code,
      timedOut: result.timedOut,
    }),
  };
}

async function launchAppCandidate(candidate: AppLaunchCandidate) {
  const args = candidate.args || [];
  const argList = args.length
    ? ` -ArgumentList @(${args.map(a => psString(a)).join(',')})`
    : '';
  if (process.platform === 'win32') {
    const ps = await runPowerShellText(`Start-Process -FilePath ${psString(candidate.command)}${argList}`, 8000);
    if (ps.success) return { success: true, method: 'powershell' };
  }
  return await new Promise<any>((resolveLaunch) => {
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', candidate.command, ...args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      child.on('error', e => resolveLaunch({ success: false, error: e.message }));
      setTimeout(() => resolveLaunch({ success: true, method: 'cmd-start', pid: child.pid }), 250);
    } catch (e: any) {
      resolveLaunch({ success: false, error: e?.message || String(e) });
    }
  });
}

async function waitForAppProcess(name: string, candidate: AppLaunchCandidate, timeoutMs = 4000) {
  const needles = dedupeStrings([
    candidate.processNeedle,
    name,
    basename(candidate.command || '').replace(/\.exe$/i, ''),
  ].filter(Boolean).map(String));
  const start = Date.now();
  let last: any = null;
  while (Date.now() - start < timeoutMs) {
    for (const needle of needles) {
      const found = await findProcessesByName(needle);
      last = found;
      if (found.success && found.processes.length > 0) {
        return {
          verified: true,
          processNeedle: needle,
          count: found.processes.length,
          processes: found.processes.slice(0, 10),
        };
      }
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return { verified: false, processNeedles: needles, last };
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const clean = String(item || '').trim().toLowerCase().replace(/\.exe$/i, '');
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

async function handleAppCommand(action: string, params: any = {}) {
  if (action === 'launch') {
    if (!hasBridgePermission('execute')) return permissionDenied('execute');
    const name = String(params?.name || '').trim();
    if (!name) return { success: false, error: 'No app name provided' };
    const limited = checkRateLimit(launchTimestamps, 5, 'launches');
    if (limited) return { success: false, error: limited };
    const candidates = appLaunchCandidates(name);
    let last: any = null;
    for (const candidate of candidates) {
      const launched = await launchAppCandidate(candidate);
      last = { candidate, launched };
      if (!launched.success) continue;
      const verified = await waitForAppProcess(name, candidate, candidate.mustVerify ? 6000 : 2500);
      if (verified.verified || !candidate.mustVerify) {
        return {
          success: true,
          name,
          command: candidate.command,
          args: candidate.args || [],
          method: launched.method,
          pid: launched.pid,
          verifiedRunning: verified.verified,
          ...(verified.verified ? { running: verified } : { warning: 'launch command succeeded, but no matching process was verified yet' }),
        };
      }
      last = { candidate, launched, verified };
    }
    return {
      success: false,
      error: `Failed to verify launch for ${name}`,
      attempts: candidates.map(c => ({ command: c.command, args: c.args || [], processNeedle: c.processNeedle, mustVerify: !!c.mustVerify })),
      last,
    };
  }

  if (action === 'is_running') {
    const found = await findProcessesByName(params?.name || '');
    if (!found.success) return found;
    return { success: true, running: found.processes.length > 0, count: found.processes.length, processes: found.processes.slice(0, 20) };
  }

  if (action === 'list_running') {
    const rows = await runPowerShellJson(`
Get-Process |
  Select-Object Id,ProcessName,@{n='WSMB';e={[math]::Round($_.WorkingSet64/1MB,1)}} |
  ConvertTo-Json -Depth 4
`, 15000);
    const processes = rows ? (Array.isArray(rows) ? rows : [rows]) : [];
    const seen = new Set<string>();
    const apps: any[] = [];
    for (const p of processes) {
      const processName = `${p.ProcessName || ''}.exe`;
      const lower = processName.toLowerCase();
      if (!processName.trim() || PROTECTED_PROCESSES.has(lower) || seen.has(lower)) continue;
      seen.add(lower);
      apps.push({ pid: p.Id, name: processName, memoryMB: p.WSMB || 0 });
    }
    apps.sort((a, b) => b.memoryMB - a.memoryMB);
    return { success: true, apps: apps.slice(0, 30), count: apps.length };
  }

  if (action === 'kill') {
    if (!hasBridgePermission('execute')) return permissionDenied('execute');
    const pid = params?.pid;
    const name = String(params?.name || '').trim().toLowerCase();
    if (!pid && !name) return { success: false, error: 'Provide either pid or name' };
    let targets: Array<{ pid: number; name: string }> = [];
    if (pid) {
      const rows = await runPowerShellJson(`Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName | ConvertTo-Json -Depth 3`);
      if (!rows) return { success: false, error: `No process found for pid: ${pid}` };
      targets = [{ pid: Number(rows.Id), name: `${rows.ProcessName}.exe` }];
    } else {
      const found = await findProcessesByName(name);
      if (!found.success) return found;
      targets = found.processes;
    }
    const blocked = targets.find(p => PROTECTED_PROCESSES.has(String(p.name || '').toLowerCase()));
    if (blocked) return { success: false, error: `Cannot kill protected process: ${blocked.name}` };
    const killed = [];
    const failed = [];
    for (const target of targets) {
      const result = await stopProcessVerified(target);
      if (result.success) killed.push({ pid: target.pid, name: target.name, alreadyExited: !!result.alreadyExited });
      else failed.push(result);
    }
    if (failed.length) {
      return {
        success: false,
        killed,
        failed,
        count: killed.length,
        error: `Failed to verify termination for ${failed.length} process(es)`,
      };
    }
    return killed.length ? { success: true, killed, count: killed.length, verifiedExited: true } : { success: false, error: 'No matching processes were killed' };
  }

  return { success: false, error: `Unknown app action: ${action}` };
}

async function handleClipboardCommand(action: string, params: any = {}) {
  if (action === 'read') {
    if (!hasBridgePermission('read')) return permissionDenied('read');
    const result = await runPowerShellText('Get-Clipboard -Raw', 8000);
    if (!result.success) return { success: false, error: result.stderr || 'Failed to read clipboard' };
    let text = result.stdout.replace(/\r\n$/, '');
    const original = text.length;
    if (text.length > MAX_TEXT_SIZE) text = `${text.slice(0, MAX_TEXT_SIZE)}\n... (truncated, ${original} chars total)`;
    return { success: true, text, length: original };
  }
  if (action === 'write' || action === 'clear') {
    if (!hasBridgePermission('write')) return permissionDenied('write');
    const text = action === 'clear' ? '' : params?.text;
    if (action === 'write' && (typeof text !== 'string' || text.length === 0)) return { success: false, error: 'No text provided' };
    const result = action === 'clear'
      ? await runPowerShellText("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()", 8000)
      : await runPowerShellText('Set-Clipboard -Value ([Console]::In.ReadToEnd())', 8000, String(text || ''));
    if (!result.success) return { success: false, error: result.stderr || 'Failed to write clipboard' };
    return action === 'clear' ? { success: true, cleared: true } : { success: true, written: String(text).length };
  }
  return { success: false, error: `Unknown clipboard action: ${action}` };
}

function shellSafetyCheck(command: string): string | null {
  for (const [pattern, reason] of BLOCKED_SHELL_PATTERNS) {
    if (pattern.test(command)) return `Command blocked: ${reason}`;
  }
  return checkRateLimit(executeTimestamps, 10, 'commands');
}

async function handleExecuteCommand(_action: string, params: any = {}) {
  if (!hasBridgePermission('execute')) {
    return { success: false, stdout: '', stderr: 'Permission denied: Execute is disabled in companion settings.', exitCode: -1, executionTime: 0, blocked: true };
  }
  const command = String(params?.command || '').trim();
  if (!command) return { success: false, stdout: '', stderr: 'No command provided', exitCode: -1, executionTime: 0 };
  const blocked = shellSafetyCheck(command);
  if (blocked) return { success: false, stdout: '', stderr: blocked, exitCode: -1, executionTime: 0, blocked: true };
  const shell = String(params?.shell || 'powershell').toLowerCase();
  const timeoutSec = Math.max(1, Math.min(120, Number(params?.timeout) || 30));
  const started = Date.now();
  const result = shell === 'cmd'
    ? await runProcess('cmd.exe', ['/c', command], { timeoutMs: timeoutSec * 1000 })
    : await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeoutMs: timeoutSec * 1000 });
  const elapsed = Date.now() - started;
  return {
    success: result.code === 0 && !result.timedOut,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.timedOut ? `Command timed out after ${timeoutSec}s` : result.stderr),
    exitCode: result.timedOut ? -2 : (result.code ?? 0),
    executionTime: elapsed,
    timedOut: result.timedOut || undefined,
  };
}

async function handleNotifyCommand(_action: string, params: any = {}) {
  const title = String(params?.title || 'Empir3').slice(0, 64).replace(/\r?\n/g, ' ');
  const message = String(params?.message || '').slice(0, 256).replace(/\r?\n/g, ' ');
  if (!message) return { success: false, error: 'No message provided' };
  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$textNodes = $template.GetElementsByTagName('text')
$textNodes.Item(0).AppendChild($template.CreateTextNode(${psString(title)})) | Out-Null
$textNodes.Item(1).AppendChild($template.CreateTextNode(${psString(message)})) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Empir3')
$notifier.Show($toast)
`;
  const result = await runPowerShellText(script, 8000);
  return result.success ? { success: true } : { success: false, error: result.stderr || result.stdout || 'Failed to show toast' };
}

function windowControlPreamble(): string {
  return `${desktopPreamble()}
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Empir3WindowCtl {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
}
"@ -ErrorAction SilentlyContinue
`;
}

async function getActiveDesktopWindow() {
  const active = await runPowerShellJson(`${windowControlPreamble()}
$h = [Empir3WindowCtl]::GetForegroundWindow()
$len = [Empir3WindowCtl]::GetWindowTextLength($h)
if ($len -le 0) { $null | ConvertTo-Json; return }
$sb = New-Object System.Text.StringBuilder ($len + 1)
[Empir3WindowCtl]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
$r = New-Object Empir3WindowCtl+RECT
[Empir3WindowCtl]::GetWindowRect($h, [ref]$r) | Out-Null
[pscustomobject]@{
  handle = $h.ToInt64(); title = $sb.ToString(); left = $r.Left; top = $r.Top;
  width = $r.Right - $r.Left; height = $r.Bottom - $r.Top;
  isMinimized = [Empir3WindowCtl]::IsIconic($h); isMaximized = [Empir3WindowCtl]::IsZoomed($h); isActive = $true
} | ConvertTo-Json -Depth 4
`);
  return { success: true, active };
}

async function handleWindowCommand(action: string, params: any = {}) {
  if (action === 'list') return listDesktopWindows(params?.title || params?.filter || '');
  if (action === 'active') return getActiveDesktopWindow();

  if (['focus', 'minimize', 'maximize', 'restore', 'resize', 'close'].includes(action) && !hasBridgePermission('execute')) {
    return permissionDenied('execute');
  }
  const title = String(params?.title || '').trim();
  if (!title) return { success: false, error: 'No title provided' };
  const listed = await listDesktopWindows(title);
  if (!listed.windows?.length) return { success: false, error: `No window found matching: ${title}` };
  const win = listed.windows[0];
  const handle = Number(win.handle);
  const showMap: Record<string, number> = { minimize: 6, maximize: 3, restore: 9 };
  if (action === 'focus') {
    const result = await runPowerShellText(`${windowControlPreamble()}
$h = [IntPtr]::new(${handle})
if ([Empir3WindowCtl]::IsIconic($h)) { [Empir3WindowCtl]::ShowWindow($h, 9) | Out-Null }
[Empir3WindowCtl]::SetForegroundWindow($h) | Out-Null
`, 8000);
    return result.success ? { success: true, focused: win } : { success: false, error: result.stderr || 'Failed to focus window' };
  }
  if (action === 'minimize' || action === 'maximize' || action === 'restore') {
    const result = await runPowerShellText(`${windowControlPreamble()}[Empir3WindowCtl]::ShowWindow([IntPtr]::new(${handle}), ${showMap[action]}) | Out-Null`, 8000);
    return result.success ? { success: true, [action]: true, window: win } : { success: false, error: result.stderr || `Failed to ${action} window` };
  }
  if (action === 'resize') {
    const x = Number(params?.x ?? win.left);
    const y = Number(params?.y ?? win.top);
    const width = Number(params?.width ?? win.width);
    const height = Number(params?.height ?? win.height);
    const result = await runPowerShellText(`${windowControlPreamble()}[Empir3WindowCtl]::MoveWindow([IntPtr]::new(${handle}), ${Math.round(x)}, ${Math.round(y)}, ${Math.round(width)}, ${Math.round(height)}, $true) | Out-Null`, 8000);
    return result.success ? { success: true, resized: { ...win, left: x, top: y, width, height } } : { success: false, error: result.stderr || 'Failed to resize window' };
  }
  if (action === 'close') {
    const result = await runPowerShellText(`${windowControlPreamble()}[Empir3WindowCtl]::PostMessage([IntPtr]::new(${handle}), 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`, 8000);
    return result.success ? { success: true, close: true, window: win } : { success: false, error: result.stderr || 'Failed to close window' };
  }
  return { success: false, error: `Unknown window action: ${action}` };
}

function escapeSendKeysText(text: string): string {
  return text.replace(/([+^%~(){}\[\]])/g, '{$1}').replace(/\r?\n/g, '~');
}

function hotkeySendKeys(keys: string[]): string {
  const modifiers: Record<string, string> = { ctrl: '^', control: '^', shift: '+', alt: '%', win: '#' };
  const mods: string[] = [];
  const rest: string[] = [];
  for (const key of keys) {
    const lower = String(key).toLowerCase();
    if (modifiers[lower]) mods.push(modifiers[lower]);
    else rest.push(lower);
  }
  const named = /^(f\d+|enter|tab|esc|escape|space|backspace|home|end|pgup|pgdn|pageup|pagedown|left|right|up|down|insert|delete|del|capslock)$/i;
  return mods.join('') + rest.map(key => key.length === 1 ? key : `{${named.test(key) ? key.toUpperCase() : key}}`).join('');
}

async function sendKeys(text: string, timeoutMs = 8000) {
  return runPowerShellText('$t = [Console]::In.ReadToEnd(); $w = New-Object -ComObject WScript.Shell; $w.SendKeys($t)', timeoutMs, text);
}

async function desktopGuiScroll(params: any = {}) {
  const clicks = Number(params?.clicks ?? params?.amount ?? 3);
  const x = params?.x != null ? Number(params.x) : null;
  const y = params?.y != null ? Number(params.y) : null;
  const delta = Math.round(clicks * 120);
  const script = `${desktopPreamble()}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3GuiScroll {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, IntPtr extra);
}
"@
${x != null && y != null ? `[Empir3GuiScroll]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null` : ''}
[Empir3GuiScroll]::mouse_event(0x0800, 0, 0, ${delta}, [IntPtr]::Zero)
`;
  const result = await runPowerShellText(script, 5000);
  return result.success ? { success: true, scrolled: clicks } : { success: false, error: result.stderr || 'Scroll failed' };
}

async function desktopCursorPosition() {
  const pos = await runPowerShellJson(`${desktopPreamble()}
$p = [System.Windows.Forms.Cursor]::Position
[pscustomobject]@{ success = $true; x = $p.X; y = $p.Y; cursor = [pscustomobject]@{ x = $p.X; y = $p.Y }; coordinateSpace = 'physical-virtual-screen' } | ConvertTo-Json -Depth 4
`);
  return pos;
}

async function desktopScreenSize() {
  const size = await runPowerShellJson(`${desktopPreamble()}
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
[pscustomobject]@{ success = $true; width = $b.Width; height = $b.Height; x = $b.X; y = $b.Y; coordinateSpace = 'physical-virtual-screen' } | ConvertTo-Json -Depth 4
`);
  return size;
}

async function handleGuiCommand(action: string, params: any = {}) {
  const writeNeeded = ['click', 'doubleclick', 'type', 'hotkey', 'move', 'scroll', 'click_ref', 'hover_ref', 'overlay', 'select_region', 'release_focus', 'pointer_show', 'pointer_move', 'pointer_pulse', 'pointer_hide', 'calibrate_pointer', 'click_cell', 'pointer_cell', 'focus_grid', 'pick_point'].includes(action);
  if (writeNeeded && !hasBridgePermission('execute')) return permissionDenied('execute');
  const limited = checkRateLimit(guiTimestamps, 30, 'GUI actions');
  if (limited) return { success: false, error: limited };

  if (action === 'monitors') return getDesktopMonitors();
  if (action === 'screenshot') {
    let region = params?.region;
    let gridArg = params?.grid;
    // Precedence (mirrors the MCP `desktop_screenshot` path): explicit region >
    // explicit monitor > active focus region > default. An explicit monitor arg
    // must win over an implicit focus scope — previously an active focus region
    // silently overrode an explicit monitor.
    const explicitMonitor = typeof params?.monitor === 'string' && params.monitor.trim().length > 0;
    const focusActive = !!(desktopFocus && !params?.noFocus);
    const useFocusRegion = !region && !explicitMonitor && focusActive;
    if (useFocusRegion) {
      region = { x: desktopFocus!.x, y: desktopFocus!.y, width: desktopFocus!.width, height: desktopFocus!.height };
      touchDesktopFocus(); // real scoped use → keep the region alive (idle-revoke)
    }
    // No-silent-scope-loss: caller relied on focus scoping but no region was
    // active — capture fell back to whole monitor. Annotate so it's observable.
    const focusExpired = !region && !explicitMonitor && !focusActive && !params?.noFocus;
    if (useFocusRegion && gridArg === undefined) {
      gridArg = { labels: 'axis' };
    } else if (gridArg === false || gridArg === null) {
      gridArg = undefined;
    }

    const shot = await takeDesktopScreenshot(params?.monitor || 'primary', region, gridArg, params?.marker);
    const first = shot?.captures?.[0];
    const imagePath = first?.path || shot?.stitchedPath;
    const prepared = imagePath && existsSync(imagePath) ? await prepareCompanionScreenshotPayload(imagePath, params) : null;
    const thumbnail = prepared ? prepared.buffer.toString('base64') : '';
    const imageData = {
      thumbnail,
      screenshot: thumbnail,
      base64: thumbnail,
      format: prepared?.mimeType === 'image/jpeg' ? 'jpg' : 'png',
      mimeType: prepared?.mimeType || 'image/png',
      width: prepared?.width,
      height: prepared?.height,
      bytes: prepared ? prepared.buffer.length : 0,
      savedPath: prepared?.path || imagePath,
      originalPath: prepared?.originalPath,
      originalBytes: prepared?.originalBytes,
      originalBase64Chars: prepared?.originalBase64Chars,
      originalWidth: prepared?.originalWidth,
      originalHeight: prepared?.originalHeight,
      relayPayloadDownscaled: !!prepared?.transformed,
      relayBase64Chars: thumbnail.length,
      relayMaxBase64Chars: prepared?.maxBase64Chars,
      relayWidth: prepared?.width,
      relayHeight: prepared?.height,
    };
    const focusAnnotation = focusExpired
      ? { focusExpired: true, focusNote: 'No active focus region — captured the whole monitor. The focus region may have expired (30 min idle) or been released; call desktop_select_region to re-scope.' }
      : {};
    return { success: !!thumbnail, ...shot, ...imageData, ...focusAnnotation, data: imageData };
  }
  if (action === 'click') return { success: true, ...(await desktopClick({ type: 'desktop_click', ...params, double: false } as any)) };
  if (action === 'doubleclick') return { success: true, ...(await desktopClick({ type: 'desktop_click', ...params, double: true } as any)) };
  if (action === 'move') return { success: true, ...(await desktopHover({ type: 'desktop_hover', ...params } as any)) };
  if (action === 'scroll') return desktopGuiScroll(params);
  if (action === 'position') return desktopCursorPosition();
  if (action === 'screensize') return desktopScreenSize();

  // ─── Added in 0.1.78: relay aliases for the new desktop tools so
  // Vincent / Empir3 server-side agents can call them through their
  // existing desktop:gui:<action> protocol.
  if (action === 'snapshot') return { success: true, ...(await getDesktopSnapshot({ type: 'desktop_snapshot', ...params } as any)) };
  if (action === 'click_ref') return { success: true, ...(await desktopClickRef({ type: 'desktop_click_ref', ...params } as any)) };
  if (action === 'hover_ref') return { success: true, ...(await desktopHoverRef({ type: 'desktop_hover_ref', ...params } as any)) };
  if (action === 'overlay') return { success: true, ...(await desktopOverlayToggle({ type: 'desktop_overlay', ...params } as any)) };
  if (action === 'select_region') return { success: true, ...(await desktopSelectRegion({ type: 'desktop_select_region', ...params } as any)) };
  if (action === 'release_focus') return { success: true, ...(await desktopReleaseFocus()) };
  if (action === 'focus_status') return { success: true, ...desktopFocusStatus() };
  if (action === 'snapshot_som') return { success: true, ...(await desktopSnapshotSom(params || {})) };
  if (action === 'pointer_show') return { success: true, ...(await desktopPointerShow({ type: 'desktop_pointer_show', ...params } as any)) };
  if (action === 'pointer_move') return { success: true, ...(await desktopPointerMove({ type: 'desktop_pointer_move', ...params } as any)) };
  if (action === 'pointer_pulse') return { success: true, ...(await desktopPointerPulse({ type: 'desktop_pointer_pulse', ...params } as any)) };
  if (action === 'pointer_hide') return { success: true, ...(await desktopPointerHide()) };
  if (action === 'pointer_status') return { success: true, ...desktopPointerStatus() };
  if (action === 'calibrate_pointer') return { success: true, ...(await desktopCalibratePointer({ type: 'desktop_calibrate_pointer', ...params } as any)) };
  if (action === 'calibration_status') return { success: true, ...desktopCalibrationStatus() };
  if (action === 'screenshot_zoom') return desktopScreenshotZoom(params || {});
  if (action === 'click_cell') return { success: true, ...(await desktopClickCell({ type: 'desktop_click_cell', ...params } as any)) };
  if (action === 'pointer_cell') return { success: true, ...(await desktopPointerCell({ type: 'desktop_pointer_cell', ...params } as any)) };
  if (action === 'focus_grid') return { success: true, ...(await desktopFocusGrid({ type: 'desktop_focus_grid', ...params } as any)) };
  if (action === 'pick_point') return { success: true, ...(await desktopPickPoint({ type: 'desktop_pick_point', ...params } as any)) };
  if (action === 'type') {
    const text = String(params?.text || '');
    if (!text) return { success: false, error: 'No text provided' };
    const result = await sendKeys(escapeSendKeysText(text), 8000);
    return result.success ? { success: true, typed: text.length } : { success: false, error: result.stderr || 'SendKeys failed' };
  }
  if (action === 'hotkey') {
    const keys = Array.isArray(params?.keys) ? params.keys : [];
    if (!keys.length) return { success: false, error: 'No keys provided' };
    const sent = hotkeySendKeys(keys);
    const result = await sendKeys(sent, 6000);
    return result.success ? { success: true, keys, sent } : { success: false, error: result.stderr || 'Hotkey failed' };
  }
  return { success: false, error: `Unknown gui action: ${action}` };
}

function validateReadableFilePath(filePath: string, maxBytes: number) {
  if (!filePath) return { ok: false, error: 'No file path provided' };
  let target = '';
  try { target = expandUserPath(filePath); } catch { return { ok: false, error: 'Invalid path' }; }
  const lower = target.toLowerCase();
  for (const prefix of BLOCKED_PATH_PREFIXES) {
    if (lower.startsWith(prefix)) return { ok: false, error: 'Access denied: system directory' };
  }
  const ext = extname(target).toLowerCase();
  if (BLOCKED_EXT_READ.has(ext)) return { ok: false, error: `Cannot read system files (${ext})` };
  if (BLOCKED_FILENAME.test(basename(target))) return { ok: false, error: 'Cannot read credential/key files' };
  if (BLOCKED_FILENAME_DOTENV.test(basename(target))) return { ok: false, error: 'Cannot read .env files (secrets)' };
  for (const frag of BLOCKED_PATH_FRAGMENTS) {
    if (lower.includes(frag)) return { ok: false, error: `Cannot read credential/config file (${frag})` };
  }
  if (!existsSync(target)) return { ok: false, error: `File not found: ${filePath}` };
  let st;
  try { st = statSync(target); } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  if (!st.isFile()) return { ok: false, error: `Not a file: ${filePath}` };
  if (st.size > maxBytes) return { ok: false, error: `File too large: ${(st.size / 1024 / 1024).toFixed(1)}MB` };
  return { ok: true, target, size: st.size };
}

function writeCompanionProjectFile(
  projectName: string,
  relPath: string,
  content: string | Buffer,
  encoding: BufferEncoding | 'base64' = 'utf-8',
  projectId?: string,
  revision?: unknown,
  incomingHash?: unknown,
) {
  const project = sanitizeRelativePath(projectName || projectId || 'Project');
  const rel = sanitizeRelativePath(relPath);
  if (!project || !rel) return { success: false, error: 'Invalid project name or path' };
  if (shouldIgnoreSyncPath(rel)) return { success: false, error: `Refusing to sync unsafe/noisy file: ${rel}` };
  const ext = extname(rel).toLowerCase();
  if (BLOCKED_EXT_WRITE.has(ext)) return { success: false, error: `File type not allowed: ${ext}` };
  const { root, projectDir, folder } = projectDirFor(project, projectId);
  writeProjectMeta(projectDir, projectId, project, revision);
  const savePath = join(projectDir, rel);
  if (!withinPath(savePath, root)) return { success: false, error: 'Path traversal blocked' };
  mkdirSync(dirname(savePath), { recursive: true });
  const nextBuffer = encoding === 'base64'
    ? Buffer.from(String(content), 'base64')
    : Buffer.isBuffer(content) ? content : Buffer.from(String(content), encoding);
  const nextHash = typeof incomingHash === 'string' && incomingHash
    ? incomingHash
    : createHash('sha256').update(nextBuffer).digest('hex');

  let finalPath = savePath;
  let conflict = false;
  if (existsSync(savePath)) {
    const existingHash = fileSha256(savePath);
    if (existingHash === nextHash) {
      const st = statSync(savePath);
      localSyncSeen.set(`${projectId || folder}:${rel}`, nextHash);
      return { success: true, savedPath: savePath, projectId: projectId || null, projectFolder: folder, previewUrl: `http://localhost:3456/projects/${folder}/${rel}`, sizeBytes: st.size, hash: nextHash, unchanged: true };
    }
    const ext = extname(savePath);
    const stem = savePath.slice(0, savePath.length - ext.length);
    finalPath = dedupePath(`${stem}.server-conflict-${Date.now()}${ext}`);
    conflict = true;
  }

  writeFileSync(finalPath, nextBuffer);
  const sizeBytes = statSync(finalPath).size;
  const finalRel = conflict ? sanitizeRelativePath(finalPath.slice(projectDir.length + 1)) : rel;
  localSyncSeen.set(`${projectId || folder}:${finalRel}`, nextHash);
  return { success: true, savedPath: finalPath, projectId: projectId || null, projectFolder: folder, previewUrl: `http://localhost:3456/projects/${folder}/${finalRel}`, sizeBytes, hash: nextHash, conflict };
}

async function handleFileCommand(type: string, action: string, params: any = {}) {
  if (type === 'desktop:file' && (action === 'push' || !action)) {
    if (!hasBridgePermission('write')) return permissionDenied('write');
    const filename = String(params?.filename || '').trim();
    const dataB64 = String(params?.data || '');
    if (!filename) return { success: false, error: 'No filename provided' };
    if (!dataB64) return { success: false, error: 'No file data provided' };
    const safeName = basename(filename).replace(UNSAFE_FILENAME_CHARS, '_');
    const ext = extname(safeName).toLowerCase();
    if (!safeName) return { success: false, error: 'Invalid filename' };
    if (BLOCKED_EXT_WRITE.has(ext)) return { success: false, error: `File type not allowed: ${ext}` };
    const buf = Buffer.from(dataB64, 'base64');
    if (buf.length > MAX_FILE_BYTES) return { success: false, error: `File too large: ${(buf.length / 1024 / 1024).toFixed(1)}MB (max 50MB)` };
    let saveDir = COMPANION_FILES_ROOT;
    const subfolder = sanitizeRelativePath(params?.subfolder || '');
    if (subfolder) saveDir = join(saveDir, subfolder);
    const dateDir = join(saveDir, todayStamp());
    mkdirSync(dateDir, { recursive: true });
    const savePath = dedupePath(join(dateDir, safeName));
    if (!withinPath(savePath, COMPANION_FILES_ROOT)) return { success: false, error: 'Path traversal blocked' };
    writeFileSync(savePath, buf);
    return { success: true, savedPath: savePath, sizeBytes: buf.length, filename: basename(savePath) };
  }

  if (type === 'desktop:file:pull' || action === 'pull') {
    if (!hasBridgePermission('read')) return permissionDenied('read');
    const maxBytes = Math.min(Math.max(Number(params?.maxSizeMB || 25), 1), 100) * 1024 * 1024 || DEFAULT_PULL_MAX_BYTES;
    const validated = validateReadableFilePath(params?.path || '', maxBytes);
    if (!validated.ok) return { success: false, error: validated.error };
    const buf = readFileSync(validated.target!);
    return { success: true, filename: basename(validated.target!), data: buf.toString('base64'), sizeBytes: validated.size, sourcePath: validated.target };
  }

  if (type === 'desktop:project:file') {
    if (!hasBridgePermission('write')) return permissionDenied('write');
    return writeCompanionProjectFile(params?.projectName || '', params?.path || '', String(params?.content || ''), 'utf-8', params?.projectId, params?.revision, params?.hash);
  }

  if (type === 'desktop:sync:push') {
    if (!hasBridgePermission('write')) return permissionDenied('write');
    const encoding = params?.encoding === 'base64' ? 'base64' : 'utf-8';
    return writeCompanionProjectFile(params?.projectName || '', params?.path || '', String(params?.content || ''), encoding, params?.projectId, params?.revision, params?.hash);
  }

  if (type === 'desktop:sync:complete') return { success: true, totalPushed: Number(params?.totalPushed || 0) };
  return { success: false, error: `Unknown file command: ${type}:${action}` };
}

function readChatLog(limit = 100): ChatMessage[] {
  if (!existsSync(CHAT_LOG)) return [];
  return readFileSync(CHAT_LOG, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function listRecordings() {
  if (!existsSync(RECORDINGS_DIR)) return [];
  return readdirSync(RECORDINGS_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const full = join(RECORDINGS_DIR, name);
      let meta: any = {};
      try {
        const parsed = JSON.parse(readFileSync(full, 'utf-8'));
        meta = {
          name: parsed.name || name,
          description: parsed.description || '',
          actionCount: Array.isArray(parsed.actions) ? parsed.actions.length : 0,
          recorded: parsed.recorded,
          engine: parsed.engine,
        };
      } catch {}
      return { file: name, path: full, ...meta };
    });
}

async function handleAgentBrowser(action: string, params: any) {
  switch (action) {
    case 'show': {
      let showRes: any = null;
      let warning: string | undefined;
      try {
        showRes = await cdpPost('/show', { url: params?.url || '' }, { timeoutMs: 8000, wakeOnNotReady: false });
      } catch (e: any) {
        warning = `Open Bridge requested, but CDP is still starting: ${e?.message || e}`;
        console.warn(`[Bridge] ${warning}`);
      }
      const href = showRes?.url || `${BRIDGE_URL}/welcome`;
      currentUrl = href;
      sessionCtx.currentUrl = currentUrl;
      if (!sessionCtx.pages.includes(currentUrl)) sessionCtx.pages.push(currentUrl);
      saveSessionContext();
      return { success: true, shown: true, url: href, warning };
    }
    case 'open':
    case 'navigate':
      return executeCommand({ type: 'navigate', url: params?.url || 'about:blank' } as any);
    case 'status':
      return executeCommand({ type: 'status' } as any);
    case 'snapshot':
      return executeCommand({ type: 'snapshot', filter: params?.filter || 'interactive', format: params?.format || 'json' } as any);
    case 'text':
    case 'get_text':
      return executeCommand({ type: 'text' } as any);
    case 'screenshot': {
      const buf = await cdpGetRaw('/screenshot', { raw: 'true', quality: String(params?.quality || 75) });
      const base64 = buf.toString('base64');
      return { success: true, screenshot: base64, base64, thumbnail: base64, format: 'jpeg', mimeType: 'image/jpeg', bytes: buf.length };
    }
    case 'click':
      return executeCommand({ type: params?.ref ? 'click_ref' : 'click', ref: params?.ref, selector: params?.selector, x: params?.x, y: params?.y } as any);
    case 'click_ref':
      return executeCommand({ type: 'click_ref', ref: params?.ref || params?.target } as any);
    case 'click_selector':
      return executeCommand({ type: 'click', selector: params?.selector || params?.target } as any);
    case 'type':
      return executeCommand({ type: params?.ref ? 'type_ref' : 'type', ref: params?.ref, selector: params?.selector, text: params?.text || '' } as any);
    case 'type_ref':
      return executeCommand({ type: 'type_ref', ref: params?.ref || params?.target, text: params?.text || '' } as any);
    case 'type_selector':
      return executeCommand({ type: 'type', selector: params?.selector || params?.target, text: params?.text || '' } as any);
    case 'press':
      return executeCommand({ type: 'press', text: params?.key || params?.text || '' } as any);
    case 'evaluate':
      return executeCommand({ type: 'evaluate', script: params?.expression || params?.script || '' } as any);
    case 'refresh':
      return executeCommand({ type: 'refresh' } as any);
    case 'highlight':
      return executeCommand({ type: 'highlight', selector: params?.selector || params?.target || '' } as any);
    case 'chat':
      return executeCommand({ type: 'chat', message: params?.message || params?.text || '' } as any);
    case 'read_chat':
      return { success: true, messages: readChatLog(100), log: CHAT_LOG };
    case 'recordings':
      return { success: true, recordings: listRecordings() };
    case 'record_start':
      return executeCommand({ type: 'record_start', text: params?.name || params?.recording || '', message: params?.description || '' } as any);
    case 'record_stop':
      return executeCommand({ type: 'record_stop', text: params?.name || params?.recording || '', message: params?.description || '' } as any);
    case 'play':
    case 'record_play':
      return executeCommand({ type: 'play', recording: params?.recording || params?.name || '', speed: params?.speed || 1, variables: params?.variables || {} } as any);
    case 'scroll': {
      const amount = Number(params?.amount || params?.dy || 600);
      const dir = params?.direction === 'up' ? -Math.abs(amount) : Math.abs(amount);
      return executeCommand({ type: 'scroll', x: params?.x || 0, y: dir } as any);
    }
    case 'close':
      return { success: true, closed: false, message: 'Bridge browser stays available for future commands.' };
    default:
      return { success: false, error: `Unknown agent-browser action: ${action}` };
  }
}

function normalizeDesktopRelayMessage(type: string, payload: any): { type: string; payload: any } {
  const canonical = canonicalCompanionType(String(type || ''), payload?.action);
  if (!canonical.startsWith('desktop:')) return { type, payload };
  const parts = canonical.split(':');
  if (parts.length <= 2) return { type: canonical, payload };

  let base = `desktop:${parts[1]}`;
  let action = parts.slice(2).join(':');
  if (parts[1] === 'agent-browser') {
    base = 'desktop:agent-browser';
  } else if (parts[1] === 'file' && parts[2] === 'pull') {
    base = 'desktop:file:pull';
    action = payload?.action || 'pull';
  } else if (parts[1] === 'project' && parts[2] === 'file') {
    base = 'desktop:project:file';
    action = payload?.action || 'save';
  } else if (parts[1] === 'sync' && (parts[2] === 'push' || parts[2] === 'complete')) {
    base = `desktop:sync:${parts[2]}`;
    action = payload?.action || parts[2];
  }

  return {
    type: base,
    payload: { ...(payload || {}), action: payload?.action || action },
  };
}

async function handleDesktopRelayCommand(type: string, payload: any) {
  const normalized = normalizeDesktopRelayMessage(type, payload);
  type = normalized.type;
  payload = normalized.payload;
  const id = payload?.id || `bridge-${Date.now()}`;
  let resultType = type === 'desktop:execute' ? 'desktop:result' : `${type}:result`;
  // empir3 website policy gate. Commands coming from the empir3 server
  // are constrained by what the website has authorized for this device,
  // on top of the local PC override that runs later inside executeCommand.
  const syntheticCmd = { type, action: payload?.action || '' } as any;
  const policyPerm = requiredBridgePermission(syntheticCmd);
  if (policyPerm && !hasEmpir3Permission(policyPerm)) {
    const denial = empir3PermissionDenied(policyPerm);
    sendEmpir3(resultType, { id, ...denial });
    return;
  }
  // Local per-tool veto applies to empir3 too — the PC owner's tool toggles
  // are the final override regardless of source.
  const toolName = commandToolName(syntheticCmd);
  if (toolName) {
    const cfg = loadConfig();
    if (cfg.enabledTools?.[toolName] === false) {
      sendEmpir3(resultType, { id, success: false, error: `Tool disabled locally: ${toolName}` });
      return;
    }
  }
  try {
    let result: any;
    const action = payload?.action || '';
    const params = payload?.params || payload || {};
    if (type === 'desktop:capabilities') {
      result = await buildDesktopCapabilities(action || 'quick', payload?.name || params?.name || '');
    } else if (type === 'desktop:sysinfo') {
      result = await getSystemInfo(action || payload?.query || 'overview');
    } else if (type === 'desktop:app') {
      result = await handleAppCommand(action, params);
    } else if (type === 'desktop:clipboard') {
      result = await handleClipboardCommand(action, params);
    } else if (type === 'desktop:execute') {
      resultType = 'desktop:result';
      result = await handleExecuteCommand(action || 'run', params);
    } else if (type === 'desktop:notify') {
      result = await handleNotifyCommand(action || 'show', params);
    } else if (type === 'desktop:file' || type === 'desktop:file:pull' || type === 'desktop:project:file' || type === 'desktop:sync:push' || type === 'desktop:sync:complete') {
      result = await handleFileCommand(type, action, params);
    } else if (type === 'desktop:window') {
      result = await handleWindowCommand(action || 'list', params);
    } else if (type === 'desktop:gui') {
      result = await handleGuiCommand(action || 'screenshot', params);
    } else if (type === 'desktop:agent-browser' || type === 'desktop:browse') {
      result = await handleAgentBrowser(action || 'status', params);
    } else {
      result = { success: false, error: `Unsupported desktop message: ${type}` };
    }
    result = normalizeCompanionResult(result);
    sendEmpir3(resultType, { id, success: result?.success !== false, ...result });
  } catch (e: any) {
    sendEmpir3(resultType, { id, success: false, error: e?.message || String(e) });
  }
}

function handleEmpir3Message(msg: any) {
  const { type } = msg;
  const payload = msg.payload || msg;

  if (type === 'relay:connected' || type === 'connected') {
    empir3Connected = true;
    empir3LastCloseCode = 0;
    empir3LastCloseReason = '';
    empir3AuthRejectedAt = 0;
    return;
  }
  if (type === 'ping' || type === 'relay:ping') {
    sendEmpir3(type === 'relay:ping' ? 'relay:pong' : 'pong', { ...payload, ts: Date.now() });
    return;
  }
  if (type === 'heartbeat') {
    sendEmpir3('heartbeat:ack', { ...payload, ts: Date.now() });
    return;
  }

  const targetDeviceId = typeof msg?._targetDeviceId === 'string' ? msg._targetDeviceId : '';
  if (targetDeviceId) {
    const localDeviceId = readBridgeSettings().deviceId || '';
    if (localDeviceId && targetDeviceId !== localDeviceId) return;
  }

  if (typeof type === 'string' && type.startsWith('claude:cli:')) {
    const action = type.slice('claude:cli:'.length);
    if (!READ_ONLY_CLI_ACTIONS.has(action) && !hasEmpir3Permission('execute')) {
      sendEmpir3('claude:cli:error', {
        id: payload?.id || '',
        stage: action || 'unknown',
        error: empir3PermissionDenied('execute').error,
      });
      return;
    }
    handleClaudeCliCommand(action, payload, (eventType, eventPayload) => {
      sendEmpir3(eventType, eventPayload);
    }).catch((e: any) => {
      sendEmpir3('claude:cli:error', {
        id: payload?.id || '',
        stage: action || 'unknown',
        error: e?.message || String(e),
      });
    });
    return;
  }

  if (typeof type === 'string' && type.startsWith('codex:cli:')) {
    const action = type.slice('codex:cli:'.length);
    if (!READ_ONLY_CLI_ACTIONS.has(action) && !hasEmpir3Permission('execute')) {
      sendEmpir3('codex:cli:error', {
        id: payload?.id || '',
        stage: action || 'unknown',
        error: empir3PermissionDenied('execute').error,
      });
      return;
    }
    handleCodexCliCommand(action, payload, (eventType, eventPayload) => {
      sendEmpir3(eventType, eventPayload);
    }).catch((e: any) => {
      sendEmpir3('codex:cli:error', {
        id: payload?.id || '',
        stage: action || 'unknown',
        error: e?.message || String(e),
      });
    });
    return;
  }

  if (typeof type === 'string' && type.startsWith('gemini:cli:')) {
    const action = type.slice('gemini:cli:'.length);
    if (!READ_ONLY_CLI_ACTIONS.has(action) && !hasEmpir3Permission('execute')) {
      sendEmpir3('gemini:cli:error', {
        id: payload?.id || '',
        stage: action || 'unknown',
        error: empir3PermissionDenied('execute').error,
      });
      return;
    }
    handleGeminiCliCommand(action, payload, (eventType, eventPayload) => {
      sendEmpir3(eventType, eventPayload);
    }).catch((e: any) => {
      sendEmpir3('gemini:cli:error', {
        id: payload?.id || '',
        stage: action || 'unknown',
        error: e?.message || String(e),
      });
    });
    return;
  }

  if (typeof type === 'string' && type.startsWith('grok:cli:')) {
    const action = type.slice('grok:cli:'.length);
    if (!READ_ONLY_CLI_ACTIONS.has(action) && !hasEmpir3Permission('execute')) {
      sendEmpir3('grok:cli:error', {
        id: payload?.id || '',
        stage: action || 'unknown',
        error: empir3PermissionDenied('execute').error,
      });
      return;
    }
    handleGrokCliCommand(action, payload, (eventType, eventPayload) => {
      sendEmpir3(eventType, eventPayload);
    }).catch((e: any) => {
      sendEmpir3('grok:cli:error', {
        id: payload?.id || '',
        stage: action || 'unknown',
        error: e?.message || String(e),
      });
    });
    return;
  }

  if (typeof type === 'string' && type.startsWith('agy:cli:')) {
    const action = type.slice('agy:cli:'.length);
    if (!READ_ONLY_CLI_ACTIONS.has(action) && !hasEmpir3Permission('execute')) {
      sendEmpir3('agy:cli:error', {
        id: payload?.id || '',
        stage: action || 'unknown',
        error: empir3PermissionDenied('execute').error,
      });
      return;
    }
    handleAgyCliCommand(action, payload, (eventType, eventPayload) => {
      sendEmpir3(eventType, eventPayload);
    }).catch((e: any) => {
      sendEmpir3('agy:cli:error', {
        id: payload?.id || '',
        stage: action || 'unknown',
        error: e?.message || String(e),
      });
    });
    return;
  }

  // ── Lent Higgsfield CLI over the empir3 channel (image + video gen) ──
  //
  // The local higgsfield_generate handler lives in executeCommand (reached by
  // the HTTP/CDP wrapper). The empir3 server routes media gen over THIS channel
  // via HiggsfieldClient.runCli, so it needs an explicit case here — parallel
  // to the *:cli:* handlers above. Without it, CLI-mode videogen dead-ended and
  // the server reported "upstream returned no video".
  if (typeof type === 'string' && type.startsWith('higgsfield:cli:')) {
    const action = type.slice('higgsfield:cli:'.length);
    // Capability probe is a read-only status check (mirrors claude/codex/gemini/
    // grok). Answer it directly via probeHiggsfieldCli() so the empir3 server's
    // videogen route-eligibility probe passes. Without this, 'probe' fell through
    // to handleHiggsfieldCliCommand → unknown_action; the server's probe:result
    // listener never fired, timed out, and CLI-mode videogen silently skipped
    // Higgsfield ("higgsfield/cli skipped - probe timeout").
    if (action === 'probe') {
      probeHiggsfieldCli()
        .then((result: any) => sendEmpir3('higgsfield:cli:probe:result', {
          id: payload?.id || '',
          ...result,
          // The server's higgsfield row uses requireAuth, which inspects
          // `auth_state` — but probeHiggsfieldCli reports `authenticated`. Map it
          // so an unauthenticated CLI is denied (and an authed one passes).
          auth_state: result.authenticated ? 'authenticated' : 'unauthenticated',
        }))
        .catch((e: any) => sendEmpir3('higgsfield:cli:probe:result', {
          id: payload?.id || '', available: false, authenticated: false,
          auth_state: 'unauthenticated', device_opted_in: false,
          error: e?.message || String(e),
        }));
      return;
    }
    if (!READ_ONLY_CLI_ACTIONS.has(action) && !hasEmpir3Permission('execute')) {
      sendEmpir3('higgsfield:cli:error', {
        id: payload?.id || '',
        stage: action || 'unknown',
        error: empir3PermissionDenied('execute').error,
      });
      return;
    }
    handleHiggsfieldCliCommand(action, payload, (eventType, eventPayload) => {
      sendEmpir3(eventType, eventPayload);
    }).catch((e: any) => {
      sendEmpir3('higgsfield:cli:error', {
        id: payload?.id || '',
        stage: action || 'unknown',
        error: e?.message || String(e),
      });
    });
    return;
  }

  // ── Lent GitHub CLI over the empir3 channel ──────────────────────────
  //
  // The github:exec / github_status handlers live in executeCommand (reached
  // by the local HTTP/CDP wrapper). The empir3-server routes GitHub work over
  // THIS channel, so it needs explicit cases here — parallel to the *:cli:*
  // handlers above. Capability discovery uses github:probe (mirrors
  // <cli>:cli:probe); execution uses github:exec. Both correlate by payload.id
  // and reply with a *:result (or github:exec:error) envelope the server
  // matches by id. github-cli.ts remains the single enforcement boundary.
  if (type === 'github:probe') {
    // Informational capability report (presence + auth account + master
    // opt-in + per-scope matrix). No execute permission required — same as
    // the other CLI probes, which are pure capability advertisements.
    probeGithubCli(githubDeviceOptedIn(), githubScopes())
      .then((caps) => sendEmpir3('github:probe:result', { id: payload?.id || '', ...caps }))
      .catch((e: any) => sendEmpir3('github:probe:result', {
        id: payload?.id || '',
        available: false,
        error: e?.message || String(e),
        device_opted_in: githubDeviceOptedIn(),
        authenticated: false,
        scopes: githubScopes(),
      }));
    return;
  }

  if (type === 'github:exec:abort') {
    // gh runs are short and the bridge enforces its own 90s cap; there is no
    // in-flight handle to cancel here. Accept-and-ignore so the server's
    // watchdog abort is a no-op rather than an "unknown message".
    return;
  }

  if (type === 'github:exec') {
    const id = payload?.id || '';
    if (!hasEmpir3Permission('execute')) {
      sendEmpir3('github:exec:error', {
        id,
        stage: 'opted_out',
        error: empir3PermissionDenied('execute').error,
      });
      return;
    }
    // Master lend opt-in is checked here; the per-scope matrix + hard-blocks
    // are enforced inside githubExec (the safety boundary).
    if (!githubDeviceOptedIn()) {
      sendEmpir3('github:exec:error', {
        id,
        stage: 'opted_out',
        error: 'Device owner has not opted in. Enable "Lend Empir3 my GitHub CLI" in the bridge settings before routing GitHub commands through this PC.',
      });
      return;
    }
    githubExec({
      args: payload?.args ?? payload?.command ?? payload?.argv,
      scopes: githubScopes(),
      cwd: typeof payload?.cwd === 'string' ? payload.cwd : undefined,
    })
      .then((result: any) => sendEmpir3('github:exec:result', { id, ...result }))
      .catch((e: any) => sendEmpir3('github:exec:error', {
        id,
        stage: 'cli_error',
        error: e?.message || String(e),
      }));
    return;
  }

  if (type === 'github_status') {
    const id = payload?.id || '';
    if (!hasEmpir3Permission('read')) {
      sendEmpir3('github_status:result', { id, ...empir3PermissionDenied('read') });
      return;
    }
    githubStatus((payload?.params || {}) as any)
      .then((result: any) => sendEmpir3('github_status:result', { id, ...result }))
      .catch((e: any) => sendEmpir3('github_status:result', { id, success: false, error: e?.message || String(e) }));
    return;
  }

  if (type === 'device:settings:updated' || type === 'device:settings:changed') {
    const settings = readBridgeSettings();
    if (payload?.deviceId && settings.deviceId && payload.deviceId !== settings.deviceId) return;
    let nextHomeDirectory = settings.homeDirectory;
    if (payload?.homeDirectory) {
      const validated = validateHomeDirectoryCandidate(payload.homeDirectory);
      if (validated.ok) {
        nextHomeDirectory = validated.path;
      } else {
        sendEmpir3('device:settings:error', {
          deviceId: settings.deviceId || payload?.deviceId || 'empir3-bridge-local',
          field: 'homeDirectory',
          requested: payload.homeDirectory,
          error: validated.error,
        });
      }
    }
    const nextEmpir3Permissions = payload?.permissions
      ? normalizeRwe(payload.permissions, bridgeEmpir3Permissions(settings))
      : bridgeEmpir3Permissions(settings);
    saveBridgeSettings({
      ...settings,
      deviceName: payload?.deviceName || settings.deviceName,
      homeDirectory: nextHomeDirectory,
      empir3Permissions: nextEmpir3Permissions,
      globalSafety: bridgeGlobalSafety(settings),
    });
    sendEmpir3('device:settings:ack', {
      deviceId: settings.deviceId || payload?.deviceId || 'empir3-bridge-local',
      deviceName: payload?.deviceName || settings.deviceName,
      homeDirectory: nextHomeDirectory,
      permissions: nextEmpir3Permissions,
      globalSafety: bridgeGlobalSafety(settings),
      settingsRevision: Number(payload?.settingsRevision || 0),
    });
    return;
  }

  if (typeof type === 'string') {
    const canonicalType = canonicalCompanionType(type, payload?.action);
    const isCommandResult = canonicalType.endsWith(':result') || canonicalType.endsWith(':report');
    if (canonicalType.startsWith('desktop:') && !isCommandResult) {
      handleDesktopRelayCommand(canonicalType, payload).catch((e: any) => console.error('[Empir3] Desktop command failed:', e?.message || e));
      return;
    }
  }

  if (type === 'chat:context' || type === 'bridge:context') {
    const projectId = payload.projectId || payload.project?.id;
    rememberEmpir3Project(projectId, payload.projectName || payload.project?.name);
    if (projectId) mirrorEmpir3Project(String(projectId), payload.projectName || payload.project?.name || '').catch(() => {});
    return;
  }

  if (type === 'state:snapshot') {
    const missed = Array.isArray(payload.missedEvents) ? payload.missedEvents : [];
    missed.forEach((event: any) => handleEmpir3Message(event));
    const active = payload.activeProjects && typeof payload.activeProjects === 'object'
      ? Object.keys(payload.activeProjects)[0]
      : '';
    if (active && !activeEmpir3ProjectId) rememberEmpir3Project(active);
    return;
  }

  if (type === 'project:created') {
    rememberEmpir3Project(payload.projectId, payload.name);
    return;
  }

  if (type === 'user:message') {
    const chatMsg = normalizeEmpir3Message({
      id: payload.messageId,
      role: 'user',
      content: payload.content,
      createdAt: payload.createdAt,
      projectId: payload.projectId,
    }, payload.projectId);
    if (chatMsg) {
      rememberEmpir3Project(chatMsg.projectId);
      appendMirroredChat(chatMsg);
    }
    return;
  }

  if (type === 'chat:chunk' || type === 'team:chunk') {
    const projectId = String(payload.projectId || activeEmpir3ProjectId || '');
    const delta = String(payload.content || msg.content || msg.chunk || '');
    if (!delta) return;
    rememberEmpir3Project(projectId);
    const prev = empir3StreamBuffers.get(projectId) || '';
    if (!prev) broadcastToOverlay({ type: 'claude_stream_start', projectId, agent: payload.agentId, agentName: payload.agentName });
    empir3StreamBuffers.set(projectId, prev + delta);
    empir3ResponseBuffer = prev + delta;
    broadcastToOverlay({ type: 'claude_text_delta', text: delta, projectId, agent: payload.agentId, agentName: payload.agentName });
    return;
  }

  if (type === 'chat:complete' || type === 'chat:intermediate') {
    const projectId = String(payload.projectId || payload.message?.projectId || activeEmpir3ProjectId || '');
    rememberEmpir3Project(projectId);
    const chatMsg = normalizeEmpir3Message(payload.message || {
      id: payload.messageId,
      role: 'agent',
      content: payload.content || msg.content || empir3StreamBuffers.get(projectId) || empir3ResponseBuffer,
      createdAt: payload.createdAt,
      projectId,
      agentId: payload.agentId || msg.agentId,
      agentName: payload.agentName || msg.agentName,
    }, projectId);
    if (chatMsg) {
      const hadStream = empir3StreamBuffers.has(projectId);
      appendMirroredChat(chatMsg, !hadStream || type === 'chat:intermediate');
      if (hadStream && type === 'chat:complete') broadcastToOverlay({ type: 'claude_message_end', projectId });
      console.log(`[Empir3] ${chatMsg.agentName || chatMsg.agent || EMPIR3_DIRECT_AGENT}: ${chatMsg.text.slice(0, 80)}...`);
    }
    empir3StreamBuffers.delete(projectId);
    empir3ResponseBuffer = '';
    return;
  }

  if (type === 'chat:typing' || type === 'agent:typing') {
    rememberEmpir3Project(payload.projectId);
    broadcastToOverlay({ type: 'agent_typing', agentId: payload.agentId || msg.agentId, agentName: payload.agentName || msg.agentName });
    return;
  }

  if (type === 'direct:mode') {
    rememberEmpir3Project(payload.projectId);
    console.log(`[Empir3] Direct mode: ${payload.active ? 'ON' : 'OFF'} -> ${payload.agentName || payload.agentId}`);
    return;
  }

  if (type === 'chat:chunk') {
    // Accumulate streamed response from agent
    empir3ResponseBuffer += msg.content || msg.chunk || '';
  }

  if (type === 'chat:complete') {
    // Agent finished responding — send full message to overlay
    const agentName = msg.agentName || msg.agentId || EMPIR3_DIRECT_AGENT;
    const responseText = empir3ResponseBuffer || msg.content || '';
    if (responseText) {
      const chatMsg = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        from: 'claude' as const,
        text: responseText,
        timestamp: new Date().toISOString(),
        channel: 'empir3',
        agent: agentName,
      };
      appendFileSync(CHAT_LOG, JSON.stringify(chatMsg) + '\n');
      broadcastToOverlay({ type: 'claude_chat', message: chatMsg });
      console.log(`[Empir3] ${agentName}: ${responseText.slice(0, 80)}...`);
    }
    empir3ResponseBuffer = '';
  }

  if (type === 'chat:typing') {
    broadcastToOverlay({ type: 'agent_typing', agentId: msg.agentId, agentName: msg.agentName });
  }

  if (type === 'direct:mode') {
    console.log(`[Empir3] Direct mode: ${msg.active ? 'ON' : 'OFF'} → ${msg.agentName || msg.agentId}`);
  }
}

function forwardToEmpir3(userMessage: ChatMessage): boolean {
  if (!empir3Ws || !empir3Connected) {
    console.log('[Empir3] Not connected — message stays local only');
    return false;
  }

  const payload: any = {
    projectId: activeEmpir3ProjectId || EMPIR3_PROJECT_ID || 'default',
    content: userMessage.text,
    directMode: { agentId: EMPIR3_DIRECT_AGENT },
  };

  // Include screenshot path if available
  if (userMessage.screenshot) {
    payload.screenshotPath = join(FEEDBACK_DIR, userMessage.screenshot);
  }

  // Include annotation context if selector was provided
  if (userMessage.selector) {
    payload.annotationContext = {
      annotations: [{
        page: userMessage.url || currentUrl,
        cssPath: userMessage.selector,
        instruction: userMessage.text,
        elementHtml: userMessage.elementHtml,
      }],
    };
  }

  empir3Ws.send(JSON.stringify({ type: 'chat:send', payload }));
  console.log(`[Empir3] Forwarded: "${userMessage.text.slice(0, 60)}..." -> ${EMPIR3_DIRECT_AGENT}`);
  return true;
}

// Connect on startup if configured
connectToEmpir3();

// ─── Empir3 Bridge Client ─────────────────────────────────────────

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isBridgeNotReadyError(text: string): boolean {
  return /Not connected|CDP not connected|Browser WS not connected/i.test(text);
}

function updateCdpReachabilityFromBody(path: string, body: any): void {
  bridgeReachable = true;
  if (path === '/health') {
    cdpConnected = body?.status === 'connected';
    return;
  }
  if (body && typeof body === 'object' && (body.closedByUser || body.chrome === 'exited' || body.chrome === 'not-started')) {
    cdpConnected = false;
    return;
  }
  cdpConnected = true;
}

async function wakeBridgeBrowser(): Promise<void> {
  try {
    await fetchWithTimeout(`${BRIDGE_URL}/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, 5000);
  } catch {}
  await wait(750);
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: init.signal || controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function cdpGet(path: string, params?: Record<string, string>, opts: { timeoutMs?: number } = {}): Promise<any> {
  let url = `${BRIDGE_URL}${path}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url += `?${qs}`;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { headers: { 'Content-Type': 'application/json' } }, opts.timeoutMs || 5000);
    } catch (e: any) {
      if (attempt < 2) {
        await wait(250);
        continue;
      }
      bridgeReachable = false;
      cdpConnected = false;
      throw new Error(`Empir3 Bridge ${path}: ${e?.name === 'AbortError' ? 'timeout' : (e?.message || e)}`);
    }
    if (res.ok) {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) {
        const body = await res.json();
        updateCdpReachabilityFromBody(path, body);
        return body;
      }
      const body = await res.text();
      updateCdpReachabilityFromBody(path, body);
      return body;
    }
    const text = await res.text();
    if (attempt < 2 && isBridgeNotReadyError(text)) {
      await wakeBridgeBrowser();
      continue;
    }
    throw new Error(`Empir3 Bridge ${path}: ${res.status} ${text}`);
  }
  throw new Error(`Empir3 Bridge ${path}: exhausted retries`);
}

async function cdpGetRaw(path: string, params?: Record<string, string>, opts: { timeoutMs?: number } = {}): Promise<Buffer> {
  let url = `${BRIDGE_URL}${path}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url += `?${qs}`;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, {}, opts.timeoutMs || 8000);
    } catch (e: any) {
      if (attempt < 2) {
        await wait(250);
        continue;
      }
      bridgeReachable = false;
      cdpConnected = false;
      throw new Error(`Empir3 Bridge ${path}: ${e?.name === 'AbortError' ? 'timeout' : (e?.message || e)}`);
    }
    if (res.ok) {
      const ab = await res.arrayBuffer();
      bridgeReachable = true;
      cdpConnected = true;
      return Buffer.from(ab);
    }
    const text = await res.text().catch(() => '');
    if (attempt < 2 && isBridgeNotReadyError(text)) {
      await wakeBridgeBrowser();
      continue;
    }
    throw new Error(`Empir3 Bridge ${path}: ${res.status} ${text}`);
  }
  throw new Error(`Empir3 Bridge ${path}: exhausted retries`);
}

async function cdpPost(path: string, data: any, opts: { wakeOnNotReady?: boolean; timeoutMs?: number } = {}): Promise<any> {
  const wakeOnNotReady = opts.wakeOnNotReady !== false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = opts.timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs) : null;
    let res: Response;
    try {
      res = await fetch(`${BRIDGE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: controller?.signal,
      });
    } catch (e: any) {
      if (wakeOnNotReady && attempt < 2 && /aborted|AbortError/i.test(String(e?.name || e?.message || e))) {
        continue;
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.ok) {
      let body: any = { success: true };
      try { body = await res.json(); } catch {}
      updateCdpReachabilityFromBody(path, body);
      return body;
    }
    const text = await res.text();
    if (wakeOnNotReady && attempt < 2 && isBridgeNotReadyError(text)) {
      await wakeBridgeBrowser();
      continue;
    }
    throw new Error(`Empir3 Bridge POST ${path}: ${res.status} ${text}`);
  }
  throw new Error(`Empir3 Bridge POST ${path}: exhausted retries`);
}

async function checkBridgeHealth(): Promise<boolean> {
  try {
    const health = await cdpGet('/health');
    // Keep daemon reachability separate from the visible Chrome window.
    // If the user closes Chrome, passive status polling must not relaunch it.
    const reachable = !!health;
    const browserReady = health?.status === 'connected';
    const changed = reachable !== bridgeReachable || browserReady !== cdpConnected;
    bridgeReachable = reachable;
    cdpConnected = browserReady;
    if (changed) {
      console.log(`[Bridge] Empir3 Bridge: ${reachable ? 'reachable' : 'unreachable'} (browser: ${browserReady ? 'connected' : 'disconnected'})`);
      // On reconnect, let the bridge-owned welcome page stay stable, then make
      // sure the in-page browser controls are present on every current/future tab.
      if (browserReady) {
        const ensureOverlay = async () => {
          try { await injectOverlay(); } catch {}
        };
        setTimeout(ensureOverlay, 2000);
        setTimeout(ensureOverlay, 4000);
        setTimeout(ensureOverlay, 6000);
        // Register overlay as auto-inject so ALL new tabs get it automatically
        setTimeout(() => injectOverlayAll().catch(() => {}), 7000);
      }
    }
    return reachable;
  } catch {
    if (bridgeReachable || cdpConnected) {
      bridgeReachable = false;
      cdpConnected = false;
      console.log('[Bridge] Empir3 Bridge: unreachable');
    }
    return false;
  }
}

/** Get interactive elements snapshot, with caching */
async function getSnapshot(filter = 'interactive', _format = 'compact'): Promise<SnapshotElement[]> {
  const now = Date.now();
  if (now - lastSnapshotTime < SNAPSHOT_CACHE_TTL && lastSnapshot.length > 0 && filter === 'interactive') {
    return lastSnapshot;
  }
  try {
    const result = await cdpGet('/snapshot', { filter, format: 'json' });
    // Empir3 Bridge returns array of elements or object with elements
    const elements: SnapshotElement[] = Array.isArray(result) ? result
      : result?.elements ? result.elements
      : result?.tree ? (Array.isArray(result.tree) ? result.tree : [])
      : [];
    if (filter === 'interactive') {
      lastSnapshot = elements;
      lastSnapshotTime = now;
    }
    return elements;
  } catch (e: any) {
    console.log(`[Bridge] Snapshot error: ${e.message?.slice(0, 60)}`);
    return [];
  }
}

/** Find the closest element ref to given coordinates */
function findRefAtPosition(elements: SnapshotElement[], x: number, y: number): SnapshotElement | null {
  let best: SnapshotElement | null = null;
  let bestDist = Infinity;
  let bestArea = Infinity;

  for (const el of elements) {
    const b = el.bounds;
    if (!b || !b.width || !b.height) continue;

    // Check if point is inside element bounds
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
      // Prefer smallest containing element (most specific)
      const area = b.width * b.height;
      if (area < bestArea) {
        best = el;
        bestArea = area;
        bestDist = 0;
      }
    } else if (bestDist > 0) {
      // Fallback: nearest element center
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist < bestDist && dist < 50) {  // within 50px
        best = el;
        bestDist = dist;
      }
    }
  }
  return best;
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const companionScreenshotMaxBase64Raw = Number(process.env.EMPIR3_COMPANION_SCREENSHOT_MAX_BASE64_CHARS || 900_000);
const COMPANION_SCREENSHOT_MAX_BASE64_CHARS = Number.isFinite(companionScreenshotMaxBase64Raw)
  ? Math.max(200_000, Math.min(900_000, Math.round(companionScreenshotMaxBase64Raw)))
  : 900_000;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function getImageDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length >= 24
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      const isSof = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isSof && offset + 8 < buffer.length) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

async function prepareCompanionScreenshotPayload(sourcePath: string, params: any = {}) {
  const originalBuffer = readFileSync(sourcePath);
  const originalDimensions = getImageDimensions(originalBuffer);
  const originalBase64Chars = originalBuffer.toString('base64').length;
  const maxBase64Chars = clampInt(params?.maxBase64Chars, COMPANION_SCREENSHOT_MAX_BASE64_CHARS, 200_000, 900_000);

  if (originalBase64Chars <= maxBase64Chars) {
    return {
      path: sourcePath,
      buffer: originalBuffer,
      mimeType: /\.jpe?g$/i.test(sourcePath) ? 'image/jpeg' : 'image/png',
      width: originalDimensions?.width,
      height: originalDimensions?.height,
      transformed: false,
      originalPath: sourcePath,
      originalBytes: originalBuffer.length,
      originalBase64Chars,
      originalWidth: originalDimensions?.width,
      originalHeight: originalDimensions?.height,
      maxBase64Chars,
    };
  }

  const base = sourcePath.replace(/\.[^.\\/]+$/, '');
  const requestedDim = clampInt(params?.maxDimension, 1800, 900, 2400);
  const requestedQuality = clampInt(params?.quality, 70, 45, 82);
  const attempts = [
    { dim: requestedDim, quality: requestedQuality },
    { dim: 1600, quality: Math.min(requestedQuality, 68) },
    { dim: 1280, quality: 60 },
    { dim: 1024, quality: 52 },
  ];

  let best: any = null;
  for (const attempt of attempts) {
    const relayPath = `${base}-relay-${attempt.dim}-q${attempt.quality}.jpg`;
    try {
      const resizeResult = await runPowerShellJson(`${desktopPreamble()}
$src = ${psString(sourcePath)}
$dst = ${psString(relayPath)}
$maxDim = [int]${attempt.dim}
$quality = [long]${attempt.quality}
$img = [System.Drawing.Image]::FromFile($src)
$bmp = $null
$g = $null
$encParams = $null
try {
  $scale = [Math]::Min(1.0, $maxDim / [double]([Math]::Max($img.Width, $img.Height)))
  $w = [Math]::Max(1, [int][Math]::Round($img.Width * $scale))
  $h = [Math]::Max(1, [int][Math]::Round($img.Height * $scale))
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList @($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($img, 0, 0, $w, $h)
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $encParams = New-Object System.Drawing.Imaging.EncoderParameters -ArgumentList 1
  $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter -ArgumentList ([System.Drawing.Imaging.Encoder]::Quality, $quality)
  $bmp.Save($dst, $codec, $encParams)
  [pscustomobject]@{ success = $true; path = $dst; width = $w; height = $h; quality = $quality; bytes = (Get-Item $dst).Length } | ConvertTo-Json -Depth 4
} finally {
  if ($encParams) { $encParams.Dispose() }
  if ($g) { $g.Dispose() }
  if ($bmp) { $bmp.Dispose() }
  $img.Dispose()
}
`, 20000);
      if (!existsSync(relayPath)) continue;
      const buffer = readFileSync(relayPath);
      const dimensions = getImageDimensions(buffer);
      const base64Chars = buffer.toString('base64').length;
      const candidate = {
        path: relayPath,
        buffer,
        mimeType: 'image/jpeg',
        width: dimensions?.width || resizeResult?.width,
        height: dimensions?.height || resizeResult?.height,
        transformed: true,
        originalPath: sourcePath,
        originalBytes: originalBuffer.length,
        originalBase64Chars,
        originalWidth: originalDimensions?.width,
        originalHeight: originalDimensions?.height,
        maxBase64Chars,
        relayBytes: buffer.length,
        relayBase64Chars: base64Chars,
        relayWidth: dimensions?.width || resizeResult?.width,
        relayHeight: dimensions?.height || resizeResult?.height,
        relayMaxDimension: attempt.dim,
        relayQuality: attempt.quality,
      };
      best = !best || candidate.relayBase64Chars < best.relayBase64Chars ? candidate : best;
      if (base64Chars <= maxBase64Chars) return candidate;
    } catch (e: any) {
      console.warn('[Empir3] screenshot relay resize failed:', e?.message || e);
    }
  }

  return best || {
    path: sourcePath,
    buffer: originalBuffer,
    mimeType: /\.jpe?g$/i.test(sourcePath) ? 'image/jpeg' : 'image/png',
    width: originalDimensions?.width,
    height: originalDimensions?.height,
    transformed: false,
    originalPath: sourcePath,
    originalBytes: originalBuffer.length,
    originalBase64Chars,
    originalWidth: originalDimensions?.width,
    originalHeight: originalDimensions?.height,
    maxBase64Chars,
  };
}

function desktopPreamble(): string {
  return `
$ErrorActionPreference = 'Stop'
# Emit stdout as UTF-8 (no BOM) so non-ASCII UIA element names (accented text,
# Segoe icon glyphs) survive to Node, which decodes stdout as UTF-8. Without
# this, Windows PowerShell 5.1 writes the OEM code page and such names arrive
# mangled as "?"/"??".
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3DesktopDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
try { [Empir3DesktopDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
  try { [Empir3DesktopDpi]::SetProcessDPIAware() | Out-Null } catch {}
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
`;
}

async function runPowerShellJson(script: string, timeoutMs = 30000): Promise<any> {
  if (process.platform !== 'win32') {
    throw new Error('Desktop tools are currently available on Windows only.');
  }
  const result = await runPowerShellText(script, timeoutMs);
  if (!result.success) {
    throw new Error((result.stderr || result.stdout || (result.timedOut ? `PowerShell timed out after ${timeoutMs}ms` : `PowerShell exited ${result.code}`)).trim());
  }
  const text = result.stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    const sanitized = text.replace(/[\u0000-\u001F]/g, ' ');
    try {
      return JSON.parse(sanitized);
    } catch {
      throw e;
    }
  }
}

async function getDesktopMonitors(): Promise<any> {
  return runPowerShellJson(`${desktopPreamble()}
$screens = [System.Windows.Forms.Screen]::AllScreens
$minX = ($screens | ForEach-Object { $_.Bounds.Left } | Measure-Object -Minimum).Minimum
$minY = ($screens | ForEach-Object { $_.Bounds.Top } | Measure-Object -Minimum).Minimum
$maxX = ($screens | ForEach-Object { $_.Bounds.Right } | Measure-Object -Maximum).Maximum
$maxY = ($screens | ForEach-Object { $_.Bounds.Bottom } | Measure-Object -Maximum).Maximum
$monitors = @()
$i = 0
foreach ($s in $screens) {
  $i++
  $id = ($s.DeviceName -replace '^\\\\\\\\\\.\\\\', '')
  $b = $s.Bounds
  $w = $s.WorkingArea
  $monitors += [pscustomobject]@{
    id = $id
    index = $i
    deviceName = $s.DeviceName
    primary = $s.Primary
    bounds = [pscustomobject]@{ x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height; right = $b.Right; bottom = $b.Bottom }
    workingArea = [pscustomobject]@{ x = $w.X; y = $w.Y; width = $w.Width; height = $w.Height; right = $w.Right; bottom = $w.Bottom }
  }
}
[pscustomobject]@{
  dpiAware = $true
  coordinateSpace = 'physical-virtual-screen'
  virtualBounds = [pscustomobject]@{ x = $minX; y = $minY; width = ($maxX - $minX); height = ($maxY - $minY); right = $maxX; bottom = $maxY }
  monitors = $monitors
} | ConvertTo-Json -Depth 8
`);
}

type GridOpts = boolean | { step?: number; color?: string; labels?: 'virtual' | 'local' | 'none' | 'axis'; labelEvery?: number; cells?: number };
type MarkerOpts = { x: number; y: number; color?: string; size?: number; label?: string };
type SomBox = { x: number; y: number; width: number; height: number; label: string; color?: string };

function normalizeMarkers(input: MarkerOpts | MarkerOpts[] | undefined): Array<{ x: number; y: number; color: string; size: number; label: string }> {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : [input];
  return raw
    .filter(m => m && Number.isFinite(Number(m.x)) && Number.isFinite(Number(m.y)))
    .map(m => ({
      x: Math.round(Number(m.x)),
      y: Math.round(Number(m.y)),
      color: typeof m.color === 'string' ? m.color : '#FF7A33',
      size: Math.max(8, Math.min(120, Math.round(Number(m.size ?? 28)))),
      label: typeof m.label === 'string' ? m.label : `${Math.round(Number(m.x))},${Math.round(Number(m.y))}`,
    }));
}

function normalizeGrid(grid: GridOpts | undefined, bitmapW?: number, bitmapH?: number): { enabled: boolean; step: number; color: string; labels: string; labelEvery: number } {
  if (!grid) return { enabled: false, step: 50, color: '#7AC8FF', labels: 'virtual', labelEvery: 2 };
  if (grid === true) {
    // Default to VIRTUAL-screen coordinate labels (matches the documented
    // schema default labels:"virtual") so the numbers printed on the grid are
    // directly usable with desktop_click. Step 50px with labels every other
    // line keeps the overlay readable without flooding the image. Callers who
    // want the sparse chess-board indices can pass grid:{labels:"axis"}.
    return { enabled: true, step: 50, color: '#7AC8FF', labels: 'virtual', labelEvery: 2 };
  }
  // Auto-pick step from `cells` when provided
  let step: number;
  if (grid.cells && bitmapW && bitmapH) {
    const dim = Math.max(bitmapW, bitmapH);
    step = Math.max(10, Math.min(500, Math.round(dim / grid.cells)));
  } else if (grid.step !== undefined) {
    step = Math.max(10, Math.min(500, Math.round(Number(grid.step))));
  } else if (grid.labels === 'axis' && bitmapW && bitmapH) {
    const dim = Math.max(bitmapW, bitmapH);
    step = Math.max(20, Math.min(200, Math.round(dim / 16)));
  } else {
    step = 50;
  }
  const validLabels = ['local', 'none', 'axis', 'virtual'] as const;
  const labels = validLabels.includes(grid.labels as any) ? (grid.labels as string) : 'virtual';
  return {
    enabled: true,
    step,
    color: typeof grid.color === 'string' ? grid.color : (labels === 'axis' ? '#64DC8C' : '#7AC8FF'),
    labels,
    labelEvery: Math.max(1, Math.round(Number(grid.labelEvery ?? (labels === 'axis' ? 1 : 2)))),
  };
}

// PowerShell helper definition that draws a coord grid on top of a captured bitmap.
// Called as: Draw-Grid -Graphics $g -OriginX $rx -OriginY $ry -BitmapW $rw -BitmapH $rh
const DRAW_GRID_PS = `
function Draw-Grid {
  param($Graphics, [int]$OriginX, [int]$OriginY, [int]$BitmapW, [int]$BitmapH, [int]$Step, [string]$ColorHex, [string]$Labels, [int]$LabelEvery)
  if ($Step -lt 10) { $Step = 10 }
  $color = [System.Drawing.ColorTranslator]::FromHtml($ColorHex)
  $linePen   = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(110, $color.R, $color.G, $color.B)), 1
  $axisPen   = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(200, $color.R, $color.G, $color.B)), 1
  $Graphics.SmoothingMode = 'AntiAlias'
  $Graphics.TextRenderingHint = 'ClearTypeGridFit'

  # vertical lines
  $startX = ([Math]::Ceiling($OriginX / [double]$Step)) * $Step
  $i = 0
  for ($vx = $startX; $vx -lt ($OriginX + $BitmapW); $vx += $Step) {
    $px = $vx - $OriginX
    $useAxis = ($i % $LabelEvery -eq 0)
    if ($useAxis) { $Graphics.DrawLine($axisPen, $px, 0, $px, $BitmapH) }
    else { $Graphics.DrawLine($linePen, $px, 0, $px, $BitmapH) }
    $i++
  }
  $startY = ([Math]::Ceiling($OriginY / [double]$Step)) * $Step
  $j = 0
  for ($vy = $startY; $vy -lt ($OriginY + $BitmapH); $vy += $Step) {
    $py = $vy - $OriginY
    $useAxis = ($j % $LabelEvery -eq 0)
    if ($useAxis) { $Graphics.DrawLine($axisPen, 0, $py, $BitmapW, $py) }
    else { $Graphics.DrawLine($linePen, 0, $py, $BitmapW, $py) }
    $j++
  }

  if ($Labels -eq 'axis') {
    # Chess-board style: integer cell indices on TOP edge (cols) and LEFT
    # edge (rows) only. Pill backgrounds in the grid accent color so labels
    # stay readable when the chat UI downscales the screenshot.
    $pillBg   = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, $color.R, $color.G, $color.B))
    $pillFg   = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 20, 30, 30))
    # Font scaled with step so labels fit inside the pill at any zoom level
    $fontPt   = [Math]::Max(10, [Math]::Min(26, [Math]::Round($Step / 4.2)))
    $font     = New-Object System.Drawing.Font('Segoe UI', $fontPt, [System.Drawing.FontStyle]::Bold)
    $pillH    = $fontPt * 1.9
    $col = 1
    for ($vx = $OriginX; $vx -lt ($OriginX + $BitmapW); $vx += $Step) {
      $px = $vx - $OriginX
      $cellW = [Math]::Min($Step, ($OriginX + $BitmapW) - $vx)
      if ($cellW -lt ($Step * 0.55)) { $col++; continue }  # skip partial trailing cell
      $text = "$col"
      $size = $Graphics.MeasureString($text, $font)
      $pillW = [Math]::Max($size.Width + 12, $pillH)
      $pillX = $px + ($cellW / 2.0) - ($pillW / 2.0)
      $pillY = 4
      $rect = New-Object System.Drawing.RectangleF ([Single]$pillX, [Single]$pillY, [Single]$pillW, [Single]$pillH)
      $Graphics.FillRectangle($pillBg, $rect)
      $tx = $pillX + (($pillW - $size.Width) / 2.0)
      $ty = $pillY + (($pillH - $size.Height) / 2.0)
      $Graphics.DrawString($text, $font, $pillFg, [Single]$tx, [Single]$ty)
      $col++
    }
    $row = 1
    for ($vy = $OriginY; $vy -lt ($OriginY + $BitmapH); $vy += $Step) {
      $py = $vy - $OriginY
      $cellH = [Math]::Min($Step, ($OriginY + $BitmapH) - $vy)
      if ($cellH -lt ($Step * 0.55)) { $row++; continue }
      $text = "$row"
      $size = $Graphics.MeasureString($text, $font)
      $pillW = [Math]::Max($size.Width + 12, $pillH)
      $pillX = 4
      $pillY = $py + ($cellH / 2.0) - ($pillH / 2.0)
      $rect = New-Object System.Drawing.RectangleF ([Single]$pillX, [Single]$pillY, [Single]$pillW, [Single]$pillH)
      $Graphics.FillRectangle($pillBg, $rect)
      $tx = $pillX + (($pillW - $size.Width) / 2.0)
      $ty = $pillY + (($pillH - $size.Height) / 2.0)
      $Graphics.DrawString($text, $font, $pillFg, [Single]$tx, [Single]$ty)
      $row++
    }
    $pillBg.Dispose(); $pillFg.Dispose(); $font.Dispose()
  } elseif ($Labels -ne 'none') {
    $labelBg   = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(180, 0, 0, 0))
    $labelFg   = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, $color.R, $color.G, $color.B))
    $font      = New-Object System.Drawing.Font('Consolas', 12, [System.Drawing.FontStyle]::Bold)
    $iy = 0
    for ($vy = $startY; $vy -lt ($OriginY + $BitmapH); $vy += $Step) {
      $py = $vy - $OriginY
      if ($iy % $LabelEvery -ne 0) { $iy++; continue }
      $ix = 0
      for ($vx = $startX; $vx -lt ($OriginX + $BitmapW); $vx += $Step) {
        $px = $vx - $OriginX
        if ($ix % $LabelEvery -ne 0) { $ix++; continue }
        $vxShow = $vx; $vyShow = $vy
        if ($Labels -eq 'local') { $vxShow = ($vx - $OriginX); $vyShow = ($vy - $OriginY) }
        $text = "$vxShow,$vyShow"
        $size = $Graphics.MeasureString($text, $font)
        $bgRect = New-Object System.Drawing.RectangleF (($px + 3), ($py + 2), ($size.Width + 6), ($size.Height + 1))
        $Graphics.FillRectangle($labelBg, $bgRect)
        $Graphics.DrawString($text, $font, $labelFg, ($px + 6), ($py + 2))
        $ix++
      }
      $iy++
    }
    $labelBg.Dispose(); $labelFg.Dispose(); $font.Dispose()
  }
  $linePen.Dispose(); $axisPen.Dispose()
}
`;

// PowerShell helper that draws crosshair markers at supplied points after
// CopyFromScreen (and after Draw-Grid if a grid is enabled). Used by the
// "verify before clicking" pattern: agent picks coords from the grid, asks
// for the same screenshot with marker={x,y}, sees if the marker lands on
// their target before committing the click.
const DRAW_MARKER_PS = `
function Draw-Marker {
  param($Graphics, [int]$OriginX, [int]$OriginY, [int]$BitmapW, [int]$BitmapH, [int]$MX, [int]$MY, [string]$ColorHex, [int]$Size, [string]$Label)
  $px = $MX - $OriginX
  $py = $MY - $OriginY
  if ($px -lt 0 -or $py -lt 0 -or $px -ge $BitmapW -or $py -ge $BitmapH) { return }
  $color = [System.Drawing.ColorTranslator]::FromHtml($ColorHex)
  $solid = New-Object System.Drawing.Pen ($color), 3
  $halo  = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 0, 0, 0)), 5
  $fill  = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(110, $color.R, $color.G, $color.B))
  $labelBg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 0, 0, 0))
  $labelFg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, $color.R, $color.G, $color.B))
  $font  = New-Object System.Drawing.Font('Consolas', 10, [System.Drawing.FontStyle]::Bold)
  $Graphics.SmoothingMode = 'AntiAlias'
  $r = [int]($Size / 2)
  # Halo crosshair (black, wider) then bright crosshair on top
  $Graphics.DrawLine($halo,   ($px - $r - 4), $py, ($px + $r + 4), $py)
  $Graphics.DrawLine($halo,   $px, ($py - $r - 4), $px, ($py + $r + 4))
  $Graphics.DrawLine($solid,  ($px - $r - 4), $py, ($px + $r + 4), $py)
  $Graphics.DrawLine($solid,  $px, ($py - $r - 4), $px, ($py + $r + 4))
  # Filled translucent circle to show target zone, with bright outline
  $rect = New-Object System.Drawing.Rectangle (($px - $r), ($py - $r), $Size, $Size)
  $Graphics.FillEllipse($fill, $rect)
  $Graphics.DrawEllipse($solid, $rect)
  # 1px center dot so the exact pixel is unmissable
  $Graphics.FillRectangle((New-Object System.Drawing.SolidBrush ($color)), $px, $py, 1, 1)
  # Label chip just below-right of marker
  if ($Label) {
    $lblSize = $Graphics.MeasureString($Label, $font)
    $lx = $px + $r + 6
    $ly = $py + $r + 6
    if (($lx + $lblSize.Width + 6) -gt $BitmapW) { $lx = $px - $r - $lblSize.Width - 6 }
    if (($ly + $lblSize.Height + 4) -gt $BitmapH) { $ly = $py - $r - $lblSize.Height - 6 }
    $bgRect = New-Object System.Drawing.RectangleF -ArgumentList @([Single]$lx, [Single]$ly, [Single]($lblSize.Width + 8), [Single]($lblSize.Height + 4))
    $Graphics.FillRectangle($labelBg, $bgRect)
    $Graphics.DrawString($Label, $font, $labelFg, ($lx + 4), $ly + 2)
  }
  $solid.Dispose(); $halo.Dispose(); $fill.Dispose(); $labelBg.Dispose(); $labelFg.Dispose(); $font.Dispose()
}
`;

// PowerShell helper that draws Set-of-Mark labeled boxes on top of a capture.
// One box per element: colored rectangle + numbered pill at the top-left
// corner. The pill is the ref id (e.g. "12") so an agent can read the image
// at chat resolution and say "click 12" without any pixel arithmetic.
// Same pattern as Microsoft's SoM prompting / OmniParser overlays.
const DRAW_SOM_PS = `
function Draw-SomBox {
  param($Graphics, [int]$OriginX, [int]$OriginY, [int]$BitmapW, [int]$BitmapH, [int]$BX, [int]$BY, [int]$BW, [int]$BH, [string]$Label, [string]$ColorHex)
  $px = $BX - $OriginX
  $py = $BY - $OriginY
  if ($px + $BW -le 0 -or $py + $BH -le 0 -or $px -ge $BitmapW -or $py -ge $BitmapH) { return }
  # Clip to bitmap
  $clipX = [Math]::Max(0, $px)
  $clipY = [Math]::Max(0, $py)
  $clipR = [Math]::Min($BitmapW, $px + $BW)
  $clipB = [Math]::Min($BitmapH, $py + $BH)
  $cw = $clipR - $clipX
  $ch = $clipB - $clipY
  if ($cw -le 1 -or $ch -le 1) { return }
  $color = [System.Drawing.ColorTranslator]::FromHtml($ColorHex)
  $boxPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(220, $color.R, $color.G, $color.B)), 2
  $pillBg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, $color.R, $color.G, $color.B))
  $pillFg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 12, 18, 18))
  $font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
  $Graphics.SmoothingMode = 'AntiAlias'
  $Graphics.TextRenderingHint = 'ClearTypeGridFit'
  $Graphics.DrawRectangle($boxPen, $clipX, $clipY, $cw, $ch)
  $size = $Graphics.MeasureString($Label, $font)
  $pillW = [Math]::Max($size.Width + 10, 22)
  $pillH = $size.Height + 4
  $pillX = $clipX
  $pillY = $clipY
  # Tuck pill inside the box top-left; if box is tiny, hang above
  if ($pillH -gt $ch -or $pillW -gt $cw) { $pillY = [Math]::Max(0, $clipY - $pillH - 1) }
  $pillRect = New-Object System.Drawing.RectangleF ([Single]$pillX, [Single]$pillY, [Single]$pillW, [Single]$pillH)
  $Graphics.FillRectangle($pillBg, $pillRect)
  $Graphics.DrawString($Label, $font, $pillFg, [Single]($pillX + 5), [Single]($pillY + 2))
  $boxPen.Dispose(); $pillBg.Dispose(); $pillFg.Dispose(); $font.Dispose()
}
`;

async function takeDesktopScreenshot(
  monitor: string = 'all',
  region?: { x: number; y: number; width: number; height: number },
  gridOpts?: GridOpts,
  markerInput?: MarkerOpts | MarkerOpts[],
  somBoxes?: SomBox[],
): Promise<any> {
  const outDir = join(FEEDBACK_DIR, 'desktop');
  mkdirSync(outDir, { recursive: true });
  const stamp = Date.now().toString();
  const grid = normalizeGrid(gridOpts, region?.width, region?.height);
  const markers = normalizeMarkers(markerInput);
  const soms = Array.isArray(somBoxes) ? somBoxes : [];
  const gridSetup = grid.enabled
    ? `${DRAW_GRID_PS}\n$GRID_STEP=[int]${grid.step}\n$GRID_COLOR=${psString(grid.color)}\n$GRID_LABELS=${psString(grid.labels)}\n$GRID_LABEL_EVERY=[int]${grid.labelEvery}`
    : '';
  const markerSetup = markers.length ? DRAW_MARKER_PS : '';
  const somSetup = soms.length ? DRAW_SOM_PS : '';
  const drawGridCall = (originXVar: string, originYVar: string, bmpWVar: string, bmpHVar: string) =>
    grid.enabled
      ? `Draw-Grid -Graphics $g -OriginX ${originXVar} -OriginY ${originYVar} -BitmapW ${bmpWVar} -BitmapH ${bmpHVar} -Step $GRID_STEP -ColorHex $GRID_COLOR -Labels $GRID_LABELS -LabelEvery $GRID_LABEL_EVERY`
      : '';
  const drawMarkerCalls = (originXVar: string, originYVar: string, bmpWVar: string, bmpHVar: string) =>
    markers.map(m =>
      `Draw-Marker -Graphics $g -OriginX ${originXVar} -OriginY ${originYVar} -BitmapW ${bmpWVar} -BitmapH ${bmpHVar} -MX ${m.x} -MY ${m.y} -ColorHex ${psString(m.color)} -Size ${m.size} -Label ${psString(m.label)}`
    ).join('\n  ');
  const drawSomCalls = (originXVar: string, originYVar: string, bmpWVar: string, bmpHVar: string) =>
    soms.map(b =>
      `Draw-SomBox -Graphics $g -OriginX ${originXVar} -OriginY ${originYVar} -BitmapW ${bmpWVar} -BitmapH ${bmpHVar} -BX ${b.x} -BY ${b.y} -BW ${b.width} -BH ${b.height} -Label ${psString(b.label)} -ColorHex ${psString(b.color || '#FFCC33')}`
    ).join('\n  ');

  if (region) {
    const rx = Math.round(Number(region.x));
    const ry = Math.round(Number(region.y));
    const rw = Math.round(Number(region.width));
    const rh = Math.round(Number(region.height));
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rw) || !Number.isFinite(rh) || rw <= 0 || rh <= 0) {
      throw new Error('desktop_screenshot region requires numeric x, y, width>0, height>0');
    }
    return runPowerShellJson(`${desktopPreamble()}
${gridSetup}
${markerSetup}
${somSetup}
$outDir = ${psString(outDir)}
$stamp = ${psString(stamp)}
$rx = [int]${rx}
$ry = [int]${ry}
$rw = [int]${rw}
$rh = [int]${rh}
$suffix = if (${grid.enabled ? '$true' : '$false'}) { '-grid' } else { '' }
if (${markers.length ? '$true' : '$false'}) { $suffix = "$suffix-mark" }
if (${soms.length ? '$true' : '$false'}) { $suffix = "$suffix-som" }
$path = Join-Path $outDir ("desktop-$stamp-region-${rx}x${ry}-${rw}x${rh}$suffix.png")
$bmp = New-Object System.Drawing.Bitmap -ArgumentList @($rw, $rh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($rx, $ry, 0, 0, $bmp.Size)
  ${drawGridCall('$rx', '$ry', '$rw', '$rh')}
  ${drawMarkerCalls('$rx', '$ry', '$rw', '$rh')}
  ${drawSomCalls('$rx', '$ry', '$rw', '$rh')}
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $g.Dispose()
  $bmp.Dispose()
}
[pscustomobject]@{
  dpiAware = $true
  coordinateSpace = 'physical-virtual-screen'
  monitor = 'region'
  stitchedPath = $null
  grid = ${grid.enabled ? `[pscustomobject]@{ step=$GRID_STEP; color=$GRID_COLOR; labels=$GRID_LABELS; labelEvery=$GRID_LABEL_EVERY }` : '$null'}
  region = [pscustomobject]@{ x=$rx; y=$ry; width=$rw; height=$rh }
  captures = @([pscustomobject]@{
    id = 'region'
    deviceName = 'region'
    primary = $false
    path = $path
    bounds = [pscustomobject]@{ x=$rx; y=$ry; width=$rw; height=$rh; right=($rx+$rw); bottom=($ry+$rh) }
  })
} | ConvertTo-Json -Depth 8
`);
  }

  // Marker calls embedded as a literal block — Save-Screen invokes them.
  // We can't pass the dynamic marker list into a PS function with a clean
  // signature, so emit them as a parameterless helper that closes over the
  // screen vars.
  const monitorMarkerBlock = markers.map(m =>
    `Draw-Marker -Graphics $g -OriginX $b.Left -OriginY $b.Top -BitmapW $captureWidth -BitmapH $captureHeight -MX ${m.x} -MY ${m.y} -ColorHex ${psString(m.color)} -Size ${m.size} -Label ${psString(m.label)}`
  ).join('\n      ');
  return runPowerShellJson(`${desktopPreamble()}
${gridSetup}
${markerSetup}
$outDir = ${psString(outDir)}
$stamp = ${psString(stamp)}
$wanted = ${psString(monitor || 'all')}
$gridSuffix = if (${grid.enabled ? '$true' : '$false'}) { '-grid' } else { '' }
$markSuffix = if (${markers.length ? '$true' : '$false'}) { '-mark' } else { '' }
$screens = [System.Windows.Forms.Screen]::AllScreens
function Save-Screen($screen, $path, [bool]$WithGrid, [bool]$WithMarkers) {
  $b = $screen.Bounds
  $captureWidth = [int]$b.Width
  $captureHeight = [int]$b.Height
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList @($captureWidth, $captureHeight)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    if ($WithGrid) {
      Draw-Grid -Graphics $g -OriginX $b.Left -OriginY $b.Top -BitmapW $captureWidth -BitmapH $captureHeight -Step $GRID_STEP -ColorHex $GRID_COLOR -Labels $GRID_LABELS -LabelEvery $GRID_LABEL_EVERY
    }
    if ($WithMarkers) {
      ${monitorMarkerBlock}
    }
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $g.Dispose()
    $bmp.Dispose()
  }
}
$captured = @()
foreach ($s in $screens) {
  $id = ($s.DeviceName -replace '^\\\\\\\\\\.\\\\', '')
  $match = $wanted -eq 'all' -or $wanted -eq $id -or $wanted -eq $s.DeviceName -or ($wanted -eq 'primary' -and $s.Primary)
  if (-not $match) { continue }
  $path = Join-Path $outDir ("desktop-$stamp-$id$gridSuffix$markSuffix.png")
  Save-Screen $s $path $${grid.enabled ? 'true' : 'false'} $${markers.length ? 'true' : 'false'}
  $b = $s.Bounds
  $captured += [pscustomobject]@{
    id = $id
    deviceName = $s.DeviceName
    primary = $s.Primary
    path = $path
    bounds = [pscustomobject]@{ x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height; right = $b.Right; bottom = $b.Bottom }
  }
}
$stitchedPath = $null
if ($wanted -eq 'all') {
  $minX = ($screens | ForEach-Object { $_.Bounds.Left } | Measure-Object -Minimum).Minimum
  $minY = ($screens | ForEach-Object { $_.Bounds.Top } | Measure-Object -Minimum).Minimum
  $maxX = ($screens | ForEach-Object { $_.Bounds.Right } | Measure-Object -Maximum).Maximum
  $maxY = ($screens | ForEach-Object { $_.Bounds.Bottom } | Measure-Object -Maximum).Maximum
  $stitchedWidth = [int]($maxX - $minX)
  $stitchedHeight = [int]($maxY - $minY)
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList @($stitchedWidth, $stitchedHeight)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($minX, $minY, 0, 0, $bmp.Size)
    ${drawGridCall('$minX', '$minY', '$stitchedWidth', '$stitchedHeight')}
    ${drawMarkerCalls('$minX', '$minY', '$stitchedWidth', '$stitchedHeight')}
    $stitchedPath = Join-Path $outDir ("desktop-$stamp-all$gridSuffix$markSuffix.png")
    $bmp.Save($stitchedPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $g.Dispose()
    $bmp.Dispose()
  }
}
[pscustomobject]@{
  dpiAware = $true
  coordinateSpace = 'physical-virtual-screen'
  monitor = $wanted
  stitchedPath = $stitchedPath
  grid = ${grid.enabled ? `[pscustomobject]@{ step=$GRID_STEP; color=$GRID_COLOR; labels=$GRID_LABELS; labelEvery=$GRID_LABEL_EVERY }` : '$null'}
  captures = $captured
} | ConvertTo-Json -Depth 8
`);
}

async function desktopClick(cmd: BridgeCommand): Promise<any> {
  const xRaw = Number(cmd.x);
  const yRaw = Number(cmd.y);
  if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) throw new Error('desktop_click requires numeric x and y');
  const monitor = cmd.monitor || '';
  let space = cmd.space || (monitor ? 'monitor' : 'desktop');
  let preX = xRaw, preY = yRaw;
  // 'focus' is resolved here in TS (add focus origin then treat as absolute).
  // 'monitor' is still resolved inside the PS body so the existing path stays
  // intact — passing space='focus' to PS would be unrecognized.
  if (String(space).toLowerCase() === 'focus') {
    const sp = resolveSpaceXY(xRaw, yRaw, 'focus');
    preX = sp.x; preY = sp.y;
    space = 'desktop';
  }
  // Apply persisted calibration offset for absolute desktop-space clicks only
  // (monitor-relative clicks get translated to absolute below, but the offset
  // was captured in absolute space so applying it here is correct either way).
  const skipCal = (cmd as any).noCalibration === true;
  const calibrated = skipCal ? { x: preX, y: preY, applied: false } : applyCalibrationOffset(preX, preY);
  const x = calibrated.x;
  const y = calibrated.y;
  const button = cmd.button || 'left';
  const double = !!cmd.double;
  const clickResult = await runPowerShellJson(`${desktopPreamble()}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3DesktopMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@
$x = [int]${Math.round(x)}
$y = [int]${Math.round(y)}
$monitor = ${psString(monitor)}
$space = ${psString(space)}
$button = ${psString(button)}
$double = ${double ? '$true' : '$false'}
$screens = [System.Windows.Forms.Screen]::AllScreens
$target = $null
if ($monitor) {
  foreach ($s in $screens) {
    $id = ($s.DeviceName -replace '^\\\\\\\\\\.\\\\', '')
    if ($monitor -eq $id -or $monitor -eq $s.DeviceName -or ($monitor -eq 'primary' -and $s.Primary)) { $target = $s; break }
  }
  if ($null -eq $target) { throw "Monitor not found: $monitor" }
  if ($space -eq 'monitor') {
    $x = $target.Bounds.Left + $x
    $y = $target.Bounds.Top + $y
  }
}
$down = 0x0002; $up = 0x0004
if ($button -eq 'right') { $down = 0x0008; $up = 0x0010 }
elseif ($button -eq 'middle') { $down = 0x0020; $up = 0x0040 }
function ClickOnce([int]$cx, [int]$cy) {
  [Empir3DesktopMouse]::SetCursorPos($cx, $cy) | Out-Null
  Start-Sleep -Milliseconds 80
  [Empir3DesktopMouse]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
  [Empir3DesktopMouse]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
}
ClickOnce $x $y
if ($double) {
  Start-Sleep -Milliseconds 130
  ClickOnce $x $y
}
$pos = [System.Windows.Forms.Cursor]::Position
# Which monitor did the click land on? Used to flag uncalibrated monitors.
$clickScreen = $null
try { $cs = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point([int]$x, [int]$y))); $clickScreen = ($cs.DeviceName -replace '^\\\\\\\\\\.\\\\', '') } catch {}

# UIA hit-test: identify the element that was clicked so callers can
# verify they hit something interactive vs. clicked dead space. Walks
# up the parent chain to find the nearest interactive ancestor when the
# direct hit is a plain container. Returns null for CEF/Electron apps
# whose renderer doesn't expose elements to UIA.
$hitInfo = $null
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  Add-Type -AssemblyName WindowsBase -ErrorAction Stop
  $pt = New-Object System.Windows.Point ([double]$x, [double]$y)
  $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
  if ($el) {
    $INTERACTIVE_TYPES = @(
      [System.Windows.Automation.ControlType]::Button,
      [System.Windows.Automation.ControlType]::MenuItem,
      [System.Windows.Automation.ControlType]::Hyperlink,
      [System.Windows.Automation.ControlType]::Edit,
      [System.Windows.Automation.ControlType]::ListItem,
      [System.Windows.Automation.ControlType]::TabItem,
      [System.Windows.Automation.ControlType]::CheckBox,
      [System.Windows.Automation.ControlType]::RadioButton,
      [System.Windows.Automation.ControlType]::ComboBox,
      [System.Windows.Automation.ControlType]::TreeItem,
      [System.Windows.Automation.ControlType]::SplitButton,
      [System.Windows.Automation.ControlType]::Slider,
      [System.Windows.Automation.ControlType]::Spinner
    )
    $cur = $el
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $depth = 0
    $interactive = $null
    while ($cur -ne $null -and $depth -lt 8) {
      try { if ($INTERACTIVE_TYPES -contains $cur.Current.ControlType) { $interactive = $cur; break } } catch {}
      try { $cur = $walker.GetParent($cur) } catch { break }
      $depth++
    }
    $describe = {
      param($node)
      try {
        $rect = $node.Current.BoundingRectangle
        $name = $node.Current.Name
        if ([string]::IsNullOrWhiteSpace($name)) { $name = $node.Current.AutomationId }
        $role = $node.Current.ControlType.ProgrammaticName -replace '^ControlType\\.',''
        [pscustomobject]@{
          role = $role
          name = ($name -as [string])
          automationId = ($node.Current.AutomationId -as [string])
          bounds = [pscustomobject]@{ x=[int]$rect.X; y=[int]$rect.Y; width=[int]$rect.Width; height=[int]$rect.Height; cx=[int]($rect.X + $rect.Width/2); cy=[int]($rect.Y + $rect.Height/2) }
        }
      } catch { return $null }
    }
    $direct = & $describe $el
    $nearestInteractive = if ($interactive -ne $null) { & $describe $interactive } else { $null }
    $hitInfo = [pscustomobject]@{
      direct = $direct
      nearestInteractive = $nearestInteractive
      onInteractive = ($interactive -ne $null)
      distanceFromCenter = if ($interactive -ne $null) {
        $b = $interactive.Current.BoundingRectangle
        [int][Math]::Sqrt([Math]::Pow($x - ($b.X + $b.Width/2), 2) + [Math]::Pow($y - ($b.Y + $b.Height/2), 2))
      } else { $null }
    }
  }
} catch { $hitInfo = [pscustomobject]@{ error = $_.Exception.Message } }

[pscustomobject]@{
  clicked = [pscustomobject]@{ x = $x; y = $y; button = $button; double = $double }
  input = [pscustomobject]@{ x = ${Math.round(x)}; y = ${Math.round(y)}; monitor = $monitor; space = $space }
  cursor = [pscustomobject]@{ x = $pos.X; y = $pos.Y }
  hit = $hitInfo
  monitorAtPoint = $clickScreen
  coordinateSpace = 'physical-virtual-screen'
} | ConvertTo-Json -Depth 8
`);

  // Nudge: if the click landed on a monitor with no saved click calibration
  // (while OTHER monitors are calibrated), surface a hint so the agent can ask
  // the user to calibrate it. Pure annotation — never changes the click.
  try {
    const monId = clickResult?.monitorAtPoint;
    if (monId && !calibrated.applied) {
      const cal: any = (readBridgeSettings() as any)?.desktopCalibration;
      if (cal?.version === 2 && cal.monitors) {
        const calibratedIds = Object.keys(cal.monitors);
        if (calibratedIds.length > 0 && !calibratedIds.includes(monId)) {
          clickResult.calibrationHint = `${monId} has no saved click calibration (calibrated: ${calibratedIds.join(', ')}). Clicks here can be a few px off — run desktop_calibrate_pointer with this monitor active for sub-pixel accuracy.`;
        }
      }
    }
  } catch {}

  return clickResult;
}

// ─── Ensure dirs ─────────────────────────────────────────────

async function desktopHover(cmd: BridgeCommand): Promise<any> {
  const xRaw = Number(cmd.x);
  const yRaw = Number(cmd.y);
  if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) throw new Error('desktop_hover requires numeric x and y');
  const monitor = cmd.monitor || '';
  let space = cmd.space || (monitor ? 'monitor' : 'desktop');
  let x = xRaw, y = yRaw;
  if (String(space).toLowerCase() === 'focus') {
    const sp = resolveSpaceXY(xRaw, yRaw, 'focus');
    x = sp.x; y = sp.y; space = 'desktop';
  }
  return runPowerShellJson(`${desktopPreamble()}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3DesktopMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
}
"@
$x = [int]${Math.round(x)}
$y = [int]${Math.round(y)}
$monitor = ${psString(monitor)}
$space = ${psString(space)}
$screens = [System.Windows.Forms.Screen]::AllScreens
$target = $null
if ($monitor) {
  foreach ($s in $screens) {
    $id = ($s.DeviceName -replace '^\\\\\\\\\\.\\\\', '')
    if ($monitor -eq $id -or $monitor -eq $s.DeviceName -or ($monitor -eq 'primary' -and $s.Primary)) { $target = $s; break }
  }
  if ($null -eq $target) { throw "Monitor not found: $monitor" }
  if ($space -eq 'monitor') {
    $x = $target.Bounds.Left + $x
    $y = $target.Bounds.Top + $y
  }
}
[Empir3DesktopMouse]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 80
$pos = [System.Windows.Forms.Cursor]::Position
[pscustomobject]@{
  moved = [pscustomobject]@{ x = $x; y = $y }
  input = [pscustomobject]@{ x = ${Math.round(x)}; y = ${Math.round(y)}; monitor = $monitor; space = $space }
  cursor = [pscustomobject]@{ x = $pos.X; y = $pos.Y }
  coordinateSpace = 'physical-virtual-screen'
} | ConvertTo-Json -Depth 5
`);
}

async function desktopDrag(cmd: BridgeCommand): Promise<any> {
  const xRaw = Number(cmd.x);
  const yRaw = Number(cmd.y);
  const toXRaw = Number(cmd.toX);
  const toYRaw = Number(cmd.toY);
  if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw) || !Number.isFinite(toXRaw) || !Number.isFinite(toYRaw)) {
    throw new Error('desktop_drag requires numeric x, y, toX, and toY');
  }
  const monitor = cmd.monitor || '';
  let space = cmd.space || (monitor ? 'monitor' : 'desktop');
  let x = xRaw, y = yRaw, toX = toXRaw, toY = toYRaw;
  if (String(space).toLowerCase() === 'focus') {
    const a = resolveSpaceXY(xRaw, yRaw, 'focus');
    const b = resolveSpaceXY(toXRaw, toYRaw, 'focus');
    x = a.x; y = a.y; toX = b.x; toY = b.y; space = 'desktop';
  }
  const button = cmd.button || 'left';
  const durationMs = Math.max(0, Math.min(10000, Math.round(Number(cmd.durationMs ?? 500))));
  const steps = Math.max(1, Math.min(200, Math.round(Number(cmd.steps ?? 24))));
  return runPowerShellJson(`${desktopPreamble()}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3DesktopMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@
$x1 = [int]${Math.round(x)}
$y1 = [int]${Math.round(y)}
$x2 = [int]${Math.round(toX)}
$y2 = [int]${Math.round(toY)}
$monitor = ${psString(monitor)}
$space = ${psString(space)}
$button = ${psString(button)}
$durationMs = [int]${durationMs}
$steps = [int]${steps}
$screens = [System.Windows.Forms.Screen]::AllScreens
$target = $null
if ($monitor) {
  foreach ($s in $screens) {
    $id = ($s.DeviceName -replace '^\\\\\\\\\\.\\\\', '')
    if ($monitor -eq $id -or $monitor -eq $s.DeviceName -or ($monitor -eq 'primary' -and $s.Primary)) { $target = $s; break }
  }
  if ($null -eq $target) { throw "Monitor not found: $monitor" }
  if ($space -eq 'monitor') {
    $x1 = $target.Bounds.Left + $x1
    $y1 = $target.Bounds.Top + $y1
    $x2 = $target.Bounds.Left + $x2
    $y2 = $target.Bounds.Top + $y2
  }
}
$down = 0x0002; $up = 0x0004
if ($button -eq 'right') { $down = 0x0008; $up = 0x0010 }
elseif ($button -eq 'middle') { $down = 0x0020; $up = 0x0040 }
$sleep = if ($steps -gt 0) { [Math]::Max(1, [int]($durationMs / $steps)) } else { 1 }
[Empir3DesktopMouse]::SetCursorPos($x1, $y1) | Out-Null
Start-Sleep -Milliseconds 80
[Empir3DesktopMouse]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
for ($i = 1; $i -le $steps; $i++) {
  $nx = [int][Math]::Round($x1 + (($x2 - $x1) * $i / $steps))
  $ny = [int][Math]::Round($y1 + (($y2 - $y1) * $i / $steps))
  [Empir3DesktopMouse]::SetCursorPos($nx, $ny) | Out-Null
  Start-Sleep -Milliseconds $sleep
}
[Empir3DesktopMouse]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
$pos = [System.Windows.Forms.Cursor]::Position
[pscustomobject]@{
  dragged = [pscustomobject]@{ from = [pscustomobject]@{ x = $x1; y = $y1 }; to = [pscustomobject]@{ x = $x2; y = $y2 }; button = $button; durationMs = $durationMs; steps = $steps }
  input = [pscustomobject]@{ x = ${Math.round(x)}; y = ${Math.round(y)}; toX = ${Math.round(toX)}; toY = ${Math.round(toY)}; monitor = $monitor; space = $space }
  cursor = [pscustomobject]@{ x = $pos.X; y = $pos.Y }
  coordinateSpace = 'physical-virtual-screen'
} | ConvertTo-Json -Depth 6
`);
}

// ─── Desktop snapshot (UI Automation) ────────────────────────

type DesktopRefEntry = {
  snapshotId: string;
  ref: string;
  role: string;
  name: string;
  automationId?: string;
  bounds: { x: number; y: number; width: number; height: number; cx: number; cy: number };
  window: { title: string; pid: number; processName: string };
};

const desktopRefCache = new Map<string, DesktopRefEntry>();
let lastDesktopSnapshotId: string | null = null;

async function getDesktopSnapshot(cmd: BridgeCommand): Promise<any> {
  const scope = (cmd as any).scope === 'all-windows' ? 'all-windows' : 'foreground';
  const maxEmit = Math.max(20, Math.min(500, Math.round(Number((cmd as any).maxElements ?? 200))));
  const maxVisited = Math.max(maxEmit * 5, 2000);
  const result = await runPowerShellJson(`${desktopPreamble()}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3DesktopUia {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$scope = ${psString(scope)}
$maxEmit = [int]${maxEmit}
$maxVisited = [int]${maxVisited}

$INTERACTIVE = @(
  [System.Windows.Automation.ControlType]::Button,
  [System.Windows.Automation.ControlType]::MenuItem,
  [System.Windows.Automation.ControlType]::Hyperlink,
  [System.Windows.Automation.ControlType]::Edit,
  [System.Windows.Automation.ControlType]::ListItem,
  [System.Windows.Automation.ControlType]::TabItem,
  [System.Windows.Automation.ControlType]::CheckBox,
  [System.Windows.Automation.ControlType]::RadioButton,
  [System.Windows.Automation.ControlType]::ComboBox,
  [System.Windows.Automation.ControlType]::TreeItem,
  [System.Windows.Automation.ControlType]::SplitButton,
  [System.Windows.Automation.ControlType]::DataItem,
  [System.Windows.Automation.ControlType]::Slider,
  [System.Windows.Automation.ControlType]::Spinner
)

function Get-WindowInfo($win) {
  try {
    $rect = $win.Current.BoundingRectangle
    $proc = $null
    try { $proc = [System.Diagnostics.Process]::GetProcessById($win.Current.ProcessId) } catch {}
    $procName = 'unknown'
    if ($proc) { $procName = $proc.ProcessName }
    return [pscustomobject]@{
      title = ($win.Current.Name -as [string])
      pid = [int]$win.Current.ProcessId
      processName = $procName
      bounds = [pscustomobject]@{ x=[int]$rect.X; y=[int]$rect.Y; width=[int]$rect.Width; height=[int]$rect.Height }
    }
  } catch { return $null }
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

# Collect candidate top-level windows
$topWindows = @()
$child = $walker.GetFirstChild($root)
while ($child -ne $null) {
  try {
    $rect = $child.Current.BoundingRectangle
    if ($rect.Width -gt 50 -and $rect.Height -gt 50 -and -not $rect.IsEmpty -and -not $child.Current.IsOffscreen) {
      $topWindows += $child
    }
  } catch {}
  $child = $walker.GetNextSibling($child)
}

$targetWindows = @()
if ($scope -eq 'all-windows') {
  $targetWindows = $topWindows
} else {
  $fgHwnd = [Empir3DesktopUia]::GetForegroundWindow()
  $pidOut = 0
  [Empir3DesktopUia]::GetWindowThreadProcessId($fgHwnd, [ref]$pidOut) | Out-Null
  $fg = $topWindows | Where-Object { $_.Current.ProcessId -eq $pidOut } | Select-Object -First 1
  if ($fg) { $targetWindows = @($fg) } elseif ($topWindows.Count -gt 0) { $targetWindows = @($topWindows[0]) }
}

$elements = @()
$windowInfos = @()
$counter = 0
$visited = 0
$snapshotId = [Guid]::NewGuid().ToString('N')

foreach ($win in $targetWindows) {
  if ($counter -ge $maxEmit -or $visited -ge $maxVisited) { break }
  $winInfo = Get-WindowInfo $win
  if ($winInfo -ne $null) { $windowInfos += $winInfo }

  $queue = New-Object System.Collections.Generic.Queue[object]
  $queue.Enqueue($win)
  while ($queue.Count -gt 0 -and $visited -lt $maxVisited -and $counter -lt $maxEmit) {
    $node = $queue.Dequeue()
    $visited++
    try {
      $ct = $node.Current.ControlType
      $rect = $node.Current.BoundingRectangle
      if (-not $node.Current.IsOffscreen -and $node.Current.IsEnabled -and -not $rect.IsEmpty -and $rect.Width -ge 6 -and $rect.Height -ge 6) {
        if ($INTERACTIVE -contains $ct) {
          $name = $node.Current.Name
          if ([string]::IsNullOrWhiteSpace($name)) { $name = $node.Current.AutomationId }
          if ([string]::IsNullOrWhiteSpace($name)) { $name = $node.Current.HelpText }
          $role = $ct.ProgrammaticName -replace '^ControlType\\.',''
          $elements += [pscustomobject]@{
            ref = "d$counter"
            role = $role
            name = ($name -as [string])
            automationId = ($node.Current.AutomationId -as [string])
            window = [pscustomobject]@{ title = $winInfo.title; pid = $winInfo.pid; processName = $winInfo.processName }
            bounds = [pscustomobject]@{
              x = [int]$rect.X; y = [int]$rect.Y
              width = [int]$rect.Width; height = [int]$rect.Height
              cx = [int]($rect.X + $rect.Width / 2)
              cy = [int]($rect.Y + $rect.Height / 2)
            }
          }
          $counter++
        }
      }
    } catch { continue }
    try {
      $kid = $walker.GetFirstChild($node)
      while ($kid -ne $null -and $queue.Count -lt 8000) {
        $queue.Enqueue($kid)
        $kid = $walker.GetNextSibling($kid)
      }
    } catch {}
  }
}

[pscustomobject]@{
  snapshotId = $snapshotId
  scope = $scope
  coordinateSpace = 'physical-virtual-screen'
  windows = $windowInfos
  elementsVisited = $visited
  elementCount = $elements.Count
  capped = ($counter -ge $maxEmit)
  elements = $elements
} | ConvertTo-Json -Depth 8 -Compress
`, 20000);

  desktopRefCache.clear();
  lastDesktopSnapshotId = result?.snapshotId || null;
  if (Array.isArray(result?.elements)) {
    for (const el of result.elements) {
      desktopRefCache.set(el.ref, {
        snapshotId: result.snapshotId,
        ref: el.ref,
        role: el.role,
        name: el.name,
        automationId: el.automationId,
        bounds: el.bounds,
        window: el.window,
      });
    }
  }
  // Best-effort: write the snapshot to a temp file so the overlay process can render boxes.
  try {
    const snapDir = join(FEEDBACK_DIR, 'desktop');
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(join(snapDir, 'last-snapshot.json'), JSON.stringify(result), 'utf-8');
  } catch {}
  return result;
}

function resolveDesktopRef(ref: string): DesktopRefEntry {
  if (!ref || typeof ref !== 'string') throw new Error('desktop ref required (e.g. "d3")');
  const entry = desktopRefCache.get(ref);
  if (!entry) {
    if (desktopRefCache.size === 0) {
      throw new Error(`No desktop snapshot in cache; call desktop_snapshot first`);
    }
    throw new Error(`Unknown desktop ref "${ref}" (valid refs: ${Array.from(desktopRefCache.keys()).slice(0, 8).join(', ')}${desktopRefCache.size > 8 ? '…' : ''})`);
  }
  return entry;
}

async function desktopClickRef(cmd: BridgeCommand): Promise<any> {
  const ref = String((cmd as any).ref || '');
  const entry = resolveDesktopRef(ref);
  const synthetic: BridgeCommand = {
    ...cmd,
    type: 'desktop_click',
    x: entry.bounds.cx,
    y: entry.bounds.cy,
    monitor: '',
    space: 'desktop',
  } as BridgeCommand;
  const result = await desktopClick(synthetic);
  return { ...result, ref: entry.ref, target: { role: entry.role, name: entry.name, window: entry.window, bounds: entry.bounds } };
}

async function desktopHoverRef(cmd: BridgeCommand): Promise<any> {
  const ref = String((cmd as any).ref || '');
  const entry = resolveDesktopRef(ref);
  const synthetic: BridgeCommand = {
    ...cmd,
    type: 'desktop_hover',
    x: entry.bounds.cx,
    y: entry.bounds.cy,
    monitor: '',
    space: 'desktop',
  } as BridgeCommand;
  const result = await desktopHover(synthetic);
  return { ...result, ref: entry.ref, target: { role: entry.role, name: entry.name, window: entry.window, bounds: entry.bounds } };
}

// ─── Desktop overlay (click-through labeled rectangles) ─────

const DESKTOP_OVERLAY_PS = `param([Parameter(Mandatory=$true)] [string]$SnapshotPath)
$ErrorActionPreference = 'Continue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3OverlayDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
}
"@
try { [Empir3OverlayDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
  try { [Empir3OverlayDpi]::SetProcessDPIAware() | Out-Null } catch {}
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$minX = ($screens | ForEach-Object { $_.Bounds.Left } | Measure-Object -Minimum).Minimum
$minY = ($screens | ForEach-Object { $_.Bounds.Top } | Measure-Object -Minimum).Minimum
$maxX = ($screens | ForEach-Object { $_.Bounds.Right } | Measure-Object -Maximum).Maximum
$maxY = ($screens | ForEach-Object { $_.Bounds.Bottom } | Measure-Object -Maximum).Maximum
$vWidth = $maxX - $minX
$vHeight = $maxY - $minY
$script:elements = @()
$script:lastMTime = $null
function Load-Snapshot {
  if (-not (Test-Path $SnapshotPath)) { return $false }
  try {
    $mtime = (Get-Item $SnapshotPath).LastWriteTime
    if ($script:lastMTime -and $mtime -eq $script:lastMTime) { return $false }
    $script:lastMTime = $mtime
    $raw = Get-Content $SnapshotPath -Raw
    $data = $raw | ConvertFrom-Json
    $script:elements = $data.elements
    return $true
  } catch { return $false }
}
Load-Snapshot | Out-Null
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($minX, $minY)
$form.Size = New-Object System.Drawing.Size($vWidth, $vHeight)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::Magenta
$form.TransparencyKey = [System.Drawing.Color]::Magenta
# Opacity 1.0: rely purely on the TransparencyKey for see-through. The box
# INTERIORS are left at the key color (fully transparent) so the user can read
# the UI behind them; only the borders + number labels are painted opaque.
$form.Opacity = 1.0
$form.Add_Shown({
  $hwnd = $form.Handle
  $GWL_EXSTYLE = -20
  $WS_EX_TRANSPARENT = 0x20
  $WS_EX_LAYERED = 0x80000
  $WS_EX_NOACTIVATE = 0x08000000
  $WS_EX_TOOLWINDOW = 0x80
  $current = [Empir3OverlayDpi]::GetWindowLong($hwnd, $GWL_EXSTYLE)
  $new = $current -bor $WS_EX_TRANSPARENT -bor $WS_EX_LAYERED -bor $WS_EX_NOACTIVATE -bor $WS_EX_TOOLWINDOW
  [Empir3OverlayDpi]::SetWindowLong($hwnd, $GWL_EXSTYLE, $new) | Out-Null
})
$form.Add_Paint({
  param($sender, $e)
  $g = $e.Graphics
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'ClearTypeGridFit'
  $boxColor = [System.Drawing.Color]::FromArgb(255, 32, 220, 120)
  $labelBg = [System.Drawing.Color]::FromArgb(255, 18, 18, 28)
  $labelFg = [System.Drawing.Color]::FromArgb(255, 240, 255, 240)
  $boxPen = New-Object System.Drawing.Pen($boxColor, 3)
  $labelBgBrush = New-Object System.Drawing.SolidBrush($labelBg)
  $labelFgBrush = New-Object System.Drawing.SolidBrush($labelFg)
  $font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
  foreach ($el in $script:elements) {
    if (-not $el.bounds) { continue }
    $x = [int]$el.bounds.x - $minX
    $y = [int]$el.bounds.y - $minY
    $w = [int]$el.bounds.width
    $h = [int]$el.bounds.height
    if ($w -le 0 -or $h -le 0) { continue }
    $rect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
    # No interior fill — keep it see-through. Border + label only.
    $g.DrawRectangle($boxPen, $rect)
    $label = $el.ref
    $textSize = $g.MeasureString($label, $font)
    $labelRect = New-Object System.Drawing.Rectangle($x, ($y - [int]$textSize.Height - 2), ([int]$textSize.Width + 10), ([int]$textSize.Height + 2))
    if ($labelRect.Y -lt 0) { $labelRect.Y = $y + 1 }
    $g.FillRectangle($labelBgBrush, $labelRect)
    $g.DrawString($label, $font, $labelFgBrush, ($labelRect.X + 5), $labelRect.Y)
  }
})
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 750
$timer.Add_Tick({ if (Load-Snapshot) { $form.Invalidate() } })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`;

let desktopOverlayProc: ChildProcess | null = null;
let desktopOverlayStartedAt: number | null = null;

function desktopOverlayRunning(): boolean {
  return !!(desktopOverlayProc && desktopOverlayProc.exitCode === null && !desktopOverlayProc.killed);
}

function hideDesktopOverlay(): boolean {
  const wasRunning = desktopOverlayRunning();
  if (wasRunning) {
    try { desktopOverlayProc!.kill('SIGTERM'); } catch {}
  }
  desktopOverlayProc = null;
  desktopOverlayStartedAt = null;
  return wasRunning;
}

async function desktopOverlayToggle(cmd: BridgeCommand): Promise<any> {
  if (process.platform !== 'win32') throw new Error('desktop_overlay is Windows-only');
  const action = String((cmd as any).action || 'toggle');

  if (action === 'status') {
    return { running: desktopOverlayRunning(), pid: desktopOverlayProc?.pid ?? null, startedAt: desktopOverlayStartedAt };
  }

  const wantShow = action === 'show' || (action === 'toggle' && !desktopOverlayRunning());
  const wantHide = action === 'hide' || (action === 'toggle' && desktopOverlayRunning());

  if (wantHide && desktopOverlayRunning()) {
    hideDesktopOverlay();
    return { running: false, action: 'hidden' };
  }

  if (wantShow) {
    if (desktopOverlayRunning()) return { running: true, pid: desktopOverlayProc!.pid, startedAt: desktopOverlayStartedAt, action: 'already-running' };
    const snapDir = join(FEEDBACK_DIR, 'desktop');
    mkdirSync(snapDir, { recursive: true });
    const snapPath = join(snapDir, 'last-snapshot.json');
    if (!existsSync(snapPath)) writeFileSync(snapPath, JSON.stringify({ elements: [] }));
    const scriptPath = join(snapDir, '_overlay.ps1');
    writeFileSync(scriptPath, DESKTOP_OVERLAY_PS, 'utf-8');
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', scriptPath,
      '-SnapshotPath', snapPath,
    ], { stdio: 'ignore', windowsHide: true });
    desktopOverlayProc = proc;
    desktopOverlayStartedAt = Date.now();
    proc.on('exit', () => {
      if (desktopOverlayProc === proc) {
        desktopOverlayProc = null;
        desktopOverlayStartedAt = null;
      }
    });
    return { running: true, pid: proc.pid, startedAt: desktopOverlayStartedAt, action: 'shown' };
  }

  return { running: desktopOverlayRunning(), pid: desktopOverlayProc?.pid ?? null };
}

// ─── Region selector (user draws a rectangle) ──────────────

const DESKTOP_REGION_SELECT_PS = `param([Parameter(Mandatory=$true)] [string]$OutputJson)
$ErrorActionPreference = 'Continue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3SelDPI {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
}
"@
try { [Empir3SelDPI]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
  try { [Empir3SelDPI]::SetProcessDPIAware() | Out-Null } catch {}
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$minX = ($screens | ForEach-Object { $_.Bounds.Left } | Measure-Object -Minimum).Minimum
$minY = ($screens | ForEach-Object { $_.Bounds.Top } | Measure-Object -Minimum).Minimum
$maxX = ($screens | ForEach-Object { $_.Bounds.Right } | Measure-Object -Maximum).Maximum
$maxY = ($screens | ForEach-Object { $_.Bounds.Bottom } | Measure-Object -Maximum).Maximum
$vWidth = $maxX - $minX
$vHeight = $maxY - $minY
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($minX, $minY)
$form.Size = New-Object System.Drawing.Size($vWidth, $vHeight)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::Black
$form.Opacity = 0.32
$form.Cursor = [System.Windows.Forms.Cursors]::Cross
$form.KeyPreview = $true
$script:dragging = $false
$script:start = $null
$script:current = $null
$script:committed = $null
$script:cancelled = $false
$panel = New-Object System.Windows.Forms.Panel
$panel.Dock = 'Fill'
$panel.BackColor = [System.Drawing.Color]::Transparent
$panel.Add_MouseDown({ param($s,$e)
  if ($e.Button -eq 'Left') {
    $script:dragging = $true
    $script:start = New-Object System.Drawing.Point ($e.X + $form.Location.X), ($e.Y + $form.Location.Y)
    $script:current = $script:start
    if ($script:banner) { try { $script:banner.Hide() } catch {} }
    $form.Invalidate()
  }
})
$panel.Add_MouseMove({ param($s,$e)
  if ($script:dragging) {
    $script:current = New-Object System.Drawing.Point ($e.X + $form.Location.X), ($e.Y + $form.Location.Y)
    $form.Invalidate()
  }
})
$panel.Add_MouseUp({ param($s,$e)
  if ($script:dragging -and $e.Button -eq 'Left') {
    $script:dragging = $false
    $script:current = New-Object System.Drawing.Point ($e.X + $form.Location.X), ($e.Y + $form.Location.Y)
    $rx = [Math]::Min($script:start.X, $script:current.X)
    $ry = [Math]::Min($script:start.Y, $script:current.Y)
    $rw = [Math]::Abs($script:current.X - $script:start.X)
    $rh = [Math]::Abs($script:current.Y - $script:start.Y)
    if ($rw -ge 4 -and $rh -ge 4) {
      $script:committed = @{ x=$rx; y=$ry; width=$rw; height=$rh }
      $form.Close()
    } else { $script:start = $null; $script:current = $null; $form.Invalidate() }
  }
})
$form.Controls.Add($panel)
$form.Add_KeyDown({ param($s,$e)
  if ($e.KeyCode -eq 'Escape') { $script:cancelled = $true; $form.Close() }
})
# The dim form only paints the live selection rectangle. The instruction
# banner lives on a SEPARATE, fully-opaque, click-through form (below) so the
# form-level Opacity used for the dim veil doesn't fade the banner. A uniform
# semi-transparent veil over the live desktop can only be done with form-level
# alpha, so the banner can't share this form and stay opaque.
$form.Add_Paint({ param($s,$e)
  $g = $e.Graphics
  $g.SmoothingMode = 'AntiAlias'
  if ($script:start -and $script:current) {
    $sx = [Math]::Min($script:start.X, $script:current.X) - $form.Location.X
    $sy = [Math]::Min($script:start.Y, $script:current.Y) - $form.Location.Y
    $sw = [Math]::Abs($script:current.X - $script:start.X)
    $sh = [Math]::Abs($script:current.Y - $script:start.Y)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 122, 200, 255)), 3
    $g.DrawRectangle($pen, $sx, $sy, $sw, $sh)
    $label = "$($sw)x$($sh)  at ($($script:start.X),$($script:start.Y))"
    $font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
    $size = $g.MeasureString($label, $font)
    $bgRect = New-Object System.Drawing.RectangleF ([Single]$sx, [Single]([Math]::Max(0, $sy - $size.Height - 4)), $size.Width + 12, $size.Height + 4)
    $bgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(220, 0, 0, 0))
    $fgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 122, 200, 255))
    $g.FillRectangle($bgBrush, $bgRect)
    $g.DrawString($label, $font, $fgBrush, ($sx + 6), $bgRect.Y + 2)
    $pen.Dispose(); $font.Dispose(); $bgBrush.Dispose(); $fgBrush.Dispose()
  }
})

# ── Instruction banner form (fully opaque, click-through, every monitor) ──
$banner = New-Object System.Windows.Forms.Form
$banner.FormBorderStyle = 'None'
$banner.StartPosition = 'Manual'
$banner.Location = New-Object System.Drawing.Point($minX, $minY)
$banner.Size = New-Object System.Drawing.Size($vWidth, $vHeight)
$banner.TopMost = $true
$banner.ShowInTaskbar = $false
$banner.BackColor = [System.Drawing.Color]::Magenta
$banner.TransparencyKey = [System.Drawing.Color]::Magenta
$banner.Opacity = 1.0
$banner.Enabled = $false
$banner.Add_Shown({
  $hwnd = $banner.Handle
  $GWL_EXSTYLE = -20
  $WS_EX_TRANSPARENT = 0x20
  $WS_EX_LAYERED = 0x80000
  $WS_EX_NOACTIVATE = 0x08000000
  $WS_EX_TOOLWINDOW = 0x80
  $cur = [Empir3SelDPI]::GetWindowLong($hwnd, $GWL_EXSTYLE)
  $newStyle = $cur -bor $WS_EX_TRANSPARENT -bor $WS_EX_LAYERED -bor $WS_EX_NOACTIVATE -bor $WS_EX_TOOLWINDOW
  [Empir3SelDPI]::SetWindowLong($hwnd, $GWL_EXSTYLE, $newStyle) | Out-Null
})
$banner.Add_Paint({ param($s,$e)
  $g = $e.Graphics
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'ClearTypeGridFit'
  $title = 'Select an area to share with the agent'
  $sub = 'Drag a rectangle around the region you want the agent to see.   Press Esc to cancel.'
  $titleFont = New-Object System.Drawing.Font('Segoe UI', 26, [System.Drawing.FontStyle]::Bold)
  $subFont = New-Object System.Drawing.Font('Segoe UI Semibold', 14, [System.Drawing.FontStyle]::Regular)
  $titleSize = $g.MeasureString($title, $titleFont)
  $subSize = $g.MeasureString($sub, $subFont)
  $padX = 56
  $padY = 28
  $dotW = 18
  $gapDot = 18
  $textW = [Math]::Max($titleSize.Width, $subSize.Width)
  $bannerW = $textW + $dotW + $gapDot + ($padX * 2)
  $bannerH = $titleSize.Height + $subSize.Height + 10 + ($padY * 2)
  $bgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(245, 12, 16, 26))
  $accentBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 100, 220, 140))
  $fgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $subBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 220, 232, 222))
  $borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 100, 220, 140)), 2
  # Draw the banner centered on EVERY monitor so it's clear the whole desktop
  # is selectable, not just the primary screen.
  foreach ($scr in [System.Windows.Forms.Screen]::AllScreens) {
    $px = $scr.Bounds.Left - $banner.Location.X + ([int](($scr.Bounds.Width - $bannerW) / 2))
    $py = $scr.Bounds.Top - $banner.Location.Y + 64
    $bannerRect = New-Object System.Drawing.RectangleF ([Single]$px, [Single]$py, [Single]$bannerW, [Single]$bannerH)
    $g.FillRectangle($bgBrush, $bannerRect)
    $g.DrawRectangle($borderPen, [Single]$px, [Single]$py, [Single]$bannerW, [Single]$bannerH)
    $dotRect = New-Object System.Drawing.Rectangle ([int]($px + $padX)), ([int]($py + $padY + 6)), $dotW, $dotW
    $g.FillEllipse($accentBrush, $dotRect)
    $textX = $px + $padX + $dotW + $gapDot
    $g.DrawString($title, $titleFont, $fgBrush, [Single]$textX, [Single]($py + $padY))
    $g.DrawString($sub, $subFont, $subBrush, [Single]$textX, [Single]($py + $padY + $titleSize.Height + 6))
  }
  $titleFont.Dispose(); $subFont.Dispose(); $bgBrush.Dispose(); $accentBrush.Dispose(); $fgBrush.Dispose(); $subBrush.Dispose(); $borderPen.Dispose()
})
$script:banner = $banner
# Show the opaque banner once the dim form's message loop is running, and keep
# it above the dim form (owned forms stay above their owner). Hide it the moment
# the user starts dragging so it never obscures the selection.
$form.Add_Shown({ $script:banner.Show(); $script:banner.Owner = $form })
$form.Add_FormClosed({ try { $script:banner.Close() } catch {} })
[System.Windows.Forms.Application]::Run($form)
$out = @{}
if ($script:committed) { $out = @{ ok=$true; cancelled=$false; region=$script:committed } }
else { $out = @{ ok=$false; cancelled=$true; region=$null } }
$out | ConvertTo-Json -Depth 5 | Set-Content -Path $OutputJson -Encoding UTF8
`;

// ─── Focus state + chip overlay ────────────────────────────

// `persist` = "keep until I release". When true, NO expiry timer is armed and
// touchDesktopFocus() is a no-op — the region lives until desktop_release_focus
// (or a new selection). When false (default), the region uses an *idle-revoke*
// TTL: every real scoped use bumps expiresAt forward via touchDesktopFocus(),
// so active work never drops, but a region that goes untouched for the full TTL
// auto-clears. For persistent regions expiresAt is set to 0 (sentinel: "no
// expiry"); desktopFocusStatus() reports remainingMs:null in that case.
type DesktopFocus = { x: number; y: number; width: number; height: number; startedAt: number; expiresAt: number; persist: boolean };
let desktopFocus: DesktopFocus | null = null;
let desktopFocusExpireTimer: NodeJS.Timeout | null = null;
let desktopFocusChipProc: ChildProcess | null = null;
let desktopFocusCloseProc: ChildProcess | null = null;
const DESKTOP_FOCUS_TTL_MS = 30 * 60 * 1000;

function clearDesktopFocus() {
  desktopFocus = null;
  if (desktopFocusExpireTimer) { clearTimeout(desktopFocusExpireTimer); desktopFocusExpireTimer = null; }
  if (desktopFocusChipProc) {
    try { desktopFocusChipProc.kill('SIGTERM'); } catch {}
    desktopFocusChipProc = null;
  }
  if (desktopFocusCloseProc) {
    try { desktopFocusCloseProc.kill('SIGTERM'); } catch {}
    desktopFocusCloseProc = null;
  }
  // A visible agent pointer is usually tied to the selected focus region.
  // Releasing or expiring focus should not leave stale "click here" guidance
  // floating over an area the agent no longer owns.
  try { clearDesktopPointer(); } catch {}
  // Grid overlay polls focus.json and exits when it disappears — be defensive
  // and SIGTERM it too so we don't wait the ~1s timer tick.
  desktopFocusGridEnabled = false;
  try { killFocusGridOverlay(); } catch {}
  try { hideDesktopOverlay(); } catch {}
  try { unlinkSync(join(FEEDBACK_DIR, 'desktop', 'focus.json')); } catch {}
}

// Persist the current focus state to focus.json (the chip + grid overlays poll
// this file for bounds and countdown). Centralized so touchDesktopFocus() and
// setDesktopFocus() write an identical shape.
function writeDesktopFocusFile() {
  if (!desktopFocus) return;
  try {
    const focusDir = join(FEEDBACK_DIR, 'desktop');
    mkdirSync(focusDir, { recursive: true });
    writeFileSync(join(focusDir, 'focus.json'), JSON.stringify(desktopFocus), 'utf-8');
  } catch {}
}

// Resolve whether a freshly-selected region should be persistent. Explicit
// per-call flag wins; otherwise fall back to the global default setting.
function resolveFocusPersist(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  try { return !!readBridgeSettings()?.desktopFocusKeepOpenDefault; } catch { return false; }
}

function setDesktopFocus(region: { x: number; y: number; width: number; height: number }, persist = false) {
  const now = Date.now();
  // persist === true → no expiry; expiresAt sentinel 0 means "never expires".
  desktopFocus = { ...region, startedAt: now, expiresAt: persist ? 0 : now + DESKTOP_FOCUS_TTL_MS, persist };
  if (desktopFocusExpireTimer) { clearTimeout(desktopFocusExpireTimer); desktopFocusExpireTimer = null; }
  if (!persist) {
    desktopFocusExpireTimer = setTimeout(() => clearDesktopFocus(), DESKTOP_FOCUS_TTL_MS);
  }
  writeDesktopFocusFile();
  spawnFocusChip();
  spawnFocusCloseButton();
  if (desktopFocusGridEnabled) spawnFocusGridOverlay();
}

// Idle-revoke keep-alive: any *real* scoped use of the focus region calls this
// to push the expiry forward by a full TTL and re-arm the timer, so active work
// never silently loses scope. No-op for persistent regions (they don't expire)
// and when there's no active region. NOT called on pure status reads — only on
// actual scoped consumption (screenshots, clicks, snapshots, cell/point ops).
function touchDesktopFocus() {
  if (!desktopFocus || desktopFocus.persist) return;
  const now = Date.now();
  desktopFocus.expiresAt = now + DESKTOP_FOCUS_TTL_MS;
  if (desktopFocusExpireTimer) clearTimeout(desktopFocusExpireTimer);
  desktopFocusExpireTimer = setTimeout(() => clearDesktopFocus(), DESKTOP_FOCUS_TTL_MS);
  // Rewrite focus.json so the chip's countdown reflects the reset.
  writeDesktopFocusFile();
}

const DESKTOP_FOCUS_CHIP_PS = `param([Parameter(Mandatory=$true)] [string]$FocusPath)
$ErrorActionPreference = 'Continue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3ChipDPI {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
}
"@
try { [Empir3ChipDPI]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
  try { [Empir3ChipDPI]::SetProcessDPIAware() | Out-Null } catch {}
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Load-Focus { try { return (Get-Content $FocusPath -Raw | ConvertFrom-Json) } catch { return $null } }
$f = Load-Focus
if (-not $f) { exit 0 }
# Window envelopes the focused region with: a 3px accent border drawn just
# OUTSIDE the region (so screenshot crops at the region bounds never include
# the border itself), and a label chip above-or-below the border. Everything
# else in the window is magenta -> transparent + click-through.
$labelH = 34
$padOuter = 8         # gap between region edge and border line
$borderW = 3
$gapChip = 4          # gap between chip and border
$chipW = 260

$regionW = [int]$f.width
$regionH = [int]$f.height

# Default: chip above the frame
$winX = [int]$f.x - $padOuter
$winY = [int]$f.y - $padOuter - $labelH - $gapChip
$winW = $regionW + ($padOuter * 2)
$winH = $regionH + ($padOuter * 2) + $labelH + $gapChip
$frameRelY = $labelH + $gapChip
$chipRelY = 0

$primary = [System.Windows.Forms.Screen]::PrimaryScreen
if ($winY -lt $primary.Bounds.Top) {
  # No room above -> chip below the frame instead
  $winY = [int]$f.y - $padOuter
  $frameRelY = 0
  $chipRelY = $regionH + ($padOuter * 2) + $gapChip
}

# Clamp chip horizontally so it stays on the primary screen if the region
# starts off-screen-left
$chipRelX = 0
if ($winX -lt $primary.Bounds.Left) {
  $chipRelX = $primary.Bounds.Left - $winX
}
if (($winX + $chipRelX + $chipW) -gt $primary.Bounds.Right) {
  $chipRelX = [Math]::Max(0, $primary.Bounds.Right - $winX - $chipW)
}

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($winX, $winY)
$form.Size = New-Object System.Drawing.Size($winW, $winH)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::Magenta
$form.TransparencyKey = [System.Drawing.Color]::Magenta
$form.Add_Shown({
  $hwnd = $form.Handle
  $GWL_EXSTYLE = -20
  $WS_EX_TRANSPARENT = 0x20
  $WS_EX_LAYERED = 0x80000
  $WS_EX_NOACTIVATE = 0x08000000
  $WS_EX_TOOLWINDOW = 0x80
  $current = [Empir3ChipDPI]::GetWindowLong($hwnd, $GWL_EXSTYLE)
  $new = $current -bor $WS_EX_TRANSPARENT -bor $WS_EX_LAYERED -bor $WS_EX_NOACTIVATE -bor $WS_EX_TOOLWINDOW
  [Empir3ChipDPI]::SetWindowLong($hwnd, $GWL_EXSTYLE, $new) | Out-Null
})
$form.Add_Paint({ param($s,$e)
  $g = $e.Graphics
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'ClearTypeGridFit'
  $accentColor = [System.Drawing.Color]::FromArgb(255, 100, 220, 140)
  $bgColor = [System.Drawing.Color]::FromArgb(235, 12, 16, 26)
  $fgColor = [System.Drawing.Color]::FromArgb(255, 240, 250, 240)

  # 1. Frame border just outside the region. The window outer edge sits
  #    $padOuter px from the region; draw the border centered on a path
  #    inset by borderW/2 so the stroke sits flush with the window edge.
  $half = [int]($borderW / 2)
  $frameW = $winW - $borderW
  $frameH = $regionH + ($padOuter * 2) - $borderW
  $pen = New-Object System.Drawing.Pen $accentColor, $borderW
  $g.DrawRectangle($pen, $half, ($frameRelY + $half), $frameW, $frameH)
  $pen.Dispose()

  # 2. Label chip
  $bg = New-Object System.Drawing.SolidBrush $bgColor
  $accent = New-Object System.Drawing.SolidBrush $accentColor
  $fg = New-Object System.Drawing.SolidBrush $fgColor
  $font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
  $chipRect = New-Object System.Drawing.Rectangle $chipRelX, $chipRelY, $chipW, $labelH
  $g.FillRectangle($bg, $chipRect)
  $dot = New-Object System.Drawing.Rectangle ($chipRelX + 12), ($chipRelY + 11), 12, 12
  $g.FillEllipse($accent, $dot)
  $label = "Agent focus active  $($regionW)x$($regionH)"
  $g.DrawString($label, $font, $fg, ($chipRelX + 32), ($chipRelY + 9))
  $bg.Dispose(); $accent.Dispose(); $fg.Dispose(); $font.Dispose()
})
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1500
$timer.Add_Tick({ if (-not (Test-Path $FocusPath)) { $form.Close() } })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`;

function spawnFocusChip() {
  if (process.platform !== 'win32') return;
  if (desktopFocusChipProc && desktopFocusChipProc.exitCode === null) return;
  try {
    const dir = join(FEEDBACK_DIR, 'desktop');
    mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, '_focus-chip.ps1');
    writeFileSync(scriptPath, DESKTOP_FOCUS_CHIP_PS, 'utf-8');
    const focusPath = join(dir, 'focus.json');
    // NOTE: detached:true + stdio:'ignore' + windowsHide:true together cause
    // powershell.exe to exit immediately before WinForms can enter its message
    // loop — the chip would die silently. Keep the child attached; on bridge
    // shutdown the tray's Job Object (KILL_ON_JOB_CLOSE) tears it down.
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', scriptPath,
      '-FocusPath', focusPath,
    ], { stdio: 'ignore', windowsHide: true });
    desktopFocusChipProc = proc;
    proc.on('exit', () => { if (desktopFocusChipProc === proc) desktopFocusChipProc = null; });
  } catch {}
}

// A small, always-on-top close button anchored just OUTSIDE the focus box's
// top-right corner (above the frame, mirroring the label chip on the top-left)
// so the user can dismiss the region by clicking the box itself — no agent
// command needed. It is a normal (non-click-through) window so the click is
// reliable; on click it POSTs desktop_release_focus to the wrapper, which
// clears focus and tears down the chip + this button. Sitting outside the
// region bounds means it's never captured in a screenshot of the region.
const DESKTOP_FOCUS_CLOSE_PS = `param([Parameter(Mandatory=$true)] [string]$FocusPath, [int]$Port = 3006, [string]$Nonce = '')
$ErrorActionPreference = 'Continue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3CloseDPI {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
}
"@
try { [Empir3CloseDPI]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
  try { [Empir3CloseDPI]::SetProcessDPIAware() | Out-Null } catch {}
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Load-Focus { try { return (Get-Content $FocusPath -Raw | ConvertFrom-Json) } catch { return $null } }
$f = Load-Focus
if (-not $f) { exit 0 }
$btn = 30
$padOuter = 8
$regionRight = [int]$f.x + [int]$f.width
$winX = $regionRight + $padOuter - $btn
$winY = [int]$f.y - $padOuter - $btn
$primary = [System.Windows.Forms.Screen]::PrimaryScreen
if ($winY -lt $primary.Bounds.Top) { $winY = [int]$f.y + $padOuter }
$script:releasing = $false
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($winX, $winY)
$form.Size = New-Object System.Drawing.Size($btn, $btn)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(18, 22, 30)
$form.Cursor = [System.Windows.Forms.Cursors]::Hand
$form.Add_Shown({
  $hwnd = $form.Handle
  $GWL_EXSTYLE = -20
  $WS_EX_NOACTIVATE = 0x08000000
  $WS_EX_TOOLWINDOW = 0x80
  $current = [Empir3CloseDPI]::GetWindowLong($hwnd, $GWL_EXSTYLE)
  $new = $current -bor $WS_EX_NOACTIVATE -bor $WS_EX_TOOLWINDOW
  [Empir3CloseDPI]::SetWindowLong($hwnd, $GWL_EXSTYLE, $new) | Out-Null
})
$form.Add_Paint({ param($s,$e)
  $g = $e.Graphics
  $g.SmoothingMode = 'AntiAlias'
  $accent = [System.Drawing.Color]::FromArgb(255, 100, 220, 140)
  $x = [System.Drawing.Color]::FromArgb(255, 255, 120, 150)
  $border = New-Object System.Drawing.Pen $accent, 1
  $g.DrawRectangle($border, 0, 0, ($btn - 1), ($btn - 1))
  $pen = New-Object System.Drawing.Pen $x, 2.4
  $m = 9
  $g.DrawLine($pen, $m, $m, ($btn - $m), ($btn - $m))
  $g.DrawLine($pen, ($btn - $m), $m, $m, ($btn - $m))
  $pen.Dispose(); $border.Dispose()
})
$form.Add_MouseDown({ param($s,$e)
  if ($script:releasing) { return }
  $script:releasing = $true
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/command" -Method Post -Body '{"type":"desktop_release_focus"}' -ContentType 'application/json' -Headers @{ 'X-Empir3-Nonce' = $Nonce } -TimeoutSec 4 | Out-Null
  } catch {}
  $form.Close()
})
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({ if (-not (Test-Path $FocusPath)) { $form.Close() } })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`;

function spawnFocusCloseButton() {
  if (process.platform !== 'win32') return;
  if (desktopFocusCloseProc && desktopFocusCloseProc.exitCode === null) return;
  try {
    const dir = join(FEEDBACK_DIR, 'desktop');
    mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, '_focus-close.ps1');
    writeFileSync(scriptPath, DESKTOP_FOCUS_CLOSE_PS, 'utf-8');
    const focusPath = join(dir, 'focus.json');
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', scriptPath,
      '-FocusPath', focusPath,
      '-Port', String(PORT),
      '-Nonce', BRIDGE_NONCE,
    ], { stdio: 'ignore', windowsHide: true });
    desktopFocusCloseProc = proc;
    proc.on('exit', () => { if (desktopFocusCloseProc === proc) desktopFocusCloseProc = null; });
  } catch {}
}

// ─── Focus grid overlay (on-screen, click-through) ──────
//
// Same chess-board grid that goes into the focus screenshot, drawn directly
// over the user's selected region as a click-through overlay. Means human +
// agent are looking at the same coord system in real time — user says "click
// cell 8,7" and AI can do it without round-tripping a screenshot. Polls
// focus.json so it disappears automatically when the user releases focus.

let desktopFocusGridProc: ChildProcess | null = null;
let desktopFocusGridEnabled = false;

const DESKTOP_FOCUS_GRID_PS = `param([Parameter(Mandatory=$true)] [string]$FocusPath)
$ErrorActionPreference = 'Continue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3GridDPI {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
}
"@
try { [Empir3GridDPI]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
  try { [Empir3GridDPI]::SetProcessDPIAware() | Out-Null } catch {}
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Load-Focus { try { return (Get-Content $FocusPath -Raw | ConvertFrom-Json) } catch { return $null } }
$script:f = Load-Focus
if (-not $script:f) { exit 0 }
$script:lastX = -9999; $script:lastY = -9999; $script:lastW = 0; $script:lastH = 0

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::Magenta
$form.TransparencyKey = [System.Drawing.Color]::Magenta

function Apply-Bounds {
  $form.Location = New-Object System.Drawing.Point([int]$script:f.x, [int]$script:f.y)
  $form.Size = New-Object System.Drawing.Size([int]$script:f.width, [int]$script:f.height)
  $script:lastX = [int]$script:f.x; $script:lastY = [int]$script:f.y
  $script:lastW = [int]$script:f.width; $script:lastH = [int]$script:f.height
}
Apply-Bounds

$form.Add_Shown({
  $hwnd = $form.Handle
  $GWL_EXSTYLE = -20
  $WS_EX_TRANSPARENT = 0x20
  $WS_EX_LAYERED = 0x80000
  $WS_EX_NOACTIVATE = 0x08000000
  $WS_EX_TOOLWINDOW = 0x80
  $current = [Empir3GridDPI]::GetWindowLong($hwnd, $GWL_EXSTYLE)
  $new = $current -bor $WS_EX_TRANSPARENT -bor $WS_EX_LAYERED -bor $WS_EX_NOACTIVATE -bor $WS_EX_TOOLWINDOW
  [Empir3GridDPI]::SetWindowLong($hwnd, $GWL_EXSTYLE, $new) | Out-Null
})

$form.Add_Paint({ param($s,$e)
  $g = $e.Graphics
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'ClearTypeGridFit'

  $W = [int]$script:f.width
  $H = [int]$script:f.height
  $dim = [Math]::Max($W, $H)
  $step = [int][Math]::Max(20, [Math]::Min(200, [Math]::Round($dim / 16.0)))

  $accentColor = [System.Drawing.Color]::FromArgb(255, 100, 220, 140)
  $linePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(95, 100, 220, 140)), 1
  $axisPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(160, 100, 220, 140)), 1

  # Vertical lines
  $vx = $step
  while ($vx -lt $W) {
    $g.DrawLine($axisPen, [int]$vx, 0, [int]$vx, $H)
    $vx += $step
  }
  # Horizontal lines
  $vy = $step
  while ($vy -lt $H) {
    $g.DrawLine($axisPen, 0, [int]$vy, $W, [int]$vy)
    $vy += $step
  }

  # Edge pill labels (cols on top, rows on left)
  $pillBg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 100, 220, 140))
  $pillFg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 20, 30, 30))
  $fontPt = [Math]::Max(10, [Math]::Min(26, [Math]::Round($step / 4.2)))
  $font   = New-Object System.Drawing.Font('Segoe UI', $fontPt, [System.Drawing.FontStyle]::Bold)
  $pillH  = $fontPt * 1.9

  $col = 1
  $vx = 0
  while ($vx -lt $W) {
    $cellW = [Math]::Min($step, $W - $vx)
    if ($cellW -ge ($step * 0.55)) {
      $text = "$col"
      $size = $g.MeasureString($text, $font)
      $pillW = [Math]::Max($size.Width + 12, $pillH)
      $pillX = $vx + ($cellW / 2.0) - ($pillW / 2.0)
      $pillY = 4
      $rect = New-Object System.Drawing.RectangleF ([Single]$pillX, [Single]$pillY, [Single]$pillW, [Single]$pillH)
      $g.FillRectangle($pillBg, $rect)
      $tx = $pillX + (($pillW - $size.Width) / 2.0)
      $ty = $pillY + (($pillH - $size.Height) / 2.0)
      $g.DrawString($text, $font, $pillFg, [Single]$tx, [Single]$ty)
    }
    $vx += $step
    $col++
  }
  $row = 1
  $vy = 0
  while ($vy -lt $H) {
    $cellH = [Math]::Min($step, $H - $vy)
    if ($cellH -ge ($step * 0.55)) {
      $text = "$row"
      $size = $g.MeasureString($text, $font)
      $pillW = [Math]::Max($size.Width + 12, $pillH)
      $pillX = 4
      $pillY = $vy + ($cellH / 2.0) - ($pillH / 2.0)
      $rect = New-Object System.Drawing.RectangleF ([Single]$pillX, [Single]$pillY, [Single]$pillW, [Single]$pillH)
      $g.FillRectangle($pillBg, $rect)
      $tx = $pillX + (($pillW - $size.Width) / 2.0)
      $ty = $pillY + (($pillH - $size.Height) / 2.0)
      $g.DrawString($text, $font, $pillFg, [Single]$tx, [Single]$ty)
    }
    $vy += $step
    $row++
  }
  $pillBg.Dispose(); $pillFg.Dispose(); $font.Dispose(); $linePen.Dispose(); $axisPen.Dispose()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  if (-not (Test-Path $FocusPath)) { $form.Close(); return }
  $nf = Load-Focus
  if (-not $nf) { return }
  $script:f = $nf
  if ([int]$script:f.x -ne $script:lastX -or [int]$script:f.y -ne $script:lastY -or [int]$script:f.width -ne $script:lastW -or [int]$script:f.height -ne $script:lastH) {
    Apply-Bounds
    $form.Invalidate()
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`;

function spawnFocusGridOverlay() {
  if (process.platform !== 'win32') return;
  if (desktopFocusGridProc && desktopFocusGridProc.exitCode === null) return;
  if (!desktopFocus) return;
  try {
    const dir = join(FEEDBACK_DIR, 'desktop');
    mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, '_focus-grid.ps1');
    writeFileSync(scriptPath, DESKTOP_FOCUS_GRID_PS, 'utf-8');
    const focusPath = join(dir, 'focus.json');
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', scriptPath,
      '-FocusPath', focusPath,
    ], { stdio: 'ignore', windowsHide: true });
    desktopFocusGridProc = proc;
    proc.on('exit', () => { if (desktopFocusGridProc === proc) desktopFocusGridProc = null; });
  } catch {}
}

function killFocusGridOverlay() {
  if (desktopFocusGridProc) {
    try { desktopFocusGridProc.kill('SIGTERM'); } catch {}
    desktopFocusGridProc = null;
  }
}

// ─── Pick-point: user clicks, bridge returns the coord ────
//
// Spawns a temporary capture overlay over the focus region. The user clicks
// somewhere inside; the bridge translates the click to focus-relative pixel
// coords AND cell coords (matching the grid the user sees), then resolves.
// Eliminates "click HERE → I guess where HERE is" round-trips.

const DESKTOP_PICK_POINT_PS = `param(
  [Parameter(Mandatory=$true)] [int]$FX,
  [Parameter(Mandatory=$true)] [int]$FY,
  [Parameter(Mandatory=$true)] [int]$FW,
  [Parameter(Mandatory=$true)] [int]$FH,
  [Parameter(Mandatory=$true)] [int]$Step,
  [Parameter(Mandatory=$true)] [string]$Prompt,
  [Parameter(Mandatory=$true)] [string]$OutputJson
)
$ErrorActionPreference = 'Continue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3PickDPI {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
try { [Empir3PickDPI]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
  try { [Empir3PickDPI]::SetProcessDPIAware() | Out-Null } catch {}
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:result = $null
$script:cancelled = $false

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($FX, $FY)
$form.Size = New-Object System.Drawing.Size($FW, $FH)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::Black
# 0.4 (was 0.18) so the dim veil + instruction banner are clearly visible; at
# 0.18 the banner was washed out to near-invisibility.
$form.Opacity = 0.4
$form.Cursor = [System.Windows.Forms.Cursors]::Cross
$form.KeyPreview = $true

$panel = New-Object System.Windows.Forms.Panel
$panel.Dock = 'Fill'
$panel.BackColor = [System.Drawing.Color]::Transparent
$panel.Add_MouseDown({ param($s,$e)
  if ($e.Button -ne 'Left') { return }
  $relX = $e.X
  $relY = $e.Y
  $col = [int][Math]::Floor($relX / [double]$Step) + 1
  $row = [int][Math]::Floor($relY / [double]$Step) + 1
  # Sub-cell offset in [-0.5, +0.5] of cell width from center
  $cellCenterX = ($col - 0.5) * $Step
  $cellCenterY = ($row - 0.5) * $Step
  $subX = [Math]::Round((($relX - $cellCenterX) / [double]$Step), 3)
  $subY = [Math]::Round((($relY - $cellCenterY) / [double]$Step), 3)
  $script:result = @{
    focusX = $relX; focusY = $relY
    absX = $relX + $FX; absY = $relY + $FY
    col = $col; row = $row
    subX = $subX; subY = $subY
    step = $Step
  }
  $form.Close()
})
$form.Controls.Add($panel)
$form.Add_KeyDown({ param($s,$e)
  if ($e.KeyCode -eq 'Escape') { $script:cancelled = $true; $form.Close() }
})

$form.Add_Paint({ param($s,$e)
  $g = $e.Graphics
  $g.SmoothingMode = 'AntiAlias'
  $title = $Prompt
  $sub = 'Click anywhere inside this rectangle.   Press Esc to cancel.'
  $titleFont = New-Object System.Drawing.Font('Segoe UI', 20, [System.Drawing.FontStyle]::Bold)
  $subFont = New-Object System.Drawing.Font('Segoe UI Semibold', 12, [System.Drawing.FontStyle]::Regular)
  $titleSize = $g.MeasureString($title, $titleFont)
  $subSize = $g.MeasureString($sub, $subFont)
  $bannerW = [Math]::Max($titleSize.Width, $subSize.Width) + 60
  $bannerH = $titleSize.Height + $subSize.Height + 40
  $px = [int](($FW - $bannerW) / 2)
  $py = 28
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(240, 12, 16, 26))
  $fg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $sub2 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 200, 215, 200))
  $border = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 100, 220, 140)), 2
  $bgRect = New-Object System.Drawing.RectangleF ([Single]$px, [Single]$py, [Single]$bannerW, [Single]$bannerH)
  $g.FillRectangle($bg, $bgRect)
  $g.DrawRectangle($border, [Single]$px, [Single]$py, [Single]$bannerW, [Single]$bannerH)
  $g.DrawString($title, $titleFont, $fg, [Single]($px + 30), [Single]($py + 12))
  $g.DrawString($sub, $subFont, $sub2, [Single]($px + 30), [Single]($py + 12 + $titleSize.Height + 6))
  $titleFont.Dispose(); $subFont.Dispose(); $bg.Dispose(); $fg.Dispose(); $sub2.Dispose(); $border.Dispose()
})
[System.Windows.Forms.Application]::Run($form)
$out = @{}
if ($script:result) {
  $out = @{ ok = $true; cancelled = $false; pick = $script:result }
} else {
  $out = @{ ok = $false; cancelled = $true; pick = $null }
}
$out | ConvertTo-Json -Depth 5 | Set-Content -Path $OutputJson -Encoding UTF8
`;

async function desktopPickPoint(cmd: BridgeCommand): Promise<any> {
  if (process.platform !== 'win32') throw new Error('desktop_pick_point is Windows-only');
  if (!desktopFocus) throw new Error('desktop_pick_point requires an active agent-focus region');
  touchDesktopFocus(); // real scoped use → keep the region alive (idle-revoke)
  const timeoutMs = Math.max(5000, Math.min(120000, Math.round(Number((cmd as any).timeoutMs ?? 60000))));
  const prompt = String((cmd as any).prompt ?? 'Click the spot you want the agent to target');
  const step = focusCellStep(desktopFocus.width, desktopFocus.height);
  const dir = join(FEEDBACK_DIR, 'desktop');
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, '_pick-point.ps1');
  const outPath = join(dir, `_pick-${Date.now()}.json`);
  writeFileSync(scriptPath, DESKTOP_PICK_POINT_PS, 'utf-8');
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', scriptPath,
      '-FX', String(desktopFocus!.x),
      '-FY', String(desktopFocus!.y),
      '-FW', String(desktopFocus!.width),
      '-FH', String(desktopFocus!.height),
      '-Step', String(step),
      '-Prompt', prompt,
      '-OutputJson', outPath,
    ], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} reject(new Error(`desktop_pick_point timed out after ${timeoutMs}ms`)); }, timeoutMs);
    proc.on('exit', () => {
      clearTimeout(timer);
      try {
        if (!existsSync(outPath)) return resolve({ ok: false, cancelled: true, pick: null });
        const data = JSON.parse(readFileSync(outPath, 'utf-8').replace(/^\uFEFF/, ''));
        try { unlinkSync(outPath); } catch {}
        resolve(data);
      } catch (e: any) { reject(e); }
    });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function desktopFocusGrid(cmd: BridgeCommand): Promise<any> {
  const rawAction = (cmd as any).action ?? (typeof (cmd as any).show === 'boolean' ? ((cmd as any).show ? 'show' : 'hide') : undefined);
  const action = String(rawAction || 'toggle').toLowerCase();
  // Enabling the grid is a scoped use of the focus region — keep it alive.
  if ((action === 'show' || action === 'toggle') && desktopFocus) touchDesktopFocus();
  if (action === 'show') {
    desktopFocusGridEnabled = true;
    spawnFocusGridOverlay();
  } else if (action === 'hide') {
    desktopFocusGridEnabled = false;
    killFocusGridOverlay();
  } else if (action === 'toggle') {
    desktopFocusGridEnabled = !desktopFocusGridEnabled;
    if (desktopFocusGridEnabled) spawnFocusGridOverlay(); else killFocusGridOverlay();
  } else if (action !== 'status') {
    throw new Error(`desktop_focus_grid: unknown action ${action}`);
  }
  return {
    enabled: desktopFocusGridEnabled,
    running: !!(desktopFocusGridProc && desktopFocusGridProc.exitCode === null),
    focusActive: !!desktopFocus,
  };
}

async function desktopSelectRegion(cmd: BridgeCommand): Promise<any> {
  if (process.platform !== 'win32') throw new Error('desktop_select_region is Windows-only');
  const timeoutMs = Math.max(5000, Math.min(120000, Math.round(Number((cmd as any).timeoutMs ?? 60000))));
  // Accept either `keepOpen` or `persist` as the per-call persistence flag.
  // Explicit boolean wins over the global default; undefined → use default.
  const keepOpenArg = (cmd as any).keepOpen ?? (cmd as any).persist;
  const persist = resolveFocusPersist(typeof keepOpenArg === 'boolean' ? keepOpenArg : undefined);
  const dir = join(FEEDBACK_DIR, 'desktop');
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, '_region-select.ps1');
  const outPath = join(dir, `_region-select-${Date.now()}.json`);
  writeFileSync(scriptPath, DESKTOP_REGION_SELECT_PS, 'utf-8');
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', scriptPath,
      '-OutputJson', outPath,
    ], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      reject(new Error(`desktop_select_region timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('exit', () => {
      clearTimeout(timer);
      try {
        if (!existsSync(outPath)) return resolve({ ok: false, cancelled: true, region: null });
        const data = JSON.parse(readFileSync(outPath, 'utf-8').replace(/^\uFEFF/, ''));
        try { unlinkSync(outPath); } catch {}
        if (data.ok && data.region) {
          setDesktopFocus(data.region, persist);
          return resolve({ ok: true, cancelled: false, region: data.region, focus: desktopFocus, persist });
        }
        return resolve({ ok: false, cancelled: !!data.cancelled, region: null });
      } catch (e: any) {
        reject(e);
      }
    });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function desktopReleaseFocus(): Promise<any> {
  const focusPath = join(FEEDBACK_DIR, 'desktop', 'focus.json');
  let prev: any = desktopFocus;
  let focusWasPresent = !!desktopFocus;
  if (!prev) {
    try {
      if (existsSync(focusPath)) {
        focusWasPresent = true;
        try { prev = JSON.parse(readFileSync(focusPath, 'utf-8')); } catch {}
      }
    } catch {}
  }
  const pointerWasVisible = !!desktopPointer;
  const gridWasVisible = desktopFocusGridEnabled || !!(desktopFocusGridProc && desktopFocusGridProc.exitCode === null);
  const overlayWasVisible = desktopOverlayRunning();
  clearDesktopFocus();
  try {
    if (cdpConnected) {
      await cdpPost('/evaluate-all', {
        expression: `(function(){
          try { document.querySelectorAll('.empir3-annotation-input,.empir3-annotation-badge').forEach(function(el){ el.remove(); }); } catch (_) {}
          try { var c = document.getElementById('empir3-draw-canvas'); if (c) { var x = c.getContext('2d'); if (x) x.clearRect(0, 0, c.width, c.height); } } catch (_) {}
          try { if (window.__empir3_clearGlow) window.__empir3_clearGlow(); } catch (_) {}
          return true;
        })()`,
      }, { timeoutMs: 3000, wakeOnNotReady: false });
    }
  } catch {}
  return {
    released: focusWasPresent || pointerWasVisible || gridWasVisible || overlayWasVisible,
    previous: prev,
    cleaned: {
      focus: focusWasPresent,
      pointer: pointerWasVisible,
      focusGrid: gridWasVisible,
      desktopOverlay: overlayWasVisible,
    },
  };
}

function desktopFocusStatus(): any {
  if (!desktopFocus) return { active: false };
  // remainingMs is null for persistent ("keep open") regions — they have no
  // expiry. For idle-revoke regions it's the time left until auto-clear, which
  // resets to the full TTL on every scoped use (see touchDesktopFocus).
  return {
    active: true,
    focus: desktopFocus,
    persist: desktopFocus.persist,
    mode: desktopFocus.persist ? 'persistent' : 'idle-revoke',
    remainingMs: desktopFocus.persist ? null : Math.max(0, desktopFocus.expiresAt - Date.now()),
    ttlMs: DESKTOP_FOCUS_TTL_MS,
    chipRunning: !!(desktopFocusChipProc && desktopFocusChipProc.exitCode === null),
  };
}

// Desktop toolbar widget launched from the tray. It is intentionally a tiny
// local WinForms surface that talks to the daemon instead of duplicating tool
// logic in Python/tray code.
let desktopToolbarProc: ChildProcess | null = null;

const DESKTOP_TOOLBAR_PS = `param(
  [Parameter(Mandatory=$true)] [int]$Port,
  [Parameter(Mandatory=$false)] [string]$Nonce = ''
)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try { Add-Type -AssemblyName Microsoft.VisualBasic } catch {}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3ToolbarDPI {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
try { [Empir3ToolbarDPI]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
  try { [Empir3ToolbarDPI]::SetProcessDPIAware() | Out-Null } catch {}
}

$base = "http://127.0.0.1:$Port"
$headers = @{}
if ($Nonce) { $headers['X-Empir3-Nonce'] = $Nonce }

function Set-ToolbarStatus([string]$Text) {
  if ($script:statusLabel) { $script:statusLabel.Text = $Text }
  [System.Windows.Forms.Application]::DoEvents()
}

function Invoke-BridgeCommand([hashtable]$Body, [int]$TimeoutSec = 130) {
  $json = $Body | ConvertTo-Json -Depth 8
  $res = Invoke-RestMethod -Uri ($base + '/api/command') -Method Post -ContentType 'application/json' -Headers $headers -Body $json -TimeoutSec $TimeoutSec
  if (-not $res.ok) {
    $msg = 'Bridge command failed'
    if ($res.error) { $msg = [string]$res.error }
    throw $msg
  }
  return $res.result
}

function Get-BridgeJson([string]$Path) {
  return Invoke-RestMethod -Uri ($base + $Path) -Method Get -Headers $headers -TimeoutSec 15
}

function Current-MonitorId {
  $pt = $script:form.PointToScreen((New-Object System.Drawing.Point ([int]($script:form.Width / 2), [int]($script:form.Height / 2))))
  foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    if ($screen.Bounds.Contains($pt)) {
      $id = [string]$screen.DeviceName
      if ($id.StartsWith('\\\\.\\')) { $id = $id.Substring(4) }
      return $id
    }
  }
  $primary = [System.Windows.Forms.Screen]::PrimaryScreen
  $pid = [string]$primary.DeviceName
  if ($pid.StartsWith('\\\\.\\')) { $pid = $pid.Substring(4) }
  return $pid
}

function Refresh-Recordings {
  try {
    $script:recordingSelect.Items.Clear()
    $rows = Get-BridgeJson '/api/recordings'
    foreach ($rec in @($rows)) {
      $label = [string]$rec.name
      if ($label) { [void]$script:recordingSelect.Items.Add($label) }
    }
    if ($script:recordingSelect.Items.Count -gt 0 -and $script:recordingSelect.SelectedIndex -lt 0) {
      $script:recordingSelect.SelectedIndex = 0
    }
    Set-ToolbarStatus ("Recordings: " + $script:recordingSelect.Items.Count)
  } catch {
    Set-ToolbarStatus ("Recordings failed: " + $_.Exception.Message)
  }
}

function Toolbar-Color([string]$Hex) {
  return [System.Drawing.ColorTranslator]::FromHtml($Hex)
}

$script:toolbarColors = @{
  bg      = Toolbar-Color '#0b1020'
  panel   = Toolbar-Color '#111827'
  rail    = Toolbar-Color '#172033'
  border  = Toolbar-Color '#2d3b58'
  ink     = Toolbar-Color '#e7eefb'
  muted   = Toolbar-Color '#98a9c4'
  brand   = Toolbar-Color '#7c5cfc'
  blue    = Toolbar-Color '#5da8ff'
  green   = Toolbar-Color '#39c980'
  red     = Toolbar-Color '#e65f78'
  warn    = Toolbar-Color '#f0b35a'
}

function Set-ButtonPalette([System.Windows.Forms.Button]$Button, [string]$Kind) {
  $c = $script:toolbarColors
  $Button.ForeColor = $c.ink
  $Button.BackColor = $c.rail
  $Button.FlatAppearance.BorderColor = $c.border
  $Button.FlatAppearance.MouseOverBackColor = Toolbar-Color '#22304d'
  $Button.FlatAppearance.MouseDownBackColor = Toolbar-Color '#0d1528'
  if ($Kind -eq 'primary') {
    $Button.BackColor = Toolbar-Color '#23396a'
    $Button.FlatAppearance.BorderColor = $c.blue
  } elseif ($Kind -eq 'brand') {
    $Button.BackColor = Toolbar-Color '#2a2354'
    $Button.FlatAppearance.BorderColor = $c.brand
  } elseif ($Kind -eq 'record') {
    $Button.BackColor = Toolbar-Color '#3a1824'
    $Button.FlatAppearance.BorderColor = $c.red
  } elseif ($Kind -eq 'play') {
    $Button.BackColor = Toolbar-Color '#173522'
    $Button.FlatAppearance.BorderColor = $c.green
  } elseif ($Kind -eq 'warn') {
    $Button.BackColor = Toolbar-Color '#342717'
    $Button.FlatAppearance.BorderColor = $c.warn
  }
}

function Add-Button([System.Windows.Forms.Control]$Parent, [string]$Text, [scriptblock]$Handler, [int]$Width = 92, [int]$Height = 34, [string]$Kind = 'default') {
  $btn = New-Object System.Windows.Forms.Button
  $btn.Text = $Text
  $btn.Width = $Width
  $btn.Height = $Height
  $btn.Margin = New-Object System.Windows.Forms.Padding(4)
  $btn.FlatStyle = 'Flat'
  $btn.FlatAppearance.BorderSize = 1
  $btn.Cursor = [System.Windows.Forms.Cursors]::Hand
  $btn.Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 8.5, ([System.Drawing.FontStyle]::Bold)
  $btn.UseVisualStyleBackColor = $false
  Set-ButtonPalette $btn $Kind
  $btn.Add_Click($Handler)
  [void]$Parent.Controls.Add($btn)
  return $btn
}

$script:form = New-Object System.Windows.Forms.Form
$script:form.Text = 'Empir3 Bridge Tools'
$script:form.FormBorderStyle = 'FixedSingle'
$script:form.StartPosition = 'Manual'
$script:form.TopMost = $true
$script:form.ShowInTaskbar = $false
$script:form.MaximizeBox = $false
$script:form.MinimizeBox = $false
$script:form.BackColor = $script:toolbarColors.bg
$script:form.ForeColor = $script:toolbarColors.ink
$script:form.Size = New-Object System.Drawing.Size(700, 300)
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$script:form.Location = New-Object System.Drawing.Point(($wa.Right - 730), ($wa.Bottom - 350))

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = 'Fill'
$root.BackColor = $script:toolbarColors.bg
$root.Padding = New-Object System.Windows.Forms.Padding(12)
$root.RowCount = 5
$root.ColumnCount = 1
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle ([System.Windows.Forms.SizeType]::Absolute, 42))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle ([System.Windows.Forms.SizeType]::Absolute, 46))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle ([System.Windows.Forms.SizeType]::Absolute, 90))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle ([System.Windows.Forms.SizeType]::Absolute, 1))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle ([System.Windows.Forms.SizeType]::Absolute, 36))) | Out-Null
$script:form.Controls.Add($root)

$brandPanel = New-Object System.Windows.Forms.Panel
$brandPanel.Dock = 'Fill'
$brandPanel.BackColor = $script:toolbarColors.bg
$root.Controls.Add($brandPanel, 0, 0)

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = 'empir3 Bridge'
$titleLabel.AutoSize = $true
$titleLabel.ForeColor = $script:toolbarColors.ink
$titleLabel.Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 13, ([System.Drawing.FontStyle]::Bold)
$titleLabel.Location = New-Object System.Drawing.Point(0, 4)
[void]$brandPanel.Controls.Add($titleLabel)

$script:monitorLabel = New-Object System.Windows.Forms.Label
$script:monitorLabel.Text = 'Monitor ' + (Current-MonitorId)
$script:monitorLabel.TextAlign = 'MiddleRight'
$script:monitorLabel.ForeColor = $script:toolbarColors.muted
$script:monitorLabel.Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 8.5
$script:monitorLabel.Width = 220
$script:monitorLabel.Height = 28
$script:monitorLabel.Location = New-Object System.Drawing.Point(430, 6)
[void]$brandPanel.Controls.Add($script:monitorLabel)

$focusPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$focusPanel.Dock = 'Fill'
$focusPanel.WrapContents = $false
$focusPanel.BackColor = $script:toolbarColors.panel
$focusPanel.Padding = New-Object System.Windows.Forms.Padding(6, 4, 6, 4)
$focusPanel.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 8)
$root.Controls.Add($focusPanel, 0, 1)

$transport = New-Object System.Windows.Forms.Panel
$transport.Dock = 'Fill'
$transport.BackColor = $script:toolbarColors.panel
$transport.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 8)
$root.Controls.Add($transport, 0, 2)

$transportLabel = New-Object System.Windows.Forms.Label
$transportLabel.Text = 'Recording transport'
$transportLabel.AutoSize = $true
$transportLabel.ForeColor = $script:toolbarColors.muted
$transportLabel.Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 8.5, ([System.Drawing.FontStyle]::Bold)
$transportLabel.Location = New-Object System.Drawing.Point(12, 9)
[void]$transport.Controls.Add($transportLabel)

[void](Add-Button $focusPanel 'Focus' {
  try {
    Set-ToolbarStatus 'Select a region on screen'
    Invoke-BridgeCommand @{ type='desktop_select_region'; timeoutMs=120000 } 130 | Out-Null
    Set-ToolbarStatus 'Focus region set'
  } catch { Set-ToolbarStatus ("Focus failed: " + $_.Exception.Message) }
} 94 30 'primary')
[void](Add-Button $focusPanel 'Release' {
  try {
    Invoke-BridgeCommand @{ type='desktop_release_focus' } 20 | Out-Null
    Set-ToolbarStatus 'Focus and artifacts released'
  } catch { Set-ToolbarStatus ("Release failed: " + $_.Exception.Message) }
} 94 30 'warn')
[void](Add-Button $focusPanel 'Chat' {
  try {
    Invoke-BridgeCommand @{ type='bridge_overlay_reinject'; reason='toolbar' } 20 | Out-Null
    Set-ToolbarStatus 'Overlay chat injected'
  } catch { Set-ToolbarStatus ("Chat inject failed: " + $_.Exception.Message) }
} 94 30 'brand')
[void](Add-Button $focusPanel 'Calibrate' {
  try {
    $mon = Current-MonitorId
    Set-ToolbarStatus ("Calibrating " + $mon)
    Invoke-BridgeCommand @{ type='desktop_calibrate_pointer'; monitor=$mon; area='monitor' } 130 | Out-Null
    Set-ToolbarStatus ("Calibrated " + $mon)
    if ($script:monitorLabel) { $script:monitorLabel.Text = 'Monitor ' + $mon }
  } catch { Set-ToolbarStatus ("Calibration failed: " + $_.Exception.Message) }
} 108 30 'primary')

$script:recordingSelect = New-Object System.Windows.Forms.ComboBox
$script:recordingSelect.DropDownStyle = 'DropDownList'
$script:recordingSelect.Width = 250
$script:recordingSelect.Height = 30
$script:recordingSelect.Location = New-Object System.Drawing.Point(12, 38)
$script:recordingSelect.BackColor = Toolbar-Color '#0c1324'
$script:recordingSelect.ForeColor = $script:toolbarColors.ink
$script:recordingSelect.FlatStyle = 'Flat'
$script:recordingSelect.Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 8.5
[void]$transport.Controls.Add($script:recordingSelect)

[void](Add-Button $transport 'REC' {
  try {
    Invoke-BridgeCommand @{ type='record_start' } 20 | Out-Null
    Set-ToolbarStatus 'Recording started'
  } catch { Set-ToolbarStatus ("Record failed: " + $_.Exception.Message) }
} 58 30 'record')
$transport.Controls[$transport.Controls.Count - 1].Location = New-Object System.Drawing.Point(274, 37)

[void](Add-Button $transport 'STOP' {
  try {
    $defaultName = 'recording-' + (Get-Date -Format 'yyyy-MM-dd-HHmmss')
    $name = $defaultName
    try { $name = [Microsoft.VisualBasic.Interaction]::InputBox('Save recording as:', 'Stop recording', $defaultName) } catch {}
    if (-not $name) { $name = $defaultName }
    $r = Invoke-BridgeCommand @{ type='record_stop'; text=$name } 30
    Refresh-Recordings
    Set-ToolbarStatus ("Saved " + $r.saved)
  } catch { Set-ToolbarStatus ("Stop failed: " + $_.Exception.Message) }
} 62 30 'warn')
$transport.Controls[$transport.Controls.Count - 1].Location = New-Object System.Drawing.Point(340, 37)

[void](Add-Button $transport 'PLAY' {
  try {
    $name = [string]$script:recordingSelect.SelectedItem
    if (-not $name) { throw 'Select a recording first' }
    Invoke-BridgeCommand @{ type='play'; recording=$name; speed=1; variables=@{} } 180 | Out-Null
    Set-ToolbarStatus ("Played " + $name)
  } catch { Set-ToolbarStatus ("Play failed: " + $_.Exception.Message) }
} 62 30 'play')
$transport.Controls[$transport.Controls.Count - 1].Location = New-Object System.Drawing.Point(410, 37)

[void](Add-Button $transport 'Open' {
  try {
    $name = [string]$script:recordingSelect.SelectedItem
    if (-not $name) { throw 'Select a recording first' }
    $rec = Get-BridgeJson ('/api/recordings/' + [uri]::EscapeDataString($name))
    $summary = $name + [Environment]::NewLine + 'Actions: ' + @($rec.actions).Count + [Environment]::NewLine + 'Start: ' + $rec.startUrl
    [System.Windows.Forms.MessageBox]::Show($summary, 'Recording') | Out-Null
    Set-ToolbarStatus ("Opened " + $name)
  } catch { Set-ToolbarStatus ("Open failed: " + $_.Exception.Message) }
} 72 30 'default')
$transport.Controls[$transport.Controls.Count - 1].Location = New-Object System.Drawing.Point(482, 37)

[void](Add-Button $transport 'Refresh' { Refresh-Recordings } 86 30 'brand')
$transport.Controls[$transport.Controls.Count - 1].Location = New-Object System.Drawing.Point(562, 37)

$script:statusLabel = New-Object System.Windows.Forms.Label
$script:statusLabel.Dock = 'Fill'
$script:statusLabel.AutoEllipsis = $true
$script:statusLabel.TextAlign = 'MiddleLeft'
$script:statusLabel.ForeColor = $script:toolbarColors.green
$script:statusLabel.BackColor = $script:toolbarColors.bg
$script:statusLabel.Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 8.5
$script:statusLabel.Text = 'Ready'
$root.Controls.Add($script:statusLabel, 0, 4)

$script:form.Add_Move({ try { if ($script:monitorLabel) { $script:monitorLabel.Text = 'Monitor ' + (Current-MonitorId) } } catch {} })
$script:form.Add_Shown({ Refresh-Recordings })
[System.Windows.Forms.Application]::Run($script:form)
`;

function desktopToolbarRunning(): boolean {
  return !!(desktopToolbarProc && desktopToolbarProc.exitCode === null && !desktopToolbarProc.killed);
}

async function desktopToolbar(cmd: BridgeCommand): Promise<any> {
  if (process.platform !== 'win32') throw new Error('desktop_toolbar is Windows-only');
  const action = String((cmd as any).action || 'show').toLowerCase();
  if (action === 'status') return { running: desktopToolbarRunning(), pid: desktopToolbarProc?.pid ?? null };
  if (action === 'hide' || action === 'close') {
    const was = desktopToolbarRunning();
    if (was) { try { desktopToolbarProc!.kill('SIGTERM'); } catch {} }
    desktopToolbarProc = null;
    return { running: false, action: was ? 'closed' : 'not-running' };
  }
  if (desktopToolbarRunning()) {
    return { running: true, pid: desktopToolbarProc!.pid, action: 'already-running' };
  }
  const dir = join(FEEDBACK_DIR, 'desktop');
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, '_toolbar.ps1');
  writeFileSync(scriptPath, DESKTOP_TOOLBAR_PS, 'utf-8');
  const proc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', scriptPath,
    '-Port', String(PORT),
    '-Nonce', BRIDGE_NONCE,
  ], { stdio: 'ignore', windowsHide: true });
  desktopToolbarProc = proc;
  proc.on('exit', () => { if (desktopToolbarProc === proc) desktopToolbarProc = null; });
  return { running: true, pid: proc.pid, action: 'shown' };
}

// ─── Agent ghost pointer ─────────────────────────────────
//
// A click-through cursor overlay the agent can move around the screen as a
// visual "I'm looking here / I'd click here" indicator without taking control
// of the user's real mouse. Same WS_EX_TRANSPARENT|LAYERED trick as the focus
// chip, so the user's clicks pass straight through. State lives in
// pointer.json which the PS overlay polls every 50ms.

type DesktopPointer = { x: number; y: number; visible: boolean; label: string; pulseAt: number };
let desktopPointer: DesktopPointer | null = null;
let desktopPointerProc: ChildProcess | null = null;

const DESKTOP_POINTER_PS = `param([Parameter(Mandatory=$true)] [string]$PointerPath)
$ErrorActionPreference = 'Continue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3PtrDPI {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
}
"@
try { [Empir3PtrDPI]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
  try { [Empir3PtrDPI]::SetProcessDPIAware() | Out-Null } catch {}
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Load-Ptr {
  # -Encoding UTF8: the file is written as UTF-8 (no BOM) by Node. Without this,
  # Windows PowerShell 5.1 reads it as the ANSI code page and mangles non-ASCII
  # label chars (e.g. an em dash "—" became "â€"").
  try { return (Get-Content $PointerPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json) } catch { return $null }
}

$winW = 320
$winH = 80
$arrowOffsetX = 0
$arrowOffsetY = 0
$script:label = ''
$script:visible = $false
$script:lastPulseAt = 0
$script:pulseStart = 0
$script:lastX = -9999
$script:lastY = -9999

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Size = New-Object System.Drawing.Size($winW, $winH)
$form.Location = New-Object System.Drawing.Point(-9999, -9999)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::Magenta
$form.TransparencyKey = [System.Drawing.Color]::Magenta

$form.Add_Shown({
  $hwnd = $form.Handle
  $GWL_EXSTYLE = -20
  $WS_EX_TRANSPARENT = 0x20
  $WS_EX_LAYERED = 0x80000
  $WS_EX_NOACTIVATE = 0x08000000
  $WS_EX_TOOLWINDOW = 0x80
  $current = [Empir3PtrDPI]::GetWindowLong($hwnd, $GWL_EXSTYLE)
  $new = $current -bor $WS_EX_TRANSPARENT -bor $WS_EX_LAYERED -bor $WS_EX_NOACTIVATE -bor $WS_EX_TOOLWINDOW
  [Empir3PtrDPI]::SetWindowLong($hwnd, $GWL_EXSTYLE, $new) | Out-Null
})

$form.Add_Paint({ param($s,$e)
  $g = $e.Graphics
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'ClearTypeGridFit'

  if (-not $script:visible) { return }

  # Pulse ring (animated)
  if ($script:pulseStart -gt 0) {
    $nowMs = [int64]([DateTime]::UtcNow.Ticks / 10000)
    $age = $nowMs - $script:pulseStart
    $dur = 650
    if ($age -lt $dur) {
      $t = [Single]($age / [double]$dur)
      $radius = 8 + ($t * 34)
      $alpha = [int](220 * (1 - $t))
      if ($alpha -lt 0) { $alpha = 0 }
      $ringColor = [System.Drawing.Color]::FromArgb($alpha, 100, 220, 140)
      $pen = New-Object System.Drawing.Pen $ringColor, 3
      $g.DrawEllipse($pen, [Single]($arrowOffsetX - $radius), [Single]($arrowOffsetY - $radius), [Single]($radius * 2), [Single]($radius * 2))
      $pen.Dispose()
    } else {
      $script:pulseStart = 0
    }
  }

  # Arrow cursor (NW-pointing arrow, green fill, black outline)
  $pts = @(
    (New-Object System.Drawing.Point ($arrowOffsetX + 0),  ($arrowOffsetY + 0)),
    (New-Object System.Drawing.Point ($arrowOffsetX + 0),  ($arrowOffsetY + 24)),
    (New-Object System.Drawing.Point ($arrowOffsetX + 6),  ($arrowOffsetY + 19)),
    (New-Object System.Drawing.Point ($arrowOffsetX + 11), ($arrowOffsetY + 29)),
    (New-Object System.Drawing.Point ($arrowOffsetX + 15), ($arrowOffsetY + 27)),
    (New-Object System.Drawing.Point ($arrowOffsetX + 10), ($arrowOffsetY + 17)),
    (New-Object System.Drawing.Point ($arrowOffsetX + 17), ($arrowOffsetY + 17))
  )
  $fillBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 100, 220, 140))
  $outlinePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 0, 0, 0)), 1.4
  $g.FillPolygon($fillBrush, $pts)
  $g.DrawPolygon($outlinePen, $pts)
  $fillBrush.Dispose(); $outlinePen.Dispose()

  # Label pill to the right of the cursor
  if ($script:label) {
    $font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
    $size = $g.MeasureString($script:label, $font)
    $maxLabelW = $winW - $arrowOffsetX - 28
    $labelW = [Math]::Min([int]$size.Width, $maxLabelW)
    $lx = $arrowOffsetX + 22
    $ly = $arrowOffsetY + 8
    $padX = 10
    $padY = 4
    $bgRect = New-Object System.Drawing.RectangleF ([Single]($lx), [Single]($ly), [Single]($labelW + ($padX * 2)), [Single]($size.Height + ($padY * 2)))
    $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 12, 16, 26))
    $border = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 100, 220, 140)), 1
    $fg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $g.FillRectangle($bg, $bgRect)
    $g.DrawRectangle($border, $bgRect.X, $bgRect.Y, $bgRect.Width, $bgRect.Height)
    $g.DrawString($script:label, $font, $fg, [Single]($lx + $padX), [Single]($ly + $padY))
    $bg.Dispose(); $border.Dispose(); $fg.Dispose(); $font.Dispose()
  }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 40
$timer.Add_Tick({
  if (-not (Test-Path $PointerPath)) { $form.Close(); return }
  $p = Load-Ptr
  if (-not $p) { return }
  $vis = [bool]$p.visible
  $lbl = if ($p.label) { [string]$p.label } else { '' }
  $px = [int]$p.x
  $py = [int]$p.y
  $newPulseAt = if ($p.pulseAt) { [int64]$p.pulseAt } else { [int64]0 }

  $needRepaint = $false
  if ($vis -ne $script:visible) { $script:visible = $vis; $needRepaint = $true }
  if ($lbl -ne $script:label) { $script:label = $lbl; $needRepaint = $true }
  if ($newPulseAt -gt $script:lastPulseAt) {
    $script:lastPulseAt = $newPulseAt
    $script:pulseStart = [int64]([DateTime]::UtcNow.Ticks / 10000)
    $needRepaint = $true
  }
  if ($script:pulseStart -gt 0) { $needRepaint = $true }

  $newX = $px - $arrowOffsetX
  $newY = $py - $arrowOffsetY
  if ($script:lastX -ne $newX -or $script:lastY -ne $newY) {
    $form.Location = New-Object System.Drawing.Point($newX, $newY)
    $script:lastX = $newX; $script:lastY = $newY
    $needRepaint = $true
  }

  if ($needRepaint) { $form.Invalidate() }
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`;

function pointerFilePath(): string {
  return join(FEEDBACK_DIR, 'desktop', 'pointer.json');
}

function writePointerFile() {
  if (!desktopPointer) return;
  const dir = join(FEEDBACK_DIR, 'desktop');
  mkdirSync(dir, { recursive: true });
  writeFileSync(pointerFilePath(), JSON.stringify(desktopPointer), 'utf-8');
}

function spawnPointerOverlay() {
  if (process.platform !== 'win32') return;
  if (desktopPointerProc && desktopPointerProc.exitCode === null) return;
  try {
    const dir = join(FEEDBACK_DIR, 'desktop');
    mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, '_pointer.ps1');
    writeFileSync(scriptPath, DESKTOP_POINTER_PS, 'utf-8');
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', scriptPath,
      '-PointerPath', pointerFilePath(),
    ], { stdio: 'ignore', windowsHide: true });
    desktopPointerProc = proc;
    proc.on('exit', () => { if (desktopPointerProc === proc) desktopPointerProc = null; });
  } catch {}
}

function clearDesktopPointer() {
  desktopPointer = null;
  try { unlinkSync(pointerFilePath()); } catch {}
  if (desktopPointerProc) {
    try { desktopPointerProc.kill('SIGTERM'); } catch {}
    desktopPointerProc = null;
  }
}

// Translate coords from a logical "space" (focus | monitor | desktop) into
// absolute virtual-screen coords. Lets agents pass coords directly from a
// cropped focus-region screenshot (where 0,0 = top-left of the selection)
// without doing the (focus.x + relX) math themselves. Returns absolute
// coords and the space resolution that actually happened.
function resolveSpaceXY(rawX: number, rawY: number, space: string | undefined, monitorHint?: string): { x: number; y: number; spaceUsed: string; origin?: { x: number; y: number } } {
  const s = (space || '').toLowerCase();
  if (s === 'focus') {
    if (!desktopFocus) {
      throw new Error('space=focus requires an active agent-focus region (desktop_select_region)');
    }
    touchDesktopFocus(); // real scoped use → keep the region alive (idle-revoke)
    return { x: rawX + desktopFocus.x, y: rawY + desktopFocus.y, spaceUsed: 'focus', origin: { x: desktopFocus.x, y: desktopFocus.y } };
  }
  // 'monitor' is handled by the click PS itself when a monitor is supplied
  // (legacy behavior). Other values fall through as absolute desktop coords.
  return { x: rawX, y: rawY, spaceUsed: s || 'desktop' };
}

function calibratedXY(rawX: number, rawY: number, skip: boolean): { x: number; y: number; applied: boolean; delta?: { x: number; y: number } } {
  if (skip) return { x: rawX, y: rawY, applied: false };
  const r = applyCalibration(rawX, rawY);
  return { x: r.x, y: r.y, applied: r.applied, delta: r.delta };
}

async function desktopPointerShow(cmd: BridgeCommand): Promise<any> {
  if (process.platform !== 'win32') throw new Error('desktop_pointer_show is Windows-only');
  const inX = Math.round(Number((cmd as any).x));
  const inY = Math.round(Number((cmd as any).y));
  if (!Number.isFinite(inX) || !Number.isFinite(inY)) throw new Error('desktop_pointer_show: x and y are required');
  const sp = resolveSpaceXY(inX, inY, (cmd as any).space);
  const skipCal = (cmd as any).noCalibration === true;
  const c = calibratedXY(sp.x, sp.y, skipCal);
  const label = String((cmd as any).label ?? '').slice(0, 80);
  desktopPointer = { x: c.x, y: c.y, visible: true, label, pulseAt: 0 };
  writePointerFile();
  spawnPointerOverlay();
  return { pointer: desktopPointer, requested: { x: inX, y: inY }, space: sp.spaceUsed, origin: sp.origin, calibrationApplied: c.applied, delta: c.delta };
}

async function desktopPointerMove(cmd: BridgeCommand): Promise<any> {
  if (process.platform !== 'win32') throw new Error('desktop_pointer_move is Windows-only');
  const inX = Math.round(Number((cmd as any).x));
  const inY = Math.round(Number((cmd as any).y));
  if (!Number.isFinite(inX) || !Number.isFinite(inY)) throw new Error('desktop_pointer_move: x and y are required');
  const sp = resolveSpaceXY(inX, inY, (cmd as any).space);
  const skipCal = (cmd as any).noCalibration === true;
  const c = calibratedXY(sp.x, sp.y, skipCal);
  const labelArg = (cmd as any).label;
  if (!desktopPointer) {
    desktopPointer = { x: c.x, y: c.y, visible: true, label: typeof labelArg === 'string' ? labelArg.slice(0, 80) : '', pulseAt: 0 };
  } else {
    desktopPointer = {
      ...desktopPointer,
      x: c.x, y: c.y,
      visible: true,
      label: typeof labelArg === 'string' ? labelArg.slice(0, 80) : desktopPointer.label,
    };
  }
  writePointerFile();
  spawnPointerOverlay();
  return { pointer: desktopPointer, requested: { x: inX, y: inY }, space: sp.spaceUsed, origin: sp.origin, calibrationApplied: c.applied, delta: c.delta };
}

async function desktopPointerPulse(cmd: BridgeCommand): Promise<any> {
  if (process.platform !== 'win32') throw new Error('desktop_pointer_pulse is Windows-only');
  if (!desktopPointer) throw new Error('desktop_pointer_pulse: no pointer shown — call desktop_pointer_show first');
  const xArg = (cmd as any).x;
  const yArg = (cmd as any).y;
  if (xArg !== undefined && yArg !== undefined) {
    const sp = resolveSpaceXY(Math.round(Number(xArg)), Math.round(Number(yArg)), (cmd as any).space);
    const skipCal = (cmd as any).noCalibration === true;
    const c = calibratedXY(sp.x, sp.y, skipCal);
    desktopPointer.x = c.x;
    desktopPointer.y = c.y;
  }
  desktopPointer.visible = true;
  desktopPointer.pulseAt = Date.now();
  writePointerFile();
  spawnPointerOverlay();
  return { pointer: desktopPointer };
}

async function desktopPointerHide(): Promise<any> {
  const prev = desktopPointer;
  clearDesktopPointer();
  return { hidden: !!prev, previous: prev };
}

// Match the cell step the axis-grid screenshot uses: max(width,height) / 16,
// clamped to [20, 200]. Single source of truth so click_cell and the grid
// renderer agree on cell layout.
function focusCellStep(width: number, height: number): number {
  const dim = Math.max(width, height);
  return Math.max(20, Math.min(200, Math.round(dim / 16)));
}

function focusCellCenterAbs(col: number, row: number, subX: number, subY: number): { x: number; y: number; step: number; cellW: number; cellH: number } {
  if (!desktopFocus) throw new Error('cell addressing requires an active agent-focus region');
  touchDesktopFocus(); // real scoped use → keep the region alive (idle-revoke)
  const step = focusCellStep(desktopFocus.width, desktopFocus.height);
  // 1-indexed columns/rows to match the on-screen pill labels (which start at 1).
  // sub offset in [-0.5, 0.5] of a cell — 0 = center.
  const sx = Math.max(-0.5, Math.min(0.5, Number(subX) || 0));
  const sy = Math.max(-0.5, Math.min(0.5, Number(subY) || 0));
  const relX = ((col - 1) + 0.5 + sx) * step;
  const relY = ((row - 1) + 0.5 + sy) * step;
  return {
    x: Math.round(desktopFocus.x + relX),
    y: Math.round(desktopFocus.y + relY),
    step,
    cellW: step,
    cellH: step,
  };
}

async function desktopClickCell(cmd: BridgeCommand): Promise<any> {
  const col = Math.round(Number((cmd as any).col));
  const row = Math.round(Number((cmd as any).row));
  if (!Number.isFinite(col) || !Number.isFinite(row) || col < 1 || row < 1) {
    throw new Error('desktop_click_cell requires positive integer col and row (1-indexed)');
  }
  const subX = Number((cmd as any).subX ?? 0);
  const subY = Number((cmd as any).subY ?? 0);
  const c = focusCellCenterAbs(col, row, subX, subY);
  const clickCmd: any = {
    type: 'desktop_click',
    x: c.x, y: c.y,
    space: 'desktop',
    button: (cmd as any).button || 'left',
    double: !!(cmd as any).double,
  };
  const result = await desktopClick(clickCmd);
  return { ...result, cell: { col, row, subX, subY }, step: c.step, target: { x: c.x, y: c.y } };
}

async function desktopPointerCell(cmd: BridgeCommand): Promise<any> {
  const col = Math.round(Number((cmd as any).col));
  const row = Math.round(Number((cmd as any).row));
  if (!Number.isFinite(col) || !Number.isFinite(row) || col < 1 || row < 1) {
    throw new Error('desktop_pointer_cell requires positive integer col and row (1-indexed)');
  }
  const subX = Number((cmd as any).subX ?? 0);
  const subY = Number((cmd as any).subY ?? 0);
  const c = focusCellCenterAbs(col, row, subX, subY);
  const showCmd: any = {
    type: 'desktop_pointer_show',
    x: c.x, y: c.y,
    label: (cmd as any).label,
    space: 'desktop',
  };
  const result = await desktopPointerShow(showCmd);
  return { ...result, cell: { col, row, subX, subY }, step: c.step };
}

function desktopPointerStatus(): any {
  return {
    active: !!desktopPointer,
    pointer: desktopPointer,
    overlayRunning: !!(desktopPointerProc && desktopPointerProc.exitCode === null),
  };
}

// ─── Browser-page ↔ physical-screen coordinate mapping ───────────
//
// Maps a CSS-viewport point in the bridge's own Chrome to a physical
// virtual-screen pixel so a REAL OS click / ghost cursor (desktop_click /
// desktop_pointer_show) lands exactly on a page element — no hand-rolled
// per-session calibration. Validated to the pixel on mixed-DPI multi-monitor.
//
//   physical = contentOrigin + css * DPR
//
// then desktop_click applies the persisted per-monitor click calibration as
// the final hop. contentOrigin is the Chrome render-widget child window's
// physical rect — NOT window.screenX/Y, which live in a global *logical*
// coordinate space (each monitor placed at its scaled size) that breaks the
// naive screenX*DPR formula across mixed-DPI monitors. The correct window is
// picked by size fingerprint (innerW*DPR, innerH*DPR) among all Chrome render
// widgets, with the foreground window as tiebreak. DPI-aware so GetWindowRect
// returns physical pixels.
const CHROME_CONTENT_RECTS_PS = `
$ErrorActionPreference='Continue'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class E3CW {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
try { [E3CW]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch { try { [E3CW]::SetProcessDPIAware() | Out-Null } catch {} }
$fg = [E3CW]::GetForegroundWindow()
$out = New-Object System.Collections.ArrayList
$script:curTop = [IntPtr]::Zero
$childCb = [E3CW+EnumProc]{ param($h,$l)
  $sb = New-Object System.Text.StringBuilder 128
  [E3CW]::GetClassName($h,$sb,128) | Out-Null
  if ($sb.ToString() -eq 'Chrome_RenderWidgetHostHWND') {
    $r = New-Object E3CW+RECT
    if ([E3CW]::GetWindowRect($h,[ref]$r)) {
      $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
      if ($w -gt 0 -and $hh -gt 0) {
        [void]$out.Add([pscustomobject]@{ x=$r.Left; y=$r.Top; w=$w; h=$hh; fg=($script:curTop -eq $fg) })
      }
    }
  }
  return $true
}
$topCb = [E3CW+EnumProc]{ param($h,$l)
  if (-not [E3CW]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 128
  [E3CW]::GetClassName($h,$sb,128) | Out-Null
  if ($sb.ToString() -eq 'Chrome_WidgetWin_1') {
    $script:curTop = $h
    [E3CW]::EnumChildWindows($h,$childCb,[IntPtr]::Zero) | Out-Null
  }
  return $true
}
[E3CW]::EnumWindows($topCb,[IntPtr]::Zero) | Out-Null
$out | ConvertTo-Json -Compress -Depth 4
`;

interface ChromeContentRect { x: number; y: number; dpr: number; rect: any; candidates: number }

async function getChromeContentRect(): Promise<ChromeContentRect> {
  if (process.platform !== 'win32') throw new Error('page coordinate mapping is Windows-only');
  // Raise + un-minimize the bridge Chrome window so (a) the foreground tiebreak
  // prefers it and (b) a subsequent real click can't be intercepted by an
  // overlapping window. /show is a no-op navigation that just brings to front.
  try { await cdpPost('/show', {}); } catch {}
  const geoRaw = await cdpPost('/evaluate', { expression: 'JSON.stringify({dpr:window.devicePixelRatio,iw:window.innerWidth,ih:window.innerHeight})' });
  let dpr = 1, iw = 0, ih = 0;
  try { const g = JSON.parse(geoRaw?.result ?? geoRaw); dpr = Number(g.dpr) || 1; iw = Number(g.iw) || 0; ih = Number(g.ih) || 0; } catch {}
  if (!iw || !ih) throw new Error('page_to_screen: could not read viewport size from the page');
  const targetW = iw * dpr, targetH = ih * dpr;
  const raw = await runPowerShellJson(CHROME_CONTENT_RECTS_PS);
  const rects: any[] = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  // Size fingerprint: the bridge tab's content widget is the one whose physical
  // size matches innerW*DPR / innerH*DPR (a few px tolerance for rounding).
  const TOL = 4;
  const sized = rects.filter(r => Math.abs(Number(r.w) - targetW) <= TOL && Math.abs(Number(r.h) - targetH) <= TOL);
  const pick = sized.find(r => r.fg) || sized[0] || null;
  if (!pick) {
    throw new Error(`page_to_screen: could not locate the bridge Chrome content window (expected ~${Math.round(targetW)}x${Math.round(targetH)}px among ${rects.length} render widget(s); is the window off-screen or fully covered?)`);
  }
  return { x: Number(pick.x), y: Number(pick.y), dpr, rect: pick, candidates: rects.length };
}

async function resolvePageCssPoint(cmd: any): Promise<{ cssX: number; cssY: number; via: string; rect?: any }> {
  const hasXY = Number.isFinite(Number(cmd?.cssX)) && Number.isFinite(Number(cmd?.cssY));
  if (hasXY) return { cssX: Number(cmd.cssX), cssY: Number(cmd.cssY), via: 'cssXY' };
  const selector = cmd?.selector
    ? String(cmd.selector)
    : (cmd?.ref ? `[data-empir3-ref="${String(cmd.ref).replace(/"/g, '\\"')}"]` : '');
  if (!selector) throw new Error('page coords require one of: selector, ref, or cssX+cssY');
  const r = await cdpPost('/evaluate', { expression: `(function(){
    var el=document.querySelector(${JSON.stringify(selector)});
    if(!el) return JSON.stringify({found:false});
    var b=el.getBoundingClientRect();
    if(b.width<=0&&b.height<=0) return JSON.stringify({found:false,reason:'zero-size'});
    return JSON.stringify({found:true,cx:b.left+b.width/2,cy:b.top+b.height/2,rect:{x:b.left,y:b.top,w:b.width,h:b.height}});
  })()` });
  let parsed: any = {};
  try { parsed = JSON.parse(r?.result ?? r); } catch {}
  if (!parsed || !parsed.found) throw new Error(`page coords: no visible element matched ${selector}`);
  return { cssX: Number(parsed.cx), cssY: Number(parsed.cy), via: cmd?.ref ? 'ref' : 'selector', rect: parsed.rect };
}

async function pageToScreen(cmd: any): Promise<any> {
  const pt = await resolvePageCssPoint(cmd);
  const content = await getChromeContentRect();
  const screenX = Math.round(content.x + pt.cssX * content.dpr);
  const screenY = Math.round(content.y + pt.cssY * content.dpr);
  const cal = applyCalibration(screenX, screenY);
  return {
    screenX, screenY,            // where the element sits on screen (intended physical px)
    sendX: cal.x, sendY: cal.y,  // calibrated coord a real desktop_click would dispatch
    css: { x: pt.cssX, y: pt.cssY },
    dpr: content.dpr,
    via: pt.via,
    contentOrigin: { x: content.x, y: content.y },
    elementRect: pt.rect,
    calibrationApplied: cal.applied,
    candidates: content.candidates,
    coordinateSpace: 'physical-virtual-screen',
  };
}

async function desktopClickPage(cmd: any): Promise<any> {
  if (process.platform !== 'win32') throw new Error('desktop_click_page is Windows-only');
  const map = await pageToScreen(cmd);
  // Feed the INTENDED physical coord to desktopClick, which applies the
  // persisted per-monitor calibration itself — don't double-calibrate.
  const click = await desktopClick({ type: 'desktop_click', x: map.screenX, y: map.screenY, button: cmd?.button, double: !!cmd?.double } as any);
  return { ...click, page: { css: map.css, via: map.via, dpr: map.dpr, screen: { x: map.screenX, y: map.screenY }, contentOrigin: map.contentOrigin } };
}

async function desktopPointerPage(cmd: any): Promise<any> {
  if (process.platform !== 'win32') throw new Error('desktop_pointer_page is Windows-only');
  const map = await pageToScreen(cmd);
  const res = await desktopPointerShow({ type: 'desktop_pointer_show', x: map.screenX, y: map.screenY, label: cmd?.label } as any);
  return { ...res, page: { css: map.css, via: map.via, dpr: map.dpr, screen: { x: map.screenX, y: map.screenY } } };
}

// ─── Click calibration (v2: multi-point per-monitor) ─────
//
// One capture PS script per monitor. It paints N target crosshairs on the
// monitor's overlay; the user clicks each in sequence. Bridge fits an
// affine transform per axis: actual = scale * requested + offset. The
// transform is stored per monitor id and consulted by every desktop_click
// (and optionally desktop_pointer_*) before the OS call.
//
// Why per-axis affine instead of a single offset: it catches DPI / scaling
// mismatches that produce a tilt across the screen (offset at left edge
// differs from offset at right edge), not just a uniform shift.

const DESKTOP_CALIBRATE_CAPTURE_PS = `param(
  [Parameter(Mandatory=$true)] [string]$MonitorId,
  [Parameter(Mandatory=$true)] [int]$MonX,
  [Parameter(Mandatory=$true)] [int]$MonY,
  [Parameter(Mandatory=$true)] [int]$MonW,
  [Parameter(Mandatory=$true)] [int]$MonH,
  [Parameter(Mandatory=$true)] [string]$TargetsJson,
  [Parameter(Mandatory=$true)] [string]$OutputJson
)
$ErrorActionPreference = 'Continue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Empir3CalDPI {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
try { [Empir3CalDPI]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
  try { [Empir3CalDPI]::SetProcessDPIAware() | Out-Null } catch {}
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$targets = ConvertFrom-Json $TargetsJson
$script:results = New-Object System.Collections.ArrayList
$script:index = 0
$script:cancelled = $false

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($MonX, $MonY)
$form.Size = New-Object System.Drawing.Size($MonW, $MonH)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::Black
# Darker veil (0.55) makes the bright green targets pop and focuses the user's
# eye; the targets themselves are drawn with opaque colors so they render at
# full strength against the dim backdrop.
$form.Opacity = 0.55
$form.Cursor = [System.Windows.Forms.Cursors]::Cross
$form.KeyPreview = $true

# Pulse timer for the active target ring
$script:pulseTick = 0
$pulseTimer = New-Object System.Windows.Forms.Timer
$pulseTimer.Interval = 50
$pulseTimer.Add_Tick({ $script:pulseTick = ($script:pulseTick + 1) % 100; $form.Invalidate() })
$pulseTimer.Start()

$panel = New-Object System.Windows.Forms.Panel
$panel.Dock = 'Fill'
$panel.BackColor = [System.Drawing.Color]::Transparent
$panel.Add_MouseDown({ param($s,$e)
  if ($e.Button -ne 'Left') { return }
  if ($script:index -ge $targets.Count) { return }
  $absX = $e.X + $form.Location.X
  $absY = $e.Y + $form.Location.Y
  $t = $targets[$script:index]
  [void]$script:results.Add(@{
    targetX = [int]$t.x; targetY = [int]$t.y
    clickX = [int]$absX; clickY = [int]$absY
  })
  $script:index++
  if ($script:index -ge $targets.Count) {
    $form.Close()
  } else {
    $form.Invalidate()
  }
})
$form.Controls.Add($panel)
$form.Add_KeyDown({ param($s,$e)
  if ($e.KeyCode -eq 'Escape') { $script:cancelled = $true; $form.Close() }
})
$form.Add_Paint({ param($s,$e)
  $g = $e.Graphics
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'ClearTypeGridFit'

  # Draw all targets — completed (dim green), upcoming (faint outline),
  # active (bold + pulsing ring).
  $i = 0
  foreach ($t in $targets) {
    $cx = [int]$t.x - $form.Location.X
    $cy = [int]$t.y - $form.Location.Y
    $state = if ($i -lt $script:index) { 'done' } elseif ($i -eq $script:index) { 'active' } else { 'pending' }
    if ($state -eq 'done') {
      $col = [System.Drawing.Color]::FromArgb(255, 80, 180, 110)
      $pen = New-Object System.Drawing.Pen $col, 2
      $g.DrawLine($pen, [Single]($cx - 10), [Single]$cy, [Single]($cx + 10), [Single]$cy)
      $g.DrawLine($pen, [Single]$cx, [Single]($cy - 10), [Single]$cx, [Single]($cy + 10))
      $pen.Dispose()
    } elseif ($state -eq 'pending') {
      # Brighter + thicker than before so upcoming targets are clearly visible
      # against the dim veil (was alpha 140 / 1px — nearly invisible).
      $col = [System.Drawing.Color]::FromArgb(235, 210, 230, 210)
      $pen = New-Object System.Drawing.Pen $col, 2
      $g.DrawEllipse($pen, [Single]($cx - 11), [Single]($cy - 11), 22, 22)
      $dotBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 210, 230, 210))
      $g.FillEllipse($dotBrush, [Single]($cx - 3), [Single]($cy - 3), 6, 6)
      $dotBrush.Dispose(); $pen.Dispose()
    } else {
      # Active: large bullseye + crosshair + pulsing outer ring + number badge.
      # A dark halo is drawn under the bright lines so the target stays high
      # contrast over both light and dark content behind the veil.
      $col = [System.Drawing.Color]::FromArgb(255, 100, 220, 140)
      $whi = [System.Drawing.Color]::White
      $haloCol = [System.Drawing.Color]::FromArgb(220, 0, 0, 0)
      $haloPen = New-Object System.Drawing.Pen $haloCol, 6
      $pen = New-Object System.Drawing.Pen $col, 4
      $whitePen = New-Object System.Drawing.Pen $whi, 2
      $g.DrawLine($haloPen, [Single]($cx - 34), [Single]$cy, [Single]($cx + 34), [Single]$cy)
      $g.DrawLine($haloPen, [Single]$cx, [Single]($cy - 34), [Single]$cx, [Single]($cy + 34))
      $g.DrawEllipse($haloPen, [Single]($cx - 24), [Single]($cy - 24), 48, 48)
      $g.DrawEllipse($pen, [Single]($cx - 24), [Single]($cy - 24), 48, 48)
      $g.DrawLine($whitePen, [Single]($cx - 34), [Single]$cy, [Single]($cx + 34), [Single]$cy)
      $g.DrawLine($whitePen, [Single]$cx, [Single]($cy - 34), [Single]$cx, [Single]($cy + 34))
      $fill = New-Object System.Drawing.SolidBrush $col
      $g.FillEllipse($fill, [Single]($cx - 5), [Single]($cy - 5), 10, 10)
      $fill.Dispose(); $haloPen.Dispose()
      # Pulse ring (animated)
      $t01 = ($script:pulseTick % 30) / 30.0
      $rr = 28 + ($t01 * 40)
      $alpha = [int](220 * (1 - $t01))
      if ($alpha -lt 0) { $alpha = 0 }
      $pulsePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($alpha, 100, 220, 140)), 3
      $g.DrawEllipse($pulsePen, [Single]($cx - $rr), [Single]($cy - $rr), [Single]($rr * 2), [Single]($rr * 2))
      $pulsePen.Dispose()
      # "Click here N/M" label below the bullseye so the user can't possibly
      # miss which one to click on a multi-monitor / multi-point flow.
      $numLabel = "Click here  $($script:index + 1) / $($targets.Count)"
      $numFont = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
      $numSize = $g.MeasureString($numLabel, $numFont)
      $padX = 12; $padY = 6
      $lblW = $numSize.Width + ($padX * 2)
      $lblH = $numSize.Height + ($padY * 2)
      $lx = $cx - ($lblW / 2)
      $ly = $cy + 48
      $lblBg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(245, 12, 16, 26))
      $lblFg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
      $lblBdr = New-Object System.Drawing.Pen $col, 2
      $lblRect = New-Object System.Drawing.RectangleF ([Single]$lx, [Single]$ly, [Single]$lblW, [Single]$lblH)
      $g.FillRectangle($lblBg, $lblRect)
      $g.DrawRectangle($lblBdr, [Single]$lx, [Single]$ly, [Single]$lblW, [Single]$lblH)
      $g.DrawString($numLabel, $numFont, $lblFg, [Single]($lx + $padX), [Single]($ly + $padY))
      $lblBg.Dispose(); $lblFg.Dispose(); $lblBdr.Dispose(); $numFont.Dispose()
      $pen.Dispose(); $whitePen.Dispose()
    }
    $i++
  }

  # Top-center banner with progress + monitor id
  $done = $script:index
  $total = $targets.Count
  $title = "Click each green target ($done of $total)"
  $sub = "Calibrating monitor $MonitorId.   Click directly on the bullseye.   Esc to cancel."
  $titleFont = New-Object System.Drawing.Font('Segoe UI', 22, [System.Drawing.FontStyle]::Bold)
  $subFont = New-Object System.Drawing.Font('Segoe UI Semibold', 13, [System.Drawing.FontStyle]::Regular)
  $titleSize = $g.MeasureString($title, $titleFont)
  $subSize = $g.MeasureString($sub, $subFont)
  $bannerW = [Math]::Max($titleSize.Width, $subSize.Width) + 80
  $bannerH = $titleSize.Height + $subSize.Height + 50
  $bx = [int](($MonW - $bannerW) / 2)
  $by = 64
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(240, 12, 16, 26))
  $fg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $sub2 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 200, 215, 200))
  $border = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 100, 220, 140)), 2
  $bgRect = New-Object System.Drawing.RectangleF ([Single]$bx, [Single]$by, [Single]$bannerW, [Single]$bannerH)
  $g.FillRectangle($bg, $bgRect)
  $g.DrawRectangle($border, [Single]$bx, [Single]$by, [Single]$bannerW, [Single]$bannerH)
  $g.DrawString($title, $titleFont, $fg, [Single]($bx + 40), [Single]($by + 16))
  $g.DrawString($sub, $subFont, $sub2, [Single]($bx + 40), [Single]($by + 16 + $titleSize.Height + 8))
  $titleFont.Dispose(); $subFont.Dispose(); $bg.Dispose(); $fg.Dispose(); $sub2.Dispose(); $border.Dispose()
})
[System.Windows.Forms.Application]::Run($form)
$pulseTimer.Stop()
$out = @{ monitorId = $MonitorId; cancelled = $script:cancelled; results = $script:results }
$out | ConvertTo-Json -Depth 5 | Set-Content -Path $OutputJson -Encoding UTF8
`;

function buildTargetsForMonitor(bounds: { x: number; y: number; width: number; height: number }): Array<{ x: number; y: number }> {
  // 5-point pattern: inset corners + center. Top inset is larger because the
  // instruction banner sits at y=64 with ~140px height; using a uniform 12%
  // inset on a 2160-tall monitor put the top targets at y=259, UNDER the
  // banner — user couldn't see them and clicked elsewhere, poisoning the fit.
  // 25% horizontal + (banner-aware) vertical keeps targets visible.
  const ix = Math.round(bounds.width * 0.25);
  const iyTop = Math.max(Math.round(bounds.height * 0.25), 280);    // below banner
  const iyBottom = Math.round(bounds.height * 0.20);
  return [
    { x: bounds.x + ix, y: bounds.y + iyTop },
    { x: bounds.x + bounds.width - ix, y: bounds.y + iyTop },
    { x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) },
    { x: bounds.x + ix, y: bounds.y + bounds.height - iyBottom },
    { x: bounds.x + bounds.width - ix, y: bounds.y + bounds.height - iyBottom },
  ];
}

function fitAxis(pairs: Array<{ req: number; act: number }>): { scale: number; offset: number } {
  if (pairs.length === 0) return { scale: 1, offset: 0 };
  if (pairs.length === 1) return { scale: 1, offset: pairs[0].act - pairs[0].req };
  const n = pairs.length;
  const meanR = pairs.reduce((s, p) => s + p.req, 0) / n;
  const meanA = pairs.reduce((s, p) => s + p.act, 0) / n;
  let num = 0, den = 0;
  for (const p of pairs) {
    num += (p.req - meanR) * (p.act - meanA);
    den += (p.req - meanR) ** 2;
  }
  const scale = den > 0 ? num / den : 1;
  const offset = meanA - scale * meanR;
  return { scale, offset };
}

async function captureMonitorCalibration(monitor: any): Promise<any> {
  const dir = join(FEEDBACK_DIR, 'desktop');
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, '_calibrate-multi.ps1');
  const outPath = join(dir, `_calibrate-${monitor.id}-${Date.now()}.json`);
  writeFileSync(scriptPath, DESKTOP_CALIBRATE_CAPTURE_PS, 'utf-8');
  const targets = buildTargetsForMonitor(monitor.bounds);
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', scriptPath,
      '-MonitorId', String(monitor.id),
      '-MonX', String(monitor.bounds.x),
      '-MonY', String(monitor.bounds.y),
      '-MonW', String(monitor.bounds.width),
      '-MonH', String(monitor.bounds.height),
      '-TargetsJson', JSON.stringify(targets),
      '-OutputJson', outPath,
    ], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} reject(new Error(`calibrate (${monitor.id}) timed out after 120s`)); }, 120000);
    proc.on('exit', () => {
      clearTimeout(timer);
      try {
        if (!existsSync(outPath)) return resolve({ cancelled: true, results: [] });
        const data = JSON.parse(readFileSync(outPath, 'utf-8').replace(/^\uFEFF/, ''));
        try { unlinkSync(outPath); } catch {}
        resolve(data);
      } catch (e: any) { reject(e); }
    });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function desktopCalibratePointer(cmd: BridgeCommand): Promise<any> {
  if (process.platform !== 'win32') throw new Error('desktop_calibrate_pointer is Windows-only');
  const persist = (cmd as any).persist !== false;
  // When agent-focus is active, default to calibrating WITHIN the focus
  // region (tighter targets → fit specific to where the user actually wants
  // accuracy, smaller overlay disruption, fewer clicks). Caller can override
  // by passing area:"monitor" or area:"all".
  const areaArg = String((cmd as any).area ?? '').toLowerCase();
  const which = areaArg === 'all' ? 'all' : String((cmd as any).monitor ?? 'primary');
  const useFocus = areaArg === 'focus' || (areaArg === '' && !!desktopFocus && which === 'primary');

  const monRes = await getDesktopMonitors();
  const allMonitors: any[] = Array.isArray(monRes?.monitors) ? monRes.monitors : [];
  if (allMonitors.length === 0) throw new Error('desktop_calibrate_pointer: no monitors detected');

  let targetMonitors: any[];
  if (useFocus) {
    if (!desktopFocus) throw new Error('desktop_calibrate_pointer: area="focus" requires an active agent-focus region');
    // Pseudo-monitor whose bounds == focus region; key the saved fit by the
    // physical monitor that contains the focus center so existing apply-by-
    // monitor lookup still works.
    const focusCenterX = desktopFocus.x + Math.round(desktopFocus.width / 2);
    const focusCenterY = desktopFocus.y + Math.round(desktopFocus.height / 2);
    const physical = allMonitors.find(m =>
      focusCenterX >= m.bounds.x && focusCenterX < m.bounds.x + m.bounds.width &&
      focusCenterY >= m.bounds.y && focusCenterY < m.bounds.y + m.bounds.height
    ) || allMonitors.find(m => m.primary) || allMonitors[0];
    targetMonitors = [{
      id: physical.id, // store under the real monitor id for lookup
      bounds: { x: desktopFocus.x, y: desktopFocus.y, width: desktopFocus.width, height: desktopFocus.height },
      primary: physical.primary,
      _focusScoped: true,
      _focusRegion: { x: desktopFocus.x, y: desktopFocus.y, width: desktopFocus.width, height: desktopFocus.height },
      _physicalMonitor: physical.id,
    }];
  } else if (which === 'all') {
    targetMonitors = allMonitors;
  } else if (which === 'primary' || which === '') {
    targetMonitors = [allMonitors.find(m => m.primary) || allMonitors[0]];
  } else {
    const m = allMonitors.find(x => x.id === which || x.deviceName === which);
    if (!m) throw new Error(`desktop_calibrate_pointer: monitor not found: ${which}`);
    targetMonitors = [m];
  }

  // Load existing calibration so we preserve other monitors when calibrating one
  let existing: any = {};
  try {
    const settings = readBridgeSettings();
    existing = (settings as any).desktopCalibration || {};
  } catch {}
  const monitorsMap: Record<string, any> = (existing.version === 2 && existing.monitors) ? { ...existing.monitors } : {};

  const perMonitorResults: any[] = [];
  let anyCaptured = false;
  for (const mon of targetMonitors) {
    const cap = await captureMonitorCalibration(mon);
    if (cap.cancelled && (!cap.results || cap.results.length === 0)) {
      perMonitorResults.push({ monitor: mon.id, cancelled: true });
      continue;
    }
    const allPoints = cap.results || [];
    if (allPoints.length === 0) {
      perMonitorResults.push({ monitor: mon.id, cancelled: true });
      continue;
    }
    // Outlier rejection: a single mis-click (target obscured, user clicked
    // elsewhere) can ruin the affine fit and make EVERY subsequent click
    // worse than no calibration. Drop any point whose displacement
    // (|click - target|) is grossly inconsistent with the rest, then refit.
    // Strategy: compute deltas, drop points where either axis delta is
    // > 4× the median absolute deviation from the median delta (or > 80px,
    // whichever is larger — handles the case where all points are accurate
    // and MAD ~= 0).
    const deltas = allPoints.map((p: any) => ({ p, dx: p.clickX - p.targetX, dy: p.clickY - p.targetY }));
    const median = (arr: number[]) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    const medDx = median(deltas.map((d: any) => d.dx));
    const medDy = median(deltas.map((d: any) => d.dy));
    const madDx = median(deltas.map((d: any) => Math.abs(d.dx - medDx)));
    const madDy = median(deltas.map((d: any) => Math.abs(d.dy - medDy)));
    const thresholdX = Math.max(80, madDx * 4);
    const thresholdY = Math.max(80, madDy * 4);
    const kept = deltas.filter((d: any) => Math.abs(d.dx - medDx) <= thresholdX && Math.abs(d.dy - medDy) <= thresholdY).map((d: any) => d.p);
    const rejected = allPoints.length - kept.length;
    if (kept.length < 2) {
      // Not enough good points to fit; skip this monitor and surface why
      perMonitorResults.push({ monitor: mon.id, rejected, error: 'not enough consistent points to fit (need at least 2 after outlier rejection)' });
      continue;
    }
    const xPairs = kept.map((p: any) => ({ req: p.targetX, act: p.clickX }));
    const yPairs = kept.map((p: any) => ({ req: p.targetY, act: p.clickY }));
    const fit = { axisX: fitAxis(xPairs), axisY: fitAxis(yPairs) };
    // Sanity check: scale should be very close to 1.0 (we expect <2% drift
    // even with extreme DPI mismatches). If it's not, the fit is suspect.
    const scaleOk = Math.abs(fit.axisX.scale - 1) < 0.05 && Math.abs(fit.axisY.scale - 1) < 0.05;
    if (!scaleOk) {
      perMonitorResults.push({ monitor: mon.id, rejected, error: `fitted scale out of range (axisX=${fit.axisX.scale.toFixed(3)}, axisY=${fit.axisY.scale.toFixed(3)}) — rerun calibration` });
      continue;
    }
    const residual = kept.reduce((sum: number, p: any) => {
      const fx = fit.axisX.scale * p.targetX + fit.axisX.offset;
      const fy = fit.axisY.scale * p.targetY + fit.axisY.offset;
      return sum + Math.hypot(fx - p.clickX, fy - p.clickY);
    }, 0) / kept.length;
    monitorsMap[mon.id] = {
      bounds: mon.bounds,
      targets: kept,
      rejected,
      fit,
      residualPx: Math.round(residual * 100) / 100,
      capturedAt: new Date().toISOString(),
      ...(mon._focusScoped ? { focusScoped: true, focusRegion: mon._focusRegion } : {}),
    };
    perMonitorResults.push({ monitor: mon.id, captured: kept.length, rejected, fit, residualPx: monitorsMap[mon.id].residualPx, focusScoped: !!mon._focusScoped });
    anyCaptured = true;
  }

  if (!anyCaptured) {
    return { success: false, ok: false, cancelled: true, calibration: null, perMonitor: perMonitorResults };
  }

  const calibration = { version: 2, monitors: monitorsMap, capturedAt: new Date().toISOString() };
  if (persist) {
    try {
      const settings = readBridgeSettings();
      (settings as any).desktopCalibration = calibration;
      saveBridgeSettings(settings);
    } catch (e: any) {
      return { success: true, ok: true, persisted: false, error: e?.message || String(e), calibration, perMonitor: perMonitorResults };
    }
  }
  return { success: true, ok: true, persisted: persist, calibration, perMonitor: perMonitorResults };
}

async function desktopScreenshotZoom(params: any): Promise<any> {
  const inX = Math.round(Number(params?.x));
  const inY = Math.round(Number(params?.y));
  if (!Number.isFinite(inX) || !Number.isFinite(inY)) {
    throw new Error('desktop_screenshot_zoom requires numeric x and y');
  }
  const sp = resolveSpaceXY(inX, inY, params?.space);
  const cx = sp.x, cy = sp.y;
  const r = Math.max(20, Math.min(800, Math.round(Number(params?.radius ?? 100))));
  const region = { x: cx - r, y: cy - r, width: r * 2, height: r * 2 };
  // Marker at center so the returned image shows the exact point the caller
  // was inspecting — useful for visual coord targeting.
  const markCenter = params?.noMarker !== true;
  const marker = markCenter ? [{ x: cx, y: cy, label: '', color: '#64DC8C', size: 10 }] : undefined;
  // Default to a dense grid overlay so the caller can refine coords from the
  // returned image without another zoom. Labels are LOCAL (top-left of crop
  // = 0,0) when no focus context is provided, FOCUS-RELATIVE when space="focus"
  // — bridge handles labels='local' here either way, then caller adds focus
  // origin themselves if needed.
  let gridArg: any = params?.grid;
  if (gridArg === undefined) {
    // step shrinks with crop size so labels stay readable; clamp at 10..50
    const step = Math.max(10, Math.min(50, Math.round(r / 6)));
    // "local" labels print the full "x,y" pair at each labeled intersection,
    // which is ~60-90px wide. Label every Nth line so the spacing between
    // labels stays ≥ ~90px and adjacent labels don't run together (the
    // "4,844,84,124…" overlap seen at small steps).
    const labelEvery = Math.max(1, Math.round(90 / step));
    gridArg = { step, labels: 'local', labelEvery };
  } else if (gridArg === false || gridArg === null) {
    gridArg = undefined;
  }
  const shot = await takeDesktopScreenshot('all', region, gridArg, marker as any);
  // Mirror the `screenshot` action: include the base64 payload in the relay
  // envelope. Without this the zoom returned only bridge-local file paths
  // (captures[].path / stitchedPath), which the Empir3 server can't save to the
  // project workspace — so the agent fed a bridge path to see_image and got
  // "couldn't read feedback/desktop/…-region-…png". With bytes present the
  // server saves the zoom to the workspace and advertises a real see_image path.
  const first = shot?.captures?.[0];
  const imagePath = first?.path || shot?.stitchedPath;
  const prepared = imagePath && existsSync(imagePath) ? await prepareCompanionScreenshotPayload(imagePath, params) : null;
  const thumbnail = prepared ? prepared.buffer.toString('base64') : '';
  const imageData = {
    thumbnail,
    screenshot: thumbnail,
    base64: thumbnail,
    format: prepared?.mimeType === 'image/jpeg' ? 'jpg' : 'png',
    mimeType: prepared?.mimeType || 'image/png',
    width: prepared?.width,
    height: prepared?.height,
  };
  return { ...shot, ...imageData, center: { x: cx, y: cy }, radius: r, cropOrigin: { x: cx - r, y: cy - r }, data: imageData };
}

// Set-of-Mark snapshot: run a UIA enumeration, filter to elements that
// intersect the agent-focus region (if active) or the foreground window,
// take a focus-scoped screenshot, and draw a numbered box on each element.
// Returns the annotated image + parallel element list with the same ids.
// Agents click by id ("click 12") using desktop_click_ref — no pixel work.
async function desktopSnapshotSom(params: any): Promise<any> {
  // Always snapshot all windows so the UIA tree contains elements inside the
  // focus region even when a different window is foreground (e.g. the bridge
  // browser took focus when the agent issued the command).
  const snap = await getDesktopSnapshot({
    type: 'desktop_snapshot',
    scope: 'all-windows',
    maxElements: Math.max(20, Math.min(500, Math.round(Number(params?.maxElements ?? 200)))),
  } as any);

  const elements: any[] = Array.isArray(snap?.elements) ? snap.elements : [];

  let region: { x: number; y: number; width: number; height: number };
  if (params?.region && Number.isFinite(Number(params.region.width)) && Number.isFinite(Number(params.region.height))) {
    region = {
      x: Math.round(Number(params.region.x)),
      y: Math.round(Number(params.region.y)),
      width: Math.round(Number(params.region.width)),
      height: Math.round(Number(params.region.height)),
    };
  } else if (desktopFocus) {
    region = { x: desktopFocus.x, y: desktopFocus.y, width: desktopFocus.width, height: desktopFocus.height };
    touchDesktopFocus(); // real scoped use → keep the region alive (idle-revoke)
  } else {
    // No focus and no explicit region: use foreground window bounds from the
    // snapshot (first window listed).
    const w = Array.isArray(snap?.windows) && snap.windows.length ? snap.windows[0] : null;
    if (!w?.bounds) throw new Error('desktop_snapshot_som requires an active agent-focus region, an explicit region, or a foreground window');
    region = { x: w.bounds.x, y: w.bounds.y, width: w.bounds.width, height: w.bounds.height };
  }

  const rxR = region.x + region.width;
  const ryB = region.y + region.height;
  // Keep elements whose center is inside the region; reduces clutter from
  // off-screen siblings UIA returns.
  const inRegion = elements.filter(el => {
    const b = el?.bounds;
    if (!b) return false;
    const cx = (typeof b.cx === 'number') ? b.cx : (b.x + b.width / 2);
    const cy = (typeof b.cy === 'number') ? b.cy : (b.y + b.height / 2);
    return cx >= region.x && cx <= rxR && cy >= region.y && cy <= ryB && b.width > 4 && b.height > 4;
  });

  if (!inRegion.length) {
    return {
      ok: true,
      empty: true,
      region,
      elementCount: 0,
      note: 'UIA returned zero elements inside the region. Common for CEF/Electron/web content — OmniParser fallback not yet wired (Phase 2).',
    };
  }

  // Number boxes 1..N in document order so the agent can read "click 14"
  // instead of "click d37".
  const palette = ['#FFCC33', '#64DC8C', '#7AC8FF', '#FF8FB1', '#C8A8FF', '#FFB07A'];
  const boxes: SomBox[] = inRegion.map((el, i) => ({
    x: el.bounds.x,
    y: el.bounds.y,
    width: el.bounds.width,
    height: el.bounds.height,
    label: String(i + 1),
    color: palette[i % palette.length],
  }));

  const shot = await takeDesktopScreenshot('all', region, undefined, undefined, boxes);

  return {
    ok: true,
    snapshotId: snap?.snapshotId,
    region,
    elementCount: inRegion.length,
    elements: inRegion.map((el, i) => ({
      id: i + 1,
      ref: el.ref,
      role: el.role,
      name: el.name,
      bounds: el.bounds,
    })),
    image: shot,
  };
}

// Discoverability helper. Agent calls this with a one-line intent; we
// return the matching tool family + a short rationale + a pointer to
// docs/AGENT_GUIDE.md. The mapping is hand-curated (small surface area —
// 47 tools — so we don't need ML; keyword scoring is enough). When a query
// matches multiple intents, all matching slices come back.
const ADVISOR_INTENTS: Array<{
  patterns: RegExp[];
  title: string;
  tools: string[];
  rationale: string;
  exampleSequence?: string[];
}> = [
  {
    patterns: [/click.*(web|page|site|button|link).*by name/i, /click.*element.*website/i, /click.*on.*page/i, /click.*\b(button|link|tab)\b/i, /web.*click/i],
    title: 'Click an element on a webpage',
    tools: ['browser_snapshot', 'browser_click_ref'],
    rationale: 'browser_snapshot returns refs (e0, e1, …) with role + name + bounds. Find the one you want by name, click by ref. Survives layout shifts.',
    exampleSequence: ['browser_snapshot', 'find { role:"button", name:"Continue" }', 'browser_click_ref'],
  },
  {
    patterns: [/type|fill.*(form|field|input|textbox)/i, /enter text/i],
    title: 'Type into a form field',
    tools: ['browser_snapshot', 'browser_type_ref'],
    rationale: 'browser_type_ref uses the native value setter + input/change events. Works with React/Vue/plain HTML. Fall back to browser_type with a CSS selector if you have one.',
    exampleSequence: ['browser_snapshot', 'find { role:"input", name:"Email" }', 'browser_type_ref ref:"e5" text:"…"'],
  },
  {
    patterns: [/click.*icon|click.*small.*element|click.*toolbar|click.*menu/i, /native app|desktop app|electron|cef/i, /(photoshop|illustrator|figma|excel|word|outlook|file explorer)/i],
    title: 'Click an element in a native desktop app',
    tools: ['desktop_snapshot_som', 'desktop_click_ref'],
    rationale: 'desktop_snapshot_som draws numbered boxes on a focus-scoped screenshot AND returns the element list. You read the number off the image and click by ref. Removes pixel guessing. Best for Win32/UWP. CEF/Electron/games may return empty:true — then use the focus chess-board grid as a fallback.',
    exampleSequence: ['desktop_select_region (one-time)', 'desktop_snapshot_som', 'find { name:"Save" }', 'desktop_click_ref ref:"d3"'],
  },
  {
    patterns: [/guide.*user|tutorial|teach|show.*user|walkthrough|point at|point to|show.*where/i, /without taking.*mouse|don.*take.*control/i],
    title: 'Guide the user through something without taking their mouse',
    tools: ['desktop_pointer_show', 'desktop_pointer_move', 'desktop_pointer_pulse', 'desktop_pointer_hide'],
    rationale: 'The ghost cursor is click-through — user\'s mouse is unaffected. Combine with desktop_snapshot_som to find the target, then point at element bounds with a label like "click here".',
    exampleSequence: ['desktop_snapshot_som', 'desktop_pointer_show x,y label:"click brush tool"', 'desktop_pointer_pulse', '… user clicks …', 'desktop_pointer_hide'],
  },
  {
    patterns: [/see.*page|read.*page|extract.*text|page content/i],
    title: 'See what is on a webpage',
    tools: ['browser_text', 'browser_snapshot', 'browser_screenshot'],
    rationale: 'browser_text is cheapest. browser_snapshot gives structure + refs. browser_screenshot is only for visual confirmation.',
  },
  {
    patterns: [/see.*desktop|see.*screen|capture.*desktop|desktop.*screenshot/i, /what.*on.*screen/i],
    title: 'See what is on the desktop',
    tools: ['desktop_screenshot', 'desktop_snapshot', 'desktop_snapshot_som'],
    rationale: 'desktop_screenshot for pixels. desktop_snapshot for the UIA element tree. desktop_snapshot_som combines both — annotated screenshot + element list. Use desktop_screenshot_zoom for tight inspection of a small area.',
  },
  {
    patterns: [/focus.*region|select.*area|work.*in.*area|scope.*to/i],
    title: 'Scope work to a region the user selects',
    tools: ['desktop_select_region', 'desktop_focus_status', 'desktop_release_focus'],
    rationale: 'desktop_select_region opens a fullscreen overlay; user drags a rect; subsequent desktop_screenshot/desktop_snapshot_som auto-scope to it. Default is idle-revoke: any scoped use resets a 30-min idle timer so active work never drops; pass keepOpen:true for a persistent region with no expiry. Check status with desktop_focus_status (reports mode + remainingMs).',
  },
  {
    patterns: [/calibrat/i, /click.*off|click.*wrong.*spot|click.*misses/i],
    title: 'Fix clicks landing off-target',
    tools: ['desktop_calibrate_pointer', 'desktop_calibration_status'],
    rationale: 'desktop_calibrate_pointer runs a multi-target interactive fit (user clicks bullseyes). Saved offset is applied to every subsequent desktop_click and desktop_pointer_*. desktop_calibration_status reads the saved fit. **User-interactive** — warn before invoking.',
  },
  {
    patterns: [/record|replay|playback|automate|repeat/i],
    title: 'Record + replay user actions',
    tools: ['bridge_overlay_reinject', 'browser_record_start', 'browser_record_stop', 'browser_recordings', 'browser_play'],
    rationale: 'Recording requires the injected overlay. bridge_overlay_reinject repairs/verifies it; browser_record_start begins capture; browser_record_stop saves a named JSON file. browser_recordings lists saved files; browser_play replays one by name.',
  },
  {
    patterns: [/run.*js|evaluate|execute.*script|inspect.*window/i],
    title: 'Run arbitrary JavaScript on the page',
    tools: ['browser_evaluate'],
    rationale: 'Default-off (effectively root on the page). Use only when no structured tool works — e.g. reading window.someAppState. Will fail with "Permission denied" unless globalSafety.execute and enabledTools[browser_evaluate] are both true.',
  },
  {
    patterns: [/scroll/i],
    title: 'Scroll a webpage',
    tools: ['browser_scroll'],
    rationale: 'browser_scroll with x/y pixel deltas. The page is scrolled, not the viewport itself.',
  },
  {
    patterns: [/screenshot|capture/i],
    title: 'Capture an image',
    tools: ['browser_screenshot', 'desktop_screenshot', 'desktop_screenshot_zoom'],
    rationale: 'browser_screenshot for the active tab. desktop_screenshot for any monitor/region. desktop_screenshot_zoom for tight pixel inspection.',
  },
  {
    patterns: [/permission|enable.*tool|disable.*tool|safety/i],
    title: 'Manage permissions',
    tools: ['safety_status', 'bridge_revoke_control'],
    rationale: 'Permissions are user-controlled through the bridge UI; agents should not silently flip them. safety_status reports current state. bridge_revoke_control disables all write tools (destructive — user-initiated only).',
  },
  {
    patterns: [/codex|grok|gemini|another (llm|model|ai)|second (opinion|llm|model)|delegate|sub-?agent|lent cli|cli_run|use my (cli|codex|grok|gemini|claude)|have (a |an )?(agent|model|llm)|hand off|pull in.*(model|llm)/i],
    title: 'Pull in another model\'s CLI (Codex / Grok / Gemini / Claude)',
    tools: ['cli_status', 'cli_run', 'cli_run_status', 'cli_runs'],
    rationale: 'Call cli_status FIRST — it lists each CLI as available / lent / authenticated / ready, so you route to a model that will actually run instead of getting a "not lent" refusal. Then cli_run({model, prompt, mode}) runs that CLI one-shot and returns its text; mode:"agentic" lets it write files in cwd (defaults to the bridge Home Directory). For long jobs pass background:true and poll cli_run_status. Each model is gated by its lend toggle — the user enables it on the API & CLIs pane.',
    exampleSequence: ['cli_status', 'pick a model where ready:true', 'cli_run model:"grok" mode:"agentic" prompt:"…"', '(if background) cli_run_status id:"…"'],
  },
  {
    patterns: [/generate.*image|create.*(image|picture|art)|make.*(image|picture|video|clip)|image gen|text.?to.?image|render.*(image|scene)|video.*(gen|generat)|edit.*image/i],
    title: 'Generate or edit an image / video',
    tools: ['higgsfield_status', 'higgsfield_models', 'higgsfield_generate', 'higgsfield_list'],
    rationale: 'higgsfield_status confirms the CLI is authenticated; higgsfield_models lists valid model ids (e.g. z_image/flux_2 for text→image, nano_banana_2 for edits that need an --image, veo3_1 for video); higgsfield_generate produces the asset and returns a URL + local artifact path. Spends the user\'s Higgsfield quota. This is separate from the cli_run text CLIs.',
    exampleSequence: ['higgsfield_status', 'higgsfield_models type:"image"', 'higgsfield_generate model:"z_image" prompt:"…"'],
  },
];

function bridgeToolAdvisor(cmd: any): any {
  const intent = String(cmd?.intent || '').trim();
  if (!intent) {
    return {
      ok: false,
      error: 'bridge_tool_advisor requires `intent` — a one-line description of what you are trying to do',
    };
  }
  const matches = ADVISOR_INTENTS.filter(i => i.patterns.some(p => p.test(intent)));
  const guideRef = 'docs/AGENT_GUIDE.md (in the bridge repo)';
  if (!matches.length) {
    return {
      ok: true,
      intent,
      matches: [],
      fallback: 'No keyword match. Read the full guide and pick from "The five things you can do" (See / Find / Act / Point / Manage).',
      guide: guideRef,
      hints: [
        'For web work: browser_snapshot first, then browser_click_ref or browser_type_ref.',
        'For desktop apps: desktop_snapshot_som — numbered boxes on a screenshot.',
        'For guiding the user: desktop_pointer_show (ghost cursor, no real input).',
        'To pull in another LLM: cli_status to see which CLIs are ready, then cli_run. For images/video: higgsfield_*.',
      ],
    };
  }
  return {
    ok: true,
    intent,
    matches: matches.map(m => ({
      title: m.title,
      tools: m.tools,
      rationale: m.rationale,
      exampleSequence: m.exampleSequence,
    })),
    guide: guideRef,
  };
}

function desktopCalibrationStatus(): any {
  try {
    const settings = readBridgeSettings();
    const cal = (settings as any).desktopCalibration || null;
    if (!cal) return { calibration: null, applied: false };
    if (cal.version === 2) {
      const ids = Object.keys(cal.monitors || {});
      return { calibration: cal, applied: ids.length > 0, monitors: ids };
    }
    return { calibration: cal, applied: true, legacy: true };
  } catch {
    return { calibration: null, applied: false };
  }
}

async function bridgeSetupStatus(): Promise<any> {
  const settings = readBridgeSettings();
  const saved = normalizeDesktopSetupState((settings as any).desktopSetup);
  const calibration = desktopCalibrationStatus();
  let monitors: any[] = [];
  let monitorError: string | null = null;
  try {
    const monRes = await getDesktopMonitors();
    monitors = Array.isArray(monRes?.monitors) ? monRes.monitors : [];
  } catch (e: any) {
    monitorError = e?.message || String(e);
  }
  let dom: any = null;
  try {
    if (cdpConnected) dom = await currentOverlayDomState();
  } catch {}
  const overlaySockets = pruneOverlayClients();
  const overlayReady = overlayDomReady(dom) || (!cdpConnected && overlaySockets > 0);
  const recordings = listRecordings();
  // Which connected monitors still lack a saved click calibration? Legacy
  // (v1) calibration is a single global offset that applies everywhere, so
  // treat all monitors as covered in that case.
  const calibratedIds: string[] = Array.isArray((calibration as any).monitors) ? (calibration as any).monitors : [];
  const uncalibratedMonitors = (calibration as any).legacy
    ? []
    : monitors.map(m => m.id).filter(id => !calibratedIds.includes(id));
  const current = {
    overlay: overlayReady,
    monitors: monitors.length > 0,
    calibration: !!calibration.applied,
    recordings: true,
  };
  return {
    success: true,
    saved,
    current,
    completeNow: !!(current.overlay && current.monitors && current.calibration && current.recordings),
    overlay: {
      injected: overlayInjected,
      clients: overlaySockets,
      dom,
    },
    monitors: {
      count: monitors.length,
      ids: monitors.map(m => m.id),
      primary: monitors.find(m => m.primary)?.id || null,
      error: monitorError,
    },
    calibration: {
      ...calibration,
      uncalibratedMonitors,
      coversAllMonitors: uncalibratedMonitors.length === 0,
      hint: uncalibratedMonitors.length
        ? `These monitors have no saved click calibration: ${uncalibratedMonitors.join(', ')}. Run desktop_calibrate_pointer on each (or area:"all") for accurate clicks there.`
        : undefined,
    },
    recordings: {
      count: recordings.length,
      active: isRecording,
      playing: isPlaying,
    },
  };
}

async function bridgeSetupSave(cmd: BridgeCommand): Promise<any> {
  const status = await bridgeSetupStatus();
  const completed = (cmd as any).completed !== false;
  const settings = readBridgeSettings();
  (settings as any).desktopSetup = {
    ...normalizeDesktopSetupState((settings as any).desktopSetup),
    completed,
    completedAt: completed ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString(),
    bridgeVersion: BRIDGE_VERSION,
    checklist: {
      overlay: !!status.current.overlay,
      monitors: !!status.current.monitors,
      calibration: !!status.current.calibration,
      recordings: !!status.current.recordings,
    },
    snapshot: {
      overlay: status.overlay,
      monitors: status.monitors,
      calibration: status.calibration,
      // Store only presence, not a frozen count — the recordings count is
      // volatile and a stale snapshot value (e.g. 30) reads as contradicting
      // the live count (e.g. 36) in the same status response. The live
      // top-level `recordings.count` is the source of truth.
      recordings: { present: (status.recordings?.count || 0) > 0 },
      savedBy: String((cmd as any).source || (cmd as any).channel || 'bridge'),
    },
  };
  saveBridgeSettings(settings);
  return bridgeSetupStatus();
}

function tabTargetFromRaw(raw: any, source?: string): BrowserTabTarget | null {
  const targetId = String(raw?.targetId || raw?.id || '').trim();
  const url = String(raw?.url || raw?.href || '').trim();
  if (!targetId && !url) return null;
  return {
    targetId,
    url,
    title: String(raw?.title || '').trim(),
    updatedAt: new Date().toISOString(),
    source,
  };
}

function sameTabTarget(a: BrowserTabTarget | null, b: BrowserTabTarget | null): boolean {
  if (!a || !b) return false;
  if (a.targetId && b.targetId) return a.targetId === b.targetId;
  return !!(a.url && b.url && a.url === b.url);
}

async function listBrowserTabs(): Promise<{ tabs: BrowserTabTarget[]; currentTargetId: string }> {
  const res = await cdpGet('/tabs');
  const tabs = Array.isArray(res?.tabs)
    ? res.tabs.map((t: any) => tabTargetFromRaw({ ...t, targetId: t.id }, t.active ? 'bridge-current' : 'bridge')).filter(Boolean) as BrowserTabTarget[]
    : [];
  return { tabs, currentTargetId: String(res?.currentTargetId || '') };
}

function findTabTarget(tabs: BrowserTabTarget[], raw: any): BrowserTabTarget | null {
  const targetId = String(raw?.targetId || raw?.id || '').trim();
  const url = String(raw?.url || raw?.href || '').trim();
  if (targetId) {
    const byId = tabs.find(t => t.targetId === targetId);
    if (byId) return { ...byId, source: raw?.source || byId.source };
  }
  if (url) {
    const byUrl = tabs.find(t => t.url === url);
    if (byUrl) return { ...byUrl, source: raw?.source || byUrl.source };
  }
  return tabTargetFromRaw(raw, raw?.source || 'manual');
}

function pruneDeadTabTargets(tabs: BrowserTabTarget[]) {
  if (agentControlTarget && !findTabTarget(tabs, agentControlTarget)) agentControlTarget = null;
  if (userFocusTarget && !findTabTarget(tabs, userFocusTarget)) userFocusTarget = null;
}

async function browserTabState(): Promise<any> {
  const { tabs, currentTargetId } = await listBrowserTabs();
  pruneDeadTabTargets(tabs);
  if (!agentControlTarget && currentTargetId) {
    const current = tabs.find(t => t.targetId === currentTargetId);
    if (current) agentControlTarget = { ...current, source: 'bridge-current', updatedAt: new Date().toISOString() };
  }
  const enriched = tabs.map(t => ({
    ...t,
    agentControlled: sameTabTarget(t, agentControlTarget),
    userFocused: sameTabTarget(t, userFocusTarget),
    bridgeCurrent: !!(currentTargetId && t.targetId === currentTargetId),
  }));
  return {
    success: true,
    currentTargetId,
    agentControlTarget,
    userFocusTarget,
    tabs: enriched,
  };
}

async function setBrowserTabFocus(cmd: BridgeCommand, source = 'direct'): Promise<any> {
  const action = String((cmd as any).tabAction || (cmd as any).action || 'user_focus').toLowerCase();
  const state = await browserTabState();
  const target = findTabTarget(state.tabs, {
    targetId: (cmd as any).targetId,
    url: (cmd as any).url,
    title: (cmd as any).title,
    source,
  });
  if (action === 'show_agent') {
    if (!agentControlTarget?.targetId) return { success: false, error: 'No agent-controlled tab is set.' };
    const shown = await cdpPost('/activate-target', { targetId: agentControlTarget.targetId, bringToFront: true });
    agentControlTarget = { ...agentControlTarget, url: shown?.url || agentControlTarget.url, title: shown?.title || agentControlTarget.title, updatedAt: new Date().toISOString(), source: 'show_agent' };
    broadcastBrowserTabState().catch(() => {});
    return { success: true, action, agentControlTarget, userFocusTarget };
  }
  if (!target) throw new Error('No browser tab target supplied.');
  if (action === 'control' || action === 'agent_control' || action === 'handoff') {
    let activated: any = null;
    if (target.targetId) {
      activated = await cdpPost('/activate-target', { targetId: target.targetId, bringToFront: true });
    }
    agentControlTarget = {
      ...target,
      targetId: activated?.targetId || target.targetId,
      url: activated?.url || target.url,
      title: activated?.title || target.title,
      updatedAt: new Date().toISOString(),
      source,
    };
    userFocusTarget = { ...agentControlTarget, source: 'handoff' };
  } else {
    userFocusTarget = { ...target, updatedAt: new Date().toISOString(), source };
  }
  broadcastBrowserTabState().catch(() => {});
  return { success: true, action, agentControlTarget, userFocusTarget };
}

async function broadcastBrowserTabState() {
  try {
    const state = await browserTabState();
    broadcastToOverlay({ type: 'tab_state_update', state });
  } catch {}
}

async function agentCursorForTarget(target: { selector?: string; ref?: string; x?: number; y?: number; intent?: string }) {
  if (!cdpConnected) return;
  const selector = target.selector || (target.ref ? `[data-empir3-ref="${String(target.ref).replace(/"/g, '\\"')}"]` : '');
  const intent = target.intent || 'target';
  try {
    if (selector) {
      await cdpPost('/evaluate', {
        expression: `(window.__empir3_agentCursorForSelector ? window.__empir3_agentCursorForSelector(${JSON.stringify(selector)}, ${JSON.stringify(intent)}) : true)`,
      }, { timeoutMs: 2500, wakeOnNotReady: false });
    } else if (typeof target.x === 'number' && typeof target.y === 'number') {
      await cdpPost('/evaluate', {
        expression: `(window.__empir3_moveCursor ? window.__empir3_moveCursor(${Math.round(target.x)}, ${Math.round(target.y)}, { intent:${JSON.stringify(intent)} }) : true)`,
      }, { timeoutMs: 2500, wakeOnNotReady: false });
    }
  } catch {}
}

// Apply per-monitor affine transform if available; legacy uniform offset
// otherwise; identity otherwise. Used by desktop_click AND desktop_pointer_*
// so "where the agent points" matches "where it would click".
function applyCalibration(x: number, y: number): { x: number; y: number; applied: boolean; monitor?: string; delta?: { x: number; y: number } } {
  try {
    const settings = readBridgeSettings();
    const cal = (settings as any).desktopCalibration;
    if (!cal) return { x, y, applied: false };
    if (cal.version === 2 && cal.monitors) {
      for (const [id, m] of Object.entries<any>(cal.monitors)) {
        const b = m?.bounds;
        if (!b) continue;
        if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) {
          const fx = m.fit?.axisX || { scale: 1, offset: 0 };
          const fy = m.fit?.axisY || { scale: 1, offset: 0 };
          const nx = Math.round(fx.scale * x + fx.offset);
          const ny = Math.round(fy.scale * y + fy.offset);
          return { x: nx, y: ny, applied: true, monitor: id, delta: { x: nx - x, y: ny - y } };
        }
      }
      return { x, y, applied: false };
    }
    if (Number.isFinite(cal.offsetX) && Number.isFinite(cal.offsetY)) {
      return { x: x + cal.offsetX, y: y + cal.offsetY, applied: true, delta: { x: cal.offsetX, y: cal.offsetY } };
    }
  } catch {}
  return { x, y, applied: false };
}

// Back-compat shim — desktopClick still calls applyCalibrationOffset.
function applyCalibrationOffset(x: number, y: number): { x: number; y: number; applied: boolean } {
  const r = applyCalibration(x, y);
  return { x: r.x, y: r.y, applied: r.applied };
}

function summarizeCommand(cmd: BridgeCommand): Record<string, any> {
  const out: Record<string, any> = { type: cmd.type };
  for (const key of ['url', 'selector', 'ref', 'x', 'y', 'toX', 'toY', 'monitor', 'space', 'double', 'button', 'durationMs', 'steps', 'filter', 'format', 'recording', 'speed']) {
    const value = (cmd as any)[key];
    if (value !== undefined) out[key] = value;
  }
  if (cmd.text !== undefined) out.textLength = String(cmd.text).length;
  if (cmd.message !== undefined) out.messageLength = String(cmd.message).length;
  // Lent GitHub CLI: record the gh command so the audit trail shows exactly
  // what a remote/team agent ran on the user's account.
  if (cmd.type === 'github:exec') {
    const raw = (cmd as any).args ?? (cmd as any).command ?? (cmd as any).argv;
    const ghCmd = Array.isArray(raw) ? raw.map(String).join(' ') : String(raw ?? '');
    out.gh = ghCmd.slice(0, 300);
  }
  return out;
}

function summarizeResult(result: any): Record<string, any> | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const out: Record<string, any> = {};
  for (const key of ['url', 'clicked', 'moved', 'dragged', 'cursor', 'coordinateSpace', 'screenshot', 'path', 'monitor', 'stitchedPath', 'running', 'engine', 'refreshed', 'highlighted', 'pressed', 'sent', 'scrolled', 'scope', 'command', 'exitCode', 'stage']) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  if (Array.isArray(result.captures)) out.captures = result.captures.map((c: any) => ({ id: c.id, path: c.path, bounds: c.bounds }));
  if (Array.isArray(result.monitors)) out.monitors = result.monitors.map((m: any) => ({ id: m.id, primary: m.primary, bounds: m.bounds }));
  return Object.keys(out).length ? out : undefined;
}

function recordActionReceipt(receipt: ActionReceipt) {
  actionLog.push(receipt);
  if (actionLog.length > ACTION_LOG_MAX) actionLog = actionLog.slice(-ACTION_LOG_MAX);
}

async function runCommandWithReceipt(cmd: BridgeCommand, source: string): Promise<any> {
  const started = Date.now();
  const id = `act-${started}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    const result = await executeCommand(cmd, source);
    recordActionReceipt({
      id,
      timestamp: new Date(started).toISOString(),
      source,
      type: cmd.type,
      ok: result?.success !== false,
      elapsedMs: Date.now() - started,
      input: summarizeCommand(cmd),
      result: summarizeResult(result),
      error: result?.success === false ? result.error : undefined,
    });
    return result;
  } catch (e: any) {
    recordActionReceipt({
      id,
      timestamp: new Date(started).toISOString(),
      source,
      type: cmd.type,
      ok: false,
      elapsedMs: Date.now() - started,
      input: summarizeCommand(cmd),
      error: e?.message || String(e),
    });
    throw e;
  }
}

function reliabilityStatus(): Record<string, any> {
  const cfg = publicConfig();
  const overlaySockets = pruneOverlayClients();
  return {
    status: cdpConnected ? 'ready' : 'browser_disconnected',
    bridge: {
      port: PORT,
      cdpUrl: BRIDGE_URL,
      cdpConnected,
      overlayClients: overlaySockets,
      cliClients: cliClients.size,
      overlayInjected,
      overlayHealthy: overlaySockets > 0,
      overlayEnsureInFlight: !!overlayEnsureInFlight,
      lastOverlayEnsureAt,
    },
    tools: {
      enabled: cfg.enabledTools,
      groups: TOOL_META.reduce((acc: Record<string, string>, t) => {
        acc[t.name] = t.group;
        return acc;
      }, {}),
    },
    lastActions: actionLog.slice(-20),
  };
}

function safetyStatus(): Record<string, any> {
  const cfg = publicConfig();
  const globalSafety = bridgeGlobalSafety(readBridgeSettings());
  const controlTools = TOOL_META
    .filter(t => {
      const required = TOOL_PERMISSION_REQUIREMENTS[t.name];
      return required === 'write' || required === 'execute';
    })
    .map(t => ({
      name: t.name,
      group: t.group,
      required: TOOL_PERMISSION_REQUIREMENTS[t.name],
      enabled: !!cfg.enabledTools[t.name],
      allowedByGlobal: !!globalSafety[TOOL_PERMISSION_REQUIREMENTS[t.name] as 'write' | 'execute'],
    }));
  const enabledWriteTools = controlTools.filter(t => t.enabled && t.allowedByGlobal);
  const blockedByGlobal = controlTools.filter(t => t.enabled && !t.allowedByGlobal);
  return {
    state: enabledWriteTools.length ? 'write_controls_enabled' : 'read_only',
    globalSafety,
    cdpConnected,
    overlayClients: pruneOverlayClients(),
    cliClients: cliClients.size,
    overlayInjected,
    mode: cfg.mode,
    writeTools: controlTools,
    enabledWriteTools,
    blockedByGlobal,
    revokeEndpoint: '/api/safety/lockdown',
    settingsUrl: `http://localhost:${PORT}/settings`,
  };
}

async function overlayRepairStatus(reason = 'manual'): Promise<Record<string, any>> {
  return ensureOverlayReady(reason, { waitMs: 6000, force: true });
}

function lockdownWriteTools(): Record<string, any> {
  const cfg = publicConfig();
  const nextEnabled = { ...cfg.enabledTools };
  for (const tool of TOOL_META) {
    if (['interact', 'desktop', 'eval', 'recordings'].includes(tool.group)) {
      nextEnabled[tool.name] = false;
    }
  }
  const next = saveConfig({ enabledTools: nextEnabled });
  return {
    ok: true,
    safety: safetyStatus(),
    config: publicConfig(next),
  };
}

async function runReliabilitySmoke(): Promise<any> {
  const checks: Array<Record<string, any>> = [];
  const add = (name: string, ok: boolean, detail?: any) => checks.push({ name, ok, detail });

  // Snapshot overlay health at the very START, before the browser click-test
  // below navigates to a data: page (which carries no overlay). Checking after
  // that navigation would always report 0 overlay clients and false-fail the
  // overlay_health gate. This reflects the overlay state the smoke was run in.
  const overlayHealthAtStart = (() => {
    try { return reliabilityStatus().bridge; } catch { return null; }
  })();

  try {
    add('wrapper_status', true, reliabilityStatus().bridge);
  } catch (e: any) {
    add('wrapper_status', false, e?.message || String(e));
  }

  try {
    const monitors = await getDesktopMonitors();
    add('desktop_monitors', Array.isArray(monitors.monitors) && monitors.monitors.length > 0, monitors);
  } catch (e: any) {
    add('desktop_monitors', false, e?.message || String(e));
  }

  try {
    const shot = await takeDesktopScreenshot('primary');
    add('desktop_screenshot_primary', !!shot.captures?.[0]?.path, shot);
  } catch (e: any) {
    add('desktop_screenshot_primary', false, e?.message || String(e));
  }

  if (cdpConnected) {
    // The click-test navigates the active tab to a data: page. Capture the
    // current URL first and restore it afterward so running the smoke doesn't
    // silently clobber whatever the user was looking at. Only restore real
    // navigable URLs (http/https/file) — never a data:/about: page.
    let prevUrl: string | null = null;
    try {
      const cur = await cdpPost('/evaluate', { expression: 'location.href' });
      const u = String((cur?.result ?? cur) || '');
      if (/^(https?|file):/i.test(u)) prevUrl = u;
    } catch {}
    try {
      const html = '<!doctype html><html><body style="margin:0;font-family:sans-serif"><button id="target" style="position:absolute;left:100px;top:100px;width:220px;height:80px;font-size:22px">Trusted click target</button><div id="result" style="position:absolute;left:100px;top:210px;font-size:24px">waiting</div><script>document.getElementById("target").addEventListener("click",e=>{document.getElementById("result").textContent=e.isTrusted?"trusted coordinate click":"synthetic click"})</script></body></html>';
      await cdpPost('/navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
      await new Promise(r => setTimeout(r, 600));
      await cdpPost('/action', { kind: 'click', x: 210, y: 140 });
      const result = await cdpPost('/evaluate', { expression: `document.getElementById('result')?.textContent` });
      add('browser_click_xy_trusted', (result?.result ?? result) === 'trusted coordinate click', result);
    } catch (e: any) {
      add('browser_click_xy_trusted', false, e?.message || String(e));
    } finally {
      if (prevUrl) {
        try { await cdpPost('/navigate', { url: prevUrl }); } catch {}
      }
    }
  } else {
    add('browser_click_xy_trusted', false, 'CDP browser is not connected');
  }

  // Overlay health: the smoke previously passed 4/4 even when the overlay was
  // injected-but-dead (overlayHealthy:false, no connected overlay clients),
  // green-lighting a broken interaction surface. Gate on it explicitly, using
  // the snapshot captured at the START (the browser click-test above navigates
  // to a data: page that carries no overlay, so a post-nav reading would always
  // be 0 clients). When CDP isn't connected the overlay can't be healthy, but
  // that's already surfaced by browser_click_xy_trusted.
  try {
    const bridgeStatus = overlayHealthAtStart || reliabilityStatus().bridge;
    const overlayHealthy = !!bridgeStatus.overlayHealthy && (bridgeStatus.overlayClients ?? 0) > 0;
    if (cdpConnected) {
      add('overlay_health', overlayHealthy, bridgeStatus);
    } else {
      add('overlay_health', false, { ...bridgeStatus, note: 'CDP browser not connected' });
    }
  } catch (e: any) {
    add('overlay_health', false, e?.message || String(e));
  }

  const passed = checks.filter(c => c.ok).length;
  return {
    ok: passed === checks.length,
    passed,
    total: checks.length,
    checks,
  };
}

function parseRelayStyleDesktopCommand(cmd: BridgeCommand): { base: string; action: string; params: any; browserScoped: boolean } | null {
  const type = String(cmd.type || '');
  if (!type.startsWith('desktop:')) return null;
  const parts = type.split(':');
  const params = { ...(cmd.params || {}), ...cmd };
  delete params.type;
  delete params.action;
  delete params.params;

  if (parts[1] === 'browse' || parts[1] === 'agent-browser') {
    return {
      base: `desktop:${parts[1]}`,
      action: parts.slice(2).join(':') || cmd.action || 'status',
      params,
      browserScoped: true,
    };
  }
  if (parts[1] === 'file' && parts[2] === 'pull') return { base: 'desktop:file:pull', action: cmd.action || 'pull', params, browserScoped: false };
  if (parts[1] === 'project' && parts[2] === 'file') return { base: 'desktop:project:file', action: cmd.action || 'save', params, browserScoped: false };
  if (parts[1] === 'sync' && (parts[2] === 'push' || parts[2] === 'complete')) return { base: `desktop:sync:${parts[2]}`, action: parts[2], params, browserScoped: false };
  return {
    base: `desktop:${parts[1]}`,
    action: parts.slice(2).join(':') || cmd.action || '',
    params,
    browserScoped: false,
  };
}

async function executeRelayStyleDesktopCommand(parsed: { base: string; action: string; params: any; browserScoped: boolean }) {
  let result: any;
  if (parsed.base === 'desktop:capabilities') result = await buildDesktopCapabilities(parsed.action || 'quick', parsed.params?.name || '');
  else if (parsed.base === 'desktop:sysinfo') result = await getSystemInfo(parsed.action || parsed.params?.query || 'overview');
  else if (parsed.base === 'desktop:app') result = await handleAppCommand(parsed.action, parsed.params);
  else if (parsed.base === 'desktop:clipboard') result = await handleClipboardCommand(parsed.action, parsed.params);
  else if (parsed.base === 'desktop:execute') result = await handleExecuteCommand(parsed.action || 'run', parsed.params);
  else if (parsed.base === 'desktop:notify') result = await handleNotifyCommand(parsed.action || 'show', parsed.params);
  else if (['desktop:file', 'desktop:file:pull', 'desktop:project:file', 'desktop:sync:push', 'desktop:sync:complete'].includes(parsed.base)) {
    result = await handleFileCommand(parsed.base, parsed.action, parsed.params);
  } else if (parsed.base === 'desktop:window') result = await handleWindowCommand(parsed.action || 'list', parsed.params);
  else if (parsed.base === 'desktop:gui') result = await handleGuiCommand(parsed.action || 'screenshot', parsed.params);
  else if (parsed.base === 'desktop:browse' || parsed.base === 'desktop:agent-browser') result = await handleAgentBrowser(parsed.action || 'status', parsed.params);
  else result = { success: false, error: `Unsupported desktop command: ${parsed.base}` };
  return normalizeCompanionResult(result);
}

if (!existsSync(FEEDBACK_DIR)) mkdirSync(FEEDBACK_DIR, { recursive: true });
if (!existsSync(RECORDINGS_DIR)) mkdirSync(RECORDINGS_DIR, { recursive: true });

// ─── HTTP Server ─────────────────────────────────────────────

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // CORS is intentionally limited. Same-origin welcome/settings pages work
  // normally; CDP-injected remote overlays must present the per-launch nonce.
  applyCors(req, res, url);
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (mutatingMethod(req.method) && browserOriginNeedsNonce(req) && !requestHasBridgeNonce(req, url)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'bridge nonce required' }));
    return;
  }

  // Dashboard
  if (url.pathname === '/' || url.pathname === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml());
    return;
  }

  // Overlay JS (injected into browser pages)
  if (url.pathname === '/overlay.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(getOverlayScript(trustedOverlayScriptRequest(req) ? BRIDGE_NONCE : ''));
    return;
  }

  // Tray sign-in/open target. The tray opens this on the wrapper port, so keep
  // it available even though the CDP bridge also has its own /welcome page.
  if (url.pathname === '/welcome') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getWelcomeHtml());
    return;
  }

  // API: Session status
  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Pairing detection: only include empir3* fields when an Empir3 token is
    // configured. Fresh OSS users with no token see a clean standalone surface.
    const auth = readBridgeAuth();
    const paired = !!(EMPIR3_WS_URL && (EMPIR3_AUTH_TOKEN || auth?.legacyToken || auth?.token));
    const payload: Record<string, any> = {
      running: cdpConnected,
      engine: 'empir3-bridge',
      version: BRIDGE_VERSION,
      pid: process.pid,
      bridgeUrl: BRIDGE_URL,
      ...sessionCtx,
      overlayClients: pruneOverlayClients(),
      cliClients: cliClients.size,
      overlayInjected,
    };
    if (paired) {
      payload.empir3Connected = empir3Connected;
      payload.empir3AuthRejected = !!empir3AuthRejectedAt;
      payload.empir3LastCloseCode = empir3LastCloseCode || null;
      payload.empir3LastCloseReason = empir3LastCloseReason || null;
      payload.empir3Agent = EMPIR3_DIRECT_AGENT;
      payload.empir3ProjectId = EMPIR3_PROJECT_ID || null;
      payload.empir3Server = EMPIR3_SERVER;
      payload.empir3Environment = bridgeAuthEnvironment();
      payload.empir3User = auth?.user || null;
    }
    res.end(JSON.stringify(payload));
    return;
  }

  // Tray compatibility endpoint. The Windows tray polls this route to decide
  // whether the daemon is alive and which status label to show.
  if (url.pathname === '/api/relay-status') {
    const auth = readBridgeAuth();
    const paired = !!(EMPIR3_WS_URL && (EMPIR3_AUTH_TOKEN || auth?.legacyToken || auth?.token));
    const uptimeMs = Math.max(0, Date.now() - Date.parse(sessionCtx.startedAt));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      version: BRIDGE_VERSION,
      mode: paired ? 'paired' : (isStandaloneMode() ? 'standalone' : 'splash'),
      standalone: !paired && isStandaloneMode(),
      hasAuth: paired,
      authUser: auth?.user || null,
      serverUrl: auth?.serverUrl || EMPIR3_SERVER,
      environment: bridgeAuthEnvironment(),
      uptimeMs,
      relay: {
        connected: paired && empir3Connected,
        user: auth?.user || null,
        deviceName: process.env.EMPIR3_DEVICE_NAME || process.env.COMPUTERNAME || hostname(),
        channelId: auth?.channelId || null,
        serverUrl: auth?.serverUrl || EMPIR3_SERVER,
        authRejected: !!empir3AuthRejectedAt,
        lastCloseCode: empir3LastCloseCode || null,
        lastCloseReason: empir3LastCloseReason || null,
      },
    }));
    return;
  }

  if (url.pathname === '/api/install/empir3-pair' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const serverUrl = normalizeEmpir3Server(body.serverUrl || EMPIR3_SERVER);
      const environment = classifyEmpir3Server(serverUrl);
      const r = await requestJson('POST', `${serverUrl}/api/auth/pairing-sessions`, {});
      if (r.status !== 201 || !r.body?.code) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: r.body?.error || 'pairing-sessions failed', status: r.status }));
        return;
      }
      const code = r.body.code;
      const redirectUrl = `${serverUrl}/connect-bridge?code=${encodeURIComponent(code)}`;
      startPairPoll(code, serverUrl, environment);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, code, redirectUrl, expiresIn: r.body.expiresIn, serverUrl, environment }));
    } catch (e: any) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    return;
  }

  if (url.pathname === '/api/install/claude-code' && req.method === 'POST') {
    markStandaloneMode();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      snippet: buildMcpSnippet(),
      addToFile: '.mcp.json',
      instructions: [
        'Save this JSON as .mcp.json in your Claude Code project root.',
        'Restart Claude Code from that same project folder.',
        'Ask Claude to use the Empir3 Bridge browser tools when you need live browser or desktop control.',
        'For OpenAI or another MCP client, add the same stdio server: command is Empir3Setup.exe and args are ["--mcp"].',
      ],
    }));
    return;
  }

  if (url.pathname === '/api/install/empir3-login' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      if (!email || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Email and password are required' }));
        return;
      }

      const serverUrl = normalizeEmpir3Server(body.serverUrl || EMPIR3_SERVER);
      const environment = classifyEmpir3Server(serverUrl);
      const r = await requestJson('POST', `${serverUrl}/api/auth/login`, { email, password });
      if (r.status !== 200 || !r.body?.token) {
        res.writeHead(r.status || 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: r.body?.error || 'Login failed' }));
        return;
      }

      saveBridgeAuth({
        legacyToken: r.body.token,
        user: r.body.user || { email },
        channelId: r.body.channelId || null,
        serverUrl,
        wsUrl: defaultEmpir3WsUrl(serverUrl),
        environment,
      });
      clearStandaloneMode();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, user: r.body.user || { email }, serverUrl, environment }));
      restartAfterPairing();
    } catch (e: any) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    return;
  }

  if (url.pathname === '/api/install/sign-out' && req.method === 'POST') {
    clearBridgeAuth();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    restartAfterPairing();
    return;
  }

  if (url.pathname === '/api/install/pair-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      polling: !!activePairPoll,
      code: activePairPoll?.code || null,
      serverUrl: activePairPoll?.serverUrl || null,
      environment: activePairPoll?.environment || null,
      tries: activePairPoll?.tries || 0,
      lastStatus: activePairPoll?.lastStatus || null,
      lastError: activePairPoll?.lastError || null,
    }));
    return;
  }

  if (url.pathname === '/api/reliability') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reliabilityStatus()));
    return;
  }

  if (url.pathname === '/api/actions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(actionLog.slice(-50)));
    return;
  }

  if (url.pathname === '/api/safety') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safetyStatus()));
    return;
  }

  if (url.pathname === '/api/safety/lockdown' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lockdownWriteTools()));
    return;
  }

  if (url.pathname === '/api/bridge-smoke-test-plan') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getBridgeSmokeTestPlan(), null, 2));
    return;
  }

  if (url.pathname === '/desktop-test') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDesktopTestHtml());
    return;
  }

  // Accuracy Lab: a dense, Photoshop-style UI with many small, tightly-packed
  // click targets (data-target-id / data-target-type) that score hit/miss/mean
  // error — a harder click-accuracy stress test than /desktop-test. Served from
  // a static asset (assets/accuracy-lab.html in dev; staged into the payload
  // root by build/build.js for the packaged daemon).
  if (url.pathname === '/accuracy-lab') {
    const html = readAccuracyLabHtml();
    if (!html) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('accuracy-lab.html is not present in this build');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // API: Per-launch identity. Lets the overlay / page scripts match the Chrome
  // they run in to the wrapper port that paired with that Chrome
  // (set by launch.js + propagated via the welcome URL's ?bridgeNonce=).
  // Empty string when bridge was started without a nonce — callers fall
  // back to first-up port discovery in that case.
  if (url.pathname === '/api/identity') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      nonce: BRIDGE_NONCE,
      port: PORT,
    }));
    return;
  }

  // API: Send command
  if (url.pathname === '/api/command' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const raw = JSON.parse(body || '{}');
        const cmd = normalizeCommand(raw);
        const source = raw?.channel === 'mcp' || cmd.channel === 'mcp' ? 'mcp' : 'http';
        const result = await runCommandWithReceipt(cmd, source);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /api/shutdown — graceful daemon exit. The tray supervisor's restart()
  // path tries this first; if we exit 0 the supervisor respawns us immediately.
  // The welcome page "Reconnect daemon" button uses the same route.
  if (url.pathname === '/api/shutdown' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'shutdown queued' }));
    setTimeout(() => {
      try { saveSessionContext(); } catch {}
      process.exit(0);
    }, 250);
    return;
  }

  // GET /api/log/tail?lines=200 — last N lines of bridge.log (whatever the
  // bootstrap layer or daemon wrote). Falls back to the in-memory action log
  // when the file is empty/missing so the welcome page always shows something.
  if (url.pathname === '/api/log/tail' && req.method === 'GET') {
    const linesParam = parseInt(url.searchParams.get('lines') || '200', 10);
    const lines = Math.min(Math.max(linesParam || 200, 10), 2000);
    let logLines: string[] = [];
    let source: 'bridge.log' | 'action-log' | 'empty' = 'empty';
    try {
      if (existsSync(BRIDGE_LOG_FILE)) {
        const stat = statSync(BRIDGE_LOG_FILE);
        const maxBytes = 256 * 1024;
        const start = Math.max(0, stat.size - maxBytes);
        const buf = readFileSync(BRIDGE_LOG_FILE);
        const slice = buf.subarray(start).toString('utf8');
        const all = slice.split(/\r?\n/);
        logLines = all.slice(-lines);
        source = 'bridge.log';
      }
    } catch {}
    if (logLines.length === 0 || logLines.every(l => !l.trim())) {
      logLines = actionLog.slice(-lines).map(a => {
        const ts = a.timestamp || new Date().toISOString();
        const status = a.ok ? 'ok' : 'err';
        return `[${ts}] ${a.type} ${status}${a.error ? ' — ' + a.error : ''}`;
      });
      source = logLines.length ? 'action-log' : 'empty';
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, source, path: BRIDGE_LOG_FILE, lines: logLines }));
    return;
  }

  // GET /api/updates/check — probe the public version manifest and compare to
  // the running daemon's version. Welcome page uses this to mirror the tray's
  // "Check for updates" action without duplicating the manifest URL.
  if (url.pathname === '/api/updates/check' && req.method === 'GET') {
    try {
      const r = await requestJson('GET', VERSION_MANIFEST_URL);
      if (r.status !== 200 || !r.body) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `manifest http ${r.status}`, local: BRIDGE_VERSION }));
        return;
      }
      const remote = String(r.body.version || '').trim();
      const local = BRIDGE_VERSION;
      const newer = isVersionNewer(remote, local);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        local,
        remote,
        newer,
        state: newer ? 'newer_available' : 'up_to_date',
        manifest: r.body,
        manifestUrl: VERSION_MANIFEST_URL,
      }));
    } catch (e: any) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e?.message || String(e), local: BRIDGE_VERSION }));
    }
    return;
  }

  // POST /api/tray/enqueue — welcome page enqueues a tray-lifecycle command.
  // The tray drains this queue on its next status poll (~4s). Allowed types
  // are whitelisted so a hostile page can't shove arbitrary strings in.
  if (url.pathname === '/api/tray/enqueue' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const raw = JSON.parse(body || '{}');
        const type = String(raw?.type || '').trim();
        const allowed = new Set([
          'tray_check_updates',
          'tray_apply_update',
          'tray_toggle_auto_update',
          'tray_open_log',
          'tray_restart_tray',
          'tray_quit',
          'tray_uninstall',
        ]);
        if (!allowed.has(type)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `unknown tray command: ${type}` }));
          return;
        }
        const cmd: TrayCommand = {
          id: randomUUID(),
          type,
          params: (raw && typeof raw.params === 'object') ? raw.params : undefined,
          enqueuedAt: Date.now(),
        };
        trayCommandQueue.push(cmd);
        if (trayCommandQueue.length > TRAY_COMMAND_MAX) {
          trayCommandQueue = trayCommandQueue.slice(-TRAY_COMMAND_MAX);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: cmd.id, queued: trayCommandQueue.length }));
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
      }
    });
    return;
  }

  // GET /api/tray/commands — tray drains the queue. Always clears so a slow
  // tray doesn't replay stale commands on the next poll.
  if (url.pathname === '/api/tray/commands' && req.method === 'GET') {
    const drained = trayCommandQueue;
    trayCommandQueue = [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, commands: drained }));
    return;
  }

  // GET /api/desktop/focus — quick check whether an agent-focus region is
  // currently active. The welcome page toggles release/grid buttons on this.
  if (url.pathname === '/api/desktop/focus' && req.method === 'GET') {
    const focusFile = join(homedir(), '.empir3-bridge', 'payload', 'feedback', 'desktop', 'focus.json');
    let active = false;
    let info: any = null;
    try {
      if (existsSync(focusFile)) {
        active = true;
        try { info = JSON.parse(readFileSync(focusFile, 'utf-8')); } catch {}
      }
    } catch {}
    const gridRunning = !!(desktopFocusGridProc && desktopFocusGridProc.exitCode === null);
    const live = desktopFocusStatus();
    const region = live.active ? live.focus : info;
    const ttlMs = live.active ? live.remainingMs : (info?.expiresAt ? Math.max(0, Number(info.expiresAt) - Date.now()) : 0);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      active: active || !!live.active,
      info,
      region,
      ttlMs,
      grid: { enabled: desktopFocusGridEnabled, running: gridRunning },
    }));
    return;
  }

  // ── Chat-with-Claude routes (Wave 1.5) ────────────────────────

  // GET /settings → HTML config UI (BYO-key/CLI + per-tool toggles)
  if (req.method === 'GET' && url.pathname === '/settings') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getSettingsHtml());
    return;
  }

  // GET /api/config → sanitized config (no raw API key)
  if (req.method === 'GET' && url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(publicConfig()));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/settings/state') {
    try {
      // Explicit "Re-scan" forces a fresh CLI probe; routine polls use the cache.
      if (url.searchParams.get('fresh') === '1') invalidateCliProbeCache();
      const state = await buildSettingsState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/settings/state') {
    try {
      const body = await readRequestBody(req);
      const chatPatch = body?.chat && typeof body.chat === 'object'
        ? { ...body.chat } as Partial<BridgeConfig>
        : null;
      if (chatPatch) {
        if (chatPatch.anthropicApiKey === '') delete chatPatch.anthropicApiKey;
        // Strip empty API key fields so the front-end can send the full
        // shape without clobbering existing values. Mirrors the legacy
        // anthropicApiKey behavior.
        const keysPatch: any = (chatPatch as any).apiKeys;
        if (keysPatch && typeof keysPatch === 'object') {
          for (const k of Object.keys(keysPatch)) {
            if (keysPatch[k] === '' || keysPatch[k] == null) delete keysPatch[k];
          }
          if (Object.keys(keysPatch).length === 0) delete (chatPatch as any).apiKeys;
        }
        saveConfig(chatPatch);
      }
      if (body?.bridge && typeof body.bridge === 'object') {
        saveBridgeSettingsPatch(body.bridge);
      }
      const state = await buildSettingsState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
    } catch (e: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    return;
  }

  // POST /api/cli/providers — add a custom OpenAI-compatible provider.
  // Body shape mirrors the empir3 admin "Add Custom Provider" modal:
  // { slug, name, apiBaseUrl, models?, apiKey?, lend? }. Validates +
  // persists, then returns the probed state so the UI knows whether
  // the endpoint is live and what models it exposes.
  if (req.method === 'POST' && url.pathname === '/api/cli/providers') {
    try {
      const body = await readRequestBody(req);
      const valid = validateProviderJson(body);
      if ('error' in valid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: valid.error }));
        return;
      }
      const list = readCustomProviders();
      const wasEmpty = list.length === 0;
      const existing = list.findIndex(p => p.slug === valid.provider.slug);
      if (existing >= 0) list[existing] = valid.provider;
      else list.push(valid.provider);
      saveCustomProviders(list);
      // Auto-enable the custom_llm dispatcher the moment the user adds
      // their first provider. The MCP tool is also family-gated on
      // customProviders.length, so it was previously hidden entirely —
      // flipping enabledTools here lets it surface as ON, not phantom-OFF.
      if (wasEmpty) {
        const cfg = loadConfig();
        if (cfg.enabledTools?.custom_llm !== true) {
          saveConfig({ enabledTools: { ...cfg.enabledTools, custom_llm: true } });
        }
      }
      const state = await buildCustomProvidersState();
      const probed = state.find(p => p.slug === valid.provider.slug) || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, provider: probed }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    return;
  }

  // DELETE /api/cli/providers/<slug> — remove a custom provider.
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/cli/providers/')) {
    try {
      const slug = decodeURIComponent(url.pathname.replace('/api/cli/providers/', '')).trim();
      if (!slug) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'slug required' }));
        return;
      }
      const next = readCustomProviders().filter(p => p.slug !== slug);
      saveCustomProviders(next);
      // Auto-disable the custom_llm dispatcher when the last provider is
      // removed — keeps the permission list and MCP tools/list clean.
      if (next.length === 0) {
        const cfg = loadConfig();
        if (cfg.enabledTools?.custom_llm === true) {
          saveConfig({ enabledTools: { ...cfg.enabledTools, custom_llm: false } });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, removed: slug }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    return;
  }

  // POST /api/cli/providers/<slug>/lend — toggle the v2 lend flag.
  if (req.method === 'POST' && /^\/api\/cli\/providers\/[^/]+\/lend$/.test(url.pathname)) {
    try {
      const slug = decodeURIComponent(url.pathname.split('/')[4]);
      const body = await readRequestBody(req);
      const lend = !!body?.lend;
      const list = readCustomProviders();
      const idx = list.findIndex(p => p.slug === slug);
      if (idx < 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unknown provider' }));
        return;
      }
      list[idx] = { ...list[idx], lend };
      saveCustomProviders(list);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, provider: { slug, lend } }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    return;
  }

  // POST /api/cli/auth — Phase 3 auth-button endpoint. Spawns the CLI's
  // own auth flow in a detached console window. We don't follow up — the
  // user finishes in their browser, then re-opens /welcome and the probe
  // picks up the new auth file or env var.
  if (req.method === 'POST' && url.pathname === '/api/cli/auth') {
    try {
      const body = await readRequestBody(req);
      const provider = String(body?.provider || '').trim().toLowerCase();
      if (!provider) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'provider is required' }));
        return;
      }
      const result = await launchProviderAuth(provider);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    return;
  }

  // POST /api/cli/install — runs a CLI's install command in a fresh, visible
  // console window. The user watches it run, then clicks Re-scan. Same shape
  // as /api/cli/auth.
  if (req.method === 'POST' && url.pathname === '/api/cli/install') {
    try {
      const body = await readRequestBody(req);
      const provider = String(body?.provider || '').trim().toLowerCase();
      if (!provider) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'provider is required' }));
        return;
      }
      const result = await launchProviderInstall(provider);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    return;
  }

  // POST /api/config → patch fields (anthropicApiKey only saved if non-empty)
  if (req.method === 'POST' && url.pathname === '/api/config') {
    let body = '';
    req.on('data', (c: Buffer) => body += c);
    req.on('end', () => {
      try {
        const patch = JSON.parse(body) as Partial<BridgeConfig>;
        // Strip empty key — front-end sends empty string when user didn't
        // touch the field, and we don't want to clobber a previously-saved key.
        if (patch.anthropicApiKey === '') delete patch.anthropicApiKey;
        const next = saveConfig(patch);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(publicConfig(next)));
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /api/conversations → list saved conversations
  if (req.method === 'GET' && url.pathname === '/api/conversations') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listConversations()));
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/conversations/')) {
    const id = decodeURIComponent(url.pathname.replace('/api/conversations/', ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readConversation(id)));
    return;
  }

  // POST /api/chat/stream → SSE stream of ChatEvents
  if (req.method === 'POST' && url.pathname === '/api/chat/stream') {
    let body = '';
    req.on('data', (c: Buffer) => body += c);
    req.on('end', async () => {
      let payload: { messages?: any[]; conversationId?: string; modeOverride?: 'api' | 'cli' };
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400); res.end('bad json'); return; }
      if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
        res.writeHead(400); res.end('messages[] required'); return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // Initial flush so the client gets the headers immediately.
      res.write(': open\n\n');

      const send = (ev: ChatEvent) => {
        try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client gone */ }
      };

      try {
        for await (const ev of streamChat({
          messages: payload.messages as any,
          conversationId: payload.conversationId,
          modeOverride: payload.modeOverride,
          bridgeBaseUrl: `http://localhost:${PORT}`,
        })) {
          send(ev);
          // Mirror assistant text + tool activity onto the overlay's chat
          // panel via the existing broadcast channel so the in-page chat
          // stays current even if the user has the panel open in a
          // different tab from the one driving /api/chat/stream.
          if (ev.type === 'tool_use') {
            broadcastToOverlay({ type: 'claude_working', tool: ev.name });
          }
        }
      } catch (e: any) {
        send({ type: 'error', message: e?.message || String(e) });
      }
      res.end();
    });
    return;
  }

  // API: Get chat history
  if (req.method === 'GET' && url.pathname === '/api/chat') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const lines = existsSync(CHAT_LOG)
      ? readFileSync(CHAT_LOG, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
    res.end(JSON.stringify(lines));
    return;
  }

  // API: Start Fresh — wipe chat history, broadcast so all overlays clear
  if (req.method === 'DELETE' && url.pathname === '/api/chat') {
    try {
      if (existsSync(CHAT_LOG)) writeFileSync(CHAT_LOG, '');
      sessionCtx.messageCount = 0;
      broadcastToOverlay({ type: 'chat_cleared' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cleared: true }));
    } catch (e: any) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: Send a chat message directly to the overlay (no DOM interaction needed)
  // API: Show "working" indicator in chat overlay
  if (req.method === 'POST' && url.pathname === '/api/chat/working') {
    broadcastToOverlay({ type: 'claude_working' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let body = '';
    req.on('data', (c: Buffer) => body += c);
    req.on('end', () => {
      try {
        const { message, role = 'claude' } = JSON.parse(body);
        if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: 'message required' })); return; }
        const chatMsg = { from: role, text: message, timestamp: new Date().toISOString(), channel: role === 'claude' ? 'mcp' : undefined };
        appendFileSync(CHAT_LOG, JSON.stringify(chatMsg) + '\n');
        broadcastToOverlay({ type: 'claude_chat', message: chatMsg });
        sessionCtx.messageCount++;
        sessionCtx.lastActivity = new Date().toISOString();
        console.log(`[Chat] ${role}: ${message.slice(0, 80)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sent: true }));
      } catch (e: any) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: Serve the overlay script over HTTP (welcome page / debugging; the
  // CDP injection path embeds this same script directly).
  if (url.pathname === '/api/overlay-script' && req.method === 'GET') {
    const script = getOverlayScript(trustedOverlayScriptRequest(req) ? BRIDGE_NONCE : '');
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
    });
    res.end(script);
    return;
  }

  // API: Get latest screenshot (proxied from Empir3 Bridge)
  if (url.pathname === '/api/screenshot') {
    try {
      const quality = url.searchParams.get('quality') || '50';
      const params: Record<string, string> = { raw: 'true', quality };
      const maxWidth = url.searchParams.get('maxWidth');
      if (maxWidth) params.maxWidth = maxWidth;
      const buf = await cdpGetRaw('/screenshot', params);
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(buf);
    } catch (e: any) {
      res.writeHead(500); res.end(e.message);
    }
    return;
  }

  // Serve feedback screenshots
  if (url.pathname.startsWith('/feedback/')) {
    const file = join(FEEDBACK_DIR, url.pathname.replace('/feedback/', ''));
    if (existsSync(file)) {
      const ext = file.endsWith('.jpg') || file.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
      res.writeHead(200, { 'Content-Type': ext });
      res.end(readFileSync(file));
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // API: List recordings
  if (url.pathname === '/api/recordings' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const files = existsSync(RECORDINGS_DIR)
      ? readdirSync(RECORDINGS_DIR).filter(f => f.endsWith('.json'))
      : [];
    const recordings = files.map(f => {
      const data: Recording = JSON.parse(readFileSync(join(RECORDINGS_DIR, f), 'utf-8'));
      return { name: data.name, description: data.description, file: f, startUrl: data.startUrl,
        recorded: data.recorded, duration: data.duration, actionCount: data.actions.length,
        variables: data.variables, engine: data.engine || 'playwright' };
    });
    res.end(JSON.stringify(recordings));
    return;
  }

  // API: Get single recording
  if (url.pathname.startsWith('/api/recordings/') && req.method === 'GET') {
    const name = decodeURIComponent(url.pathname.replace('/api/recordings/', ''));
    const file = join(RECORDINGS_DIR, name.endsWith('.json') ? name : name + '.json');
    if (existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(readFileSync(file, 'utf-8'));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Recording not found' }));
    }
    return;
  }

  // API: Save recording
  if (url.pathname === '/api/recordings' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const recording: Recording = JSON.parse(body);
        const filename = recording.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() + '.json';
        writeFileSync(join(RECORDINGS_DIR, filename), JSON.stringify(recording, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file: filename }));
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // API: Delete recording
  if (url.pathname.startsWith('/api/recordings/') && req.method === 'DELETE') {
    const name = decodeURIComponent(url.pathname.replace('/api/recordings/', ''));
    const file = join(RECORDINGS_DIR, name.endsWith('.json') ? name : name + '.json');
    if (existsSync(file)) {
      unlinkSync(file);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
    return;
  }

  // API: Recording status
  if (url.pathname === '/api/recording-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      recording: isRecording, playing: isPlaying,
      actionCount: recordingActions.length,
      duration: isRecording ? Date.now() - recordingStartTime : 0,
      engine: 'empir3',
    }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ─── WebSocket Server ────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const wsUrl = new URL(req.url || '/', `http://localhost:${PORT}`);
  const wsOrigin = String(req.headers.origin || '');
  if (wsOrigin && !isLocalBridgeOrigin(wsOrigin) && !validBridgeNonce(wsUrl.searchParams.get('nonce') || '')) {
    try { ws.close(1008, 'bridge nonce required'); } catch {}
    return;
  }
  const isCliClient = wsUrl.searchParams.get('role') === 'cli';

  if (isCliClient) {
    cliClients.add(ws);
    console.log(`[Bridge] Claude Code CLI connected (${cliClients.size} total)`);
    ws.on('close', () => cliClients.delete(ws));

    ws.on('message', async (data) => {
      try {
        const cmd = normalizeCommand(JSON.parse(data.toString()));
        const result = await runCommandWithReceipt(cmd, 'ws:cli');
        ws.send(JSON.stringify({ type: 'command_result', result }));
      } catch (e: any) {
        ws.send(JSON.stringify({ type: 'error', error: e.message }));
      }
    });
  } else {
    overlayClients.add(ws);
    overlayInjected = true;
    (ws as any)._empir3IsAlive = true;
    ws.on('pong', () => { (ws as any)._empir3IsAlive = true; });
    console.log(`[Bridge] Browser overlay connected (${overlayClients.size} total)`);
    ws.on('close', () => {
      overlayClients.delete(ws);
      if (overlayClients.size === 0) {
        overlayInjected = false;
        // Schedule re-injection after navigation
        setTimeout(() => {
          if (overlayClients.size === 0 && cdpConnected) {
            console.log('[Bridge] Overlay disconnected, scheduling re-injection...');
            injectOverlay().catch(() => {});
          }
        }, 2000);
      }
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await handleOverlayMessage(msg, ws);
      } catch (e: any) {
        console.error('[Bridge] Overlay message error:', e.message);
      }
    });

    ws.send(JSON.stringify({ type: 'status', controlling: false, url: sessionCtx.currentUrl }));
    // Send recording state so new tabs/pages pick up active recording
    if (isRecording) {
      ws.send(JSON.stringify({ type: 'recording_state', recording: true }));
      ws.send(JSON.stringify({ type: 'recording_action', count: recordingActions.length, action: 'sync' }));
    }
    if (isPlaying) {
      ws.send(JSON.stringify({ type: 'playback_state', playing: true, name: playbackControl.name, total: playbackControl.total }));
      ws.send(JSON.stringify(transportSnapshot()));
    }
  }
});

// ─── Handle overlay messages ─────────────────────────────────

async function handleOverlayMessage(msg: any, ws: WebSocket) {
  (ws as any).__empir3LastMessageAt = Date.now();
  (ws as any)._empir3IsAlive = true;
  if (msg.type === 'tab_hello' || msg.type === 'request_tab_state') {
    const targetId = String((ws as any).__cdpTargetId || msg.targetId || '').trim();
    const target = tabTargetFromRaw({
      targetId,
      url: msg.url || msg.href,
      title: msg.title,
    }, 'overlay');
    const state = await browserTabState();
    const resolved = target ? findTabTarget(state.tabs, target) || target : null;
    (ws as any).__empir3LastHelloAt = Date.now();
    (ws as any).__empir3Url = String(msg.url || msg.href || resolved?.url || '');
    (ws as any).__empir3Title = String(msg.title || resolved?.title || '');
    if (resolved?.targetId) (ws as any).__cdpTargetId = resolved.targetId;
    ws.send(JSON.stringify({
      type: 'tab_state',
      target: resolved,
      state,
    }));
    // Sync active playback to a freshly-announced overlay. Covers CDP-mailbox
    // overlays on https (which never hit the WS 'connection' handler) and any
    // overlay re-injected after a navigation mid-replay — both otherwise miss
    // the one-time playback_state broadcast and never show the transport bar.
    if (isPlaying) {
      ws.send(JSON.stringify({ type: 'playback_state', playing: true, name: playbackControl.name, total: playbackControl.total }));
      ws.send(JSON.stringify(transportSnapshot()));
    }
    return;
  }

  if (msg.type === 'tab_focus') {
    const targetId = String((ws as any).__cdpTargetId || msg.targetId || '').trim();
    try {
      const result = await setBrowserTabFocus({
        type: 'browser_tab_focus',
        tabAction: msg.action || 'user_focus',
        targetId,
        url: msg.url || msg.href,
        title: msg.title,
      } as any, 'overlay');
      ws.send(JSON.stringify({ type: 'tab_focus_ack', result }));
    } catch (e: any) {
      ws.send(JSON.stringify({ type: 'error', error: e.message || String(e) }));
    }
    return;
  }

  if (msg.type === 'chat') {
    const chatMode: 'mcp' | 'empir3' = msg.chatMode === 'empir3' ? 'empir3' : 'mcp';
    const chatMsg: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from: 'user',
      text: msg.text,
      timestamp: new Date().toISOString(),
      channel: chatMode,
      url: msg.url,
      selector: msg.selector,
      elementHtml: msg.elementHtml,
    };

    // Take screenshot if requested
    if (msg.includeScreenshot) {
      try {
        const buf = await cdpGetRaw('/screenshot', { raw: 'true', quality: '35' });
        const screenshotName = `chat-${Date.now()}.jpg`;
        writeFileSync(join(FEEDBACK_DIR, screenshotName), buf);
        chatMsg.screenshot = screenshotName;
      } catch (e) { /* screenshot failed, continue without it */ }
    }

    appendFileSync(CHAT_LOG, JSON.stringify(chatMsg) + '\n');
    sessionCtx.messageCount++;
    sessionCtx.lastActivity = new Date().toISOString();
    saveSessionContext();

    if (chatMode === 'empir3') {
      const forwarded = forwardToEmpir3(chatMsg);
      ws.send(JSON.stringify({
        type: 'chat_ack',
        id: chatMsg.id,
        screenshot: chatMsg.screenshot || null,
        chatMode,
        routed: forwarded ? 'empir3' : 'none',
        error: forwarded ? null : 'empir3 is not connected. Switch to MCP or reconnect the bridge account.',
      }));
      console.log(`[Chat] User -> Empir3: ${msg.text.slice(0, 80)}${msg.text.length > 80 ? '...' : ''}`);
    } else {
      for (const cli of cliClients) {
        cli.send(JSON.stringify({ type: 'user_message', message: chatMsg }));
      }
      // Check if Claude is actively listening (heartbeat file)
      const hbFile = resolve(FEEDBACK_DIR, '.claude-listening');
      let claudeListening = false;
      try {
        const hbTime = parseInt(readFileSync(hbFile, 'utf-8').trim(), 10);
        claudeListening = (Date.now() - hbTime) < 10000; // within 10 seconds
      } catch {}
      ws.send(JSON.stringify({ type: 'chat_ack', id: chatMsg.id, screenshot: chatMsg.screenshot || null, listening: claudeListening, chatMode, routed: 'mcp' }));
      console.log(`[Chat] User -> MCP: ${msg.text.slice(0, 80)}${msg.text.length > 80 ? '...' : ''}`);

      // Kick off Claude (Wave 1.5) — fire-and-forget; events broadcast to all overlays.
      // Skipped if Claude is "actively listening" externally so we don't double up.
      if (!claudeListening) runClaudeChatTurn(msg.text).catch(e => {
        console.error('[Chat] Claude turn failed:', e?.message || e);
      });
    }
  }

  if (msg.type === 'feedback') {
    const entry = {
      ...msg.data,
      timestamp: new Date().toISOString(),
      url: currentUrl,
    };

    try {
      const buf = await cdpGetRaw('/screenshot', { raw: 'true' });
      const screenshotName = `feedback-${Date.now()}.jpg`;
      writeFileSync(join(FEEDBACK_DIR, screenshotName), buf);
      entry.screenshotPath = join(FEEDBACK_DIR, screenshotName);
      entry.screenshotName = screenshotName;
    } catch (e) { /* continue without screenshot */ }

    appendFileSync(join(FEEDBACK_DIR, 'feedback.jsonl'), JSON.stringify(entry) + '\n');
    sessionCtx.feedbackCount++;
    saveSessionContext();

    for (const cli of cliClients) {
      cli.send(JSON.stringify({ type: 'feedback', entry }));
    }
    console.log(`[Feedback] "${entry.comment}" on ${entry.selector}`);
  }

  // Recording: capture user actions from overlay, enrich with element refs
  if (msg.type === 'record_action' && isRecording) {
    await addRecordedAction(msg.action as RecordedAction, 'overlay');
  }

  // Commands from overlay
  if (msg.type === 'command') {
    try {
      const data = { ...(msg.data || {}) };
      if (!data.targetId && (ws as any).__cdpTargetId) data.targetId = (ws as any).__cdpTargetId;
      if (!data.url && msg.url) data.url = msg.url;
      if (!data.title && msg.title) data.title = msg.title;
      const result = await runCommandWithReceipt(normalizeCommand(data), 'ws:overlay');
      ws.send(JSON.stringify({ type: 'command_result', result }));
    } catch (e: any) {
      ws.send(JSON.stringify({ type: 'error', error: e.message }));
    }
  }

  // Standalone overlay (CDP-injected) requests history on mount so the
  // chat panel reflects the prior turns when navigating across pages.
  if (msg.type === 'request_history') {
    try {
      const lines = existsSync(CHAT_LOG)
        ? readFileSync(CHAT_LOG, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
        : [];
      // Replay recent turns into THIS page's overlay only. The virtual-ws
      // for CDP pages forwards through pushToCdpOverlay so __empir3_inbox
      // receives each event.
      for (const m of lines.slice(-40)) {
        ws.send(JSON.stringify({ type: 'claude_chat', message: m }));
      }
      ws.send(JSON.stringify({ type: 'bridge_ready' }));
    } catch { /* swallow */ }
  }

  if (msg.type === 'clear_history') {
    try {
      if (existsSync(CHAT_LOG)) writeFileSync(CHAT_LOG, '');
      sessionCtx.messageCount = 0;
      broadcastToOverlay({ type: 'chat_cleared' });
    } catch { /* swallow */ }
  }
}

// ─── Claude chat turn (Wave 1.5) ─────────────────────────────

// Tracks the active conversation across user turns so multi-turn context is
// preserved without the overlay having to manage state. One conversation per
// daemon process — fine for v0.1.0; per-tab convos can layer in via a
// chrome.storage.session key once the multi-tab UX matters.
let activeConversationId: string | null = null;

async function runClaudeChatTurn(userText: string) {
  // Show "thinking" dots immediately — there's a perceptible delay while
  // the API connection opens or the CLI subprocess spawns. The dots are
  // replaced by the stream bubble on the first event.
  broadcastToOverlay({ type: 'claude_working' });

  // Rebuild conversation history from CHAT_LOG so the model has prior context.
  // Each line is { from: 'user'|'claude', text, timestamp, ... }; we trim
  // metadata fields that don't belong in the prompt.
  const history: any[] = [];
  if (existsSync(CHAT_LOG)) {
    const lines = readFileSync(CHAT_LOG, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        if (!m.text) continue;
        if (m.from === 'user') history.push({ role: 'user', content: m.text });
        else if (m.from === 'claude') history.push({ role: 'assistant', content: m.text });
      } catch { /* skip */ }
    }
  }
  // CHAT_LOG already contains the user's latest message (appended above
  // before this is called), so don't add it again.

  // Cap history to most recent 20 turns to keep context costs sane.
  const messages = history.slice(-20);
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    // Defensive — make sure the most recent turn is the user's message
    messages.push({ role: 'user', content: userText });
  }

  let assistantText = '';
  try {
    for await (const ev of streamChat({
      messages: messages as any,
      conversationId: activeConversationId || undefined,
      bridgeBaseUrl: `http://localhost:${PORT}`,
    })) {
      switch (ev.type) {
        case 'message_start':
          activeConversationId = ev.conversationId;
          broadcastToOverlay({ type: 'claude_stream_start', conversationId: ev.conversationId });
          break;
        case 'text_delta':
          assistantText += ev.text;
          broadcastToOverlay({ type: 'claude_text_delta', text: ev.text });
          break;
        case 'tool_use':
          broadcastToOverlay({ type: 'claude_tool_use', id: ev.id, name: ev.name, input: ev.input });
          break;
        case 'tool_result':
          broadcastToOverlay({ type: 'claude_tool_result', id: ev.id, name: ev.name, ok: ev.ok, output: ev.output });
          break;
        case 'usage':
          broadcastToOverlay({ type: 'claude_usage', inputTokens: ev.inputTokens, outputTokens: ev.outputTokens });
          break;
        case 'message_end':
          broadcastToOverlay({ type: 'claude_message_end', stopReason: ev.stopReason, iterations: ev.iterations });
          break;
        case 'error':
          broadcastToOverlay({ type: 'claude_error', message: ev.message });
          break;
      }
    }
  } catch (e: any) {
    broadcastToOverlay({ type: 'claude_error', message: e?.message || String(e) });
    return;
  }

  // Persist Claude's full response into CHAT_LOG so future turns + cross-tab
  // history loads include it.
  if (assistantText.trim()) {
    const claudeMsg: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from: 'claude',
      text: assistantText,
      timestamp: new Date().toISOString(),
      channel: 'mcp',
    };
    appendFileSync(CHAT_LOG, JSON.stringify(claudeMsg) + '\n');
    sessionCtx.messageCount++;
    // Tabs that joined mid-stream missed the deltas — they refresh from
    // /api/chat on next reconnect. We don't broadcast a final claude_chat
    // here because tabs that DID see the deltas would render the bubble twice.
  }
}

// ─── Execute commands ────────────────────────────────────────

async function executeCommand(cmd: BridgeCommand, source = 'direct'): Promise<any> {
  const policyError = enforceCommandPolicy(cmd, source);
  if (policyError) return policyError;

  if (typeof cmd.type === 'string' && cmd.type.startsWith('claude:cli:')) {
    const action = cmd.type.slice('claude:cli:'.length);
    const payload = cmd.params || cmd;
    return handleClaudeCliCommand(action, payload, () => {});
  }

  if (typeof cmd.type === 'string' && cmd.type.startsWith('codex:cli:')) {
    const action = cmd.type.slice('codex:cli:'.length);
    const payload = cmd.params || cmd;
    return handleCodexCliCommand(action, payload, () => {});
  }

  if (typeof cmd.type === 'string' && cmd.type.startsWith('gemini:cli:')) {
    const action = cmd.type.slice('gemini:cli:'.length);
    const payload = cmd.params || cmd;
    return handleGeminiCliCommand(action, payload, () => {});
  }

  if (typeof cmd.type === 'string' && cmd.type.startsWith('grok:cli:')) {
    const action = cmd.type.slice('grok:cli:'.length);
    const payload = cmd.params || cmd;
    return handleGrokCliCommand(action, payload, () => {});
  }

  if (typeof cmd.type === 'string' && cmd.type.startsWith('agy:cli:')) {
    const action = cmd.type.slice('agy:cli:'.length);
    const payload = cmd.params || cmd;
    return handleAgyCliCommand(action, payload, () => {});
  }

  const relayStyleDesktopCommand = parseRelayStyleDesktopCommand(cmd);
  if (relayStyleDesktopCommand && !relayStyleDesktopCommand.browserScoped) {
    return executeRelayStyleDesktopCommand(relayStyleDesktopCommand);
  }
  if (relayStyleDesktopCommand?.browserScoped && ['status', 'read_chat', 'recordings', 'close'].includes(relayStyleDesktopCommand.action)) {
    return executeRelayStyleDesktopCommand(relayStyleDesktopCommand);
  }

  const browserFreeCommands = new Set(['status', 'read_chat', 'recordings', 'playback_pause', 'playback_resume', 'playback_stop', 'playback_step', 'playback_speed', 'playback_seek', 'desktop_monitors', 'desktop_screenshot', 'desktop_screenshot_zoom', 'desktop_click', 'desktop_hover', 'desktop_drag', 'desktop_cursor_position', 'desktop_screen_size', 'desktop_snapshot', 'desktop_snapshot_som', 'desktop_click_ref', 'desktop_hover_ref', 'desktop_overlay', 'desktop_select_region', 'desktop_release_focus', 'desktop_focus_status', 'desktop_pointer_show', 'desktop_pointer_move', 'desktop_pointer_pulse', 'desktop_pointer_hide', 'desktop_pointer_status', 'desktop_calibrate_pointer', 'desktop_calibration_status', 'desktop_click_cell', 'desktop_pointer_cell', 'desktop_focus_grid', 'desktop_pick_point', 'desktop_toolbar', 'bridge_tool_advisor', 'bridge_setup_status', 'bridge_setup_save', 'overlay_reinject', 'bridge_overlay_reinject', 'action_log', 'reliability_status', 'reliability_smoke', 'safety_status', 'safety_lockdown', 'higgsfield_status', 'higgsfield_list', 'higgsfield_generate', 'custom_llm', 'github_status', 'github:exec']);
  if (!browserFreeCommands.has(cmd.type) && !cdpConnected) {
    const ok = await checkBridgeHealth();
    if (!ok) throw new Error('Empir3 Bridge not connected. Start empir3-bridge first, or use --launch flag.');
  }

  if (relayStyleDesktopCommand?.browserScoped) {
    return executeRelayStyleDesktopCommand(relayStyleDesktopCommand);
  }

  switch (cmd.type) {
    case 'status':
      return { running: cdpConnected, engine: 'empir3', ...sessionCtx };

    case 'browser_tab_state':
      return browserTabState();

    case 'browser_tab_focus':
      return setBrowserTabFocus(cmd, source);

    case 'action_log':
      return { actions: actionLog.slice(-50) };

    case 'higgsfield_status':
      return higgsfieldStatus(cmd.params || {});

    case 'higgsfield_list':
      return higgsfieldList((cmd.params || cmd) as any);

    case 'higgsfield_models':
      return higgsfieldModels((cmd.params || cmd) as any);

    case 'cli_run':
      return cliRun((cmd.params || cmd) as any);

    case 'cli_runs':
      return cliRunsList();

    case 'cli_status':
      return cliRunRoster();

    case 'cli_run_status':
      return cliRunStatus((cmd.params || cmd) as any);

    case 'higgsfield_generate':
      return higgsfieldGenerate((cmd.params || cmd) as any);

    case 'github_status':
      return githubStatus((cmd.params || {}) as any);

    case 'github:exec': {
      // Lent GitHub CLI execution for remote/team agents. Master opt-in
      // (lendGitHubCli) is checked here; the per-scope matrix + hard-blocks
      // are enforced inside githubExec (the safety boundary). Dormant until
      // empir3-server sends this command.
      if (!githubDeviceOptedIn()) {
        return { success: false, stage: 'opted_out', error: 'Device owner has not opted in. Enable "Lend Empir3 my GitHub CLI" in the bridge settings before routing GitHub commands through this PC.' };
      }
      const p = (cmd.params || cmd) as any;
      return githubExec({ args: p.args ?? p.command ?? p.argv, scopes: githubScopes(), cwd: typeof p.cwd === 'string' ? p.cwd : undefined });
    }

    case 'custom_llm': {
      // Generic chat-completion against any custom LLM (Ollama,
      // LM Studio, OpenRouter, vLLM, etc) the user has configured on
      // the API & CLIs pane. Returns the assistant text + raw envelope.
      const p = (cmd.params || cmd) as any;
      const result = await chatWithCustomProvider({
        slug: String(p.provider || p.slug || ''),
        model: String(p.model || ''),
        prompt: String(p.prompt || p.text || ''),
        system: typeof p.system === 'string' ? p.system : undefined,
      });
      if (!result.ok) return { success: false, error: result.error };
      return { success: true, text: result.text, result: { text: result.text, raw: result.raw } };
    }

    case 'overlay_reinject':
    case 'bridge_overlay_reinject':
      return overlayRepairStatus(String((cmd as any).reason || cmd.message || 'manual'));

    case 'reliability_status':
      return reliabilityStatus();

    case 'reliability_smoke':
      return runReliabilitySmoke();

    case 'safety_status':
      return safetyStatus();

    case 'safety_lockdown':
      return lockdownWriteTools();

    case 'read_chat': {
      const limit = Math.max(1, Math.min(500, Math.round(Number((cmd as any).limit ?? 100))));
      return { success: true, messages: readChatLog(limit), log: CHAT_LOG };
    }

    case 'recordings':
      return { success: true, recordings: listRecordings() };

    case 'navigate': {
      currentUrl = cmd.url || '';
      sessionCtx.currentUrl = currentUrl;
      if (!sessionCtx.pages.includes(currentUrl)) sessionCtx.pages.push(currentUrl);
      saveSessionContext();
      setTimeout(() => {
        cdpPost('/navigate', { url: cmd.url }, { timeoutMs: 20000, wakeOnNotReady: false })
          .then((res: any) => {
            if (agentControlTarget) {
              agentControlTarget = {
                ...agentControlTarget,
                url: res?.url || cmd.url || agentControlTarget.url,
                title: res?.title || agentControlTarget.title,
                updatedAt: new Date().toISOString(),
                source: 'navigate',
              };
              broadcastBrowserTabState().catch(() => {});
            }
          })
          .catch((e: any) => console.warn(`[Bridge] Background navigate failed: ${e?.message || e}`));
      }, 250);
      // Re-inject overlay after navigation
      setTimeout(() => injectOverlay().catch(() => {}), 1500);
      broadcastToOverlay({ type: 'navigated', url: currentUrl });
      if (isRecording) await addRecordedAction({ action: 'navigate', url: currentUrl, delay: 0 });
      return { url: currentUrl };
    }

    case 'desktop:browse:show': {
      let showRes: any = null;
      let warning: string | undefined;
      try {
        showRes = await cdpPost('/show', { url: cmd.url || '' }, { timeoutMs: 8000, wakeOnNotReady: false });
      } catch (e: any) {
        warning = `Open Bridge requested, but CDP is still starting: ${e?.message || e}`;
        console.warn(`[Bridge] ${warning}`);
      }
      const href = showRes?.url || `${BRIDGE_URL}/welcome`;
      currentUrl = href;
      sessionCtx.currentUrl = currentUrl;
      if (!sessionCtx.pages.includes(currentUrl)) sessionCtx.pages.push(currentUrl);
      saveSessionContext();
      setTimeout(() => {
        browserTabState()
          .then(() => broadcastBrowserTabState())
          .catch(() => {});
      }, 0);
      return { shown: true, url: href, warning };
    }

    case 'click': {
      broadcastToOverlay({ type: 'claude_action', action: 'clicking', selector: cmd.selector });
      // Route through the CDP action path so selector clicks use real mouse events.
      if (cmd.selector) {
        await agentCursorForTarget({ selector: cmd.selector, intent: 'click' });
        await cdpPost('/action', { kind: 'click', selector: cmd.selector });
      }
      if (isRecording) await addRecordedAction({ action: 'click', selector: cmd.selector, delay: 0 });
      return { clicked: cmd.selector };
    }

    case 'click_ref': {
      if (!cmd.ref) throw new Error('Missing ref parameter');
      broadcastToOverlay({ type: 'claude_action', action: 'clicking', selector: `ref:${cmd.ref}` });
      await agentCursorForTarget({ ref: cmd.ref, intent: 'click' });
      await cdpPost('/action', { kind: 'click', ref: cmd.ref });
      if (isRecording) await addRecordedAction({ action: 'click', ref: cmd.ref, delay: 0 });
      return { clicked: cmd.ref };
    }

    case 'click_xy': {
      broadcastToOverlay({ type: 'claude_action', action: 'clicking', selector: `(${cmd.x}, ${cmd.y})` });
      try {
        await agentCursorForTarget({ x: Number(cmd.x || 0), y: Number(cmd.y || 0), intent: 'click' });
      } catch {}
      await cdpPost('/action', { kind: 'click', x: cmd.x || 0, y: cmd.y || 0 });
      if (isRecording) await addRecordedAction({ action: 'click', x: Number(cmd.x || 0), y: Number(cmd.y || 0), delay: 0 });
      return { clicked: { x: cmd.x, y: cmd.y } };
    }

    case 'type': {
      if (cmd.selector) {
        broadcastToOverlay({ type: 'claude_action', action: 'typing', selector: cmd.selector });
        await agentCursorForTarget({ selector: cmd.selector, intent: 'focus' });
        const typeResult = await cdpPost('/evaluate', {
          expression: `(function() {
            const el = document.querySelector(${JSON.stringify(cmd.selector)});
            if (!el) return 'not_found';
            el.focus();
            if (el.isContentEditable) {
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, ${JSON.stringify(cmd.text || '')});
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return 'typed_contenteditable';
            }
            const tag = el.tagName;
            const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) {
              const tracker = el._valueTracker;
              if (tracker) tracker.setValue('');
              setter.call(el, ${JSON.stringify(cmd.text || '')});
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return 'typed';
            }
            if ('value' in el) {
              el.value = ${JSON.stringify(cmd.text || '')};
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return 'typed_basic';
            }
            el.textContent = ${JSON.stringify(cmd.text || '')};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return 'typed_basic';
          })()`,
        });
        if (typeResult?.result === 'not_found') throw new Error(`No element matched selector: ${cmd.selector}`);
      } else {
        broadcastToOverlay({ type: 'claude_action', action: 'typing', selector: 'focused element' });
        await cdpPost('/action', { kind: 'type', text: cmd.text || '' });
      }
      if (isRecording) await addRecordedAction({ action: 'type', selector: cmd.selector, text: cmd.text || '', delay: 0 });
      return { typed: cmd.text, into: cmd.selector || 'focused' };
    }

    case 'type_ref': {
      if (!cmd.ref) throw new Error('Missing ref parameter');
      broadcastToOverlay({ type: 'claude_action', action: 'typing', selector: `ref:${cmd.ref}` });
      await agentCursorForTarget({ ref: cmd.ref, intent: 'focus' });
      // Use native value setter + input/change events (keyboard-only typing doesn't update .value)
      const refSelector = `[data-empir3-ref="${cmd.ref}"]`;
      const typeRefResult = await cdpPost('/evaluate', {
        expression: `(function() {
          const el = document.querySelector(${JSON.stringify(refSelector)});
          if (!el) return 'not_found';
          el.focus();
          const isTextarea = el.tagName === 'TEXTAREA';
          const proto = isTextarea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) {
            const tracker = el._valueTracker;
            if (tracker) tracker.setValue('');
            setter.call(el, ${JSON.stringify(cmd.text || '')});
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return 'typed';
          }
          el.value = ${JSON.stringify(cmd.text || '')};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'typed_basic';
        })()`,
      });
      if (typeRefResult?.result === 'not_found') throw new Error(`Element ref not found: ${cmd.ref}`);
      if (isRecording) await addRecordedAction({ action: 'type', ref: cmd.ref, text: cmd.text || '', delay: 0 });
      return { typed: cmd.text, ref: cmd.ref };
    }

    case 'press':
      {
        const key = String((cmd as any).text || (cmd as any).key || '');
        await cdpPost('/action', { kind: 'press', key });
        if (isRecording) await addRecordedAction({ action: 'press', key, delay: 0 });
        return { pressed: key };
      }

    case 'scroll': {
      const dx = Number(cmd.x || 0);
      const dy = Number(cmd.y || 0);
      const result = await cdpPost('/evaluate', {
        expression: `(function() {
          var dx = ${JSON.stringify(dx)}, dy = ${JSON.stringify(dy)};
          // Pick best scroll target: visible inner container covering viewport center,
          // fall back to document.scrollingElement (handles body/html scroller sites).
          var cx = window.innerWidth / 2, cy = window.innerHeight / 2;
          var best = null, bestArea = 0;
          var all = document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var c = all[i];
            var cs = getComputedStyle(c);
            var sy = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && c.scrollHeight > c.clientHeight + 10;
            var sx = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && c.scrollWidth > c.clientWidth + 10;
            if (!sy && !sx) continue;
            if (cs.display === 'none' || cs.visibility === 'hidden' || c.offsetHeight === 0) continue;
            var r = c.getBoundingClientRect();
            if (r.left > cx || r.right < cx || r.top > cy || r.bottom < cy) continue;
            var area = r.width * r.height;
            if (area > bestArea) { best = c; bestArea = area; }
          }
          // Kill smooth-scroll so result is instant (restore after).
          var html = document.documentElement;
          var prev = html.style.scrollBehavior;
          html.style.scrollBehavior = 'auto';
          try {
            var target, targetName;
            if (best) {
              target = best;
              targetName = 'inner';
            } else {
              target = document.scrollingElement || document.documentElement;
              targetName = 'window';
            }
            var beforeX = Number(target.scrollLeft || 0);
            var beforeY = Number(target.scrollTop || 0);
            if (dy) target.scrollTop = beforeY + dy;
            if (dx) target.scrollLeft = beforeX + dx;
            var afterX = Number(target.scrollLeft || 0);
            var afterY = Number(target.scrollTop || 0);
            var maxX = Math.max(0, Number(target.scrollWidth || 0) - Number(target.clientWidth || window.innerWidth || 0));
            var maxY = Math.max(0, Number(target.scrollHeight || 0) - Number(target.clientHeight || window.innerHeight || 0));
            return JSON.stringify({
              target: targetName,
              requested: { x: dx, y: dy },
              before: { x: beforeX, y: beforeY },
              after: { x: afterX, y: afterY },
              delta: { x: afterX - beforeX, y: afterY - beforeY },
              max: { x: maxX, y: maxY },
              canScroll: maxX > 0 || maxY > 0,
              moved: afterX !== beforeX || afterY !== beforeY
            });
          } finally {
            html.style.scrollBehavior = prev;
          }
        })()`,
      });
      let scroll: any = result?.result ?? result;
      if (typeof scroll === 'string') {
        try { scroll = JSON.parse(scroll); } catch {}
      }
      if (isRecording) await addRecordedAction({ action: 'scroll', x: dx, y: dy, delay: 0 });
      return {
        scrolled: { x: dx, y: dy },
        scroll,
        position: scroll?.after || scroll,
        moved: scroll?.moved === true,
      };
    }

    case 'screenshot': {
      const buf = await cdpGetRaw('/screenshot', { raw: 'true' });
      const name = `claude-${Date.now()}.jpg`;
      const path = join(FEEDBACK_DIR, name);
      writeFileSync(path, buf);
      return { screenshot: name, path };
    }

    case 'desktop_monitors':
      return getDesktopMonitors();

    case 'desktop_screenshot': {
      let region = (cmd as any).region;
      const explicitMonitor = typeof cmd.monitor === 'string' && cmd.monitor.trim()
        ? cmd.monitor.trim()
        : null;
      let gridArg: any = (cmd as any).grid;
      // Precedence: explicit region > explicit monitor > active focus region > all.
      // An explicit monitor arg must win over an implicit focus scope; only an
      // explicit region overrides a monitor. The focus region is used as the
      // capture target only when the caller supplied neither monitor nor region.
      const focusActive = !!(desktopFocus && !(cmd as any).noFocus);
      const useFocusRegion = !region && !explicitMonitor && focusActive;
      if (useFocusRegion) {
        region = { x: desktopFocus!.x, y: desktopFocus!.y, width: desktopFocus!.width, height: desktopFocus!.height };
        touchDesktopFocus(); // real scoped use → keep the region alive (idle-revoke)
      }
      // No-silent-scope-loss: the caller relied on focus scoping (no monitor/
      // region) but no focus region was active — the capture fell back to the
      // whole desktop. Annotate so the caller can tell scope was lost rather
      // than silently grabbing everything.
      const focusExpired = !region && !explicitMonitor && !focusActive && !(cmd as any).noFocus;
      const monitor = explicitMonitor || 'all';
      // When falling back to the focus region (no explicit monitor/region),
      // default to a chess-board grid: ~16 cells across the larger dimension,
      // integer cell indices on top + left edges only in pill labels. Sparse
      // labels survive any chat downscale and make agent-side targeting trivial
      // ("nose looks like cell 8,7 — call desktop_click_cell col:8 row:7").
      // Opt-out with grid:false.
      if (useFocusRegion && gridArg === undefined) {
        gridArg = { labels: 'axis' };
      } else if (gridArg === false || gridArg === null) {
        gridArg = undefined; // explicit opt-out
      }
      const shotResult = await takeDesktopScreenshot(monitor, region, gridArg, (cmd as any).marker);
      if (focusExpired) {
        return { ...shotResult, focusExpired: true, focusNote: 'No active focus region — captured the whole desktop. The focus region may have expired (30 min idle) or been released; call desktop_select_region to re-scope.' };
      }
      return shotResult;
    }

    case 'desktop_screenshot_zoom':
      return desktopScreenshotZoom(cmd as any);

    case 'desktop_click':
      return desktopClick(cmd);

    case 'desktop_click_page':
      return desktopClickPage(cmd as any);

    case 'desktop_pointer_page':
      return desktopPointerPage(cmd as any);

    case 'page_to_screen':
      return pageToScreen(cmd as any);

    case 'desktop_hover':
      return desktopHover(cmd);

    case 'desktop_drag':
      return desktopDrag(cmd);

    case 'desktop_cursor_position':
      return desktopCursorPosition();

    case 'desktop_screen_size':
      return desktopScreenSize();

    case 'desktop_snapshot':
      return getDesktopSnapshot(cmd);

    case 'desktop_snapshot_som':
      return desktopSnapshotSom(cmd as any);

    case 'bridge_tool_advisor':
      return bridgeToolAdvisor(cmd as any);

    case 'bridge_setup_status':
      return bridgeSetupStatus();

    case 'bridge_setup_save':
      return bridgeSetupSave(cmd);

    case 'desktop_click_ref':
      return desktopClickRef(cmd);

    case 'desktop_hover_ref':
      return desktopHoverRef(cmd);

    case 'desktop_overlay':
      return desktopOverlayToggle(cmd);

    case 'desktop_select_region':
      return desktopSelectRegion(cmd);

    case 'desktop_release_focus':
      return desktopReleaseFocus();

    case 'desktop_focus_status':
      return desktopFocusStatus();

    case 'desktop_pointer_show':
      return desktopPointerShow(cmd);

    case 'desktop_pointer_move':
      return desktopPointerMove(cmd);

    case 'desktop_pointer_pulse':
      return desktopPointerPulse(cmd);

    case 'desktop_pointer_hide':
      return desktopPointerHide();

    case 'desktop_pointer_status':
      return desktopPointerStatus();

    case 'desktop_calibrate_pointer':
      return desktopCalibratePointer(cmd);

    case 'desktop_calibration_status':
      return desktopCalibrationStatus();

    case 'desktop_click_cell':
      return desktopClickCell(cmd);

    case 'desktop_pointer_cell':
      return desktopPointerCell(cmd);

    case 'desktop_focus_grid':
      return desktopFocusGrid(cmd);

    case 'desktop_pick_point':
      return desktopPickPoint(cmd);

    case 'desktop_toolbar':
      return desktopToolbar(cmd);

    case 'refresh':
      await cdpPost('/evaluate', { expression: 'location.reload()' });
      setTimeout(() => injectOverlay().catch(() => {}), 2000);
      broadcastToOverlay({ type: 'refreshed' });
      return { refreshed: true };

    case 'evaluate': {
      const expression = String((cmd as any).script || (cmd as any).code || (cmd as any).expression || '');
      const result = await cdpPost('/evaluate', { expression });
      return { result: result?.result ?? result };
    }

    case 'highlight': {
      broadcastToOverlay({ type: 'highlight', selector: cmd.selector });
      const sel = JSON.stringify(cmd.selector || '');
      // Apply styles directly rather than depending on window.__empir3_glowElement
      // being injected — works on any page even if overlay isn't loaded yet.
      const evalResult = await cdpPost('/evaluate', {
        expression: `(function(){
          try {
            var els = document.querySelectorAll(${sel});
            if (!els.length) return { count: 0, error: 'no match' };
            var saved = [];
            els.forEach(function(el){
              saved.push({ el: el, o: el.style.outline, oo: el.style.outlineOffset, bs: el.style.boxShadow });
              el.style.setProperty('outline', 'rgba(59,130,246,0.9) solid 2px', 'important');
              el.style.setProperty('outline-offset', '2px', 'important');
              el.style.setProperty('box-shadow', '0 0 15px rgba(59,130,246,0.5), 0 0 30px rgba(59,130,246,0.25)', 'important');
            });
            setTimeout(function(){
              saved.forEach(function(s){
                s.el.style.outline = s.o || '';
                s.el.style.outlineOffset = s.oo || '';
                s.el.style.boxShadow = s.bs || '';
              });
            }, 3000);
            return { count: els.length };
          } catch (e) { return { count: 0, error: String(e && e.message || e) }; }
        })()`,
      });
      const hitCount = evalResult?.result?.value?.count ?? evalResult?.result?.count ?? 0;
      return { highlighted: cmd.selector, count: hitCount };
    }

    case 'cursor_move':
      await cdpPost('/evaluate', {
        expression: `window.__empir3_moveCursor && window.__empir3_moveCursor(${cmd.x || 0}, ${cmd.y || 0})`,
      });
      return { cursor: { x: cmd.x, y: cmd.y } };

    case 'chat': {
      const chatMsg: ChatMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        from: 'claude',
        text: cmd.message || '',
        timestamp: new Date().toISOString(),
        channel: 'mcp',
      };
      appendFileSync(CHAT_LOG, JSON.stringify(chatMsg) + '\n');
      broadcastToOverlay({ type: 'claude_chat', message: chatMsg });
      console.log(`[Chat] Claude: ${cmd.message?.slice(0, 80)}`);
      return { sent: true };
    }

    case 'snapshot': {
      const snapFilter = cmd.filter || 'interactive';
      const snapFormat = cmd.format || 'compact';
      const result = await cdpGet('/snapshot', { filter: snapFilter, format: snapFormat });
      return { snapshot: result, filter: snapFilter, format: snapFormat };
    }

    case 'text': {
      const result = await cdpGet('/text');
      const text = typeof result?.text === 'string'
        ? result.text
        : (typeof result?.content === 'string' ? result.content : JSON.stringify(result ?? '', null, 2));
      return { text, url: currentUrl, title: result?.title };
    }

    case 'record_start': {
      isRecording = true;
      recordingActions = [];
      recentBridgeRecordedActions = [];
      recordingStartTime = Date.now();
      lastActionTime = Date.now();
      recordingStartUrl = currentUrl;
      // Pre-fetch snapshot for element ref matching
      getSnapshot().catch(() => {});
      const overlay = await ensureOverlayReady('record_start', { waitMs: 7000, force: true });
      const overlayConnected = !!overlay.connected;
      if (!overlayConnected) {
        isRecording = false;
        recordingActions = [];
        recentBridgeRecordedActions = [];
        broadcastToOverlay({ type: 'recording_state', recording: false });
        const detail = overlay.error || 'overlay did not connect';
        console.log(`[Recording] Refusing to start: ${detail}`);
        throw new Error(`Overlay injection failed; recording was not started. ${detail}`);
      }
      broadcastToOverlay({ type: 'recording_state', recording: true });
      console.log(`[Recording] Started at ${recordingStartUrl} (overlay connected)`);
      return {
        recording: true,
        startUrl: recordingStartUrl,
        engine: 'empir3',
        overlayConnected,
        overlay,
      };
    }

    case 'record_stop': {
      isRecording = false;
      broadcastToOverlay({ type: 'recording_state', recording: false });
      const duration = Date.now() - recordingStartTime;
      const vars = new Set<string>();
      recordingActions.forEach(a => {
        const matches = (a.text || '').match(/\{\{[A-Z_]+\}\}/g);
        if (matches) matches.forEach(m => vars.add(m));
      });
      // Get viewport from Empir3 Bridge
      let viewport = { width: 1920, height: 1080 };
      try {
        const vpResult = await cdpPost('/evaluate', {
          expression: `JSON.stringify({ width: window.innerWidth, height: window.innerHeight })`,
        }, { timeoutMs: 3000, wakeOnNotReady: false });
        const vpStr = vpResult?.result || vpResult;
        if (typeof vpStr === 'string') viewport = JSON.parse(vpStr);
      } catch {}

      const recording: Recording = {
        name: cmd.text || `recording-${new Date().toISOString().slice(0, 10)}`,
        description: cmd.message,
        startUrl: recordingStartUrl,
        recorded: new Date().toISOString(),
        duration,
        viewport,
        actions: recordingActions,
        variables: [...vars],
        engine: 'empir3',
      };
      const filename = recording.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() + '.json';
      writeFileSync(join(RECORDINGS_DIR, filename), JSON.stringify(recording, null, 2));
      console.log(`[Recording] Stopped. ${recordingActions.length} actions, ${(duration / 1000).toFixed(1)}s. Saved: ${filename}`);
      const refCount = recordingActions.filter(a => a.ref).length;
      console.log(`[Recording] ${refCount}/${recordingActions.length} actions have element refs`);
      recordingActions = [];
      recentBridgeRecordedActions = [];
      // Agent-driven actions (browser_click/type issued by the agent) replay via
      // their selector/evaluate path and don't carry accessibility-tree refs, so
      // a 0 refCount on an agent-recorded flow is expected, not a failure — only
      // user/overlay-captured clicks populate refs. Surface that so the count
      // doesn't read as alarming.
      const refNote = refCount === 0 && recording.actions.length > 0
        ? 'No element refs captured — expected for agent-driven actions; playback uses the selector/evaluate fallback.'
        : undefined;
      return { saved: filename, actionCount: recording.actions.length, duration, variables: recording.variables, refCount, ...(refNote ? { refNote } : {}) };
    }

    case 'play':
      return await playRecording(cmd.recording!, cmd.speed || 1, cmd.variables || {});

    case 'playback_pause':
      if (!isPlaying) return { ok: false, error: 'No recording is playing' };
      playbackControl.paused = true;
      broadcastToOverlay(transportSnapshot());
      return { ok: true, paused: true };

    case 'playback_resume':
      if (!isPlaying) return { ok: false, error: 'No recording is playing' };
      playbackControl.paused = false;
      playbackControl.stepOnce = false;
      broadcastToOverlay(transportSnapshot());
      return { ok: true, paused: false };

    case 'playback_stop':
      if (!isPlaying) return { ok: false, error: 'No recording is playing' };
      playbackControl.stop = true;
      playbackControl.paused = false;  // unblock the pause gate so the loop sees the stop
      return { ok: true, stopped: true };

    case 'playback_step':
      if (!isPlaying) return { ok: false, error: 'No recording is playing' };
      playbackControl.stepOnce = true;  // pause gate releases for one action, then re-pauses
      return { ok: true, stepped: true };

    case 'playback_speed': {
      const sp = Math.max(0.1, Math.min(10, Number(cmd.speed) || 1));
      playbackControl.speed = sp;
      if (isPlaying) broadcastToOverlay(transportSnapshot());
      return { ok: true, speed: sp };
    }

    case 'playback_seek': {
      if (!isPlaying) return { ok: false, error: 'No recording is playing' };
      const target = Math.max(0, Math.min((playbackControl.total || 1) - 1, Math.floor(Number(cmd.step) || 0)));
      playbackControl.seekTo = target;
      playbackControl.paused = false;   // unblock the pause gate so the loop performs the seek
      playbackControl.stepOnce = false;
      return { ok: true, seekTo: target };
    }

    case 'delete_recording': {
      const delName = cmd.recording || '';
      const delFile = join(RECORDINGS_DIR, delName.endsWith('.json') ? delName : delName.replace(/[^a-zA-Z0-9_\- ]/g, '_').toLowerCase() + '.json');
      if (existsSync(delFile)) {
        unlinkSync(delFile);
        console.log(`[Bridge] Deleted recording: ${delName}`);
        return { deleted: delName };
      }
      throw new Error(`Recording not found: ${delName}`);
    }

    default:
      throw new Error(`Unknown command: ${cmd.type}`);
  }
}

// ─── Recording: enrich with element refs ─────────────────────

function sameRecordedActionIntent(a: RecordedAction, b: RecordedAction): boolean {
  if (a.action !== b.action) return false;
  if (a.selector && b.selector && a.selector === b.selector) return true;
  if (a.ref && b.ref && a.ref === b.ref) return true;
  if (a.action === 'type') return !!(a.selector && b.selector && a.selector === b.selector && a.text === b.text);
  if (a.action === 'press') return !!(a.key && a.key === b.key);
  if (a.action === 'navigate') return !!(a.url && a.url === b.url);
  if (a.action === 'scroll') return Number(a.x || 0) === Number(b.x || 0) && Number(a.y || 0) === Number(b.y || 0);
  if (a.x !== undefined && a.y !== undefined && b.x !== undefined && b.y !== undefined) {
    return Math.abs(Number(a.x) - Number(b.x)) <= 3 && Math.abs(Number(a.y) - Number(b.y)) <= 3;
  }
  return false;
}

function isOverlayEchoOfBridgeAction(action: RecordedAction, now: number): boolean {
  recentBridgeRecordedActions = recentBridgeRecordedActions.filter(item => now - item.at < 30000);
  const zeroCoordClick = action.action === 'click' && Number(action.x || 0) === 0 && Number(action.y || 0) === 0;
  const recentBridgeEcho = recentBridgeRecordedActions.some(item => {
    const age = now - item.at;
    if (!sameRecordedActionIntent(action, item.action)) return false;
    if (zeroCoordClick) return age < 30000;
    return age < 2500;
  });
  if (recentBridgeEcho) return true;
  const last = recordingActions[recordingActions.length - 1];
  const sinceLast = now - lastActionTime;
  return !!(last && sameRecordedActionIntent(action, last) && (
    (zeroCoordClick && sinceLast < 30000) || sinceLast < 2500
  ));
}

async function addRecordedAction(action: RecordedAction, source: 'bridge' | 'overlay' = 'bridge') {
  if (!isRecording) return;
  const now = Date.now();
  if (source === 'overlay' && isOverlayEchoOfBridgeAction(action, now)) {
    console.log(`[Recording] Dropped overlay echo for ${action.action}${action.selector ? ` ${action.selector}` : ''}`);
    return;
  }

  action.delay = now - lastActionTime;
  lastActionTime = now;

  // Enrich clicks with element refs from Empir3 Bridge snapshot
  if (action.action === 'click' && action.x !== undefined && action.y !== undefined) {
    try {
      const elements = await getSnapshot();
      const match = findRefAtPosition(elements, action.x, action.y);
      if (match) {
        action.ref = match.ref;
        action.refLabel = match.name || '';
        action.refRole = match.role || '';
        console.log(`[Recording] Click at (${action.x},${action.y}) → ref:${match.ref} "${match.name}" [${match.role}]`);
      } else {
        console.log(`[Recording] Click at (${action.x},${action.y}) — no element ref found`);
      }
    } catch (e: any) {
      console.log(`[Recording] Ref enrichment failed: ${e.message?.slice(0, 40)}`);
    }
  }

  recordingActions.push(action);
  if (source === 'bridge') {
    recentBridgeRecordedActions.push({ action: { ...action }, at: now });
    recentBridgeRecordedActions = recentBridgeRecordedActions.filter(item => now - item.at < 30000);
  }
  broadcastToOverlay({ type: 'recording_action', count: recordingActions.length, action: action.action,
    ref: action.ref, refLabel: action.refLabel });
  console.log(`[Recording] +${action.action}${action.ref ? ` ref:${action.ref}` : ''} (${recordingActions.length} total)`);
}

// ─── Playback Engine (element ref first, coordinate fallback) ─

async function playRecording(nameOrFile: string, speed: number = 1, variables: Record<string, string> = {}): Promise<any> {
  if (!cdpConnected) throw new Error('Empir3 Bridge not connected');
  if (isPlaying) throw new Error('Already playing a recording');

  const file = join(RECORDINGS_DIR, nameOrFile.endsWith('.json') ? nameOrFile : nameOrFile.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() + '.json');
  if (!existsSync(file)) throw new Error(`Recording not found: ${nameOrFile}`);
  const recording: Recording = JSON.parse(readFileSync(file, 'utf-8'));

  const missingVars = recording.variables.filter(v => !variables[v.replace(/[{}]/g, '')] && !variables[v]);
  if (missingVars.length > 0) {
    console.log(`[Playback] Warning: missing variables: ${missingVars.join(', ')}`);
  }

  isPlaying = true;
  try {
  speed = Math.max(0.1, Math.min(10, speed));
  resetPlaybackControl();
  playbackControl.speed = speed;
  playbackControl.total = recording.actions.length;
  playbackControl.name = recording.name;
  console.log(`[Playback] Playing "${recording.name}" (${recording.actions.length} actions, ${speed}x speed, engine: ${recording.engine || 'legacy'})`);

  // Force-navigate back to the recording's start origin. Used both for the
  // initial run and when the user scrubs/rewinds backward (a seek to an index
  // at or before the cursor): replaying forward from a known origin is the only
  // correct way to "rewind" an action replay, since clicks/types can't be undone.
  const goToStart = async () => {
    if (!recording.startUrl) return;
    try {
      const baseUrl = new URL(recording.startUrl).origin;
      console.log(`[Playback] Navigating to start: ${baseUrl}`);
      await cdpPost('/navigate', { url: baseUrl });
      await new Promise(r => setTimeout(r, 2000));
      try { await injectOverlay(); } catch {}
    } catch {}
  };

  // Navigate to start URL (use origin for SPA deep links — server doesn't handle client routes)
  if (recording.startUrl) {
    try {
      const startUrl = new URL(recording.startUrl);
      const baseUrl = startUrl.origin; // e.g., https://app.empir3.com (no /connect, /settings, etc.)
      const curUrl = await cdpPost('/evaluate', { expression: 'location.href' });
      const current = curUrl?.result || curUrl || '';
      const currentOrigin = current ? new URL(current).origin : '';
      if (currentOrigin !== baseUrl || current.includes('welcome') || current.includes('9867')) {
        console.log(`[Playback] Navigating to: ${baseUrl}`);
        await cdpPost('/navigate', { url: baseUrl });
        await new Promise(r => setTimeout(r, 2000));
        try { await injectOverlay(); } catch {}
      }
    } catch {
      const startUrl = new URL(recording.startUrl);
      await cdpPost('/navigate', { url: startUrl.origin });
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Bring the playback tab to the foreground so the user can see it
  try {
    const curRes = await cdpPost('/evaluate', { expression: 'location.href' });
    const curHref = (typeof curRes === 'string' ? curRes : curRes?.result) || '';
    if (curHref) {
      // /navigate to current URL triggers switchToTarget → Page.bringToFront
      await cdpPost('/navigate', { url: curHref });
    }
  } catch {}

  // Get current viewport and compute scale factors for coordinate adjustment
  let scaleX = 1, scaleY = 1;
  if (recording.viewport) {
    try {
      const vpResult = await cdpPost('/evaluate', {
        expression: 'JSON.stringify({w:window.innerWidth,h:window.innerHeight})',
      });
      const vpStr = typeof vpResult === 'string' ? vpResult : vpResult?.result;
      if (vpStr && typeof vpStr === 'string') {
        const currentVp = JSON.parse(vpStr);
        scaleX = currentVp.w / recording.viewport.width;
        scaleY = currentVp.h / recording.viewport.height;
        if (scaleX !== 1 || scaleY !== 1) {
          console.log(`[Playback] Viewport mismatch: recorded ${recording.viewport.width}x${recording.viewport.height}, current ${currentVp.w}x${currentVp.h} — scaling coordinates (${scaleX.toFixed(3)}x, ${scaleY.toFixed(3)}y)`);
        }
      }
    } catch (e: any) {
      console.log(`[Playback] Could not detect viewport for scaling: ${e.message}`);
    }
  }

  broadcastToOverlay({ type: 'playback_state', playing: true, name: recording.name, total: recording.actions.length });
  broadcastToOverlay(transportSnapshot());

  const results: { step: number; action: string; ok: boolean; error?: string; method?: string; warning?: string; hit?: string }[] = [];
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  let i = 0;
  let fastUntil = -1;  // while i < fastUntil, replay with minimal delay (used when seeking)
  while (i < recording.actions.length) {
    if (playbackControl.stop) break;

    // Handle a pending seek (scrub / rewind / fast-forward / restart). A target
    // at or before the cursor means rewind: re-navigate to start and replay
    // forward at speed until the target. A target ahead means fast-forward
    // through the intervening actions (state stays consistent).
    if (playbackControl.seekTo !== null) {
      const target = Math.max(0, Math.min(recording.actions.length - 1, playbackControl.seekTo));
      playbackControl.seekTo = null;
      if (target <= i) {
        playbackControl.current = 0;
        broadcastToOverlay(transportSnapshot({ seeking: true, current: 0 }));
        await goToStart();
        if (playbackControl.stop) break;
        i = 0;
      }
      fastUntil = target;
      broadcastToOverlay(transportSnapshot({ seeking: true }));
    }

    // Pause gate — held while paused; released by resume / stop / seek / step.
    while (playbackControl.paused && !playbackControl.stop && playbackControl.seekTo === null && !playbackControl.stepOnce) {
      await sleep(120);
    }
    if (playbackControl.stop) break;
    if (playbackControl.seekTo !== null) continue;  // a seek arrived during pause — handle it at the top
    const stepping = playbackControl.stepOnce;
    playbackControl.stepOnce = false;

    const act = recording.actions[i];
    const fast = i < fastUntil;
    playbackControl.current = i;
    playbackControl.action = act.action;   // so a mid-playback synced overlay shows the real action, not "Starting…"
    playbackControl.ref = act.ref || '';
    broadcastToOverlay({ type: 'playback_step', step: i + 1, total: recording.actions.length, action: act.action, ref: act.ref });
    broadcastToOverlay(transportSnapshot());

    // Delay — minimum 800ms between actions so playback is watchable (skipped
    // while fast-seeking). Speed is read live so the scrubber's speed control
    // takes effect mid-playback.
    const liveSpeed = playbackControl.speed || 1;
    const delay = fast ? 25 : Math.max(800 / liveSpeed, act.delay / liveSpeed);
    await sleep(delay);
    if (playbackControl.stop) break;
    if (playbackControl.seekTo !== null) continue;  // re-handle seek before executing

    // Tab routing: if the recording tagged this action with the URL it was captured on,
    // ensure the bridge is focused on that tab. /navigate switches to an already-open tab
    // when the URL matches, otherwise opens it. Skip for 'navigate' actions — they manage
    // their own URL. Skip if pageUrl missing (legacy recordings).
    if (act.pageUrl && act.action !== 'navigate') {
      try {
        const curRes = await cdpPost('/evaluate', { expression: 'location.href' });
        const cur = (typeof curRes === 'string' ? curRes : curRes?.result) || '';
        const norm = (u: string) => u.replace(/[#/]+$/, '');
        if (norm(cur) !== norm(act.pageUrl)) {
          console.log(`[Playback] Tab route: "${cur}" → "${act.pageUrl}"`);
          await cdpPost('/navigate', { url: act.pageUrl });
          await new Promise(r => setTimeout(r, 600));
          try { await injectOverlay(); } catch {}
        }
      } catch {}
    }

    // Substitute variables
    let text = act.text || '';
    let url = act.url || '';
    for (const [key, val] of Object.entries(variables)) {
      const pattern = key.startsWith('{{') ? key : `{{${key}}}`;
      text = text.replace(pattern, val);
      url = url.replace(pattern, val);
    }

    // Snapshot tab list before action (for new-tab detection after clicks — legacy fallback only)
    let tabsBefore: string[] = [];
    if (act.action === 'click' && !act.pageUrl) {
      try {
        const tabs = await cdpGet('/tabs');
        tabsBefore = (tabs?.tabs || []).map((t: any) => t.id);
      } catch {}
    }

    try {
      switch (act.action) {
        case 'click': {
          let method = 'unknown';
          let clicked = false;

          // Strategy 1: Use element ref (most reliable)
          if (act.ref) {
            try {
              await cdpPost('/action', { kind: 'click', ref: act.ref });
              method = 'ref';
              clicked = true;
            } catch (e: any) {
              console.log(`[Playback] Ref click failed (${act.ref}): ${e.message?.slice(0, 40)}, trying fallback...`);
            }
          }

          // Strategy 2: If ref failed, try finding element by label in current snapshot
          if (!clicked && act.refLabel) {
            try {
              const elements = await getSnapshot();
              const match = elements.find(el =>
                el.name === act.refLabel && (!act.refRole || el.role === act.refRole)
              );
              if (match) {
                await cdpPost('/action', { kind: 'click', ref: match.ref });
                method = 'ref_by_label';
                clicked = true;
                console.log(`[Playback] Found element by label "${act.refLabel}" → ref:${match.ref}`);
              }
            } catch {}
          }

          // Strategy 3: Fall back to coordinate click via evaluate (scaled to current viewport)
          let coordHitTag: string | null = null;
          if (!clicked && act.x !== undefined && act.y !== undefined) {
            const sx = Math.round(act.x * scaleX);
            const sy = Math.round(act.y * scaleY);
            // Move cursor for visual feedback
            try {
              await cdpPost('/evaluate', {
                expression: `window.__empir3_moveCursor && window.__empir3_moveCursor(${sx}, ${sy})`,
              });
            } catch {}
            await new Promise(r => setTimeout(r, Math.max(50, 150 / speed)));
            const hitRes = await cdpPost('/evaluate', {
              expression: `(function() {
                const el = document.elementFromPoint(${sx}, ${sy});
                if (!el) return null;
                el.click();
                return el.tagName + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0,2).join('.') : '');
              })()`,
            });
            coordHitTag = hitRes?.result?.value || hitRes?.result || null;
            method = 'coordinates';
            clicked = true;
          }

          // Strategy 4: CSS selector fallback
          if (!clicked && act.selector) {
            await cdpPost('/evaluate', {
              expression: `document.querySelector(${JSON.stringify(act.selector)})?.click()`,
            });
            method = 'selector';
          }

          // Flag coord-only clicks that likely missed: hit a non-interactive
          // container or nothing at all. Coordinate playback is fragile across
          // viewport changes, so surface this loudly rather than calling it "passed".
          let warning: string | undefined;
          if (method === 'coordinates') {
            const tag = String(coordHitTag || '').toUpperCase();
            const interactive = /^(BUTTON|A|INPUT|SELECT|TEXTAREA|LABEL|SUMMARY)/.test(tag);
            if (!coordHitTag) warning = `Coord-only click at (${act.x},${act.y}) hit nothing — recording lacks selector/ref and viewport may have changed`;
            else if (!interactive) warning = `Coord-only click landed on non-interactive ${tag} — likely missed the intended target`;
          }
          results.push({ step: i + 1, action: 'click', ok: !warning, method, warning, hit: coordHitTag || undefined });

          // After click: detect if a new tab opened and switch to it
          if (tabsBefore.length > 0) {
            // Poll for new tab (may take a moment to open)
            for (let pollAttempt = 0; pollAttempt < 5; pollAttempt++) {
              await new Promise(r => setTimeout(r, 1000));
              try {
                const tabsAfter = await cdpGet('/tabs');
                const afterIds = (tabsAfter?.tabs || []).map((t: any) => t.id);
                const newTabs = afterIds.filter((id: string) => !tabsBefore.includes(id));
                if (newTabs.length > 0) {
                  const newTab = (tabsAfter.tabs || []).find((t: any) => t.id === newTabs[0]);
                  if (newTab?.url && !newTab.url.includes('about:blank')) {
                    console.log(`[Playback] New tab detected: "${newTab.title}" (${newTab.url}) — switching`);
                    await cdpPost('/navigate', { url: newTab.url });
                    await new Promise(r => setTimeout(r, 1500));
                    try { await injectOverlay(); } catch {}
                    break;
                  }
                } else if (pollAttempt >= 2) {
                  break; // No new tab after 3 attempts, move on
                }
              } catch {}
            }
          }
          break;
        }

        case 'type': {
          let method = 'unknown';

          // Determine if this is a new field or continuation
          const prevAction = i > 0 ? recording.actions[i - 1] : null;
          const isNewField = !prevAction || prevAction.action === 'click';

          // If the previous click had a ref, use it to target the field
          if (isNewField && prevAction?.ref) {
            try {
              // Click the ref first to focus
              await cdpPost('/action', { kind: 'click', ref: prevAction.ref });
              await new Promise(r => setTimeout(r, 100));
            } catch {}
          }

          // Use React-compatible value setter via evaluate
          try {
            const fullText = isNewField ? text : await (async () => {
              try {
                const cur = await cdpPost('/evaluate', {
                  expression: `(document.activeElement?.value || '')`,
                });
                return (cur?.result || '') + text;
              } catch { return text; }
            })();

            // Find the right input field using previous click coordinates + skip already-typed inputs
            const prevClick = prevAction?.action === 'click' ? prevAction : null;
            const clickX = prevClick ? Math.round((prevClick.x || 0) * scaleX) : -1;
            const clickY = prevClick ? Math.round((prevClick.y || 0) * scaleY) : -1;
            await cdpPost('/evaluate', {
              expression: `(function() {
                var el = document.activeElement;
                // Track which inputs have been typed into (stored on window to persist across steps)
                if (!window.__empir3_typedInputs) window.__empir3_typedInputs = new Set();

                // If activeElement is an input we already typed into, clear it and find next
                if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && window.__empir3_typedInputs.has(el)) {
                  el = null; // Force finding the next input
                }

                // If activeElement isn't a fresh input, find the right one
                if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) {
                  var cx = ${clickX}, cy = ${clickY};
                  // Find nearest UNTYPED input by distance to click point
                  var inputs = document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea');
                  var bestDist = Infinity, bestInp = null;
                  for (var ii = 0; ii < inputs.length; ii++) {
                    var inp = inputs[ii];
                    if (window.__empir3_typedInputs.has(inp)) continue; // Skip already-typed
                    var r = inp.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0 && !inp.disabled && !inp.readOnly) {
                      if (cx >= 0 && cy >= 0) {
                        var midX = r.left + r.width/2, midY = r.top + r.height/2;
                        var dist = Math.abs(midX - cx) + Math.abs(midY - cy);
                        if (dist < bestDist) { bestDist = dist; bestInp = inp; }
                      } else if (!bestInp) {
                        bestInp = inp; // No coordinates — just take first untyped
                      }
                    }
                  }
                  if (bestInp) { bestInp.focus(); el = bestInp; }
                }
                if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                  var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                  var setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                  if (setter) {
                    var tracker = el._valueTracker;
                    if (tracker) tracker.setValue('');
                    setter.call(el, ${JSON.stringify(fullText)});
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    window.__empir3_typedInputs.add(el);
                    return 'typed_react';
                  }
                  el.value = ${JSON.stringify(fullText)};
                  window.__empir3_typedInputs.add(el);
                  return 'typed_basic';
                }
                return 'no_input_focused';
              })()`,
            });
            method = 'evaluate';
          } catch {
            // Fallback: type via Empir3 Bridge keyboard action
            await cdpPost('/action', { kind: 'selectAll' });
            await cdpPost('/action', { kind: 'type', text: isNewField ? text : text });
            method = 'keyboard';
          }
          results.push({ step: i + 1, action: 'type', ok: true, method });
          break;
        }

        case 'press':
          await cdpPost('/action', { kind: 'press', key: act.key || text });
          results.push({ step: i + 1, action: 'press', ok: true });
          break;

        case 'navigate': {
          // If this navigate follows immediately after a click (< 500ms delay),
          // it's a SPA route change triggered by the click — don't reload the page
          const prevAct = i > 0 ? recording.actions[i - 1] : null;
          const isSpaNav = prevAct && prevAct.action === 'click' && act.delay < 500;

          // Check if already on this URL
          let current = '';
          try {
            const r = await cdpPost('/evaluate', { expression: 'location.href' });
            current = r?.result || '';
          } catch {}

          if (current === url || current.replace(/\/$/, '') === url.replace(/\/$/, '')) {
            results.push({ step: i + 1, action: 'navigate (already here)', ok: true });
          } else if (isSpaNav) {
            // Wait for the SPA navigation triggered by the previous click
            // Poll until URL matches or timeout after 5s
            let matched = false;
            for (let w = 0; w < 10; w++) {
              await new Promise(r => setTimeout(r, 500));
              try {
                const check = await cdpPost('/evaluate', { expression: 'location.href' });
                const nowUrl = check?.result || '';
                if (nowUrl === url || nowUrl.replace(/\/$/, '') === url.replace(/\/$/, '')) {
                  matched = true;
                  break;
                }
              } catch {}
            }
            try { await injectOverlay(); } catch {}
            results.push({ step: i + 1, action: matched ? 'navigate (SPA confirmed)' : 'navigate (SPA timeout, forcing)', ok: true });
            // If SPA didn't navigate, force it
            if (!matched) {
              try { await cdpPost('/navigate', { url }); } catch {}
              await new Promise(r => setTimeout(r, 1500));
              try { await injectOverlay(); } catch {}
            }
          } else {
            try {
              await cdpPost('/navigate', { url });
            } catch (navErr: any) {
              console.log(`[Playback] Navigate warning: ${navErr.message?.slice(0, 60)}`);
            }
            await new Promise(r => setTimeout(r, 1500));
            try { await injectOverlay(); } catch {}
            results.push({ step: i + 1, action: 'navigate', ok: true });
          }
          break;
        }

        case 'scroll':
          await cdpPost('/evaluate', {
            expression: `(function() {
              var dx = ${act.x || 0}, dy = ${act.y || 0};
              // Find the visible scrollable container closest to viewport center
              // (RN Web keeps hidden tab containers in DOM — must pick the visible one)
              var cx = window.innerWidth / 2, cy = window.innerHeight / 2;
              var best = null, bestDist = Infinity;
              var all = document.querySelectorAll('*');
              for (var i = 0; i < all.length; i++) {
                var c = all[i];
                var cs = getComputedStyle(c);
                if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && c.scrollHeight > c.clientHeight + 10) {
                  // Skip invisible/hidden elements
                  if (cs.display === 'none' || cs.visibility === 'hidden' || c.offsetHeight === 0) continue;
                  var r = c.getBoundingClientRect();
                  if (r.width === 0 || r.height === 0) continue;
                  // Prefer containers that contain the viewport center
                  if (r.left <= cx && r.right >= cx && r.top <= cy && r.bottom >= cy) {
                    // Among containers containing center, prefer the innermost (smallest area)
                    var area = r.width * r.height;
                    if (area < bestDist) { best = c; bestDist = area; }
                  }
                }
              }
              if (best) { best.scrollBy(dx, dy); }
              else { window.scrollBy(dx, dy); }
            })()`,
          });
          // Settle time after scroll — let content render before next action
          await new Promise(r => setTimeout(r, Math.max(300, 500 / speed)));
          results.push({ step: i + 1, action: 'scroll', ok: true });
          break;

        case 'tab_focus': {
          // User switched to this tab via browser tab bar during recording.
          // Switch the bridge to the matching tab.
          const tabUrl = act.url || act.pageUrl || '';
          if (tabUrl) {
            try {
              await cdpPost('/navigate', { url: tabUrl });
              await new Promise(r => setTimeout(r, 600));
              try { await injectOverlay(); } catch {}
            } catch (navErr: any) {
              console.log(`[Playback] Tab focus switch failed: ${navErr.message?.slice(0, 60)}`);
            }
          }
          results.push({ step: i + 1, action: 'tab_focus', ok: true });
          break;
        }

        case 'wait':
          await new Promise(r => setTimeout(r, act.delay / speed));
          results.push({ step: i + 1, action: 'wait', ok: true });
          break;

        case 'assert': {
          let passed = false;
          switch (act.assertType) {
            case 'contains_text': {
              const r = await cdpPost('/evaluate', {
                expression: `document.body.innerText.includes(${JSON.stringify(act.assertValue || '')})`,
              });
              passed = r?.result === true || r?.result === 'true';
              break;
            }
            case 'url_match': {
              const r = await cdpPost('/evaluate', { expression: 'location.href' });
              passed = (r?.result || '').includes(act.assertValue || '');
              break;
            }
            case 'element_exists': {
              const r = await cdpPost('/evaluate', {
                expression: `!!document.querySelector(${JSON.stringify(act.assertValue || '')})`,
              });
              passed = r?.result === true || r?.result === 'true';
              break;
            }
            case 'element_visible': {
              const r = await cdpPost('/evaluate', {
                expression: `(function() {
                  const el = document.querySelector(${JSON.stringify(act.assertValue || '')});
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0;
                })()`,
              });
              passed = r?.result === true || r?.result === 'true';
              break;
            }
          }
          results.push({ step: i + 1, action: `assert:${act.assertType}`, ok: passed,
            error: passed ? undefined : `Assertion failed: ${act.assertType} "${act.assertValue}"` });
          break;
        }
      }
    } catch (e: any) {
      results.push({ step: i + 1, action: act.action, ok: false, error: e.message });
      console.log(`[Playback] Error at step ${i + 1}: ${e.message}`);
    }

    i++;
    if (fastUntil >= 0 && i >= fastUntil) fastUntil = -1;  // reached the seek target — resume normal pacing
    // Single-step (Step button): execute exactly one action, then hold again.
    if (stepping && !playbackControl.stop && playbackControl.seekTo === null) {
      playbackControl.current = Math.min(i, recording.actions.length - 1);
      playbackControl.paused = true;
      broadcastToOverlay(transportSnapshot());
    }
  }

  const stopped = playbackControl.stop;
  isPlaying = false;
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const warnings = results.filter((r: any) => r.warning).map((r: any) => `step ${r.step}: ${r.warning}`);
  broadcastToOverlay({ type: 'playback_state', playing: false, name: recording.name, passed, failed, stopped });
  broadcastToOverlay(transportSnapshot({ active: false, stopped }));
  console.log(`[Playback] ${stopped ? 'Stopped' : 'Done'}. ${passed}/${results.length} steps ran${failed ? `, ${failed} failed` : ''}${warnings.length ? `, ${warnings.length} warnings` : ''}.`);
  return { name: recording.name, results, passed, failed, total: results.length, warnings, stopped };
  } finally {
    isPlaying = false;
    resetPlaybackControl();
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function broadcastToOverlay(msg: any) {
  const data = JSON.stringify(msg);
  // Snapshot first — we may mutate overlayClients during the loop when
  // dropping dead sockets. Also use try/catch per-send so one half-dead
  // client can't break the broadcast for every other client.
  const targets = Array.from(overlayClients);
  for (const ws of targets) {
    const state = (ws as any).readyState;
    if (state !== 1 /* OPEN */) {
      overlayClients.delete(ws);
      continue;
    }
    try {
      ws.send(data);
    } catch (e: any) {
      overlayClients.delete(ws);
      console.warn('[Bridge] overlay send failed, dropping client:', e?.message || e);
    }
  }
  // Also push into every CDP-injected page that has __empir3_inbox.
  if (cdpConnected && pruneOverlayClients() === 0) {
    pushToCdpOverlay(msg).catch(() => { /* tab nav races; non-fatal */ });
  }
}

// WS keepalive — overlay connections sit idle during CLI cold-start
// (~10s) or any quiet period. Without a heartbeat, intermediate proxies
// or browser tab-throttling can silently half-close the socket; the
// server keeps "broadcasting" into a dead pipe and the user has to
// refresh to see the persisted reply. ws.ping() round-trips at the
// protocol level; if no pong inside the next interval, terminate so
// the client reconnects on its next page render.
const OVERLAY_PING_INTERVAL_MS = 25000;
setInterval(() => {
  for (const ws of Array.from(overlayClients)) {
    const w = ws as any;
    if (w.readyState !== 1) { overlayClients.delete(ws); continue; }
    if (w._empir3IsAlive === false) {
      try { w.terminate(); } catch {}
      overlayClients.delete(ws);
      continue;
    }
    w._empir3IsAlive = false;
    try { w.ping(); } catch { overlayClients.delete(ws); }
  }
}, OVERLAY_PING_INTERVAL_MS).unref();

async function pushToCdpOverlay(ev: any) {
  // Wrap the JSON twice — once to make it a JS string literal in the
  // expression, and once because __empir3_inbox parses JSON.
  const payload = JSON.stringify(JSON.stringify(ev));
  await cdpPost('/evaluate-all', {
    expression: `try{window.__empir3_inbox && window.__empir3_inbox(${payload})}catch(e){}`,
    timeoutMs: 750,
  }, { timeoutMs: 1200, wakeOnNotReady: false });
}

async function pushToCdpTarget(targetId: string, ev: any) {
  if (!targetId) return pushToCdpOverlay(ev);
  const payload = JSON.stringify(JSON.stringify(ev));
  await cdpPost('/evaluate-on-target', {
    targetId,
    expression: `try{window.__empir3_inbox && window.__empir3_inbox(${payload})}catch(e){}`,
    timeoutMs: 1000,
  }, { timeoutMs: 1500, wakeOnNotReady: false });
}

// ─── CDP-overlay outbox poll ─────────────────────────────────
// The standalone overlay (no extension) pushes outbound messages into
// window.__empir3_outbox. Drain it with one in-flight CDP eval at a time so
// overlay mail cannot starve real browser commands.
let overlayPollHandle: NodeJS.Timeout | null = null;
let overlayPollInFlight = false;
function startOverlayPoll() {
  if (overlayPollHandle) return;
  overlayPollHandle = setInterval(async () => {
    if (!cdpConnected) return;
    if (pruneOverlayClients() > 0) return;
    if (overlayPollInFlight) return;
    overlayPollInFlight = true;
    try {
      const r: any = await cdpPost('/evaluate-all', {
        expression: 'JSON.stringify((window.__empir3_outbox||[]).splice(0))',
        timeoutMs: 750,
      }, { timeoutMs: 1200, wakeOnNotReady: false });
      const results = r?.results || [];
      for (const target of results) {
        // /evaluate-all returns { targetId, url, ok, result } per tab — the
        // expression's stringified return value lives in `result`, not `value`.
        if (target?.ok !== true) continue;
        const value = target?.result;
        if (!value || value === '[]' || typeof value !== 'string') continue;
        let arr: any[];
        try { arr = JSON.parse(value); } catch { continue; }
        for (const itemJson of arr) {
          let msg: any;
          try { msg = JSON.parse(itemJson); } catch { continue; }
          // Synthesize a virtual ws so handleOverlayMessage can `ws.send`
          // its ack/response. Acks route back to the same page that posted.
          const targetId = target?.targetId || target?.id || null;
          const virtualWs: any = {
            send: (s: string) => {
              try {
                const ev = JSON.parse(s);
                if (targetId) pushToCdpTarget(targetId, ev).catch(() => {});
                else pushToCdpOverlay(ev).catch(() => {});
              } catch { /* ignore */ }
            },
            readyState: 1,
            __cdpTargetId: targetId,
          };
          try { await handleOverlayMessage(msg, virtualWs); } catch (e: any) {
            console.log('[Bridge] virtual-ws message error:', e?.message || e);
          }
        }
      }
    } catch { /* poll storm during nav is fine */ }
    finally { overlayPollInFlight = false; }
  }, 2000);
}
function stopOverlayPoll() {
  if (overlayPollHandle) { clearInterval(overlayPollHandle); overlayPollHandle = null; }
}

function saveSessionContext() {
  writeFileSync(CONTEXT_FILE, JSON.stringify(sessionCtx, null, 2));
}

/**
 * Standalone CDP-injected chat overlay — works on every page including https
 * without requiring the browser extension. Communicates with the bridge via
 * a mailbox pattern: page pushes outbound to window.__empir3_outbox (drained
 * by the bridge via Runtime.evaluate polling), and the bridge pushes inbound
 * by calling window.__empir3_inbox(jsonStr). No WebSocket from the page side,
 * so no mixed-content blocks.
 */
let _standaloneOverlayScript: string | null = null;
function getStandaloneOverlayScript(): string {
  // Keep the no-extension path feature-complete. This reuses the full browser
  // overlay with side switching, page push, annotate, draw, record, and play
  // instead of the older reduced CDP panel.
  //
  // Memoized: BRIDGE_NONCE is stable for the life of the process and
  // getOverlayScript builds a ~111KB template literal. Rebuilding it on every
  // injectOverlay / health-loop / auto-inject call (and re-stringifying it over
  // the loopback HTTP hop to the CDP bridge) was a large recurring sync allocation
  // on the shared event loop — cache it once.
  if (_standaloneOverlayScript === null) _standaloneOverlayScript = getOverlayScript(BRIDGE_NONCE);
  return _standaloneOverlayScript;
}

/** Inject overlay into Chrome via Empir3 Bridge's evaluate endpoint */
async function injectOverlay(opts: { timeoutMs?: number } = {}): Promise<Record<string, any>> {
  if (!cdpConnected) return { ok: false, error: 'browser disconnected' };
  try {
    const overlayScript = getStandaloneOverlayScript();
    const result = await cdpPost('/evaluate', { expression: overlayScript }, {
      timeoutMs: opts.timeoutMs ?? 5000,
      wakeOnNotReady: false,
    });
    overlayInjected = true;
    startOverlayPoll();
    console.log('[Bridge] Browser overlay injected via CDP evaluate');
    return { ok: true, target: 'current', result };
  } catch (e: any) {
    const error = e.message || String(e);
    console.log(`[Bridge] Overlay injection failed: ${error.slice(0, 60)}`);
    return { ok: false, error };
  }
}

/**
 * Inject overlay into ALL open tabs via the bridge's /evaluate-all endpoint.
 * Also registers the overlay as the auto-inject script so new tabs get it automatically.
 */
async function injectOverlayAll(opts: { timeoutMs?: number } = {}): Promise<Record<string, any>> {
  if (!cdpConnected) return { ok: false, error: 'browser disconnected' };
  try {
    const overlayScript = getStandaloneOverlayScript();
    // Register for auto-injection into future tabs + inject into all current tabs
    const result: any = await cdpPost('/register-auto-inject', { script: overlayScript }, {
      timeoutMs: opts.timeoutMs ?? 5000,
      wakeOnNotReady: false,
    });
    const injected = result?.injected || [];
    const ok = injected.filter((r: any) => r.ok).length;
    const fail = injected.filter((r: any) => !r.ok).length;
    if (ok > 0) overlayInjected = true;
    console.log(`[Bridge] Browser overlay registered for auto-inject + applied to ${ok} tabs (${fail} failed)`);
    startOverlayPoll();
    return { ok: ok > 0, registered: !!result?.registered, injected, okCount: ok, failCount: fail };
  } catch (e: any) {
    const error = e.message || String(e);
    console.log(`[Bridge] Overlay inject-all failed: ${error.slice(0, 60)}`);
    return { ok: false, error };
  }
}

async function currentOverlayDomState(opts: { timeoutMs?: number } = {}): Promise<Record<string, any>> {
  if (!cdpConnected) return { ok: false, error: 'browser disconnected' };
  try {
    const r = await cdpPost('/evaluate', {
      expression: `JSON.stringify({
        href: location.href,
        loaded: !!window.__empir3BridgeLoaded,
        bubble: !!document.querySelector('#empir3-bubble'),
        toolbar: !!document.querySelector('#empir3-toolbar'),
        hasMoveCursor: typeof window.__empir3_moveCursor === 'function',
        wsOpen: !!window.__empir3WsOpen,
        wsLastOpenAt: window.__empir3WsLastOpenAt || 0,
        wsLastCloseAt: window.__empir3WsLastCloseAt || 0,
        outboxLength: Array.isArray(window.__empir3_outbox) ? window.__empir3_outbox.length : null
      })`,
    }, { timeoutMs: opts.timeoutMs ?? 1500, wakeOnNotReady: false });
    const raw = r?.result ?? r;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    return { ok: true, ...parsed };
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function waitForOverlayClient(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (pruneOverlayClients() === 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }
  return pruneOverlayClients() > 0;
}

async function ensureOverlayReady(
  reason = 'ensure',
  opts: { waitMs?: number; force?: boolean; cdpTimeoutMs?: number } = {},
): Promise<Record<string, any>> {
  if (!cdpConnected) {
    return { ok: false, connected: false, reason, error: 'browser disconnected' };
  }
  const cdpTimeoutMs = Math.max(500, Math.min(6000, opts.cdpTimeoutMs ?? 3000));
  const socketCount = pruneOverlayClients();
  const dom = await currentOverlayDomState({ timeoutMs: Math.min(1500, cdpTimeoutMs) });
  const domReady = overlayDomReady(dom);
  if (!opts.force && socketCount > 0 && domReady) {
    overlayInjected = true;
    return {
      ok: true,
      connected: true,
      reason,
      overlayClients: socketCount,
      overlayInjected,
      dom,
    };
  }
  if (!opts.force && socketCount > 0 && !domReady) {
    overlayInjected = true;
    return {
      ok: true,
      connected: true,
      reason,
      overlayClients: socketCount,
      overlayInjected,
      dom,
      warning: 'overlay socket connected; skipped automatic repair',
    };
  }

  if (overlayEnsureInFlight) return overlayEnsureInFlight;

  overlayEnsureInFlight = (async () => {
    lastOverlayEnsureAt = Date.now();
    const before = dom;
    const all = await injectOverlayAll({ timeoutMs: cdpTimeoutMs });
    let connected = await waitForOverlayClient(opts.waitMs ?? 5000);
    let single: Record<string, any> | null = null;
    if (!connected) {
      single = await injectOverlay({ timeoutMs: cdpTimeoutMs });
      connected = await waitForOverlayClient(Math.min(3000, opts.waitMs ?? 5000));
    }
    const after = await currentOverlayDomState({ timeoutMs: Math.min(1500, cdpTimeoutMs) });
    const usable = connected || overlayDomReady(after);
    if (usable) overlayInjected = true;
    return {
      ok: usable,
      connected: usable,
      socketConnected: connected,
      reason,
      overlayClients: pruneOverlayClients(),
      overlayInjected,
      before,
      after,
      injectAll: all,
      injectCurrent: single,
      error: usable ? undefined : 'overlay did not connect after injection',
    };
  })().finally(() => {
    overlayEnsureInFlight = null;
  });

  return overlayEnsureInFlight;
}

function startOverlayHealthLoop() {
  if (overlayHealthTimer) return;
  overlayHealthTimer = setInterval(async () => {
    if (!cdpConnected || overlayEnsureInFlight) return;
    if (Date.now() - lastOverlayEnsureAt < 8000) return;
    const dom = await currentOverlayDomState({ timeoutMs: 1000 });
    if (pruneOverlayClients() > 0) {
      if (overlayDomReady(dom)) overlayInjected = true;
      return;
    }
    ensureOverlayReady('health_loop', { waitMs: 1000, cdpTimeoutMs: 1200 })
      .then(r => {
        if (!r.ok) console.log(`[Bridge] Overlay health repair failed: ${r.error || 'not connected'}`);
      })
      .catch(e => console.log(`[Bridge] Overlay health repair failed: ${e?.message || e}`));
  }, 5000);
}

function getWelcomeHtml(apiBase = '') {
  const api = apiBase || '';
  const signedIn = hasBridgeAuth();

  // Map each tool to the global safety category it requires (mirrors
  // requiredBridgePermission() in this file). Drives the per-row "NEEDS X"
  // warning chip when a tool is enabled but its required global category
  // is off — saves users from chasing silent denials.
  const toolsEnriched = TOOL_META.map(t => ({
    n: t.name,
    g: t.group,
    d: t.defaultEnabled,
    r: TOOL_PERMISSION_REQUIREMENTS[t.name] || null,
    b: t.blurb,
  }));
  const toolsJson = JSON.stringify(toolsEnriched);
  const toolCount = TOOL_META.length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>empir3 Bridge — Console</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; }
  :root {
    --ink:#18181b;--ink-2:#27272a;--ink-3:#3f3f46;
    --paper:#ffffff;--bg:#f4f4f5;--surface:#fafafa;--surface-2:#e4e4e7;
    --rail:#18181b;--rail-2:#27272a;
    --rail-line:rgba(255,255,255,0.08);
    --rail-text:#d4d4d8;--rail-text-dim:#71717a;--rail-text-bright:#fafafa;
    --line:rgba(0,0,0,0.10);--line-strong:rgba(0,0,0,0.18);--rule:rgba(0,0,0,0.06);
    --muted:#52525b;--soft:#71717a;--faint:#a1a1aa;
    --accent:#6b4ef0;--accent-soft:rgba(107,78,240,0.10);
    --good:#059669;--good-soft:rgba(5,150,105,0.10);
    --warn:#d97706;--warn-soft:rgba(217,119,6,0.10);
    --bad:#dc2626;--bad-soft:rgba(220,38,38,0.10);
  }
  body[data-theme="dark"] {
    --ink:#fafafa;--ink-2:#e4e4e7;--ink-3:#d4d4d8;
    --paper:#18181b;--bg:#09090b;--surface:#1f1f23;--surface-2:#27272a;
    --rail:#050507;--rail-2:#131316;--rail-line:rgba(255,255,255,0.06);
    --rail-text:#a1a1aa;--rail-text-dim:#52525b;--rail-text-bright:#fafafa;
    --line:rgba(255,255,255,0.08);--line-strong:rgba(255,255,255,0.16);--rule:rgba(255,255,255,0.05);
    --muted:#a1a1aa;--soft:#71717a;--faint:#52525b;
    --accent:#8c6bff;--accent-soft:rgba(140,107,255,0.14);
    --good:#10b981;--good-soft:rgba(16,185,129,0.14);
    --warn:#f59e0b;--warn-soft:rgba(245,158,11,0.14);
    --bad:#ef4444;--bad-soft:rgba(239,68,68,0.14);
  }
  body[data-theme="dark"] pre.snippet { background:#050507; color:#fafafa; }
  body[data-theme="dark"] .signin { background:var(--accent); border-color:var(--accent); color:#fff; }
  body[data-theme="dark"] .signin:hover { background:#7a55ff; border-color:#7a55ff; }
  body[data-theme="dark"] .signin .brand-inline .three,
  body[data-theme="dark"] .btn.primary .brand-inline .three { color:#fff; }
  body[data-theme="dark"] .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  body[data-theme="dark"] .btn.primary:hover { background:#7a55ff; border-color:#7a55ff; }
  body[data-theme="dark"] .tag.solid-ink { background:var(--accent); color:#fff; border-color:var(--accent); }
  body[data-theme="dark"] .perm-toolbar .filter-group button.on { background:var(--accent); color:#fff; }
  body[data-theme="dark"] .acct .av { background:linear-gradient(135deg,#8c6bff,#b8a3ff); }
  body[data-theme="dark"] .rail-foot .led { box-shadow:0 0 6px rgba(16,185,129,0.5); }
  body[data-theme="dark"] .tele-cell .led { box-shadow:0 0 5px rgba(16,185,129,0.45); }

  html, body { margin:0; height:100vh; overflow:hidden; }
  body {
    background:var(--bg); color:var(--ink);
    font-family:'Inter', system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size:14.5px; line-height:1.5;
    -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
    font-feature-settings:'cv11','ss01','ss03';
  }
  code, pre.snippet {
    font-family:'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric:tabular-nums;
  }
  .mono, .num { font-feature-settings:'cv11','ss01'; font-variant-numeric:tabular-nums; letter-spacing:-0.005em; }

  .app { display:grid; grid-template-columns:224px 1fr; height:100vh; }
  aside.rail {
    background:var(--rail); color:var(--rail-text);
    display:grid; grid-template-rows:auto 1fr auto;
    border-right:1px solid var(--rail-line); overflow:hidden;
  }
  .rail-head { padding:18px 20px 16px; border-bottom:1px solid var(--rail-line); }
  .rail-brand { display:flex; align-items:baseline; gap:0; font-weight:900; font-size:19px; letter-spacing:-0.01em; color:var(--rail-text-bright); line-height:1; }
  .rail-brand .three { color:var(--accent); }
  .rail-brand .sub { margin-left:8px; font-weight:700; font-size:14px; color:var(--rail-text-dim); }
  .rail-tag { margin-top:8px; font-variant-numeric:tabular-nums; font-size:10px; color:var(--rail-text-dim); letter-spacing:0.04em; }
  .rail-tag .live { display:inline-block; width:6px; height:6px; background:var(--good); border-radius:1px; margin-right:6px; box-shadow:0 0 8px rgba(15,139,90,0.7); }

  .rail-nav { padding:14px 10px; overflow-y:auto; }
  .rail-section-label { padding:14px 12px 6px; font-size:11px; font-weight:700; letter-spacing:0.14em; text-transform:uppercase; color:var(--rail-text-dim); }
  .rail-nav a { display:flex; align-items:center; gap:11px; padding:9px 12px; margin:1px 0; color:var(--rail-text); text-decoration:none; font-weight:500; font-size:14px; border-radius:5px; cursor:pointer; position:relative; }
  .rail-nav a:hover { background:var(--rail-2); color:var(--rail-text-bright); }
  .rail-nav a.active { background:var(--rail-2); color:var(--rail-text-bright); font-weight:700; }
  .rail-nav a.active::before { content:''; position:absolute; left:0; top:6px; bottom:6px; width:3px; background:var(--accent); border-radius:0 2px 2px 0; }
  .rail-nav a .ico { width:16px; height:16px; color:var(--rail-text-dim); flex-shrink:0; }
  .rail-nav a.active .ico { color:var(--accent); }
  .rail-nav a .count { margin-left:auto; font-variant-numeric:tabular-nums; font-size:10.5px; color:var(--rail-text-dim); background:rgba(255,255,255,0.06); padding:1px 6px; border-radius:3px; }
  .rail-nav a.danger { color:#e88a85; }
  .rail-nav a.danger .ico { color:#c66662; }

  .rail-foot { padding:12px 16px 14px; border-top:1px solid var(--rail-line); display:grid; gap:8px; }
  .rail-foot .row { display:flex; align-items:center; gap:8px; font-variant-numeric:tabular-nums; font-size:10.5px; color:var(--rail-text-dim); }
  .rail-foot .row .k { color:var(--rail-text); }
  .rail-foot .led { width:7px; height:7px; border-radius:1px; background:var(--good); box-shadow:0 0 6px rgba(15,139,90,0.6); }
  .rail-foot .led.warn { background:var(--warn); box-shadow:0 0 6px rgba(182,107,0,0.6); }

  main.console { display:grid; grid-template-rows:auto auto 1fr; overflow:hidden; background:var(--bg); }
  .topbar { display:flex; align-items:center; gap:14px; padding:12px 22px; background:var(--paper); border-bottom:1px solid var(--line); height:52px; }
  .crumbs { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--soft); }
  .crumbs .here { color:var(--ink); font-weight:700; }
  .crumbs .sep { color:var(--faint); }
  .topbar .spacer { flex:1; }
  .topbar .search { width:280px; position:relative; }
  .topbar .search input { width:100%; padding:7px 10px 7px 30px; border:1px solid var(--line); background:var(--surface); color:var(--ink); font:inherit; font-size:12.5px; border-radius:4px; }
  .topbar .search svg { position:absolute; left:9px; top:50%; transform:translateY(-50%); width:13px; height:13px; color:var(--soft); }
  .topbar kbd { position:absolute; right:8px; top:50%; transform:translateY(-50%); font-variant-numeric:tabular-nums; font-size:10px; color:var(--soft); border:1px solid var(--line); padding:1px 5px; border-radius:3px; background:var(--paper); }
  .theme-toggle { appearance:none; width:32px; height:32px; display:inline-flex; align-items:center; justify-content:center; border:1px solid var(--line); background:var(--surface); color:var(--muted); border-radius:5px; cursor:pointer; transition:color 100ms ease, border-color 100ms ease, background 100ms ease; }
  .theme-toggle:hover { color:var(--ink); border-color:var(--line-strong); }
  .theme-toggle svg { width:15px; height:15px; }
  body[data-theme="light"] .theme-toggle .moon { display:none; }
  body[data-theme="dark"]  .theme-toggle .sun  { display:none; }
  .signin { display:inline-flex; align-items:center; gap:9px; padding:8px 14px; border:1px solid var(--ink); background:var(--ink); color:var(--bg); font:inherit; font-weight:700; font-size:12.5px; cursor:pointer; border-radius:5px; transition:background 100ms ease; }
  .signin:hover { background:var(--ink-2); }
  .signin svg { width:12px; height:12px; }
  .signin .brand-inline { color:inherit; }
  .brand-inline { display:inline-flex; align-items:baseline; font-weight:700; color:inherit; }
  .brand-inline .three { color:var(--accent); }
  .signin .brand-inline .three { color:#b8a3ff; }
  .acct { display:inline-flex; align-items:center; gap:9px; padding:5px 10px 5px 6px; border:1px solid var(--line-strong); background:var(--surface); border-radius:5px; font:inherit; font-weight:600; font-size:12.5px; cursor:pointer; color:var(--ink); }
  .acct:hover { border-color:var(--accent); }
  .acct .av { width:22px; height:22px; background:linear-gradient(135deg, var(--accent), #8c6bff); color:#fff; font-weight:800; font-size:10.5px; display:inline-flex; align-items:center; justify-content:center; border-radius:4px; }
  .acct .em { color:var(--muted); font-size:12px; }
  .acct .car { color:var(--soft); font-size:9px; }

  .tele-strip { display:flex; gap:0; background:var(--surface); border-bottom:1px solid var(--line); padding:0; overflow-x:auto; }
  .tele-cell { flex:1; min-width:0; padding:12px 22px; border-right:1px solid var(--rule); display:grid; gap:3px; }
  .tele-cell:last-child { border-right:none; }
  .tele-cell .lbl { font-size:11px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color:var(--soft); display:flex; align-items:center; gap:7px; }
  .tele-cell .led { width:7px; height:7px; border-radius:1px; background:var(--good); box-shadow:0 0 5px rgba(15,139,90,0.5); }
  .tele-cell .led.warn { background:var(--warn); box-shadow:0 0 5px rgba(182,107,0,0.5); }
  .tele-cell .led.bad { background:var(--bad); box-shadow:0 0 5px rgba(178,36,31,0.5); }
  .tele-cell .led.idle { background:var(--soft); box-shadow:none; }
  .tele-cell .val { font-variant-numeric:tabular-nums; font-size:15px; font-weight:600; color:var(--ink); line-height:1.15; letter-spacing:-0.01em; }
  .tele-cell .sub { font-variant-numeric:tabular-nums; font-size:11.5px; color:var(--muted); line-height:1.4; }
  .safety-shortcuts { display:inline-flex; align-items:center; gap:4px; }
  .safety-shortcut { appearance:none; border:1px solid transparent; background:transparent; color:var(--muted); font:inherit; font-weight:800; line-height:1; padding:2px 3px; border-radius:3px; cursor:pointer; min-width:18px; }
  .safety-shortcut:hover { border-color:var(--accent); color:var(--ink); }
  .safety-shortcut.on { color:var(--good); }
  .safety-shortcut.off { color:var(--muted); opacity:0.55; }
  .safety-divider { color:var(--muted); font-weight:600; }

  .pane-scroll { overflow-y:auto; padding:24px 22px 36px; }
  .pane { max-width:1100px; }
  .pane[data-pane] { display:none; }
  .pane.active { display:block; }

  h1.pane-title { margin:0 0 4px; font-size:22px; font-weight:800; letter-spacing:-0.005em; }
  p.pane-lede { margin:0 0 22px; color:var(--muted); font-size:14.5px; line-height:1.6; max-width:68ch; }

  .block { background:var(--paper); border:1px solid var(--line); border-radius:6px; margin-bottom:18px; }
  .block-head { padding:12px 16px; border-bottom:1px solid var(--rule); display:flex; align-items:center; gap:12px; background:var(--surface); border-radius:6px 6px 0 0; }
  .block-head .ix { font-variant-numeric:tabular-nums; font-size:11.5px; font-weight:600; color:var(--soft); letter-spacing:0; }
  .block-head .title { font-size:13.5px; font-weight:700; letter-spacing:0.04em; color:var(--ink); }
  .block-head .spacer { flex:1; }
  .block-head .sub { font-size:12.5px; color:var(--muted); }
  .block-body { padding:14px 16px; }

  .tag { display:inline-flex; align-items:center; gap:5px; padding:3px 7px; border-radius:3px; font-variant-numeric:tabular-nums; font-size:11px; font-weight:600; letter-spacing:0; background:var(--surface-2); color:var(--muted); border:1px solid var(--line); white-space:nowrap; }
  .tag.good { background:var(--good-soft); color:var(--good); border-color:rgba(15,139,90,0.22); }
  .tag.warn { background:var(--warn-soft); color:var(--warn); border-color:rgba(182,107,0,0.22); }
  .tag.bad  { background:var(--bad-soft);  color:var(--bad);  border-color:rgba(178,36,31,0.22); }
  .tag.accent { background:var(--accent-soft); color:var(--accent); border-color:rgba(107,78,240,0.22); }
  .tag.solid-ink { background:var(--ink); color:var(--bg); border-color:var(--ink); }

  .btn { appearance:none; display:inline-flex; align-items:center; justify-content:center; gap:7px; padding:7px 12px; border:1px solid var(--line-strong); background:var(--paper); color:var(--ink); font:inherit; font-weight:600; font-size:12.5px; cursor:pointer; border-radius:4px; min-height:32px; transition:border-color 100ms ease, background 100ms ease; }
  .btn:hover { border-color:var(--accent); }
  .btn.primary { background:var(--ink); color:var(--bg); border-color:var(--ink); }
  .btn.primary:hover { background:var(--ink-2); border-color:var(--ink-2); }
  .btn.danger { color:var(--bad); border-color:rgba(178,36,31,0.35); }
  .btn.danger:hover { background:var(--bad-soft); border-color:var(--bad); }
  .btn.small { padding:4px 8px; min-height:26px; font-size:11.5px; }
  .btn.ghost { background:transparent; }
  .btn:disabled { opacity:0.4; cursor:not-allowed; }
  .btn svg { width:12px; height:12px; }

  .sw { position:relative; display:inline-block; width:32px; height:18px; flex-shrink:0; }
  .sw input { opacity:0; width:0; height:0; }
  .sw .s { position:absolute; inset:0; background:rgba(0,0,0,0.22); border-radius:3px; transition:background 140ms ease; cursor:pointer; }
  .sw .s::before { content:''; position:absolute; width:14px; height:14px; left:2px; top:2px; background:#fff; border-radius:2px; box-shadow:0 1px 3px rgba(0,0,0,0.3); transition:transform 140ms cubic-bezier(.4,1.4,.6,1); }
  .sw input:checked + .s { background:var(--good); }
  .sw input:checked + .s::before { transform:translateX(14px); }

  .safety-bar { display:grid; grid-template-columns:repeat(3, 1fr); gap:1px; background:var(--line); margin:0; }
  .safety-cell { background:var(--paper); padding:14px 16px; display:grid; grid-template-columns:auto 1fr auto; gap:12px; align-items:center; }
  .safety-cell .ico { width:28px; height:28px; border-radius:4px; background:var(--bad-soft); color:var(--bad); display:inline-flex; align-items:center; justify-content:center; }
  .safety-cell.on .ico { background:var(--good-soft); color:var(--good); }
  .safety-cell .ico svg { width:14px; height:14px; }
  .safety-cell .meta .name { font-weight:700; font-size:13px; }
  .safety-cell .meta .sub { font-size:11px; color:var(--muted); margin-top:1px; }

  .perm-toolbar { display:flex; align-items:center; gap:10px; padding:10px 16px; border-bottom:1px solid var(--rule); background:var(--surface); flex-wrap:wrap; }
  .perm-toolbar .filter-group { display:inline-flex; background:var(--paper); border:1px solid var(--line); border-radius:4px; overflow:hidden; }
  .perm-toolbar .filter-group button { appearance:none; background:transparent; border:none; border-right:1px solid var(--line); padding:6px 11px; font:inherit; font-size:12.5px; font-weight:600; letter-spacing:0; color:var(--muted); cursor:pointer; }
  .perm-toolbar .filter-group button:last-child { border-right:none; }
  .perm-toolbar .filter-group button.on { background:var(--ink); color:var(--bg); }
  .perm-toolbar .filter-group button:hover:not(.on) { background:var(--surface-2); color:var(--ink); }
  .perm-toolbar .count-readout { margin-left:auto; font-variant-numeric:tabular-nums; font-size:12.5px; color:var(--soft); }
  .perm-toolbar .count-readout .num { color:var(--ink); font-weight:700; }
  .perm-toolbar .scope-note, .perm-bulkbar .scope-note { display:inline-flex; align-items:center; gap:8px; padding:6px 11px; border:1px solid var(--line); background:var(--accent-soft); color:var(--ink); border-radius:4px; font-size:12.5px; line-height:1.4; }
  .perm-toolbar .scope-note svg, .perm-bulkbar .scope-note svg { color:var(--accent); }

  .perm-bulkbar { display:flex; align-items:center; gap:12px; padding:10px 16px; border-bottom:1px solid var(--rule); background:var(--paper); flex-wrap:wrap; }
  .perm-bulkbar .bulk-actions { display:inline-flex; gap:6px; }

  .perm-table .dep-warn { display:inline-flex; align-items:center; gap:5px; padding:2px 7px; border-radius:3px; font-size:11px; font-weight:600; background:var(--warn-soft); color:var(--warn); border:1px solid color-mix(in srgb, var(--warn) 28%, var(--line)); margin-left:8px; cursor:help; }
  .perm-table .dep-warn svg { width:11px; height:11px; }

  .perm-table { width:100%; border-collapse:collapse; font-size:13px; }
  .perm-table thead th { text-align:left; padding:10px 16px; font-size:11px; font-weight:700; letter-spacing:0.10em; text-transform:uppercase; color:var(--soft); background:var(--surface); border-bottom:1px solid var(--line); position:sticky; top:0; }
  .perm-table tbody tr { border-bottom:1px solid var(--rule); transition:background 80ms ease; }
  .perm-table tbody tr:hover { background:var(--surface); }
  .perm-table tbody tr.group-header { background:var(--surface-2); cursor:pointer; }
  .perm-table tbody tr.group-header:hover { background:var(--surface-2); }
  .perm-table tbody tr.group-header td { padding:9px 16px; font-size:11.5px; font-weight:700; letter-spacing:0.10em; text-transform:uppercase; color:var(--ink-3); border-bottom:1px solid var(--line); }
  .perm-table tbody tr.group-header td .count { font-variant-numeric:tabular-nums; font-size:11.5px; font-weight:500; letter-spacing:0; text-transform:none; color:var(--soft); margin-left:10px; }
  .perm-table tbody tr.group-header .bulk { float:right; display:inline-flex; gap:4px; text-transform:none; letter-spacing:0; }
  .perm-table tbody tr.group-header .bulk button { appearance:none; border:1px solid var(--line-strong); background:var(--paper); color:var(--muted); font:inherit; font-variant-numeric:tabular-nums; font-size:11.5px; font-weight:500; padding:3px 9px; border-radius:3px; cursor:pointer; }
  .perm-table tbody tr.group-header .bulk button:hover { color:var(--ink); border-color:var(--accent); }
  .perm-table td { padding:9px 16px; vertical-align:top; }
  .perm-table td.col-tg { width:44px; padding-top:11px; }
  .perm-table td.col-nm { font-variant-numeric:tabular-nums; font-size:13px; font-weight:500; color:var(--ink); white-space:nowrap; width:230px; }
  .perm-table td.col-tag { width:110px; padding-top:11px; }
  .perm-table td.col-blurb { color:var(--muted); font-size:13.5px; line-height:1.5; }
  .perm-table tr.disabled td.col-nm { color:var(--faint); }
  .perm-table tr.eval td.col-nm { color:var(--bad); }

  .kv { display:grid; grid-template-columns:130px 1fr; gap:4px 16px; font-size:13px; }
  .kv .k { color:var(--soft); font-weight:600; font-size:12px; letter-spacing:0.04em; text-transform:uppercase; align-self:center; }
  .kv .v { color:var(--ink); font-weight:500; }
  .kv .v.mono { font-variant-numeric:tabular-nums; letter-spacing:-0.005em; font-weight:500; font-size:13.5px; word-break:break-all; }
  .kv .v + .k { margin-top:8px; }
  .kv .k + .v { padding:4px 0; }

  .log-table { width:100%; border-collapse:collapse; margin-top:10px; font-size:12.5px; }
  .log-table td { padding:5px 10px; border-bottom:1px solid var(--rule); vertical-align:middle; white-space:nowrap; }
  .log-table tr:last-child td { border-bottom:none; }
  .log-table td.ts { color:var(--soft); font-size:12px; width:70px; }
  .log-table td.nm { color:var(--ink); font-weight:500; }
  .log-table td.st { color:var(--good); font-weight:600; width:40px; }
  .log-table td.st.err { color:var(--bad); }
  .log-table td.ms { color:var(--muted); text-align:right; width:64px; }
  .log-table td.dt { color:var(--soft); font-size:12px; overflow:hidden; text-overflow:ellipsis; max-width:280px; }

  pre.snippet { margin:0; padding:12px 14px; background:var(--ink); color:var(--bg); border-radius:5px; font-size:12px; line-height:1.55; overflow:auto; white-space:pre; max-height:240px; }

  .backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.30); z-index:50; display:none; }
  .backdrop.open { display:block; }
  .drawer { position:fixed; top:0; right:0; bottom:0; width:400px; max-width:92vw; background:var(--paper); border-left:1px solid var(--line-strong); z-index:60; display:none; grid-template-rows:auto auto 1fr; box-shadow:-16px 0 40px rgba(0,0,0,0.18); }
  .drawer.open { display:grid; }
  .drawer-head { display:flex; align-items:center; gap:10px; padding:14px 18px; border-bottom:1px solid var(--line); background:var(--surface); }
  .drawer-head .title { font-size:15px; font-weight:700; letter-spacing:-0.005em; color:var(--ink); }
  .drawer > .sub { margin:0; padding:12px 18px 14px; background:var(--surface); border-bottom:1px solid var(--line); color:var(--muted); font-size:13px; line-height:1.5; }
  .drawer-head .spacer { flex:1; }
  .drawer-head .x { appearance:none; border:none; background:none; width:28px; height:28px; color:var(--soft); cursor:pointer; border-radius:4px; }
  .drawer-head .x:hover { background:var(--surface-2); color:var(--ink); }
  .drawer-body { padding:18px; display:grid; gap:14px; overflow-y:auto; align-content:start; }
  .drawer-body label { display:grid; gap:6px; font-size:12.5px; color:var(--ink); font-weight:600; }
  .drawer-body input, .drawer-body select { width:100%; padding:9px 11px; border:1px solid var(--line-strong); background:var(--paper); color:var(--ink); font:inherit; font-size:13.5px; font-weight:400; border-radius:4px; height:36px; line-height:1.2; }
  .drawer-body input::placeholder { color:var(--faint); }
  .drawer-body input:focus, .drawer-body select:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
  .drawer-body .btn.primary, .drawer-body .btn { min-height:36px; padding:8px 14px; }
  .drawer-body .divider { display:flex; align-items:center; gap:10px; color:var(--soft); font-size:11.5px; font-weight:500; margin:2px 0; }
  .drawer-body .divider::before, .drawer-body .divider::after { content:''; flex:1; height:1px; background:var(--rule); }
  .drawer-body .fields { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .drawer-body .hint { margin:-4px 0 0; font-size:11.5px; color:var(--soft); line-height:1.4; }
  .drawer-body .status { margin:0; font-size:12px; color:var(--muted); min-height:14px; }
  .drawer-body .status.ok { color:var(--good); }
  .drawer-body .status.err { color:var(--bad); }

  body[data-view="signedout"] .when-signedin { display:none !important; }
  body[data-view="signedin"]  .when-signedout { display:none !important; }

  .ov-grid { display:grid; grid-template-columns:repeat(12, 1fr); gap:14px; }
  .ov-tile { grid-column:span 6; background:var(--paper); border:1px solid var(--line); border-radius:6px; padding:16px; }
  .ov-tile.s4 { grid-column:span 4; }
  .ov-tile.s8 { grid-column:span 8; }
  .ov-tile.s12 { grid-column:span 12; }
  .ov-tile h3 { margin:0 0 4px; font-size:12px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:var(--soft); }
  .ov-tile .big { font-variant-numeric:tabular-nums; font-size:24px; font-weight:500; color:var(--ink); line-height:1.1; margin:6px 0 4px; letter-spacing:-0.01em; }
  .ov-tile .big.good { color:var(--good); }
  .ov-tile .big.warn { color:var(--warn); }
  .ov-tile .big.bad { color:var(--bad); }
  .ov-tile p { margin:6px 0 0; color:var(--muted); font-size:13.5px; line-height:1.55; }
  .ov-tile .actions { margin-top:12px; display:flex; gap:6px; flex-wrap:wrap; }

  .stub { border:1px dashed var(--line-strong); background:var(--surface); border-radius:6px; padding:32px 24px; color:var(--muted); font-size:13px; text-align:center; }

  /* Generic status text under blocks/buttons */
  .status { min-height:16px; font-size:12.5px; color:var(--muted); margin:0; }
  .status.ok { color:var(--good); }
  .status.err { color:var(--bad); }
  .status.info { color:var(--accent); }
  .desktop-metrics { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:1px; background:var(--line); border:1px solid var(--line); border-radius:4px; overflow:hidden; margin-bottom:14px; }
  .desktop-metric { background:var(--paper); padding:12px; min-width:0; }
  .desktop-metric.wide { grid-column:span 2; }
  .desktop-metric .label { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--soft); margin-bottom:6px; }
  .desktop-metric .value { font-size:20px; line-height:1.1; font-weight:800; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .desktop-metric .value.small { font-size:13px; line-height:1.35; font-weight:600; white-space:normal; word-break:break-all; }
  .desktop-metric .value.good { color:var(--good); }
  .desktop-metric .value.warn { color:var(--warn); }
  .desktop-metric .value.bad { color:var(--bad); }
  .desktop-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .desktop-actions input, .desktop-actions select { min-height:32px; padding:6px 9px; border:1px solid var(--line-strong); border-radius:4px; background:var(--paper); color:var(--ink); font:inherit; font-size:12.5px; }
  .desktop-actions input { min-width:190px; }
  .desktop-actions select { min-width:210px; max-width:100%; }
  .desktop-output { display:none; margin:12px 0 0; padding:10px; min-height:64px; max-height:220px; overflow:auto; border:1px solid var(--line); border-radius:4px; background:var(--surface); color:var(--ink); font:12px/1.45 var(--mono); white-space:pre-wrap; }
  .setup-checklist { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:8px; margin-bottom:14px; }
  .setup-item { display:grid; grid-template-columns:16px 1fr; gap:9px; padding:10px; border:1px solid var(--line); border-radius:4px; background:var(--surface); min-width:0; }
  .setup-dot { width:10px; height:10px; border-radius:50%; margin-top:3px; background:var(--faint); box-shadow:0 0 0 3px rgba(0,0,0,0.04); }
  .setup-item.done .setup-dot { background:var(--good); }
  .setup-item.warn .setup-dot { background:var(--warn); }
  .setup-item strong { display:block; font-size:12.5px; color:var(--ink); }
  .setup-item small { display:block; margin-top:2px; color:var(--muted); line-height:1.35; overflow-wrap:anywhere; }

  /* Sidebar overlay toggle — shown only below the breakpoint. Clicking
     pops the rail back in as a floating overlay so the user can pick a
     section, then it auto-dismisses. Click outside also closes. */
  .rail-toggle { display:none; align-items:center; justify-content:center; width:34px; height:34px; padding:0; border:1px solid var(--surface-2); background:var(--surface); color:var(--ink); border-radius:6px; cursor:pointer; flex-shrink:0; margin-right:10px; }
  .rail-toggle:hover { background:var(--surface-2); }
  .rail-toggle svg { width:16px; height:16px; }
  .rail-scrim { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:80; }

  @media (max-width: 880px) {
    .app { grid-template-columns:1fr; }
    aside.rail { display:none; }
    .rail-toggle { display:inline-flex; }
    body.rail-open aside.rail { display:grid; position:fixed; left:0; top:0; bottom:0; width:240px; z-index:90; box-shadow:0 0 24px rgba(0,0,0,0.45); }
    body.rail-open .rail-scrim { display:block; }
  }
  @media (max-width: 720px) {
    .topbar { height:auto; min-height:52px; padding:8px 10px; gap:8px; flex-wrap:wrap; }
    .topbar .spacer { display:none; }
    .crumbs { flex:1 1 auto; min-width:0; gap:6px; }
    .crumbs > span:first-child { max-width:86px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .crumbs .here { max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .topbar .search { order:2; width:100%; flex:1 0 100%; }
    .topbar kbd { display:none; }
    .signin { padding:7px 10px; font-size:12px; white-space:nowrap; }
    .theme-toggle { width:34px; height:34px; flex-shrink:0; }
    .tele-strip { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); overflow-x:visible; }
    .tele-cell { min-width:0; padding:10px 12px; border-right:1px solid var(--rule); border-bottom:1px solid var(--rule); }
    .tele-cell:nth-child(2n) { border-right:none; }
    .tele-cell:last-child { grid-column:1 / -1; border-right:none; }
    .tele-cell .sub { overflow-wrap:anywhere; }
    .pane-scroll { padding:20px 14px 30px; overflow-x:hidden; }
    .pane { max-width:100%; min-width:0; }
    h1.pane-title { font-size:21px; }
    p.pane-lede { font-size:14px; max-width:100%; }
    .ov-grid { grid-template-columns:1fr; gap:12px; }
    .ov-tile, .ov-tile.s4, .ov-tile.s8, .ov-tile.s12 { grid-column:1; min-width:0; }
    .ov-tile { padding:14px; overflow:hidden; }
    .log-table { width:100%; table-layout:fixed; }
    .log-table td { padding:5px 6px; white-space:normal; overflow:hidden; text-overflow:ellipsis; }
    .log-table td.ts { width:62px; }
    .log-table td.st { width:38px; }
    .log-table td.ms, .log-table td.dt { display:none; }
    .block { overflow-x:auto; }
    .block-head { align-items:flex-start; flex-wrap:wrap; }
    .block-head .sub { flex-basis:100%; }
    .safety-bar { grid-template-columns:1fr; }
    .safety-cell { grid-template-columns:auto 1fr auto; padding:12px 14px; }
    .perm-toolbar, .perm-bulkbar { padding:10px 12px; align-items:flex-start; }
    .perm-toolbar .filter-group { max-width:100%; overflow-x:auto; }
    .perm-toolbar .filter-group button { white-space:nowrap; }
    .perm-toolbar .count-readout { width:100%; margin-left:0; }
    .perm-table { min-width:680px; }
    .perm-table td.col-nm { white-space:normal; overflow-wrap:anywhere; }
    .kv { grid-template-columns:1fr; gap:2px; }
    .desktop-metrics { grid-template-columns:repeat(2, minmax(0, 1fr)); }
    .desktop-metric.wide { grid-column:1 / -1; }
    .setup-checklist { grid-template-columns:1fr; }
    .drawer { width:100vw; max-width:100vw; }
    .drawer-body { padding:16px; }
    .drawer-body .fields { grid-template-columns:1fr; }
  }
</style>
</head>
<body data-view="${signedIn ? 'signedin' : 'signedout'}" data-theme="light">

<div class="app">

  <aside class="rail">
    <div class="rail-head">
      <div class="rail-brand"><span>empir<span class="three">3</span></span><span class="sub">Bridge</span></div>
      <div class="rail-tag"><span class="live"></span>BRIDGE ${BRIDGE_VERSION} · LIVE</div>
    </div>

    <nav class="rail-nav">
      <div class="rail-section-label">Console</div>
      <a data-nav="overview" class="active">
        <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="5" height="6" rx="0.6"/><rect x="9" y="2" width="5" height="4" rx="0.6"/><rect x="2" y="10" width="5" height="4" rx="0.6"/><rect x="9" y="8" width="5" height="6" rx="0.6"/></svg>
        Overview
      </a>
      <a data-nav="permissions">
        <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1L2 4v4c0 3.5 2.5 6.5 6 7 3.5-.5 6-3.5 6-7V4L8 1z"/><path d="M5.5 8l2 2 3-3.5"/></svg>
        Permissions
        <span class="count" id="sidebarPermCount">${toolCount}</span>
      </a>
      <a data-nav="mcp">
        <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l-3 4 3 4M12 4l3 4-3 4M10 2L6 14"/></svg>
        MCP Connection
      </a>
      <a data-nav="clis">
        <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v10H2z"/><path d="M4 6l2 2-2 2M8 10h4"/></svg>
        API &amp; CLIs
      </a>
      <a data-nav="agent">
        <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="1"/><path d="M6 6h4v4H6z"/></svg>
        Desktop Tools
      </a>
      <a data-nav="account">
        <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="6" r="3"/><path d="M2 14c0-3 2.5-5 6-5s6 2 6 5"/></svg>
        empir3 Account
      </a>

      <div class="rail-section-label">System</div>
      <a data-nav="daemon">
        <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.4"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4"/></svg>
        Daemon
      </a>
      <a data-nav="updates">
        <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8a6 6 0 0 1 10-4.5L14 5M14 8a6 6 0 0 1-10 4.5L2 11M11 5h3V2M5 11H2v3"/></svg>
        Updates
      </a>
      <a data-nav="logs">
        <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2h7l3 3v9H3V2zM10 2v3h3M5 8h6M5 11h6"/></svg>
        Activity Log
      </a>
      <a data-nav="lifecycle" class="danger">
        <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1L1 14h14L8 1zM8 6v4M8 12v.5"/></svg>
        Tray Lifecycle
      </a>
    </nav>

    <div class="rail-foot">
      <div class="row"><span class="led" id="footDaemonLed"></span><span class="k">daemon</span><span style="margin-left:auto" id="footDaemonUptime">—</span></div>
      <div class="row"><span class="led" id="footMcpLed"></span><span class="k">mcp</span><span style="margin-left:auto" id="footMcpCount">—</span></div>
      <div class="row"><span class="led${signedIn ? '' : ' warn'}" id="footRelayLed"></span><span class="k">relay</span><span style="margin-left:auto" id="footRelayState">${signedIn ? 'connected' : 'unpaired'}</span></div>
    </div>
  </aside>

  <div class="rail-scrim" id="railScrim"></div>

  <main class="console">

    <div class="topbar">
      <button class="rail-toggle" type="button" id="railToggle" title="Show navigation" aria-label="Show navigation">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M2 8h12M2 12h12"/></svg>
      </button>
      <div class="crumbs">
        <span>empir<span style="color:var(--accent); font-weight:700;">3</span> Bridge</span>
        <span class="sep">/</span>
        <span class="here" id="crumbHere">Overview</span>
      </div>
      <div class="spacer"></div>
      <div class="search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5"/><path d="M14 14l-3-3"/></svg>
        <input placeholder="Search tools, settings…" id="globalSearch" />
        <kbd>⌘K</kbd>
      </div>
      <button class="theme-toggle" type="button" id="themeToggle" title="Toggle theme" aria-label="Toggle theme">
        <svg class="sun" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4"/></svg>
        <svg class="moon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a6 6 0 1 0 7 7z"/></svg>
      </button>
      <button class="signin when-signedout" type="button" id="openSignIn">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11l3-3-3-3M13 8H6M9 14H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h5"/></svg>
        Sign in with <span class="brand-inline">empir<span class="three">3</span></span>
      </button>
      <button class="acct when-signedin" type="button" id="openAccount">
        <span class="av" id="acctAvatar">··</span><span class="em" id="acctEmail">loading…</span><span class="car">▾</span>
      </button>
    </div>

    <div class="tele-strip">
      <div class="tele-cell">
        <div class="lbl"><span class="led" id="teleDaemonLed"></span>Daemon</div>
        <div class="val" id="teleDaemonVal">RUNNING</div>
        <div class="sub" id="teleDaemonSub">PID ${process.pid} · uptime —</div>
      </div>
      <div class="tele-cell">
        <div class="lbl"><span class="led" id="teleMcpLed"></span>MCP</div>
        <div class="val" id="teleMcpVal">READY</div>
        <div class="sub" id="teleMcpSub">stdio · — calls / — errors</div>
      </div>
      <div class="tele-cell">
        <div class="lbl"><span class="led idle" id="teleAgentLed"></span>Agent</div>
        <div class="val" id="teleAgentVal">IDLE</div>
        <div class="sub" id="teleAgentSub">no focus region</div>
      </div>
      <div class="tele-cell">
        <div class="lbl"><span class="led${signedIn ? '' : ' warn'}" id="teleRelayLed"></span>Relay</div>
        <div class="val" id="teleRelayVal">—</div>
        <div class="sub" id="teleRelaySub">—</div>
      </div>
      <div class="tele-cell">
        <div class="lbl"><span class="led" id="teleSafetyLed"></span>Safety</div>
        <div class="val" id="teleSafetyVal">— / — / —</div>
        <div class="sub" id="teleSafetySub">—</div>
      </div>
    </div>

    <div class="pane-scroll">

      <section class="pane active" data-pane="overview">
        <h1 class="pane-title">Overview</h1>
        <p class="pane-lede">The <span class="brand-inline">empir<span class="three">3</span></span> Bridge is the local Chrome bridge for Claude Code, Claude Desktop, OpenAI, and any other MCP client. Everything runs on this PC.</p>

        <div class="ov-grid">

          <div class="ov-tile s4">
            <h3>Daemon</h3>
            <div class="big" id="ovDaemonUptime">—</div>
            <p>Process <span class="mono">empir3-bridge</span> · wrapper <span class="mono">:${PORT}</span> · <span id="ovDaemonPid">PID ${process.pid}</span></p>
            <div class="actions">
              <button class="btn small" id="ovOpenBridge" type="button">Open bridge window</button>
              <button class="btn small ghost" id="ovReconnect" type="button">Reconnect</button>
            </div>
            <p class="status" id="ovDaemonStatus"></p>
          </div>

          <div class="ov-tile s4">
            <h3>MCP Calls (last 80)</h3>
            <div class="big" id="ovMcpCalls">— <span style="color:var(--soft); font-size:14px;">/ — err</span></div>
            <p id="ovMcpLast">Loading recent activity…</p>
            <div class="actions">
              <button class="btn small" data-goto="logs" type="button">View call log</button>
              <button class="btn small ghost" data-goto="mcp" type="button">Show config</button>
            </div>
          </div>

          <div class="ov-tile s4">
            <h3>Permissions</h3>
            <div class="big" id="ovPermSummary">— / ${toolCount}</div>
            <p id="ovPermTags"><span class="tag good">—</span></p>
            <div class="actions">
              <button class="btn small" data-goto="permissions" type="button">Manage permissions →</button>
            </div>
          </div>

          <div class="ov-tile s8">
            <h3>Recent activity</h3>
            <table class="log-table" id="ovLogTable">
              <tbody id="ovLogRows"><tr><td class="dt" style="text-align:center;">No activity yet.</td></tr></tbody>
            </table>
          </div>

          <div class="ov-tile s4">
            <h3>Relay</h3>
            <div class="big when-signedout" style="color: var(--warn)">UNPAIRED</div>
            <div class="big good when-signedin" id="ovRelayStatus">CONNECTED</div>
            <p class="when-signedout">Sign in with <span class="brand-inline">empir<span class="three">3</span></span> to relay browser tools to your agents.</p>
            <p class="when-signedin"><span class="mono" id="ovRelayUser">—</span> · <span class="mono" id="ovRelayServer">—</span></p>
            <div class="actions">
              <button class="btn small primary when-signedout" type="button" onclick="openDrawer()">Sign in</button>
              <button class="btn small when-signedin" data-goto="account" type="button">Manage account</button>
            </div>
          </div>

        </div>
      </section>

      <section class="pane" data-pane="permissions">
        <h1 class="pane-title">Permissions</h1>
        <p class="pane-lede">Every bridge tool can be allowed or blocked at the PC level. Disabled tools never appear in the MCP client's inventory — same model as Anthropic computer-use, macOS Accessibility, or Chrome extension permissions: explicit consent, no AI judgment.</p>

        <div class="block">
          <div class="block-head">
            <span class="ix">00</span>
            <span class="title">Global Safety Override</span>
            <span class="spacer"></span>
            <span class="sub">The final PC-level switch. Disabling a category blocks every tool in it regardless of fine-tune.</span>
          </div>
          <div class="safety-bar">
            <label class="safety-cell">
              <span class="ico"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg></span>
              <div class="meta"><div class="name">Read</div><div class="sub">Screenshots, page text, snapshots, status</div></div>
              <span class="sw"><input type="checkbox" data-safety="read"><span class="s"></span></span>
            </label>
            <label class="safety-cell">
              <span class="ico"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z"/></svg></span>
              <div class="meta"><div class="name">Write</div><div class="sub">Overlay chat, recordings, safety lockdown</div></div>
              <span class="sw"><input type="checkbox" data-safety="write"><span class="s"></span></span>
            </label>
            <label class="safety-cell">
              <span class="ico"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2l9 6-9 6V2z"/></svg></span>
              <div class="meta"><div class="name">Execute</div><div class="sub">Click, type, navigate, drag, run JS</div></div>
              <span class="sw"><input type="checkbox" data-safety="execute"><span class="s"></span></span>
            </label>
          </div>
          <p class="status" id="safetyStatus" style="padding:8px 16px 12px;"></p>
        </div>

        <div class="block">
          <div class="block-head">
            <span class="ix">01</span>
            <span class="title">Tool-by-tool Permissions</span>
            <span class="spacer"></span>
            <span class="sub">${toolCount} tools across 7 groups</span>
          </div>
          <div class="perm-bulkbar">
            <div class="bulk-actions">
              <button class="btn small" type="button" data-bulk="enable-all">Enable all</button>
              <button class="btn small" type="button" data-bulk="default">Restore defaults</button>
              <button class="btn small" type="button" data-bulk="disable-all">Disable all</button>
            </div>
            <div class="scope-note">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5v4M8 11v.5"/></svg>
              <span>Disabling a tool blocks it everywhere — MCP, local chat, and <span class="brand-inline">empir<span class="three">3</span></span> relay.</span>
            </div>
          </div>
          <div class="perm-toolbar">
            <div class="filter-group" role="tablist">
              <button class="on" data-filter="all">All</button>
              <button data-filter="advisor">Advisor</button>
              <button data-filter="read">Read</button>
              <button data-filter="navigate">Navigate</button>
              <button data-filter="interact">Interact</button>
              <button data-filter="desktop">Desktop</button>
              <button data-filter="eval">Eval</button>
              <button data-filter="recordings">Recordings</button>
              <button data-filter="higgsfield">Higgsfield</button>
            </div>
            <div class="count-readout"><span class="num" id="enabledCount">—</span> / <span class="num" id="visibleToolCount">${toolCount}</span> enabled</div>
          </div>
          <div style="overflow-x:auto;">
            <table class="perm-table">
              <thead>
                <tr><th>On</th><th>Tool</th><th>Group</th><th>What it does</th></tr>
              </thead>
              <tbody id="permRows"></tbody>
            </table>
          </div>
          <p class="status" id="permStatus" style="padding:8px 16px 12px;"></p>
        </div>
      </section>

      <section class="pane" data-pane="mcp">
        <h1 class="pane-title">MCP Connection</h1>
        <p class="pane-lede">Add the <span class="brand-inline">empir<span class="three">3</span></span> Bridge as a stdio MCP server in Claude Code, Claude Desktop, OpenAI, or any other client.</p>

        <div class="block">
          <div class="block-head">
            <span class="ix">01</span>
            <span class="title">stdio Config</span>
            <span class="spacer"></span>
            <span class="tag good">READY</span>
          </div>
          <div class="block-body">
            <div style="display:flex; gap:8px; margin-bottom:12px;">
              <button class="btn primary" id="mcpShowConfig" type="button">Show config</button>
              <button class="btn" id="mcpCopyConfig" type="button">Copy snippet</button>
            </div>
            <pre class="snippet" id="mcpSnippet">Click "Show config" to generate the snippet for this install.</pre>
            <ol id="mcpSteps" style="margin:14px 0 0; padding-left:20px; color:var(--muted); line-height:1.7; font-size:13px;">
              <li>Save the config as <code style="background:var(--surface-2); padding:1px 6px; border-radius:3px;">.mcp.json</code> in your project root.</li>
              <li>Restart your MCP client from that folder.</li>
              <li>Ask the client to use the <span class="brand-inline">empir<span class="three">3</span></span> Bridge browser or desktop tools.</li>
            </ol>
            <p class="status" id="mcpStatus" style="margin-top:10px;"></p>
          </div>
        </div>
      </section>

      <section class="pane" data-pane="clis">
        <h1 class="pane-title">API &amp; CLIs</h1>
        <p class="pane-lede">Local CLIs the bridge knows about, the API keys it can hold, and which inference CLIs you've opted-in to lend to <span class="brand-inline">empir<span class="three">3</span></span> team agents.</p>

        <div class="block">
          <div class="block-head">
            <span class="ix">01</span>
            <span class="title">Installed CLIs</span>
            <span class="spacer"></span>
            <span class="tag" id="cliInstalledTag">— / —</span>
          </div>
          <div class="block-body">
            <div style="overflow-x:auto;">
              <table class="perm-table" style="font-size:13px;">
                <thead>
                  <tr>
                    <th style="width:24%;">CLI</th>
                    <th style="width:20%;">Install</th>
                    <th style="width:18%;">Auth</th>
                    <th style="width:20%;" title="For inference CLIs: lend to empir3 team agents. For handler CLIs: gate whether the bridge advertises the tools at all.">Lend / Tools</th>
                    <th style="width:18%;">Action</th>
                  </tr>
                </thead>
                <tbody id="cliRows">
                  <tr><td colspan="5" class="dt" style="text-align:center; color:var(--soft);">Loading…</td></tr>
                </tbody>
              </table>
            </div>
            <div style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
              <button class="btn" type="button" id="rescanClisBtn">↻ Re-scan</button>
              <button class="btn" type="button" id="addCustomProviderBtn">+ Add custom provider</button>
              <span style="font-size:11.5px; color:var(--soft); align-self:center;">Re-scan after installing a CLI · custom = OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter, vLLM, etc)</span>
            </div>
            <p class="status" id="cliStatus" style="margin-top:10px;"></p>
          </div>
        </div>

        <!-- Add Custom Provider modal -->
        <div id="providerModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:100; align-items:center; justify-content:center;">
          <div style="background:var(--paper); color:var(--ink); border:1px solid var(--surface-2); border-radius:8px; max-width:640px; width:92%; max-height:90vh; overflow:auto; padding:24px;">
            <div style="display:flex; align-items:center; margin-bottom:14px;">
              <h2 style="margin:0; font-size:18px; font-weight:700;">Add custom provider</h2>
              <button class="btn small ghost" type="button" id="providerModalClose" style="margin-left:auto;">✕</button>
            </div>
            <p style="margin:0 0 14px; color:var(--muted); font-size:13px;">Paste a JSON definition for an OpenAI-compatible provider. Must include <code>slug</code>, <code>name</code>, <code>apiBaseUrl</code>. <code>models</code> auto-populates from <code>/v1/models</code> if omitted; <code>apiKey</code> is optional (Ollama doesn't need one, OpenRouter does).</p>
            <textarea id="providerModalJson" spellcheck="false" style="width:100%; min-height:240px; padding:12px; font-family:var(--mono); font-size:13px; background:var(--surface); border:1px solid var(--surface-2); border-radius:4px; color:var(--ink); resize:vertical;" placeholder='{
  "slug": "ollama-local",
  "name": "Ollama (local)",
  "apiBaseUrl": "http://localhost:11434/v1"
}'></textarea>
            <div style="display:flex; gap:8px; margin-top:12px;">
              <button class="btn primary" type="button" id="providerModalSave">Add provider</button>
              <button class="btn ghost" type="button" id="providerModalCancel">Cancel</button>
              <button class="btn small ghost" type="button" id="providerModalExample" style="margin-left:auto;">Insert example</button>
            </div>
            <p class="status" id="providerModalStatus" style="margin-top:10px;"></p>
          </div>
        </div>

        <div class="block">
          <div class="block-head">
            <span class="ix">02</span>
            <span class="title">API Keys</span>
            <span class="spacer"></span>
            <span class="tag" id="apiKeysTag">— set</span>
          </div>
          <div class="block-body">
            <p style="margin:0 0 14px; color:var(--muted); font-size:13px;">Keys stay on this PC in <code style="background:var(--surface-2); padding:1px 6px; border-radius:3px;">~/.empir3-bridge/config.json</code> (chmod&nbsp;600). Used when an MCP client or empir3 agent picks the direct-API route instead of a local CLI. Leave blank to keep the existing value — submitting an empty field never clobbers a saved key.</p>
            <div class="kv" style="grid-template-columns: 140px 1fr; gap:10px 14px;">
              <div class="k">Anthropic</div><div class="v"><input type="password" id="apiKeyAnthropic" placeholder="sk-ant-…" autocomplete="off" style="width:100%; padding:7px 10px; font-family:var(--mono); background:var(--surface); border:1px solid var(--surface-2); border-radius:4px; color:var(--ink);"></div>
              <div class="k">OpenAI</div><div class="v"><input type="password" id="apiKeyOpenai" placeholder="sk-…" autocomplete="off" style="width:100%; padding:7px 10px; font-family:var(--mono); background:var(--surface); border:1px solid var(--surface-2); border-radius:4px; color:var(--ink);"></div>
              <div class="k">Google</div><div class="v"><input type="password" id="apiKeyGoogle" placeholder="AIza…" autocomplete="off" style="width:100%; padding:7px 10px; font-family:var(--mono); background:var(--surface); border:1px solid var(--surface-2); border-radius:4px; color:var(--ink);"></div>
              <div class="k">xAI (Grok)</div><div class="v"><input type="password" id="apiKeyXai" placeholder="xai-…" autocomplete="off" style="width:100%; padding:7px 10px; font-family:var(--mono); background:var(--surface); border:1px solid var(--surface-2); border-radius:4px; color:var(--ink);"></div>
            </div>
            <div style="display:flex; gap:8px; margin-top:14px;">
              <button class="btn primary" id="apiKeysSave" type="button">Save keys</button>
              <button class="btn" id="apiKeysReveal" type="button">Show/hide</button>
            </div>
            <p class="status" id="apiKeysStatus" style="margin-top:10px;"></p>
          </div>
        </div>
      </section>

      <section class="pane" data-pane="agent">
        <h1 class="pane-title">Desktop Tools</h1>
        <p class="pane-lede">Open the safe desktop-test harness or the Accuracy Lab click-precision stress test, inspect the controlled browser window, and scope desktop actions before clicking real apps.</p>

        <div class="block">
          <div class="block-head">
            <span class="ix">01</span>
            <span class="title">Testing Tools And Calibration</span>
            <span class="spacer"></span>
            <span class="tag warn" id="setupTag">CHECK REQUIRED</span>
          </div>
          <div class="block-body">
            <div class="setup-checklist">
              <div class="setup-item" id="setupItemOverlay"><span class="setup-dot"></span><div><strong>Overlay chat injected</strong><small id="setupOverlayText">Checking overlay bubble.</small></div></div>
              <div class="setup-item" id="setupItemMonitors"><span class="setup-dot"></span><div><strong>Monitors detected</strong><small id="setupMonitorText">Checking display map.</small></div></div>
              <div class="setup-item" id="setupItemCalibration"><span class="setup-dot"></span><div><strong>Click calibration saved</strong><small id="setupCalibrationText">Checking persisted calibration.</small></div></div>
              <div class="setup-item" id="setupItemRecordings"><span class="setup-dot"></span><div><strong>Recording tools ready</strong><small id="setupRecordingText">Checking record/playback surface.</small></div></div>
            </div>
            <div class="desktop-actions">
              <button class="btn primary" id="setupInjectOverlay" type="button">Inject overlay chat</button>
              <button class="btn" id="setupDetectMonitors" type="button">Detect monitors</button>
              <button class="btn" id="setupCalibratePrimary" type="button">Calibrate primary</button>
              <button class="btn" id="setupSaveComplete" type="button">Save setup complete</button>
            </div>
            <p class="status" id="setupStatus" style="margin-top:8px;"></p>
          </div>
        </div>

        <div class="block">
          <div class="block-head">
            <span class="ix">02</span>
            <span class="title">Bridge Test Harness</span>
            <span class="spacer"></span>
            <span class="tag" id="dtBridgeTag">CHECKING</span>
          </div>
          <div class="block-body">
            <div class="desktop-metrics">
              <div class="desktop-metric">
                <div class="label">Bridge</div>
                <div class="value" id="dtBridgeStatus">Checking</div>
              </div>
              <div class="desktop-metric">
                <div class="label">Messages</div>
                <div class="value" id="dtMessageCount">0</div>
              </div>
              <div class="desktop-metric">
                <div class="label">Overlay</div>
                <div class="value" id="dtOverlayStatus">-</div>
              </div>
              <div class="desktop-metric">
                <div class="label">Safety</div>
                <div class="value" id="dtSafetyStatus">-</div>
              </div>
              <div class="desktop-metric wide">
                <div class="label">Current URL</div>
                <div class="value small mono" id="dtCurrentUrl">-</div>
              </div>
              <div class="desktop-metric wide">
                <div class="label">Control Detail</div>
                <div class="value small" id="dtSafetyDetail">read - write - execute</div>
              </div>
            </div>
            <div class="desktop-actions">
              <button class="btn primary" id="dtOpenDesktopTest" type="button">Open desktop test</button>
              <button class="btn primary" id="dtOpenAccuracyLab" type="button">Open Accuracy Lab</button>
              <button class="btn" id="dtBrowserScreenshot" type="button">Screenshot</button>
              <button class="btn" id="dtBrowserRefresh" type="button">Refresh</button>
              <button class="btn" id="dtBrowserSnapshot" type="button">Snapshot</button>
              <button class="btn" id="dtInjectOverlay" type="button">Inject overlay</button>
              <button class="btn" id="dtOpenToolbar" type="button">Open floating toolbar</button>
              <button class="btn danger" id="dtRevokeControl" type="button">Revoke write control</button>
            </div>
            <pre class="desktop-output" id="dtCommandOutput"></pre>
            <p class="status" id="desktopToolsStatus" style="margin-top:10px;"></p>
          </div>
        </div>

        <div class="block">
          <div class="block-head">
            <span class="ix">03</span>
            <span class="title">Recording And Playback</span>
            <span class="spacer"></span>
            <span class="tag" id="recordingTag">IDLE</span>
          </div>
          <div class="block-body">
            <div class="desktop-metrics">
              <div class="desktop-metric">
                <div class="label">Recorder</div>
                <div class="value" id="recState">Idle</div>
              </div>
              <div class="desktop-metric">
                <div class="label">Actions</div>
                <div class="value" id="recActionCount">0</div>
              </div>
              <div class="desktop-metric">
                <div class="label">Saved</div>
                <div class="value" id="recSavedCount">0</div>
              </div>
              <div class="desktop-metric">
                <div class="label">Playback</div>
                <div class="value" id="recPlayState">Ready</div>
              </div>
            </div>
            <div class="desktop-actions">
              <button class="btn primary" id="recStart" type="button">Start recording</button>
              <button class="btn" id="recStop" type="button">Stop and save</button>
              <input id="recName" type="text" placeholder="Recording name">
              <button class="btn" id="recRefresh" type="button">Pull recordings</button>
              <select id="recSelect" aria-label="Saved recording"></select>
              <button class="btn" id="recLoad" type="button">Pull up recording</button>
              <button class="btn" id="recPlay" type="button">Play recording</button>
            </div>
            <pre class="desktop-output" id="recPreview"></pre>
            <p class="status" id="recStatus" style="margin-top:8px;"></p>
          </div>
        </div>

        <div class="block">
          <div class="block-head">
            <span class="ix">04</span>
            <span class="title">Focus Region</span>
            <span class="spacer"></span>
            <span class="tag" id="focusTag">NONE LOCKED</span>
          </div>
          <div class="block-body">
            <div class="kv">
              <div class="k">Status</div><div class="v" id="focusStatusText">No region — agent sees full virtual screen</div>
              <div class="k">TTL</div><div class="v mono" id="focusTtl">—</div>
              <div class="k">Bounds</div><div class="v mono" id="focusBounds">—</div>
            </div>
            <div style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
              <button class="btn primary" id="agtSelectRegion" type="button">Select region…</button>
              <button class="btn" id="agtReleaseFocus" type="button">Release focus</button>
              <button class="btn" id="agtFocusGrid" type="button" disabled>Show focus grid</button>
            </div>
            <p class="status" id="agentStatus" style="margin-top:8px;"></p>
          </div>
        </div>

        <div class="block">
          <div class="block-head">
            <span class="ix">05</span>
            <span class="title">Click Calibration</span>
            <span class="spacer"></span>
            <span class="tag" id="calibrationTag">UNCALIBRATED</span>
          </div>
          <div class="block-body">
            <div class="kv">
              <div class="k">Offset X</div><div class="v mono" id="calOffsetX">—</div>
              <div class="k">Offset Y</div><div class="v mono" id="calOffsetY">—</div>
              <div class="k">Last run</div><div class="v mono" id="calLastRun">—</div>
              <div class="k">Monitors</div><div class="v mono" id="calMonitorSummary">-</div>
            </div>
            <div class="desktop-actions" style="margin-top:14px;">
              <button class="btn" id="agtDetectMonitors" type="button">Detect monitors</button>
              <select id="agtCalMonitor" aria-label="Calibration monitor"><option value="primary">Primary monitor</option><option value="all">All monitors</option></select>
              <button class="btn" id="agtCalibrate" type="button">Calibrate selected</button>
              <button class="btn" id="agtCalibrateAll" type="button">Calibrate all</button>
            </div>
            <p class="status" id="calStatus" style="margin-top:8px;"></p>
          </div>
        </div>
      </section>

      <section class="pane" data-pane="account">
        <h1 class="pane-title">empir3 Account</h1>
        <p class="pane-lede">Pair this bridge with an <span class="brand-inline">empir<span class="three">3</span></span> account so agents can drive it remotely. The token stays on this PC.</p>

        <div class="block when-signedout">
          <div class="block-head">
            <span class="ix">01</span>
            <span class="title">Pairing</span>
            <span class="spacer"></span>
            <span class="tag warn">NOT PAIRED</span>
          </div>
          <div class="block-body">
            <p style="margin:0 0 14px; color:var(--muted); font-size:13px;">Two ways to pair: use the empir3 account already in your browser, or sign in directly to store a token on this PC that survives browser logouts.</p>
            <div style="display:flex; gap:8px;">
              <button class="btn primary" type="button" onclick="openDrawer()">Sign in with <span class="brand-inline">empir<span class="three">3</span></span></button>
            </div>
          </div>
        </div>

        <div class="block when-signedin">
          <div class="block-head">
            <span class="ix">01</span>
            <span class="title">Paired Account</span>
            <span class="spacer"></span>
            <span class="tag good" id="acctConnTag">CONNECTED</span>
          </div>
          <div class="block-body">
            <div class="kv">
              <div class="k">Account</div><div class="v" id="acctPaneEmail">—</div>
              <div class="k">Server</div><div class="v mono" id="acctPaneServer">—</div>
              <div class="k">Mode</div><div class="v" id="acctPaneMode">—</div>
              <div class="k">Device</div><div class="v mono" id="acctPaneDevice">—</div>
            </div>
            <div style="display:flex; gap:8px; margin-top:14px;">
              <button class="btn danger" id="acctSignOut" type="button">Sign out</button>
            </div>
            <p class="status" id="acctStatus" style="margin-top:8px;"></p>
          </div>
        </div>
      </section>

      <section class="pane" data-pane="daemon">
        <h1 class="pane-title">Daemon</h1>
        <p class="pane-lede">The <span class="brand-inline">empir<span class="three">3</span></span> Bridge process and the Chrome window it drives.</p>

        <div class="block">
          <div class="block-head">
            <span class="ix">01</span>
            <span class="title">Process</span>
            <span class="spacer"></span>
            <span class="tag good" id="daemonHealthTag">HEALTHY</span>
          </div>
          <div class="block-body">
            <div class="kv">
              <div class="k">PID</div><div class="v mono" id="daemonPid">${process.pid}</div>
              <div class="k">Uptime</div><div class="v mono" id="daemonUptime">—</div>
              <div class="k">Bridge URL</div><div class="v mono" id="daemonBridgeUrl">http://localhost:${PORT}</div>
              <div class="k">Version</div><div class="v mono">${BRIDGE_VERSION}</div>
            </div>
            <div style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
              <button class="btn" id="daemonOpenBridge" type="button">Open bridge window</button>
              <button class="btn" id="daemonReconnect" type="button">Reconnect daemon</button>
              <button class="btn ghost" id="daemonToggleLog" type="button">Show log</button>
            </div>
            <pre class="snippet" id="daemonLog" style="display:none; max-height:260px; margin-top:12px;"></pre>
            <p class="status" id="daemonStatus" style="margin-top:8px;"></p>
          </div>
        </div>

        <div class="block">
          <div class="block-head">
            <span class="ix">02</span>
            <span class="title">Identity</span>
            <span class="spacer"></span>
            <span class="tag" id="identityTag">—</span>
          </div>
          <div class="block-body">
            <p style="margin:0 0 14px; color:var(--muted); font-size:13px;">How this PC is labeled in <span class="brand-inline">empir<span class="three">3</span></span> agents and where bridge-side file ops (project sync, file pulls/pushes) are scoped.</p>
            <div class="kv" style="grid-template-columns: 150px 1fr; gap:10px 14px;">
              <div class="k">Device name</div><div class="v"><input type="text" id="deviceNameInput" placeholder="MSI" autocomplete="off" style="width:100%; padding:7px 10px; font-family:var(--mono); background:var(--surface); border:1px solid var(--surface-2); border-radius:4px; color:var(--ink);"></div>
              <div class="k">Home directory</div><div class="v"><input type="text" id="homeDirInput" placeholder="C:\\Users\\you\\Documents\\Empir3" autocomplete="off" style="width:100%; padding:7px 10px; font-family:var(--mono); background:var(--surface); border:1px solid var(--surface-2); border-radius:4px; color:var(--ink);"></div>
            </div>
            <div style="display:flex; gap:8px; margin-top:14px;">
              <button class="btn primary" id="identitySave" type="button">Save identity</button>
              <button class="btn ghost" id="identityReset" type="button">Reset to current</button>
            </div>
            <p class="status" id="identityStatus" style="margin-top:10px;"></p>
          </div>
        </div>
      </section>

      <section class="pane" data-pane="updates">
        <h1 class="pane-title">Updates</h1>
        <p class="pane-lede">Bridge payloads ship as auto-updateable packages. You can hold a version or auto-apply.</p>

        <div class="block">
          <div class="block-head">
            <span class="ix">01</span>
            <span class="title">Version</span>
            <span class="spacer"></span>
            <span class="tag" id="updateTag">—</span>
          </div>
          <div class="block-body">
            <div class="kv">
              <div class="k">Installed</div><div class="v mono">${BRIDGE_VERSION}</div>
              <div class="k">Available</div><div class="v mono" id="updateAvailable">—</div>
              <div class="k">Last check</div><div class="v mono" id="updateLastCheck">—</div>
            </div>
            <div style="display:flex; gap:8px; margin-top:14px;">
              <button class="btn" id="updateCheck" type="button">Check now</button>
              <button class="btn primary" id="updateApply" type="button" style="display:none;">Apply update (restarts tray)</button>
            </div>
            <p class="status" id="updateStatus" style="margin-top:8px;"></p>
          </div>
        </div>

        <div class="block">
          <div class="block-head">
            <span class="ix">02</span>
            <span class="title">Policy</span>
          </div>
          <div class="block-body">
            <label style="display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--line); border-radius:5px; background:var(--surface); cursor:pointer;">
              <span class="sw"><input type="checkbox" id="autoUpdateToggle"><span class="s"></span></span>
              <span style="font-size:13px;"><strong>Auto-update</strong> — apply new bridge payloads automatically as they ship.</span>
            </label>
            <p class="status" id="policyStatus" style="margin-top:8px;"></p>
          </div>
        </div>
      </section>

      <section class="pane" data-pane="logs">
        <h1 class="pane-title">Activity Log</h1>
        <p class="pane-lede">Recent tool calls captured by the action log.</p>
        <div class="block">
          <div class="block-head">
            <span class="ix">01</span>
            <span class="title">Action Log</span>
            <span class="spacer"></span>
            <button class="btn small ghost" id="logsRefresh" type="button">Refresh</button>
          </div>
          <div class="block-body">
            <table class="log-table" id="logsTable">
              <tbody id="logsRows"><tr><td class="dt" style="text-align:center;">Loading…</td></tr></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="pane" data-pane="lifecycle">
        <h1 class="pane-title" style="color: var(--bad);">Tray Lifecycle</h1>
        <p class="pane-lede">These restart or remove the running tray. Each click asks for confirmation. Uninstall is irreversible.</p>

        <div class="block" style="border-color: rgba(178,36,31,0.28);">
          <div class="block-head" style="background: var(--bad-soft); border-bottom-color: rgba(178,36,31,0.18);">
            <span class="ix" style="color:var(--bad);">!!</span>
            <span class="title" style="color:var(--bad);">Destructive Actions</span>
            <span class="spacer"></span>
            <span class="tag bad">CONFIRMATION REQUIRED</span>
          </div>
          <div class="block-body">
            <div style="display:grid; gap:10px;">
              <div style="display:grid; grid-template-columns: 1fr auto; gap:14px; align-items:center; padding:12px; border:1px solid var(--line); border-radius:5px; background:var(--surface);">
                <div>
                  <div style="font-weight:700; font-size:13px;">Restart tray</div>
                  <div style="font-size:11.5px; color:var(--muted); margin-top:1px;">The bridge daemon will restart with it. Active MCP sessions reconnect automatically.</div>
                </div>
                <button class="btn danger" id="lifeRestart" type="button">Restart tray</button>
              </div>
              <div style="display:grid; grid-template-columns: 1fr auto; gap:14px; align-items:center; padding:12px; border:1px solid var(--line); border-radius:5px; background:var(--surface);">
                <div>
                  <div style="font-weight:700; font-size:13px;">Quit Empir3</div>
                  <div style="font-size:11.5px; color:var(--muted); margin-top:1px;">Tray icon disappears, bridge daemon stops. MCP clients lose connection.</div>
                </div>
                <button class="btn danger" id="lifeQuit" type="button">Quit Empir3</button>
              </div>
              <div style="display:grid; grid-template-columns: 1fr auto; gap:14px; align-items:center; padding:12px; border:1px solid var(--bad); border-radius:5px; background:var(--bad-soft);">
                <div>
                  <div style="font-weight:700; font-size:13px; color:var(--bad);">Uninstall Empir3</div>
                  <div style="font-size:11.5px; color:var(--muted); margin-top:1px;">Wipes Chrome profile, auth, settings, autostart entry, Start Menu shortcut, and cached payloads. Irreversible.</div>
                </div>
                <button class="btn danger" id="lifeUninstall" type="button">Uninstall…</button>
              </div>
            </div>
            <p class="status" id="lifeStatus" style="margin-top:10px;"></p>
          </div>
        </div>
      </section>

    </div>
  </main>
</div>

<div class="backdrop" id="backdrop"></div>
<aside class="drawer" id="drawer">
  <div class="drawer-head">
    <span class="title">Sign in with <span class="brand-inline">empir<span class="three">3</span></span></span>
    <span class="spacer"></span>
    <button class="x" type="button" onclick="closeDrawer()" aria-label="Close">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
    </button>
  </div>
  <p class="sub">Pair this bridge with your <span class="brand-inline">empir<span class="three">3</span></span> account. The token stays on this PC.</p>
  <div class="drawer-body">
    <label>Server
      <select id="serverPreset">
        <option value="production">Production — app.empir3.com</option>
        <option value="local-dev">Local dev — localhost:3005</option>
        <option value="custom">Custom…</option>
      </select>
    </label>
    <label id="customServerLabel" style="display:none;">Custom URL <input id="serverUrl" type="url" value="${EMPIR3_SERVER}"></label>
    <button class="btn primary" id="pairEmpir3" type="button" style="width:100%;">Use browser <span class="brand-inline">empir<span class="three">3</span></span> login</button>
    <p class="hint">Reuses the <span class="brand-inline">empir<span class="three">3</span></span> account you're already signed into in your browser.</p>
    <div class="divider">or sign in directly</div>
    <form id="loginForm" style="display:grid; gap:10px;">
      <div class="fields">
        <label>Email<input type="email" id="loginEmail" autocomplete="username" placeholder="you@example.com"></label>
        <label>Password<input type="password" id="loginPassword" autocomplete="current-password" placeholder="••••••••"></label>
      </div>
      <button class="btn" type="submit" style="width:100%;">Sign in and store on this bridge</button>
    </form>
    <p class="hint">Stores a long-lived bridge token locally, independent of your browser session.</p>
    <p class="status" id="drawerStatus"></p>
  </div>
</aside>

<script>
  // ────── Constants from server ──────
  const API = ${JSON.stringify(api)};
  const TOOLS = ${toolsJson};
  TOOLS.forEach(function(t){ t.on = t.d; });
  const PROD_SERVER = ${JSON.stringify(DEFAULT_EMPIR3_SERVER)};
  const DEV_SERVER  = ${JSON.stringify(LOCAL_DEV_EMPIR3_SERVER)};
  let SAFETY = { read: true, write: false, execute: false };

  const GROUP_ORDER = ['advisor','read','navigate','interact','desktop','eval','recordings','higgsfield'];
  const GROUP_LABEL = { advisor:'Advisor', read:'Read', navigate:'Navigate', interact:'Interact', desktop:'Desktop', eval:'JavaScript (Eval)', recordings:'Recordings & Chat', higgsfield:'Higgsfield CLI' };
  const GROUP_TAG = { advisor:'good', read:'good', navigate:'accent', interact:'warn', desktop:'warn', eval:'bad', recordings:'', higgsfield:'accent' };

  const $ = function(id){ return document.getElementById(id); };
  function setText(id, v) { var el = $(id); if (el) el.textContent = v == null ? '—' : String(v); }
  function setStatus(id, msg, tone) {
    var el = $(id); if (!el) return;
    el.classList.remove('ok','err','info');
    if (tone) el.classList.add(tone);
    el.textContent = msg || '';
  }
  function setMetricTone(id, tone) {
    var el = $(id); if (!el) return;
    el.classList.remove('good','warn','bad');
    if (tone) el.classList.add(tone);
  }
  function escapeAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  async function api(path, opts) {
    var r = await fetch(API + path, opts);
    var j = {}; try { j = await r.json(); } catch (_) {}
    if (!r.ok && !j.ok) throw new Error(j.error || ('http ' + r.status));
    return j;
  }
  // Single-flight per path + abort timeout. The dashboard runs ~6 polling
  // intervals (status/actions/focus/recording/cli/settings); if the daemon is
  // momentarily slow, fixed-clock intervals would re-fire before the prior fetch
  // returns and pile up concurrent requests — which loads the daemon's shared
  // event loop further and feeds a slow-loop⇄pile-up spiral. Collapsing
  // same-path GETs to one in-flight request (and aborting a stuck one) prevents
  // that pile-up so the daemon's trivial handlers stay responsive.
  var __getJsonInflight = {};
  async function getJson(path) {
    if (__getJsonInflight[path]) return __getJsonInflight[path];
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function(){ try { ctrl.abort(); } catch (e) {} }, 8000) : null;
    var p = fetch(API + path, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function(r){ return r.json(); })
      .finally(function(){ if (timer) clearTimeout(timer); delete __getJsonInflight[path]; });
    __getJsonInflight[path] = p;
    return p;
  }
  async function postJson(path, body) {
    return api(path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body || {}) });
  }

  // ────── Permissions table ──────
  // Map a tool group to its handler-family key in
  // settings.handlers.<key>.enabled. Only handler families (Higgsfield,
  // future Replicate/Runway/Suno) are gated this way — the core browser /
  // desktop groups have no family layer above them. Returns null for the
  // groups that bypass the family gate entirely.
  function familyHandlerKey(grp) {
    if (grp === 'higgsfield') return 'higgsfield';
    return null;
  }
  function warnSvg() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1L1 14h14L8 1zM8 6v4M8 12v.5"/></svg>';
  }
  function dependencyWarning(tool) {
    if (!tool.r || !tool.on) return '';
    if (SAFETY[tool.r]) return '';
    var attrTitle = tool.r.toUpperCase() + ' is OFF on the global safety override — this tool will be blocked until you enable ' + tool.r + '.';
    return ' <span class="dep-warn" title="' + escapeAttr(attrTitle) + '">' + warnSvg() + 'NEEDS ' + tool.r.toUpperCase() + '</span>';
  }
  function activeFilter() {
    var btn = document.querySelector('.perm-toolbar .filter-group button.on');
    return btn ? btn.dataset.filter : 'all';
  }
  var currentSearch = '';
  function renderTable(filter) {
    filter = filter || activeFilter();
    var tbody = $('permRows'); if (!tbody) return;
    tbody.innerHTML = '';
    var q = currentSearch.trim().toLowerCase();
    for (var gi = 0; gi < GROUP_ORDER.length; gi++) {
      var grp = GROUP_ORDER[gi];
      var rows = TOOLS.filter(function(t){
        if (t.hidden) return false;
        if (t.g !== grp) return false;
        if (filter !== 'all' && filter !== grp) return false;
        if (q && t.n.toLowerCase().indexOf(q) === -1 && (t.b||'').toLowerCase().indexOf(q) === -1) return false;
        return true;
      });
      if (!rows.length) continue;
      var onCount = rows.filter(function(r){ return r.on; }).length;
      var hdr = document.createElement('tr');
      hdr.className = 'group-header';
      hdr.innerHTML =
        '<td colspan="4">' +
          '<span>' + escapeHtml(GROUP_LABEL[grp]) + '</span>' +
          '<span class="count">' + onCount + ' / ' + rows.length + '</span>' +
          '<span class="bulk">' +
            '<button data-grp="' + grp + '" data-act="enable">enable all</button>' +
            '<button data-grp="' + grp + '" data-act="default">defaults</button>' +
            '<button data-grp="' + grp + '" data-act="disable">disable all</button>' +
          '</span>' +
        '</td>';
      tbody.appendChild(hdr);
      // Handler-family gate banner — when a family group is shown but its
      // tray/handler gate is off, every row below is effectively dead. Say
      // so plainly with a jump back to the API & CLIs pane.
      var familyGated = familyHandlerKey(grp);
      if (familyGated) {
        var fEnabled = !!(CLI_STATE && CLI_STATE.bridge && CLI_STATE.bridge.handlers && CLI_STATE.bridge.handlers[familyGated] && CLI_STATE.bridge.handlers[familyGated].enabled);
        if (!fEnabled) {
          var banner = document.createElement('tr');
          banner.innerHTML = '<td colspan="4" style="padding:10px 14px; background:rgba(243,156,18,0.08); border-left:3px solid var(--warn,#f39c12); color:var(--muted); font-size:12.5px;">' +
            '⚠ Family gate is OFF — these tools won\\'t appear in any MCP client until you enable <strong>' + escapeHtml(GROUP_LABEL[grp]) + '</strong> on the ' +
            '<a href="#" data-goto="clis" style="color:var(--accent); text-decoration:underline;">API &amp; CLIs</a> page.' +
            '</td>';
          tbody.appendChild(banner);
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var t = rows[i];
        var tr = document.createElement('tr');
        if (!t.on) tr.classList.add('disabled');
        if (t.g === 'eval') tr.classList.add('eval');
        var dangerTag = t.g === 'eval' ? ' <span class="tag bad" style="margin-left:6px;">DANGER</span>' : '';
        tr.innerHTML =
          '<td class="col-tg"><label class="sw"><input type="checkbox" data-tool="' + t.n + '"' + (t.on?' checked':'') + '><span class="s"></span></label></td>' +
          '<td class="col-nm">' + escapeHtml(t.n) + dangerTag + dependencyWarning(t) + '</td>' +
          '<td class="col-tag"><span class="tag ' + (GROUP_TAG[t.g] || '') + '">' + t.g.toUpperCase() + '</span></td>' +
          '<td class="col-blurb">' + escapeHtml(t.b) + '</td>';
        tbody.appendChild(tr);
      }
    }
    var visibleTools = TOOLS.filter(function(t){ return !t.hidden; });
    var enabled = visibleTools.filter(function(t){ return t.on; }).length;
    var blockedBySafety = visibleTools.filter(function(t){ return t.on && t.r && !SAFETY[t.r]; }).length;
    var effective = enabled - blockedBySafety;
    setText('enabledCount', enabled);
    setText('visibleToolCount', visibleTools.length);
    setText('sidebarPermCount', visibleTools.length);
    setText('ovPermSummary', effective + ' / ' + visibleTools.length);
    var ovTags = $('ovPermTags');
    if (ovTags) {
      var tags = '<span class="tag good">' + effective + ' READY</span>';
      if (blockedBySafety) tags += ' <span class="tag warn" style="margin-left:4px;">' + blockedBySafety + ' NEED SAFETY</span>';
      var disabled = visibleTools.length - enabled;
      if (disabled) tags += ' <span class="tag" style="margin-left:4px;">' + disabled + ' BLOCKED</span>';
      ovTags.innerHTML = tags;
    }
  }
  document.querySelectorAll('.perm-toolbar .filter-group button').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('.perm-toolbar .filter-group button').forEach(function(b){ b.classList.remove('on'); });
      btn.classList.add('on');
      renderTable(btn.dataset.filter);
    });
  });
  // Global ⌘K / Ctrl+K search — filters the permissions table by tool name
  // or blurb substring as the user types, and auto-switches to the
  // Permissions pane when something is queried.
  var gs = $('globalSearch');
  if (gs) {
    gs.addEventListener('input', function(){
      currentSearch = gs.value || '';
      if (currentSearch.trim() && typeof goto === 'function') {
        var permPane = document.querySelector('[data-pane="permissions"]');
        if (permPane && !permPane.classList.contains('active')) goto('permissions');
      }
      renderTable();
    });
  }
  document.addEventListener('keydown', function(e){
    var isModK = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
    if (isModK && gs) {
      e.preventDefault();
      gs.focus();
      gs.select();
    } else if (e.key === 'Escape' && document.activeElement === gs && gs.value) {
      gs.value = '';
      currentSearch = '';
      renderTable();
    }
  });
  // Save a single tool's enabled state to /api/settings/state
  async function saveToolPatch(name, on) {
    markLocalMutate();
    setStatus('permStatus', 'Saving ' + name + '…', 'info');
    try {
      var patch = {}; patch[name] = on;
      var r = await postJson('/api/settings/state', { chat: { enabledTools: patch } });
      // server returns full state; sync our model
      var et = (r && r.chat && r.chat.enabledTools) || {};
      TOOLS.forEach(function(t){
        // A tool absent from server's enabledTools means it's family-gated
        // off (e.g. custom_llm when no custom providers exist). Treat as
        // hidden — don't render the row, don't count in N / N.
        t.hidden = !(t.n in et);
        if (et[t.n] !== undefined) t.on = !!et[t.n];
      });
      renderTable();
      // Per-tool toggle on Permissions affects the "N / N tools" readout
      // in the API & CLIs row — keep them in sync without a full reload.
      if (typeof renderCliRows === 'function' && CLI_STATE) renderCliRows();
      setStatus('permStatus', 'Saved ' + name + ' = ' + (on?'on':'off') + '.', 'ok');
    } catch (e) {
      setStatus('permStatus', 'Failed to save: ' + e.message, 'err');
      // revert UI by reloading
      loadPermissionState();
    }
  }
  async function saveBulkPatch(patchMap) {
    markLocalMutate();
    setStatus('permStatus', 'Saving ' + Object.keys(patchMap).length + ' tools…', 'info');
    try {
      var r = await postJson('/api/settings/state', { chat: { enabledTools: patchMap } });
      var et = (r && r.chat && r.chat.enabledTools) || {};
      TOOLS.forEach(function(t){
        // A tool absent from server's enabledTools means it's family-gated
        // off (e.g. custom_llm when no custom providers exist). Treat as
        // hidden — don't render the row, don't count in N / N.
        t.hidden = !(t.n in et);
        if (et[t.n] !== undefined) t.on = !!et[t.n];
      });
      renderTable();
      // Per-tool toggle on Permissions affects the "N / N tools" readout
      // in the API & CLIs row — keep them in sync without a full reload.
      if (typeof renderCliRows === 'function' && CLI_STATE) renderCliRows();
      setStatus('permStatus', 'Saved.', 'ok');
    } catch (e) {
      setStatus('permStatus', 'Failed to save: ' + e.message, 'err');
      loadPermissionState();
    }
  }
  document.addEventListener('change', function(e){
    if (e.target.matches && e.target.matches('input[data-tool]')) {
      var name = e.target.dataset.tool;
      var t = TOOLS.find(function(x){ return x.n === name; });
      if (t) { t.on = e.target.checked; renderTable(); saveToolPatch(name, t.on); }
    }
  });
  document.addEventListener('change', function(e){
    if (e.target.matches && e.target.matches('input[data-safety]')) {
      var key = e.target.dataset.safety;
      var on = !!e.target.checked;
      SAFETY[key] = on;
      var row = e.target.closest('.safety-cell');
      if (row) row.classList.toggle('on', on);
      paintSafety(SAFETY);
      renderTable();
      saveSafety();
    }
  });
  document.addEventListener('click', function(e){
    var b = e.target.closest && e.target.closest('button[data-safety-toggle]');
    if (!b) return;
    var key = b.dataset.safetyToggle;
    if (!(key in SAFETY)) return;
    SAFETY[key] = !SAFETY[key];
    paintSafety(SAFETY);
    renderTable();
    saveSafety();
  });
  document.addEventListener('click', function(e){
    var b = e.target.closest && e.target.closest('button[data-grp]');
    if (!b) return;
    var act = b.dataset.act;
    var patch = {};
    TOOLS.filter(function(t){ return t.g === b.dataset.grp; }).forEach(function(t){
      if (act === 'enable') t.on = true;
      else if (act === 'disable') t.on = false;
      else if (act === 'default') t.on = t.d;
      patch[t.n] = t.on;
    });
    renderTable();
    saveBulkPatch(patch);
  });
  document.addEventListener('click', function(e){
    var b = e.target.closest && e.target.closest('button[data-bulk]');
    if (!b) return;
    var act = b.dataset.bulk;
    var patch = {};
    TOOLS.forEach(function(t){
      if (act === 'enable-all') t.on = true;
      else if (act === 'disable-all') t.on = false;
      else if (act === 'default') t.on = t.d;
      patch[t.n] = t.on;
    });
    renderTable();
    saveBulkPatch(patch);
  });

  // ────── Global Safety persistence ──────
  function paintSafety(s) {
    if (!s) return;
    SAFETY = { read: !!s.read, write: !!s.write, execute: !!s.execute };
    document.querySelectorAll('input[data-safety]').forEach(function(input){
      var k = input.dataset.safety;
      input.checked = !!SAFETY[k];
      var row = input.closest('.safety-cell');
      if (row) row.classList.toggle('on', !!SAFETY[k]);
    });
    var v = (SAFETY.read?'R':'·') + ' / ' + (SAFETY.write?'W':'·') + ' / ' + (SAFETY.execute?'E':'·');
    var detail = 'read ' + (SAFETY.read?'on':'off') + ' · write ' + (SAFETY.write?'on':'off') + ' · exec ' + (SAFETY.execute?'on':'off');
    var topSafety = $('teleSafetyVal');
    if (topSafety) {
      topSafety.innerHTML = '<span class="safety-shortcuts">' +
        '<button class="safety-shortcut ' + (SAFETY.read ? 'on' : 'off') + '" type="button" data-safety-toggle="read" aria-pressed="' + (SAFETY.read ? 'true' : 'false') + '" title="Toggle read permission">R</button>' +
        '<span class="safety-divider">/</span>' +
        '<button class="safety-shortcut ' + (SAFETY.write ? 'on' : 'off') + '" type="button" data-safety-toggle="write" aria-pressed="' + (SAFETY.write ? 'true' : 'false') + '" title="Toggle write permission">W</button>' +
        '<span class="safety-divider">/</span>' +
        '<button class="safety-shortcut ' + (SAFETY.execute ? 'on' : 'off') + '" type="button" data-safety-toggle="execute" aria-pressed="' + (SAFETY.execute ? 'true' : 'false') + '" title="Toggle execute permission">E</button>' +
        '</span>';
    }
    setText('teleSafetySub', detail + ' · click R/W/E to toggle');
    setText('dtSafetyStatus', v);
    setText('dtSafetyDetail', detail);
    setMetricTone('dtSafetyStatus', (!SAFETY.read && !SAFETY.write && !SAFETY.execute) ? 'bad' : ((SAFETY.write || SAFETY.execute) ? 'warn' : 'good'));
    var led = $('teleSafetyLed');
    if (led) {
      led.classList.remove('warn','bad','idle');
      if (!SAFETY.read && !SAFETY.write && !SAFETY.execute) led.classList.add('bad');
      else if (SAFETY.read && !SAFETY.write && !SAFETY.execute) {/* default */}
      else led.classList.remove('warn','bad','idle');
    }
  }
  async function saveSafety() {
    markLocalMutate();
    setStatus('safetyStatus', 'Saving safety override…', 'info');
    try {
      var r = await postJson('/api/settings/state', { bridge: { globalSafety: SAFETY } });
      paintSafety(r && r.bridge && r.bridge.globalSafety);
      renderTable();
      setStatus('safetyStatus', 'Saved.', 'ok');
    } catch (e) {
      setStatus('safetyStatus', 'Failed: ' + e.message, 'err');
      loadPermissionState();
    }
  }

  // ────── Initial settings load ──────
  async function loadPermissionState() {
    try {
      var s = await getJson('/api/settings/state');
      var et = (s.chat && s.chat.enabledTools) || {};
      TOOLS.forEach(function(t){
        // A tool absent from server's enabledTools means it's family-gated
        // off (e.g. custom_llm when no custom providers exist). Treat as
        // hidden — don't render the row, don't count in N / N.
        t.hidden = !(t.n in et);
        if (et[t.n] !== undefined) t.on = !!et[t.n];
      });
      paintSafety((s.bridge && s.bridge.globalSafety) || { read:true, write:false, execute:false });
      renderTable();
      // auto-update toggle
      if ($('autoUpdateToggle')) $('autoUpdateToggle').checked = !!(s.bridge && s.bridge.autoUpdate !== false);
    } catch (e) {
      setStatus('permStatus', 'Could not load settings: ' + e.message, 'err');
    }
  }

  // Track most recent local mutation so the background refresh doesn't clobber
  // an in-flight save (POST → 200 → UI updates → background poll fires before
  // user sees the result would briefly revert state).
  var lastLocalMutate = 0;
  function markLocalMutate() { lastLocalMutate = Date.now(); }
  async function refreshSettingsIfQuiet() {
    if (Date.now() - lastLocalMutate < 2500) return; // user is actively editing
    try { await loadPermissionState(); } catch (_) {}
  }

  // ────── Live status / telemetry ──────
  function formatUptime(ms) {
    if (!ms || ms < 0) return '—';
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600); s -= h*3600;
    var m = Math.floor(s / 60); s -= m*60;
    function pad(n){ return n < 10 ? '0' + n : '' + n; }
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  }
  function timeAgo(ts) {
    if (!ts) return '—';
    var d = (Date.now() - Date.parse(ts)) / 1000;
    if (d < 60) return Math.floor(d) + 's ago';
    if (d < 3600) return Math.floor(d/60) + 'm ago';
    if (d < 86400) return Math.floor(d/3600) + 'h ago';
    return Math.floor(d/86400) + 'd ago';
  }
  async function refreshStatus() {
    try {
      var s = await getJson('/api/status');
      var rs = await getJson('/api/relay-status');
      var uptimeMs = rs.uptimeMs || 0;
      // Daemon telemetry. The daemon answered with a valid status payload, so it
      // is alive BY DEFINITION here. Daemon/MCP liveness must NOT be gated on
      // s.running (= cdpConnected, the Chrome/CDP browser link) — closing Chrome
      // leaves the daemon perfectly healthy. The browser/CDP state is surfaced
      // separately by the Desktop-tools indicator (dtBridge*) below. (getJson
      // doesn't check res.ok, so validate the payload shape, not just "no throw".)
      var daemonAlive = !!(s && s.engine === 'empir3-bridge');
      setText('teleDaemonVal', daemonAlive ? 'RUNNING' : 'OFFLINE');
      setText('teleDaemonSub', (s.pid ? 'PID ' + s.pid + ' · ' : '') + 'uptime ' + formatUptime(uptimeMs));
      var dled = $('teleDaemonLed'); if (dled){ dled.classList.remove('warn','bad','idle'); if (!daemonAlive) dled.classList.add('bad'); }
      // Desktop tools harness telemetry
      setText('dtBridgeStatus', s.running ? 'Connected' : 'Disconnected');
      setMetricTone('dtBridgeStatus', s.running ? 'good' : 'bad');
      var dtTag = $('dtBridgeTag');
      if (dtTag) { dtTag.textContent = s.running ? 'CONNECTED' : 'OFFLINE'; dtTag.className = 'tag ' + (s.running ? 'good' : 'bad'); }
      setText('dtCurrentUrl', s.currentUrl || '—');
      setText('dtMessageCount', s.messageCount || 0);
      setMetricTone('dtMessageCount', (s.messageCount || 0) > 0 ? 'warn' : '');
      setText('dtOverlayStatus', s.overlayInjected ? 'Active' : 'Not injected');
      setMetricTone('dtOverlayStatus', s.overlayInjected ? 'good' : 'warn');
      // Overview daemon tile
      setText('ovDaemonUptime', formatUptime(uptimeMs));
      setText('ovDaemonPid', s.pid ? 'PID ' + s.pid : 'PID —');
      // Daemon pane
      setText('daemonPid', s.pid || '—');
      setText('daemonUptime', formatUptime(uptimeMs));
      setText('daemonBridgeUrl', s.bridgeUrl || ('http://localhost:${PORT}'));
      var healthTag = $('daemonHealthTag');
      if (healthTag) {
        healthTag.classList.remove('good','warn','bad');
        if (daemonAlive) { healthTag.classList.add('good'); healthTag.textContent = 'HEALTHY'; }
        else { healthTag.classList.add('bad'); healthTag.textContent = 'OFFLINE'; }
      }
      // Rail foot
      setText('footDaemonUptime', formatUptime(uptimeMs));
      var fdLed = $('footDaemonLed'); if (fdLed){ fdLed.classList.remove('warn','bad'); if (!daemonAlive) fdLed.classList.add('bad'); }
      var fmLed = $('footMcpLed'); if (fmLed){ fmLed.classList.remove('warn','bad'); if (!daemonAlive) fmLed.classList.add('bad'); }
      // MCP cell — the stdio MCP server IS the daemon, so MCP is READY whenever
      // the daemon is reachable (NOT gated on the browser/CDP link). Calls are
      // counted from /api/actions.
      setText('teleMcpVal', daemonAlive ? 'READY' : 'OFFLINE');
      var mled = $('teleMcpLed'); if (mled){ mled.classList.remove('warn','bad'); if (!daemonAlive) mled.classList.add('bad'); }
      // Relay
      var rConn = !!(rs.relay && rs.relay.connected);
      var rPaired = !!rs.hasAuth;
      var rRejected = !!(rs.relay && rs.relay.authRejected);
      var rNeedAuth = rPaired && rRejected;
      var who = (rs.authUser && rs.authUser.email) || '';
      var relayLabel = rPaired ? (rNeedAuth ? 'SIGN IN NEEDED' : (rConn ? 'CONNECTED' : 'PAIRED')) : 'UNPAIRED';
      setText('teleRelayVal', relayLabel);
      setText('teleRelaySub', rPaired ? (rNeedAuth ? ((who || 'stored bridge account') + ' - sign in again') : (who + (rConn ? '' : ' · awaiting'))) : 'no empir3 account on this PC');
      var rled = $('teleRelayLed'); if (rled){ rled.classList.remove('warn','bad'); if (rNeedAuth) rled.classList.add('bad'); else if (!rPaired) rled.classList.add('warn'); }
      var frled = $('footRelayLed'); if (frled){ frled.classList.remove('warn','bad'); if (rNeedAuth) frled.classList.add('bad'); else if (!rPaired) frled.classList.add('warn'); }
      setText('footRelayState', rNeedAuth ? 'sign in needed' : (rPaired ? (who.split('@')[0] || 'paired') : 'unpaired'));
      var ovRelayStatus = $('ovRelayStatus');
      if (ovRelayStatus) {
        ovRelayStatus.textContent = relayLabel;
        ovRelayStatus.classList.remove('good','warn','bad');
        ovRelayStatus.classList.add(rNeedAuth ? 'bad' : (rPaired ? 'good' : 'warn'));
      }
      // Account chip + pane
      if (rPaired && who) {
        setText('acctEmail', who);
        var initials = (who.split('@')[0] || '').slice(0,2).toUpperCase();
        setText('acctAvatar', initials || '··');
        setText('acctPaneEmail', who);
        setText('acctPaneServer', (rs.serverUrl || '').replace(/^https?:\\/\\//,''));
        setText('acctPaneMode', rs.mode + (rNeedAuth ? ' · sign in needed' : (rConn ? ' · connected' : ' · awaiting relay')));
        setText('acctPaneDevice', (rs.relay && rs.relay.deviceName) || '—');
        var acctTag = $('acctConnTag');
        if (acctTag) {
          acctTag.className = 'tag ' + (rNeedAuth ? 'bad' : (rConn ? 'good' : 'warn'));
          acctTag.textContent = rNeedAuth ? 'SIGN IN NEEDED' : (rConn ? 'CONNECTED' : 'PAIRED');
        }
        if (rNeedAuth) setStatus('acctStatus', 'Empir3 rejected the stored bridge token. Sign in again to pair this PC.', 'err');
        else setStatus('acctStatus', '', 'info');
        setText('ovRelayUser', who);
        setText('ovRelayServer', (rs.serverUrl || '').replace(/^https?:\\/\\//,''));
        document.body.dataset.view = 'signedin';
      } else {
        document.body.dataset.view = 'signedout';
      }
    } catch (e) {
      // Daemon unreachable — reset the ENTIRE daemon family to OFFLINE, not just
      // the daemon pill. Leaving MCP / health / foot LEDs / uptime at their last
      // good value would paint a half-green console over a dead daemon.
      setText('teleDaemonVal','OFFLINE');
      var dled2 = $('teleDaemonLed'); if (dled2){ dled2.classList.remove('warn','idle'); dled2.classList.add('bad'); }
      setText('teleMcpVal','OFFLINE');
      var mled2 = $('teleMcpLed'); if (mled2){ mled2.classList.remove('warn'); mled2.classList.add('bad'); }
      var healthTag2 = $('daemonHealthTag');
      if (healthTag2) { healthTag2.classList.remove('good','warn'); healthTag2.classList.add('bad'); healthTag2.textContent = 'OFFLINE'; }
      var fdLed2 = $('footDaemonLed'); if (fdLed2){ fdLed2.classList.remove('warn'); fdLed2.classList.add('bad'); }
      var fmLed2 = $('footMcpLed'); if (fmLed2){ fmLed2.classList.remove('warn'); fmLed2.classList.add('bad'); }
      setText('footDaemonUptime','—');
      setText('daemonUptime','—');
      setText('ovDaemonUptime','—');
      setText('dtBridgeStatus','Disconnected');
      setMetricTone('dtBridgeStatus','bad');
      var dtTag2 = $('dtBridgeTag'); if (dtTag2) { dtTag2.textContent = 'OFFLINE'; dtTag2.className = 'tag bad'; }
    }
  }
  async function refreshActions() {
    try {
      var rows = await getJson('/api/actions');
      if (!Array.isArray(rows)) return;
      var calls = rows.length, errs = rows.filter(function(r){ return r.ok === false; }).length;
      setText('ovMcpCalls', calls + ' '); // suffix kept by overview HTML structure
      var ovCalls = $('ovMcpCalls');
      if (ovCalls) ovCalls.innerHTML = calls + ' <span style="color:var(--soft); font-size:14px;">/ ' + errs + ' err</span>';
      setText('teleMcpSub', 'stdio · ' + calls + ' calls / ' + errs + ' errors');
      setText('footMcpCount', calls + ' calls');
      // Overview recent activity (top 5)
      var ovRows = $('ovLogRows');
      if (ovRows) {
        if (!rows.length) ovRows.innerHTML = '<tr><td class="dt" style="text-align:center;">No activity yet.</td></tr>';
        else ovRows.innerHTML = rows.slice(-5).reverse().map(rowHtml).join('');
        var last = rows[rows.length-1];
        if (last) setText('ovMcpLast', 'Last call ' + last.type + ' · ' + timeAgo(last.timestamp));
      }
      // Full log pane
      var logsRows = $('logsRows');
      if (logsRows) {
        if (!rows.length) logsRows.innerHTML = '<tr><td class="dt" style="text-align:center;">No activity yet.</td></tr>';
        else logsRows.innerHTML = rows.slice().reverse().map(rowHtml).join('');
      }
    } catch (e) {}
  }
  function rowHtml(r) {
    var t = (r.timestamp || '').slice(11,19);
    var ok = r.ok !== false;
    var status = ok ? '200' : 'err';
    var stClass = ok ? 'st' : 'st err';
    var ms = (r.elapsedMs || 0) + ' ms';
    var detail = r.error ? r.error : summarizeReceiptInput(r);
    return '<tr><td class="ts mono">' + escapeHtml(t) + '</td><td class="nm">' + escapeHtml(r.type || '') + '</td><td class="' + stClass + '">' + status + '</td><td class="ms mono">' + escapeHtml(ms) + '</td><td class="dt">' + escapeHtml(detail) + '</td></tr>';
  }
  function summarizeReceiptInput(r) {
    var i = r.input || {};
    // Pick the field most useful per tool family. summarizeCommand() in
    // server.ts copies through these keys verbatim, so they're stable.
    if (i.url) return String(i.url);
    if (i.ref) return 'ref:' + i.ref;
    if (i.selector) return i.selector;
    if (typeof i.x === 'number' && typeof i.y === 'number') return '(' + i.x + ',' + i.y + ')';
    if (i.monitor) return 'monitor:' + i.monitor;
    if (i.recording) return 'rec:' + i.recording;
    if (i.filter) return 'filter:' + i.filter;
    if (typeof i.textLength === 'number') return 'text·' + i.textLength + 'ch';
    if (typeof i.messageLength === 'number') return 'msg·' + i.messageLength + 'ch';
    if (i.format) return 'fmt:' + i.format;
    return r.source || '';
  }
  async function refreshFocus() {
    try {
      var j = await getJson('/api/desktop/focus');
      var has = !!j.active;
      var tag = $('focusTag'); if (tag) { tag.textContent = has ? 'LOCKED' : 'NONE LOCKED'; tag.className = 'tag ' + (has ? 'good' : ''); }
      setText('focusStatusText', has ? 'Region locked — agent scoped to it.' : 'No region — agent sees full virtual screen');
      setText('focusTtl', has && j.ttlMs ? Math.round(j.ttlMs/1000) + 's' : '—');
      setText('focusBounds', has && j.region ? (j.region.width + '×' + j.region.height + ' @ (' + j.region.x + ',' + j.region.y + ')') : '—');
      var rel = $('agtReleaseFocus'); if (rel) rel.disabled = false;
      var grid = $('agtFocusGrid'); if (grid) grid.disabled = !has;
      // Sync the focus-grid button label with the daemon's authoritative
      // state. Without this the boot label always reads "Show focus grid"
      // even when another channel (CLI, second tab) already toggled it on.
      var serverGrid = !!(j.grid && j.grid.enabled);
      if (serverGrid !== focusGridOn) {
        focusGridOn = serverGrid;
        if (grid) grid.textContent = focusGridOn ? 'Hide focus grid' : 'Show focus grid';
      }
      var aled = $('teleAgentLed'); if (aled){ aled.classList.remove('warn','bad','idle'); if (has) aled.classList.remove('idle'); else aled.classList.add('idle'); }
      setText('teleAgentVal', has ? 'FOCUSED' : 'IDLE');
      setText('teleAgentSub', has ? (j.region.width + '×' + j.region.height + ' locked') : 'no focus region');
    } catch (e) {}
  }

  // ────── MCP config ──────
  var mcpText = '';
  $('mcpShowConfig').addEventListener('click', async function(){
    setStatus('mcpStatus', 'Generating MCP config…', 'info');
    try {
      var j = await postJson('/api/install/claude-code', {});
      mcpText = JSON.stringify(j.snippet, null, 2);
      $('mcpSnippet').textContent = mcpText;
      if (Array.isArray(j.instructions)) {
        $('mcpSteps').innerHTML = j.instructions.map(function(s){ return '<li>' + escapeHtml(s) + '</li>'; }).join('');
      }
      setStatus('mcpStatus', 'MCP config ready.', 'ok');
    } catch (e) { setStatus('mcpStatus', 'Could not generate config: ' + e.message, 'err'); }
  });
  $('mcpCopyConfig').addEventListener('click', async function(){
    if (!mcpText) mcpText = $('mcpSnippet').textContent;
    try { await navigator.clipboard.writeText(mcpText); setStatus('mcpStatus','Copied.','ok'); }
    catch (e) {
      // navigator.clipboard.writeText rejects in headless contexts and any
      // browser tab without focus. Pre-select the snippet so ⌘C / Ctrl+C
      // grabs it without the user having to click into the <pre> manually.
      try {
        var pre = $('mcpSnippet');
        var range = document.createRange();
        range.selectNodeContents(pre);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        setStatus('mcpStatus','Snippet selected — press \u2318C / Ctrl+C to copy.','info');
      } catch (_e) {
        setStatus('mcpStatus','Select the snippet and copy manually.','err');
      }
    }
  });

  // ────── Daemon pane ──────
  async function onOpenBridge() {
    try { await postJson('/api/command', { action:'desktop:browse:show', params:{} }); setStatus('daemonStatus','Bridge window requested.','ok'); }
    catch (e) { setStatus('daemonStatus','Could not open: ' + e.message,'err'); }
  }
  $('daemonOpenBridge').addEventListener('click', onOpenBridge);
  $('ovOpenBridge').addEventListener('click', onOpenBridge);
  async function onReconnect() {
    setStatus('daemonStatus','Reconnecting daemon… tray will respawn it.','info');
    try { await fetch(API + '/api/shutdown', { method:'POST' }); setTimeout(refreshStatus, 2500); }
    catch (e) { setStatus('daemonStatus','Reconnect failed: ' + e.message,'err'); }
  }
  $('daemonReconnect').addEventListener('click', onReconnect);
  $('ovReconnect').addEventListener('click', onReconnect);
  $('daemonToggleLog').addEventListener('click', async function(){
    var pane = $('daemonLog');
    if (pane.style.display === 'none') {
      try {
        var j = await getJson('/api/log/tail?lines=200');
        var lines = (j.lines || []).filter(function(l){ return l && l.trim(); });
        pane.textContent = lines.length ? lines.join('\\n') : '(no log lines yet — ' + (j.path || 'bridge.log') + ')';
        pane.style.display = 'block';
        $('daemonToggleLog').textContent = 'Hide log';
      } catch (e) {
        pane.textContent = 'Could not load log: ' + e.message;
        pane.style.display = 'block';
        $('daemonToggleLog').textContent = 'Hide log';
      }
    } else {
      pane.style.display = 'none';
      $('daemonToggleLog').textContent = 'Show log';
    }
  });

  // ────── Identity (Device name + Home directory) ──────
  // Mirrors the old /settings page fields that didn't make it into the
  // welcome console rewrite. Both live in bridge-settings.json and feed
  // empir3-agent labelling + the project-sync scope.
  function hydrateIdentity() {
    if (!CLI_STATE || !CLI_STATE.bridge) return;
    var dn = $('deviceNameInput'); if (dn && !dn.matches(':focus')) dn.value = CLI_STATE.bridge.deviceName || '';
    var hd = $('homeDirInput'); if (hd && !hd.matches(':focus')) hd.value = CLI_STATE.bridge.homeDirectory || '';
    setText('identityTag', CLI_STATE.bridge.deviceName || 'unnamed');
  }
  var identitySave = $('identitySave');
  if (identitySave) {
    identitySave.addEventListener('click', async function(){
      var dn = ($('deviceNameInput').value || '').trim();
      var hd = ($('homeDirInput').value || '').trim();
      if (!dn && !hd) { setStatus('identityStatus','Nothing to save.','info'); return; }
      var patch = {};
      if (dn) patch.deviceName = dn;
      if (hd) patch.homeDirectory = hd;
      setStatus('identityStatus','Saving identity…','info');
      markLocalMutate();
      try {
        await postJson('/api/settings/state', { bridge: patch });
        setStatus('identityStatus','Saved.','ok');
        await loadCliState();
      } catch (e) {
        setStatus('identityStatus','Failed: ' + e.message,'err');
      }
    });
  }
  var identityReset = $('identityReset');
  if (identityReset) {
    identityReset.addEventListener('click', function(){
      if (CLI_STATE && CLI_STATE.bridge) {
        $('deviceNameInput').value = CLI_STATE.bridge.deviceName || '';
        $('homeDirInput').value = CLI_STATE.bridge.homeDirectory || '';
        setStatus('identityStatus','Reset to saved values.','info');
      }
    });
  }

  // ────── Desktop tools pane ──────
  function showDesktopOutput(label, value) {
    var out = $('dtCommandOutput');
    if (!out) return;
    out.style.display = 'block';
    var text = typeof value === 'string' ? value : JSON.stringify(value, function(k, v) {
      if (typeof v === 'string' && v.length > 1200) return v.slice(0, 1200) + '…';
      return v;
    }, 2);
    out.textContent = label + '\\n' + text;
  }
  async function runDesktopCommand(label, cmd, options) {
    options = options || {};
    setStatus('desktopToolsStatus', label + '…', 'info');
    try {
      var j = await postJson('/api/command', cmd);
      var result = j && (j.result || j);
      if (options.show !== false) showDesktopOutput(label, result);
      setStatus('desktopToolsStatus', options.done || (label + ' complete.'), 'ok');
      refreshStatus();
      refreshActions();
      return result;
    } catch (e) {
      setStatus('desktopToolsStatus', label + ' failed: ' + e.message, 'err');
      throw e;
    }
  }
  var DESKTOP_MONITORS = [];
  function setSetupItem(key, done, detail) {
    var item = $('setupItem' + key);
    if (item) {
      item.classList.toggle('done', !!done);
      item.classList.toggle('warn', !done);
    }
    var text = $('setup' + key + 'Text');
    if (text) text.textContent = detail;
  }
  async function refreshSetupStatus() {
    try {
      var j = await postJson('/api/command', { type:'bridge_setup_status' });
      var s = j && (j.result || j);
      var cur = (s && s.current) || {};
      var saved = (s && s.saved) || {};
      setSetupItem('Overlay', !!cur.overlay, cur.overlay ? 'Chat bubble/overlay is available.' : 'Overlay is not connected yet.');
      setSetupItem('Monitors', !!cur.monitors, (s.monitors && s.monitors.count ? (s.monitors.count + ' monitor(s): ' + (s.monitors.ids || []).join(', ')) : 'No monitors detected yet.'));
      setSetupItem('Calibration', !!cur.calibration, cur.calibration ? 'Saved click calibration found.' : 'Run calibration before first agent use.');
      setSetupItem('Recordings', !!cur.recordings, 'Record/playback endpoints are available.');
      var tag = $('setupTag');
      if (tag) {
        tag.className = 'tag ' + (saved.completed ? 'good' : (s.completeNow ? 'warn' : 'bad'));
        tag.textContent = saved.completed ? 'SAVED' : (s.completeNow ? 'READY TO SAVE' : 'CHECK REQUIRED');
      }
      setStatus('setupStatus', saved.completed ? ('Saved ' + (saved.completedAt || '').slice(0, 16).replace('T',' ')) : 'Complete the checks, then save setup.', saved.completed ? 'ok' : 'info');
      return s;
    } catch (e) {
      setStatus('setupStatus', 'Setup status failed: ' + e.message, 'err');
      return null;
    }
  }
  async function refreshMonitors(showStatus) {
    try {
      if (showStatus) setStatus('calStatus', 'Detecting monitors...', 'info');
      var j = await postJson('/api/command', { type:'desktop_monitors' });
      var result = j && (j.result || j);
      DESKTOP_MONITORS = Array.isArray(result.monitors) ? result.monitors : [];
      var sel = $('agtCalMonitor');
      if (sel) {
        var current = sel.value || 'primary';
        sel.innerHTML = '<option value="primary">Primary monitor</option><option value="all">All monitors</option>';
        DESKTOP_MONITORS.forEach(function(m){
          var b = m.bounds || {};
          var opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.id + (m.primary ? ' (primary)' : '') + ' - ' + (b.width || '?') + 'x' + (b.height || '?') + ' @ ' + (b.x || 0) + ',' + (b.y || 0);
          sel.appendChild(opt);
        });
        if ([].slice.call(sel.options).some(function(o){ return o.value === current; })) sel.value = current;
      }
      setText('calMonitorSummary', DESKTOP_MONITORS.length ? DESKTOP_MONITORS.map(function(m){ return m.id + (m.primary ? '*' : ''); }).join(', ') : '-');
      if (showStatus) setStatus('calStatus', DESKTOP_MONITORS.length + ' monitor(s) detected.', 'ok');
      refreshSetupStatus();
      return DESKTOP_MONITORS;
    } catch (e) {
      if (showStatus) setStatus('calStatus', 'Monitor detection failed: ' + e.message, 'err');
      return [];
    }
  }
  async function refreshRecordingStatus() {
    try {
      var s = await getJson('/api/recording-status');
      setText('recState', s.recording ? 'Recording' : 'Idle');
      setText('recActionCount', s.actionCount || 0);
      setText('recPlayState', s.playing ? 'Playing' : 'Ready');
      var tag = $('recordingTag');
      if (tag) { tag.textContent = s.recording ? 'RECORDING' : (s.playing ? 'PLAYING' : 'IDLE'); tag.className = 'tag ' + (s.recording ? 'bad' : (s.playing ? 'warn' : '')); }
    } catch (_) {}
  }
  async function refreshRecordings(showStatus) {
    try {
      var rows = await getJson('/api/recordings');
      var sel = $('recSelect');
      if (sel) {
        var current = sel.value;
        sel.innerHTML = '';
        if (!rows.length) {
          var empty = document.createElement('option'); empty.value = ''; empty.textContent = 'No recordings saved'; sel.appendChild(empty);
        } else {
          rows.forEach(function(r){
            var opt = document.createElement('option');
            opt.value = r.name;
            opt.textContent = r.name + ' - ' + (r.actionCount || 0) + ' action(s)';
            sel.appendChild(opt);
          });
          if ([].slice.call(sel.options).some(function(o){ return o.value === current; })) sel.value = current;
        }
      }
      setText('recSavedCount', rows.length || 0);
      if (showStatus) setStatus('recStatus', rows.length + ' recording(s) loaded.', 'ok');
      refreshSetupStatus();
      return rows;
    } catch (e) {
      if (showStatus) setStatus('recStatus', 'Could not load recordings: ' + e.message, 'err');
      return [];
    }
  }
  async function loadSelectedRecording() {
    var sel = $('recSelect');
    var name = sel && sel.value;
    if (!name) { setStatus('recStatus', 'Select a recording first.', 'err'); return; }
    try {
      var rec = await getJson('/api/recordings/' + encodeURIComponent(name));
      var preview = {
        name: rec.name,
        startUrl: rec.startUrl,
        recorded: rec.recorded,
        actionCount: Array.isArray(rec.actions) ? rec.actions.length : 0,
        variables: rec.variables || [],
        actions: (rec.actions || []).slice(0, 12),
      };
      var out = $('recPreview');
      if (out) { out.style.display = 'block'; out.textContent = JSON.stringify(preview, null, 2); }
      setStatus('recStatus', 'Recording loaded.', 'ok');
    } catch (e) {
      setStatus('recStatus', 'Load failed: ' + e.message, 'err');
    }
  }
  $('setupInjectOverlay').addEventListener('click', async function(){
    setStatus('setupStatus', 'Injecting overlay chat...', 'info');
    try {
      await postJson('/api/command', { type:'bridge_overlay_reinject', reason:'setup' });
      setStatus('setupStatus', 'Overlay chat injected.', 'ok');
      refreshStatus(); refreshSetupStatus();
    } catch (e) { setStatus('setupStatus', 'Overlay injection failed: ' + e.message, 'err'); }
  });
  $('setupDetectMonitors').addEventListener('click', function(){ refreshMonitors(true); });
  $('setupCalibratePrimary').addEventListener('click', async function(){
    setStatus('setupStatus', 'Calibration started on primary monitor.', 'info');
    try {
      await postJson('/api/command', { type:'desktop_calibrate_pointer', monitor:'primary', area:'monitor' });
      setStatus('setupStatus', 'Primary monitor calibration saved.', 'ok');
      refreshCalibration(); refreshSetupStatus();
    } catch (e) { setStatus('setupStatus', 'Calibration failed: ' + e.message, 'err'); }
  });
  $('setupSaveComplete').addEventListener('click', async function(){
    setStatus('setupStatus', 'Saving setup...', 'info');
    try {
      var s = await postJson('/api/command', { type:'bridge_setup_status' });
      var status = s && (s.result || s);
      await postJson('/api/settings/state', { bridge: { desktopSetup: { completed:true, checklist:(status && status.current) || {}, snapshot:status || {} } } });
      setStatus('setupStatus', 'Setup saved for MCP and empir3 agents.', 'ok');
      refreshSetupStatus();
    } catch (e) { setStatus('setupStatus', 'Save failed: ' + e.message, 'err'); }
  });
  $('dtOpenDesktopTest').addEventListener('click', function(){
    runDesktopCommand('Opening desktop test', { type:'navigate', url: location.origin + '/desktop-test' }, { show:false, done:'Desktop test opened.' });
  });
  $('dtOpenAccuracyLab').addEventListener('click', function(){
    window.open(location.origin + '/accuracy-lab', '_blank');
    setStatus('desktopToolsStatus', 'Accuracy Lab opened in a new tab.', 'ok');
  });
  $('dtBrowserScreenshot').addEventListener('click', function(){
    runDesktopCommand('Browser screenshot', { type:'screenshot' });
  });
  $('dtBrowserRefresh').addEventListener('click', function(){
    runDesktopCommand('Browser refresh', { type:'refresh' }, { show:false, done:'Refresh sent.' });
  });
  $('dtBrowserSnapshot').addEventListener('click', function(){
    runDesktopCommand('Interactive snapshot', { type:'snapshot', filter:'interactive', format:'compact' });
  });
  $('dtInjectOverlay').addEventListener('click', async function(){
    try { await runDesktopCommand('Inject overlay', { type:'bridge_overlay_reinject', reason:'desktop-tools' }, { done:'Overlay injected and verified.' }); refreshSetupStatus(); }
    catch (_) {}
  });
  $('dtOpenToolbar').addEventListener('click', async function(){
    try { await runDesktopCommand('Open floating toolbar', { type:'desktop_toolbar', action:'show' }, { show:false, done:'Floating toolbar opened.' }); }
    catch (_) {}
  });
  $('dtRevokeControl').addEventListener('click', async function(){
    if (!confirm('Disable browser interact, desktop, eval, and recording tools?')) return;
    setStatus('desktopToolsStatus','Revoking write control…','info');
    try {
      var r = await fetch(API + '/api/safety/lockdown', { method:'POST' });
      if (!r.ok) throw new Error(await r.text());
      await loadPermissionState();
      await refreshStatus();
      setStatus('desktopToolsStatus','Write control revoked.','ok');
    } catch (e) {
      setStatus('desktopToolsStatus','Revoke failed: ' + e.message,'err');
    }
  });

  $('recStart').addEventListener('click', async function(){
    setStatus('recStatus', 'Starting recording...', 'info');
    try {
      var j = await postJson('/api/command', { type:'record_start' });
      showDesktopOutput('Recording start', j && (j.result || j));
      setStatus('recStatus', 'Recording started.', 'ok');
      refreshRecordingStatus(); refreshSetupStatus();
    } catch (e) { setStatus('recStatus', 'Start failed: ' + e.message, 'err'); }
  });
  $('recStop').addEventListener('click', async function(){
    var name = ($('recName').value || '').trim() || ('recording-' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-'));
    setStatus('recStatus', 'Stopping recording...', 'info');
    try {
      var j = await postJson('/api/command', { type:'record_stop', text:name });
      var result = j && (j.result || j);
      showDesktopOutput('Recording stop', result);
      setStatus('recStatus', 'Saved ' + (result.saved || name) + '.', 'ok');
      $('recName').value = '';
      refreshRecordingStatus(); refreshRecordings(); refreshSetupStatus();
    } catch (e) { setStatus('recStatus', 'Stop failed: ' + e.message, 'err'); }
  });
  $('recRefresh').addEventListener('click', function(){ refreshRecordings(true); });
  $('recLoad').addEventListener('click', loadSelectedRecording);
  $('recPlay').addEventListener('click', async function(){
    var sel = $('recSelect');
    var name = sel && sel.value;
    if (!name) { setStatus('recStatus', 'Select a recording first.', 'err'); return; }
    setStatus('recStatus', 'Playing recording...', 'info');
    try {
      var j = await postJson('/api/command', { type:'play', recording:name, speed:1, variables:{} });
      var result = j && (j.result || j);
      var out = $('recPreview');
      if (out) { out.style.display = 'block'; out.textContent = JSON.stringify(result, null, 2); }
      setStatus('recStatus', 'Playback complete.', 'ok');
      refreshRecordingStatus();
    } catch (e) { setStatus('recStatus', 'Playback failed: ' + e.message, 'err'); refreshRecordingStatus(); }
  });

  $('agtSelectRegion').addEventListener('click', async function(){
    setStatus('agentStatus','Drag a region on screen — bridge waits up to 2 minutes.','info');
    try {
      var j = await postJson('/api/command', { type:'desktop_select_region', timeoutMs:120000 });
      var region = j && j.result && j.result.region;
      if (region) setStatus('agentStatus','Region set: ' + region.width + '×' + region.height + ' at (' + region.x + ',' + region.y + ').','ok');
      else if (j && j.result && j.result.cancelled) setStatus('agentStatus','Region selection cancelled.','info');
      else setStatus('agentStatus','Region selection finished.','ok');
      refreshFocus(); refreshSetupStatus();
    } catch (e) { setStatus('agentStatus','Select region failed: ' + e.message,'err'); }
  });
  $('agtReleaseFocus').addEventListener('click', async function(){
    setStatus('agentStatus','Releasing focus…','info');
    try { await postJson('/api/command', { type:'desktop_release_focus' }); setStatus('agentStatus','Agent focus and screen artifacts released.','ok'); refreshFocus(); refreshSetupStatus(); }
    catch (e) { setStatus('agentStatus','Release failed: ' + e.message,'err'); }
  });
  var focusGridOn = false;
  $('agtFocusGrid').addEventListener('click', async function(){
    try {
      var want = !focusGridOn;
      var j = await postJson('/api/command', { type:'desktop_focus_grid', action: want ? 'show' : 'hide' });
      focusGridOn = !!(j && j.result && j.result.enabled);
      $('agtFocusGrid').textContent = focusGridOn ? 'Hide focus grid' : 'Show focus grid';
      setStatus('agentStatus','Focus grid ' + (focusGridOn ? 'visible.' : 'hidden.'),'ok');
    } catch (e) { setStatus('agentStatus','Focus grid toggle failed: ' + e.message,'err'); }
  });
  $('agtDetectMonitors').addEventListener('click', function(){ refreshMonitors(true); });
  $('agtCalibrate').addEventListener('click', async function(){
    var sel = $('agtCalMonitor');
    var mon = (sel && sel.value) || 'primary';
    var area = mon === 'all' ? 'all' : 'monitor';
    setStatus('calStatus','Calibration started for ' + mon + '.','info');
    try {
      var j = await postJson('/api/command', { type:'desktop_calibrate_pointer', monitor:mon, area:area });
      if (j && j.result && j.result.cancelled) { setStatus('calStatus','Calibration cancelled.','info'); return; }
      setStatus('calStatus','Calibration saved.','ok');
      refreshCalibration(); refreshSetupStatus();
    } catch (e) { setStatus('calStatus','Calibration failed: ' + e.message,'err'); }
  });
  $('agtCalibrateAll').addEventListener('click', async function(){
    setStatus('calStatus','Calibration started for all monitors.','info');
    try {
      await postJson('/api/command', { type:'desktop_calibrate_pointer', monitor:'all', area:'all' });
      setStatus('calStatus','All monitor calibration saved.','ok');
      refreshCalibration(); refreshSetupStatus();
    } catch (e) { setStatus('calStatus','Calibration failed: ' + e.message,'err'); }
  });

  // ────── Updates pane ──────
  $('updateCheck').addEventListener('click', async function(){
    setStatus('updateStatus','Checking for updates…','info');
    try {
      var j = await getJson('/api/updates/check');
      var local = j.local || '${BRIDGE_VERSION}';
      var remote = j.remote || '(unknown)';
      setText('updateAvailable', remote);
      setText('updateLastCheck', new Date().toLocaleTimeString());
      var tag = $('updateTag'); if (tag){ tag.textContent = j.newer ? 'UPDATE AVAILABLE' : 'CURRENT'; tag.className = 'tag ' + (j.newer ? 'warn' : 'good'); }
      if (j.newer) { $('updateApply').style.display = 'inline-flex'; setStatus('updateStatus','Update available: v' + remote + ' (you are on v' + local + ').','ok'); }
      else { $('updateApply').style.display = 'none'; setStatus('updateStatus','You are on the latest version.','ok'); }
    } catch (e) { setStatus('updateStatus','Update check failed: ' + e.message,'err'); }
  });
  $('updateApply').addEventListener('click', async function(){
    if (!confirm('Apply update? The tray and bridge daemon will restart.')) return;
    setStatus('updateStatus','Queuing update…','info');
    try { await postJson('/api/tray/enqueue', { type:'tray_apply_update' }); setStatus('updateStatus','Update queued — tray will restart shortly.','ok'); }
    catch (e) { setStatus('updateStatus','Could not queue update: ' + e.message,'err'); }
  });
  $('autoUpdateToggle').addEventListener('change', async function(e){
    setStatus('policyStatus','Saving…','info');
    try { var r = await postJson('/api/settings/state', { bridge: { autoUpdate: !!e.target.checked } }); setStatus('policyStatus','Auto-update ' + ((r && r.bridge && r.bridge.autoUpdate !== false) ? 'on' : 'off') + '.','ok'); }
    catch (e2) { setStatus('policyStatus','Could not save: ' + e2.message,'err'); }
  });

  // ────── Lifecycle pane ──────
  async function enqueueTray(type, confirmMsg) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setStatus('lifeStatus','Queuing ' + type + '…','info');
    try { await postJson('/api/tray/enqueue', { type: type }); setStatus('lifeStatus',type + ' queued.','ok'); }
    catch (e) { setStatus('lifeStatus','Failed: ' + e.message,'err'); }
  }
  $('lifeRestart').addEventListener('click', function(){ enqueueTray('tray_restart_tray','Restart the Empir3 tray? The bridge daemon will restart with it.'); });
  $('lifeQuit').addEventListener('click',    function(){ enqueueTray('tray_quit','Quit Empir3? The tray icon will disappear and the bridge daemon will stop.'); });
  $('lifeUninstall').addEventListener('click', function(){ enqueueTray('tray_uninstall','Uninstall Empir3?\\n\\nThis wipes the bridge Chrome profile, auth, settings, autostart entry, Start Menu shortcut, and cached payloads. Irreversible.'); });

  // ────── Account / sign-in drawer ──────
  function syncServerUi(serverUrl) {
    var norm = (serverUrl || PROD_SERVER).replace(/\\/+$/,'');
    if (norm === PROD_SERVER) $('serverPreset').value = 'production';
    else if (norm === DEV_SERVER) $('serverPreset').value = 'local-dev';
    else $('serverPreset').value = 'custom';
    if ($('serverUrl')) $('serverUrl').value = norm;
    $('customServerLabel').style.display = $('serverPreset').value === 'custom' ? 'grid' : 'none';
  }
  function selectedServer() {
    var p = $('serverPreset').value;
    if (p === 'production') return PROD_SERVER;
    if (p === 'local-dev') return DEV_SERVER;
    return ($('serverUrl').value || PROD_SERVER).trim();
  }
  $('serverPreset').addEventListener('change', function(){
    var p = $('serverPreset').value;
    if (p === 'production') $('serverUrl').value = PROD_SERVER;
    else if (p === 'local-dev') $('serverUrl').value = DEV_SERVER;
    $('customServerLabel').style.display = p === 'custom' ? 'grid' : 'none';
  });
  $('pairEmpir3').addEventListener('click', async function(){
    setStatus('drawerStatus','Starting browser-based empir3 pairing…','info');
    try {
      var j = await postJson('/api/install/empir3-pair', { serverUrl: selectedServer() });
      if (!j.ok || !j.redirectUrl) throw new Error(j.error || 'pairing failed');
      setStatus('drawerStatus','Opening empir3…','ok');
      setTimeout(function(){ location.href = j.redirectUrl; }, 400);
    } catch (e) { setStatus('drawerStatus','Could not start pairing: ' + e.message,'err'); }
  });
  $('loginForm').addEventListener('submit', async function(e){
    e.preventDefault();
    setStatus('drawerStatus','Signing in…','info');
    try {
      var j = await postJson('/api/install/empir3-login', { email: $('loginEmail').value, password: $('loginPassword').value, serverUrl: selectedServer() });
      if (!j.ok) throw new Error(j.error || 'login failed');
      setStatus('drawerStatus','Signed in. Reloading…','ok');
      setTimeout(function(){ location.reload(); }, 700);
    } catch (e2) { setStatus('drawerStatus','Could not sign in: ' + e2.message,'err'); }
  });
  $('acctSignOut').addEventListener('click', async function(){
    if (!confirm('Sign out the stored empir3 account from this bridge?')) return;
    setStatus('acctStatus','Signing out…','info');
    try { var j = await postJson('/api/install/sign-out', {}); if (!j.ok) throw new Error(j.error||'sign out failed'); setStatus('acctStatus','Signed out. Reloading…','ok'); setTimeout(function(){ location.reload(); }, 600); }
    catch (e) { setStatus('acctStatus','Could not sign out: ' + e.message,'err'); }
  });

  // ────── Drawer + nav + theme ──────
  var drawer = $('drawer'), backdrop = $('backdrop');
  window.openDrawer = function(){ drawer.classList.add('open'); backdrop.classList.add('open'); };
  window.closeDrawer = function(){ drawer.classList.remove('open'); backdrop.classList.remove('open'); };
  $('openSignIn').addEventListener('click', openDrawer);
  $('openAccount').addEventListener('click', function(){ goto('account'); });
  backdrop.addEventListener('click', closeDrawer);

  var PANE_LABELS = { overview:'Overview', permissions:'Permissions', mcp:'MCP Connection', clis:'API & CLIs', agent:'Desktop Tools', account:'empir3 Account', daemon:'Daemon', updates:'Updates', logs:'Activity Log', lifecycle:'Tray Lifecycle' };
  function closeRail() { document.body.classList.remove('rail-open'); }
  function goto(name) {
    document.querySelectorAll('.rail-nav a').forEach(function(a){ a.classList.toggle('active', a.dataset.nav === name); });
    document.querySelectorAll('.pane').forEach(function(p){ p.classList.toggle('active', p.dataset.pane === name); });
    setText('crumbHere', PANE_LABELS[name] || name);
    document.querySelector('.pane-scroll').scrollTop = 0;
    if (name === 'logs') refreshActions();
    closeRail();
  }
  document.querySelectorAll('[data-nav]').forEach(function(a){ a.addEventListener('click', function(e){ e.preventDefault(); goto(a.dataset.nav); }); });
  document.querySelectorAll('[data-goto]').forEach(function(b){ b.addEventListener('click', function(e){ e.preventDefault(); goto(b.dataset.goto); }); });
  var railToggleBtn = $('railToggle');
  if (railToggleBtn) railToggleBtn.addEventListener('click', function(){ document.body.classList.toggle('rail-open'); });
  var railScrim = $('railScrim');
  if (railScrim) railScrim.addEventListener('click', closeRail);
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && document.body.classList.contains('rail-open')) closeRail(); });

  // Theme persistence
  try { var th = localStorage.getItem('empir3-bridge-theme'); if (th === 'dark' || th === 'light') document.body.dataset.theme = th; } catch (_) {}
  $('themeToggle').addEventListener('click', function(){
    var next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = next;
    try { localStorage.setItem('empir3-bridge-theme', next); } catch (_) {}
  });

  // Logs refresh button
  $('logsRefresh').addEventListener('click', refreshActions);

  // ────── Calibration initial load (real fetch on boot) ──────
  async function refreshCalibration() {
    try {
      var j = await postJson('/api/command', { type: 'desktop_calibration_status' });
      var result = j && (j.result || j);
      var cal = result && result.calibration;
      var monitorIds = (result && result.monitors) || (cal && cal.monitors ? Object.keys(cal.monitors) : []);
      var hasCal = !!(result && result.applied);
      var tag = $('calibrationTag');
      if (hasCal) {
        if (cal && cal.version === 2 && cal.monitors) {
          var rows = Object.keys(cal.monitors).map(function(id){ var m = cal.monitors[id] || {}; return id + (m.residualPx != null ? ' (' + m.residualPx + 'px)' : ''); });
          setText('calOffsetX', 'per-monitor');
          setText('calOffsetY', 'affine fit');
          setText('calMonitorSummary', rows.join(', '));
          if (cal.capturedAt) setText('calLastRun', String(cal.capturedAt).slice(0,16).replace('T',' '));
        } else {
          var dx = cal && (cal.offsetX|0), dy = cal && (cal.offsetY|0);
          setText('calOffsetX', (dx>=0?'+':'') + dx + ' px');
          setText('calOffsetY', (dy>=0?'+':'') + dy + ' px');
          setText('calMonitorSummary', monitorIds.length ? monitorIds.join(', ') : 'legacy');
          if (cal && cal.updatedAt) setText('calLastRun', String(cal.updatedAt).slice(0,16).replace('T',' '));
        }
        if (tag) { tag.textContent = 'CALIBRATED'; tag.className = 'tag good'; }
      } else {
        setText('calOffsetX', '—'); setText('calOffsetY', '—'); setText('calLastRun', '—');
        if (!DESKTOP_MONITORS.length) setText('calMonitorSummary', '—');
        if (tag) { tag.textContent = 'UNCALIBRATED'; tag.className = 'tag'; }
      }
      refreshSetupStatus();
    } catch (_) { /* read-only call; ignore if denied */ }
  }

  // ────── API & CLIs pane ──────
  // The row schema is single-source-of-truth — adding a provider here +
  // its probe in buildSettingsState() is the whole front-end change.
  // The 'lendable' flag controls whether the row gets a "Lend to empir3"
  // toggle vs the higgsfield handler-family toggle.
  var CLI_ROWS = [
    { id:'claude',     label:'Claude Code',      vendor:'Anthropic', lendable:true, settingsKey:'lendClaudeMax',     keyField:'apiKeyAnthropic', keyVendor:'anthropic' },
    { id:'codex',      label:'OpenAI Codex',     vendor:'OpenAI',    lendable:true, settingsKey:'lendOpenAiCodex',   keyField:'apiKeyOpenai',    keyVendor:'openai' },
    { id:'grok',       label:'Grok Build CLI',   vendor:'xAI',       lendable:true, settingsKey:'lendXaiGrok',       keyField:'apiKeyXai',       keyVendor:'xai' },
    { id:'agy',        label:'Antigravity',      vendor:'Google',    lendable:true, settingsKey:'lendGoogleAntigravity' },
    { id:'higgsfield', label:'Higgsfield CLI',   vendor:'Higgsfield',lendable:false, handlerKey:'higgsfield' },
    { id:'github',     label:'GitHub CLI',       vendor:'GitHub',    lendable:true, settingsKey:'lendGitHubCli', ghScopes:true },
  ];
  // GitHub CLI lend scopes — fine-grained per-capability gates shown under
  // the GitHub row when the master lend is on. Mirrors the backend
  // defaultGhScopes() baseline. label/hint are UI-only.
  var GH_SCOPE_DEFS = [
    { key:'read',      label:'Read',      hint:'list / view / status / search / api GET' },
    { key:'pr',        label:'Pull requests', hint:'create / edit / merge / review / comment' },
    { key:'issue',     label:'Issues',    hint:'create / edit / close / comment' },
    { key:'repo',      label:'Repos',     hint:'create / edit / fork / rename (not delete)' },
    { key:'release',   label:'Releases',  hint:'create / edit / upload / download' },
    { key:'workflow',  label:'Workflows', hint:'run / cancel / rerun — spends CI' },
    { key:'admin',     label:'Admin',     hint:'secrets, repo delete, org, SSH/GPG keys' },
    { key:'api_write', label:'Raw API write', hint:'gh api with POST / PATCH / DELETE' },
  ];
  var CLI_STATE = null; // last full settings-state response

  function renderCliRows() {
    var tbody = $('cliRows'); if (!tbody) return;
    if (!CLI_STATE) { tbody.innerHTML = '<tr><td colspan="5" class="dt" style="text-align:center; color:var(--soft);">Loading…</td></tr>'; return; }
    var providers = (CLI_STATE.providers || {});
    var bridge = (CLI_STATE.bridge || {});
    var handlers = bridge.handlers || {};
    var installedCount = 0;
    var html = '';
    for (var i = 0; i < CLI_ROWS.length; i++) {
      var row = CLI_ROWS[i];
      var p = providers[row.id] || {};
      var installed = !!p.available;
      if (installed) installedCount++;
      var authed = !!p.authenticated;
      var installTag = installed
        ? '<span class="tag good">' + escapeHtml(p.version || 'installed') + '</span>'
        : '<span class="tag bad">NOT INSTALLED</span>';
      var authTag = installed
        ? (authed
          ? '<span class="tag good">AUTHED' + (p.auth_via && p.auth_via !== 'creds_file' && p.auth_via !== 'auth_file' ? ' · ' + escapeHtml(String(p.auth_via).toUpperCase()) : '') + '</span>'
          : '<span class="tag warn">NEEDS AUTH</span>')
        : '<span class="tag" style="color:var(--soft);">—</span>';
      var toggleCell;
      if (row.lendable) {
        var checked = !!bridge[row.settingsKey];
        toggleCell = '<label class="sw"><input type="checkbox" data-cli-toggle="' + row.id + '" data-settings-key="' + row.settingsKey + '"' + (checked?' checked':'') + (installed?'':' disabled') + '><span class="s"></span></label> <span style="font-size:11.5px; color:var(--soft); margin-left:6px;">' + (installed ? (checked ? 'lending' : 'not lent') : 'install first') + '</span>';
      } else if (row.handlerKey) {
        var hEnabled = !!(handlers[row.handlerKey] && handlers[row.handlerKey].enabled);
        // Count per-tool toggles for this family on the Permissions page —
        // gives users a "3 / 3 tools on" readout so they can see the family
        // gate and per-tool layers stay in sync.
        var familyTools = (typeof TOOLS !== 'undefined' && TOOLS) ? TOOLS.filter(function(t){ return t.g === row.handlerKey; }) : [];
        var familyOn = familyTools.filter(function(t){ return t.on; }).length;
        var summary;
        if (!hEnabled) {
          summary = 'tools disabled <span style="opacity:0.7;">(' + familyOn + '/' + familyTools.length + ' configured)</span>';
        } else {
          summary = familyOn + ' / ' + familyTools.length + ' tools · <a href="#" data-goto="permissions" data-perm-filter="' + row.handlerKey + '" style="color:var(--accent); text-decoration:underline;">configure</a>';
        }
        toggleCell = '<label class="sw"><input type="checkbox" data-cli-toggle="' + row.id + '" data-handler-key="' + row.handlerKey + '"' + (hEnabled?' checked':'') + '><span class="s"></span></label> <span style="font-size:11.5px; color:var(--soft); margin-left:6px;">' + summary + '</span>';
      } else {
        toggleCell = '<span style="color:var(--soft);">—</span>';
      }
      var authBtn = installed
        ? '<button class="btn small" type="button" data-cli-auth="' + row.id + '">' + (authed ? 'Re-auth' : 'Authenticate') + '</button>'
        : (p.install
          ? '<button class="btn small" type="button" data-cli-install="' + row.id + '">Install</button>'
          : '<span style="font-size:11.5px; color:var(--soft);">install first</span>');
      html += '<tr>' +
        '<td class="col-nm"><div style="font-weight:600;">' + escapeHtml(row.label) + '</div><div style="font-size:11.5px; color:var(--soft);">' + escapeHtml(row.vendor) + (p.path ? ' · ' + escapeHtml(shortPath(p.path)) : '') + '</div></td>' +
        '<td>' + installTag + '</td>' +
        '<td>' + authTag + '</td>' +
        '<td>' + toggleCell + '</td>' +
        '<td>' + authBtn + '</td>' +
        '</tr>';
      // NOT INSTALLED: full-width helper row with the install command (copy),
      // a Get-it link to the official page, and any caveat note. The "Install"
      // button in the Action column runs the same command in a console.
      if (!installed && p.install) {
        html += '<tr class="cli-install-row"><td colspan="5" style="padding:2px 14px 14px 14px;">' +
          '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">' +
            '<span style="font-size:11.5px; color:var(--soft);">Get it:</span>' +
            '<code style="font-size:12px; background:var(--card2,rgba(255,255,255,0.04)); border:1px solid var(--line); border-radius:6px; padding:4px 8px; user-select:all;">' + escapeHtml(p.install.command) + '</code>' +
            '<button class="btn small ghost" type="button" data-install-copy="' + escapeAttr(p.install.command) + '">Copy</button>' +
            '<a href="' + escapeAttr(p.install.docsUrl) + '" target="_blank" rel="noopener noreferrer" style="font-size:12px; color:var(--accent); text-decoration:underline;">Official page ↗</a>' +
            '<span style="font-size:11px; color:var(--soft);">or just tell your agent to install it</span>' +
          '</div>' +
          (p.install.note ? '<div style="font-size:11px; color:var(--soft); margin-top:6px;">' + escapeHtml(p.install.note) + '</div>' : '') +
        '</td></tr>';
      }
      // GitHub CLI: when the master lend is on, render the fine-grained
      // scope matrix as a full-width sub-row directly beneath it.
      if (row.ghScopes && !!bridge.lendGitHubCli) {
        var sc = bridge.githubScopes || {};
        var acct = (p.account ? ' · acting as <b>' + escapeHtml(p.account) + '</b>' : '');
        var cells = '';
        for (var gi = 0; gi < GH_SCOPE_DEFS.length; gi++) {
          var sd = GH_SCOPE_DEFS[gi];
          var on = !!sc[sd.key];
          cells += '<label class="gh-scope" title="' + escapeAttr(sd.hint) + '" style="display:flex; align-items:flex-start; gap:7px; padding:7px 9px; border:1px solid var(--line); border-radius:8px; background:var(--card2,rgba(255,255,255,0.02));">' +
            '<input type="checkbox" data-gh-scope="' + sd.key + '"' + (on?' checked':'') + (installed?'':' disabled') + ' style="margin-top:2px;">' +
            '<span><span style="font-weight:600; font-size:12.5px;">' + escapeHtml(sd.label) + '</span><br><span style="font-size:11px; color:var(--soft);">' + escapeHtml(sd.hint) + '</span></span>' +
            '</label>';
        }
        html += '<tr class="gh-scope-row"><td colspan="5" style="padding:4px 14px 14px 14px;">' +
          '<div style="font-size:11.5px; color:var(--soft); margin:0 0 8px 2px;">Scopes a remote / team agent may use with your GitHub login' + acct + '. Token exfil, de-auth, aliases &amp; extensions are always blocked.</div>' +
          '<div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:8px;">' + cells + '</div>' +
          '</td></tr>';
      }
    }
    // Append custom OpenAI-compatible providers (dynamic — added by the
    // user via the "+ Add custom provider" modal). Renders as the same
    // row shape so the table stays consistent. Action column gets a
    // Remove button instead of Auth since custom providers don't have a
    // CLI auth flow — they hold their API key (if any) inside the
    // provider definition itself.
    var customs = (CLI_STATE.customProviders || []);
    for (var ci = 0; ci < customs.length; ci++) {
      var cp = customs[ci];
      var avail = !!cp.available;
      if (avail) installedCount++;
      var statusTag = avail
        ? (cp.authError
          ? '<span class="tag warn">AUTH ERROR</span>'
          : '<span class="tag good">ONLINE</span>')
        : '<span class="tag bad">OFFLINE</span>';
      var keyTag = cp.apiKeySet
        ? '<span class="tag good">KEY SET</span>'
        : (avail ? '<span class="tag" style="color:var(--soft);">NO KEY</span>' : '<span class="tag" style="color:var(--soft);">—</span>');
      var modelCount = (cp.models || []).length;
      var modelInfo = modelCount > 0 ? modelCount + ' model' + (modelCount === 1 ? '' : 's') : (avail ? '0 models' : '—');
      var lendCell = '<label class="sw"><input type="checkbox" data-custom-lend="' + escapeAttr(cp.slug) + '"' + (cp.lend?' checked':'') + (avail?'':' disabled') + '><span class="s"></span></label> <span style="font-size:11.5px; color:var(--soft); margin-left:6px;">' + (avail ? (cp.lend ? 'lending (v2)' : 'not lent') : 'offline') + '</span>';
      html += '<tr>' +
        '<td class="col-nm"><div style="font-weight:600;">' + escapeHtml(cp.name) + '</div><div style="font-size:11.5px; color:var(--soft);">custom · ' + escapeHtml(cp.slug) + ' · ' + escapeHtml(shortPath(cp.apiBaseUrl)) + '</div></td>' +
        '<td>' + statusTag + ' <span style="font-size:11.5px; color:var(--soft); margin-left:4px;">' + escapeHtml(modelInfo) + '</span></td>' +
        '<td>' + keyTag + '</td>' +
        '<td>' + lendCell + '</td>' +
        '<td><button class="btn small ghost" type="button" data-custom-remove="' + escapeAttr(cp.slug) + '">Remove</button></td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
    setText('cliInstalledTag', installedCount + ' / ' + (CLI_ROWS.length + customs.length));
    // API key indicators
    var keysSet = (CLI_STATE.chat && CLI_STATE.chat.apiKeysSet) || {};
    var setCount = ['anthropic','openai','google','xai'].filter(function(k){ return !!keysSet[k]; }).length;
    setText('apiKeysTag', setCount + ' / 4 set');
    // Wire toggle change handlers freshly each render
    document.querySelectorAll('[data-cli-toggle]').forEach(function(cb){
      cb.addEventListener('change', function(){ onCliToggleChange(cb); });
    });
    document.querySelectorAll('[data-gh-scope]').forEach(function(cb){
      cb.addEventListener('change', function(){ onGhScopeChange(cb); });
    });
    document.querySelectorAll('[data-cli-auth]').forEach(function(btn){
      btn.addEventListener('click', function(){ onCliAuthClick(btn.dataset.cliAuth); });
    });
    document.querySelectorAll('[data-cli-install]').forEach(function(btn){
      btn.addEventListener('click', function(){ onCliInstallClick(btn.dataset.cliInstall); });
    });
    document.querySelectorAll('[data-install-copy]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var cmd = btn.dataset.installCopy;
        try { await navigator.clipboard.writeText(cmd); setStatus('cliStatus', 'Copied: ' + cmd, 'ok'); }
        catch (e) { setStatus('cliStatus', 'Copy this command: ' + cmd, 'info'); }
      });
    });
    // Wire the "configure" link inside the cell summary — jump to
    // Permissions and pre-select the matching family filter button.
    document.querySelectorAll('#cliRows [data-perm-filter]').forEach(function(a){
      a.addEventListener('click', function(e){
        e.preventDefault();
        var f = a.dataset.permFilter;
        goto('permissions');
        var btn = document.querySelector('.perm-toolbar .filter-group [data-filter="' + f + '"]');
        if (btn) btn.click();
      });
    });
    // Custom provider: Remove button.
    document.querySelectorAll('#cliRows [data-custom-remove]').forEach(function(b){
      b.addEventListener('click', function(){
        var slug = b.dataset.customRemove;
        if (!confirm('Remove provider "' + slug + '"?')) return;
        removeCustomProvider(slug);
      });
    });
    // Custom provider: Lend toggle (v1 flips the local flag; empir3
    // server-side routing is v2 and ignores this for now).
    document.querySelectorAll('#cliRows [data-custom-lend]').forEach(function(cb){
      cb.addEventListener('change', function(){
        toggleCustomProviderLend(cb.dataset.customLend, cb.checked);
      });
    });
  }

  async function removeCustomProvider(slug) {
    setStatus('cliStatus', 'Removing ' + slug + '…', 'info');
    markLocalMutate();
    try {
      var r = await fetch(API + '/api/cli/providers/' + encodeURIComponent(slug), { method: 'DELETE' });
      var j = await r.json();
      if (!j.ok) throw new Error(j.error || 'remove failed');
      setStatus('cliStatus', slug + ' removed.', 'ok');
      await loadCliState();
    } catch (e) {
      setStatus('cliStatus', 'Remove failed: ' + e.message, 'err');
    }
  }

  async function toggleCustomProviderLend(slug, lend) {
    setStatus('cliStatus', 'Saving ' + slug + '…', 'info');
    markLocalMutate();
    try {
      var r = await fetch(API + '/api/cli/providers/' + encodeURIComponent(slug) + '/lend', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ lend: lend })
      });
      var j = await r.json();
      if (!j.ok) throw new Error(j.error || 'failed');
      setStatus('cliStatus', slug + ' ' + (lend ? 'lend on' : 'lend off') + ' (empir3 routing is v2 — not active yet)', 'ok');
      await loadCliState();
    } catch (e) {
      setStatus('cliStatus', 'Failed: ' + e.message, 'err');
    }
  }

  function shortPath(p) {
    if (!p) return '';
    var s = String(p);
    if (s.length <= 36) return s;
    return '…' + s.slice(-33);
  }

  async function onCliToggleChange(cb) {
    var id = cb.dataset.cliToggle;
    var want = cb.checked;
    setStatus('cliStatus', 'Saving ' + id + '…', 'info');
    markLocalMutate();
    try {
      var patch;
      if (cb.dataset.settingsKey) {
        patch = {}; patch[cb.dataset.settingsKey] = want;
        await postJson('/api/settings/state', { bridge: patch });
      } else if (cb.dataset.handlerKey) {
        var h = {}; h[cb.dataset.handlerKey] = { enabled: want };
        await postJson('/api/settings/state', { bridge: { handlers: h } });
      }
      setStatus('cliStatus', id + ' ' + (want ? 'enabled.' : 'disabled.'), 'ok');
      await loadCliState();
    } catch (e) {
      setStatus('cliStatus', 'Failed: ' + e.message, 'err');
      await loadCliState();
    }
  }

  async function onGhScopeChange(cb) {
    var scope = cb.dataset.ghScope;
    var want = cb.checked;
    setStatus('cliStatus', 'Saving GitHub ' + scope + ' scope…', 'info');
    markLocalMutate();
    try {
      var s = {}; s[scope] = want;
      await postJson('/api/settings/state', { bridge: { githubScopes: s } });
      setStatus('cliStatus', 'GitHub "' + scope + '" scope ' + (want ? 'enabled.' : 'disabled.'), 'ok');
      await loadCliState();
    } catch (e) {
      setStatus('cliStatus', 'Failed: ' + e.message, 'err');
      await loadCliState();
    }
  }

  async function onCliAuthClick(id) {
    setStatus('cliStatus', 'Launching ' + id + ' auth flow…', 'info');
    try {
      var j = await postJson('/api/cli/auth', { provider: id });
      if (j && j.launched) {
        setStatus('cliStatus', id + ' auth launched in a new window — finish in your browser, then click Refresh.', 'ok');
      } else if (j && j.error) {
        setStatus('cliStatus', 'Auth failed: ' + j.error, 'err');
      }
    } catch (e) {
      setStatus('cliStatus', 'Auth call failed: ' + e.message, 'err');
    }
  }

  async function onCliInstallClick(id) {
    setStatus('cliStatus', 'Launching ' + id + ' installer…', 'info');
    try {
      var j = await postJson('/api/cli/install', { provider: id });
      if (j && j.launched) {
        setStatus('cliStatus', id + ' installer opened in a new console — watch it finish, then click Re-scan.', 'ok');
      } else if (j && j.error) {
        setStatus('cliStatus', 'Install failed: ' + j.error, 'err');
      }
    } catch (e) {
      setStatus('cliStatus', 'Install call failed: ' + e.message, 'err');
    }
  }

  async function loadCliState() {
    try {
      var s = await getJson('/api/settings/state');
      CLI_STATE = s;
      renderCliRows();
      // Refresh permissions table too — the family-gate banner there is
      // driven by CLI_STATE.bridge.handlers, so a tray/CLI-page toggle
      // needs to re-render the per-tool group below it.
      if (typeof renderTable === 'function') renderTable();
      // Identity inputs on the Daemon pane mirror bridge-settings.json
      if (typeof hydrateIdentity === 'function') hydrateIdentity();
      // Hydrate API-key field placeholders to reflect "set" vs "empty".
      var keysSet = (s.chat && s.chat.apiKeysSet) || {};
      var k = $('apiKeyAnthropic'); if (k) k.placeholder = keysSet.anthropic ? '•••••• (saved — leave blank to keep)' : 'sk-ant-…';
      var k2 = $('apiKeyOpenai'); if (k2) k2.placeholder = keysSet.openai ? '•••••• (saved — leave blank to keep)' : 'sk-…';
      var k3 = $('apiKeyGoogle'); if (k3) k3.placeholder = keysSet.google ? '•••••• (saved — leave blank to keep)' : 'AIza…';
      var k4 = $('apiKeyXai'); if (k4) k4.placeholder = keysSet.xai ? '•••••• (saved — leave blank to keep)' : 'xai-…';
    } catch (e) {
      setStatus('cliStatus', 'Could not load CLI state: ' + e.message, 'err');
    }
  }

  var apiKeysSaveBtn = $('apiKeysSave');
  if (apiKeysSaveBtn) {
    apiKeysSaveBtn.addEventListener('click', async function(){
      var patch = { apiKeys: {} };
      var fields = [['apiKeyAnthropic','anthropic'],['apiKeyOpenai','openai'],['apiKeyGoogle','google'],['apiKeyXai','xai']];
      var any = false;
      for (var i = 0; i < fields.length; i++) {
        var el = $(fields[i][0]); if (!el) continue;
        var v = el.value.trim();
        if (v) { patch.apiKeys[fields[i][1]] = v; any = true; }
      }
      if (!any) { setStatus('apiKeysStatus', 'No new keys to save.', 'info'); return; }
      setStatus('apiKeysStatus', 'Saving keys…', 'info');
      markLocalMutate();
      try {
        await postJson('/api/settings/state', { chat: patch });
        // Clear the fields so a refresh doesn't reveal what was typed.
        fields.forEach(function(f){ var el = $(f[0]); if (el) el.value = ''; });
        setStatus('apiKeysStatus', 'Saved ' + Object.keys(patch.apiKeys).length + ' key(s).', 'ok');
        await loadCliState();
      } catch (e) {
        setStatus('apiKeysStatus', 'Failed: ' + e.message, 'err');
      }
    });
  }
  var apiKeysRevealBtn = $('apiKeysReveal');
  if (apiKeysRevealBtn) {
    apiKeysRevealBtn.addEventListener('click', function(){
      var fields = ['apiKeyAnthropic','apiKeyOpenai','apiKeyGoogle','apiKeyXai'];
      var anyPassword = fields.some(function(id){ var el = $(id); return el && el.type === 'password'; });
      fields.forEach(function(id){ var el = $(id); if (el) el.type = anyPassword ? 'text' : 'password'; });
    });
  }

  // ────── Custom provider modal ──────
  function openProviderModal() {
    var m = $('providerModal'); if (!m) return;
    m.style.display = 'flex';
    setStatus('providerModalStatus', '', 'info');
    setTimeout(function(){ $('providerModalJson').focus(); }, 50);
  }
  function closeProviderModal() {
    var m = $('providerModal'); if (m) m.style.display = 'none';
  }
  var rescanBtn = $('rescanClisBtn');
  if (rescanBtn) rescanBtn.addEventListener('click', async function(){
    setStatus('cliStatus', 'Re-scanning installed CLIs…', 'info');
    // Force a fresh probe (bypass the server-side CLI-probe cache), then render.
    try { await getJson('/api/settings/state?fresh=1'); } catch (e) {}
    await loadCliState();
    setStatus('cliStatus', 'Re-scan complete.', 'ok');
  });
  var addBtn = $('addCustomProviderBtn');
  if (addBtn) addBtn.addEventListener('click', openProviderModal);
  var closeBtn = $('providerModalClose');
  if (closeBtn) closeBtn.addEventListener('click', closeProviderModal);
  var cancelBtn = $('providerModalCancel');
  if (cancelBtn) cancelBtn.addEventListener('click', closeProviderModal);
  var exampleBtn = $('providerModalExample');
  if (exampleBtn) exampleBtn.addEventListener('click', function(){
    $('providerModalJson').value = JSON.stringify({
      slug: 'ollama-local',
      name: 'Ollama (local)',
      apiBaseUrl: 'http://localhost:11434/v1'
    }, null, 2);
  });
  var saveBtn = $('providerModalSave');
  if (saveBtn) saveBtn.addEventListener('click', async function(){
    var raw = ($('providerModalJson').value || '').trim();
    if (!raw) { setStatus('providerModalStatus','Paste a JSON definition first.','err'); return; }
    var parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { setStatus('providerModalStatus','Invalid JSON: ' + e.message,'err'); return; }
    setStatus('providerModalStatus','Saving + probing endpoint…','info');
    markLocalMutate();
    try {
      var r = await fetch(API + '/api/cli/providers', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(parsed)
      });
      var j = await r.json();
      if (!j.ok) throw new Error(j.error || ('http ' + r.status));
      var probed = j.provider || {};
      var msg = 'Added ' + (probed.name || parsed.name) + ' — ';
      if (probed.available) {
        msg += probed.authError ? 'reachable but auth error' : (probed.models?.length || 0) + ' models detected';
      } else {
        msg += 'not reachable (' + (probed.error || 'no response') + ')';
      }
      setStatus('providerModalStatus', msg, probed.available && !probed.authError ? 'ok' : 'err');
      await loadCliState();
      if (probed.available && !probed.authError) {
        setTimeout(closeProviderModal, 600);
      }
    } catch (e) {
      setStatus('providerModalStatus','Failed: ' + e.message,'err');
    }
  });

  // ────── Boot ──────
  syncServerUi(${JSON.stringify(EMPIR3_SERVER)});
  loadPermissionState();
  loadCliState();
  refreshStatus();
  refreshActions();
  refreshFocus();
  refreshCalibration();
  refreshMonitors(false);
  refreshRecordings(false);
  refreshRecordingStatus();
  refreshSetupStatus();
  setInterval(refreshStatus, 5000);
  setInterval(refreshActions, 8000);
  setInterval(refreshFocus, 6000);
  setInterval(refreshRecordingStatus, 3000);
  setInterval(loadCliState, 15000);
  setInterval(refreshSettingsIfQuiet, 10000);
</script>
</body>
</html>`;

}

/** Replace Empir3 Bridge welcome page with Empir3 branded splash */
async function injectEmpir3Splash() {
  try {
    await cdpPost('/evaluate', {
      expression: `(function() {
        document.title = 'empir3 Bridge';
        if (!document.getElementById('empir3-splash-font')) {
          var f = document.createElement('link');
          f.id = 'empir3-splash-font';
          f.rel = 'stylesheet';
          f.href = 'https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800;900&display=swap';
          document.head.appendChild(f);
        }
        document.body.style.cssText = 'margin:0;padding:0;background:#f5efe2;display:flex;align-items:center;justify-content:center;min-height:100vh;overflow:hidden;font-family:Outfit,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;color:#1c160a;';
        document.body.innerHTML = '<div style="text-align:center;animation:fadeIn 0.8s ease">' +
          '<div style="font-size:72px;font-weight:900;letter-spacing:-0.055em;line-height:.9;margin-bottom:8px;color:#1c160a">empir<span style="color:#6b4ef0">3</span></div>' +
          '<div style="font-size:13px;color:#8a8070;letter-spacing:.18em;text-transform:uppercase;font-weight:700;margin-bottom:40px">Browser Bridge</div>' +
          '<div style="display:flex;align-items:center;justify-content:center;gap:8px;color:#5a4f3d;font-size:13px">' +
            '<span style="width:8px;height:8px;background:#10b981;border-radius:50%;animation:blink 1.5s ease infinite"></span>' +
            'Ready for commands' +
          '</div>' +
          '<div style="margin-top:32px;display:flex;gap:16px;justify-content:center">' +
            '<div style="width:40px;height:3px;border-radius:2px;background:rgba(28,22,10,0.08);overflow:hidden"><div style="width:100%;height:100%;background:#1c160a;animation:shimmer 1.5s ease-in-out infinite"></div></div>' +
            '<div style="width:40px;height:3px;border-radius:2px;background:rgba(107,78,240,0.18);overflow:hidden"><div style="width:100%;height:100%;background:#6b4ef0;animation:shimmer 1.5s ease-in-out 0.3s infinite"></div></div>' +
            '<div style="width:40px;height:3px;border-radius:2px;background:rgba(28,22,10,0.08);overflow:hidden"><div style="width:100%;height:100%;background:#8a8070;animation:shimmer 1.5s ease-in-out 0.6s infinite"></div></div>' +
          '</div>' +
        '</div>';
        if (!document.getElementById('empir3-splash-style')) {
          var s = document.createElement('style');
          s.id = 'empir3-splash-style';
          s.textContent = '@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1}}@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.05) rotate(-2deg)}}@keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}@keyframes shimmer{0%{transform:translateX(-100%)}50%{transform:translateX(100%)}100%{transform:translateX(100%)}}';
          document.head.appendChild(s);
        }
      })()`,
    });
    console.log('[Bridge] Empir3 splash injected');
  } catch (e: any) {
    console.log(`[Bridge] Splash injection failed: ${e.message?.slice(0, 60)}`);
  }
}

/** Poll Empir3 Bridge for URL changes and re-inject overlay */
async function urlWatcher() {
  while (true) {
    await new Promise(r => setTimeout(r, 3000));
    const reachable = await checkBridgeHealth();
    if (!reachable || !cdpConnected) {
      continue;
    }
    try {
      const state = await browserTabState();
      const current = state.tabs.find((t: any) => t.bridgeCurrent) || state.tabs[0];
      const newUrl = current?.url || '';
      if (newUrl && newUrl !== lastKnownUrl) {
        lastKnownUrl = newUrl;
        currentUrl = newUrl;
        sessionCtx.currentUrl = newUrl;
        if (!sessionCtx.pages.includes(newUrl)) sessionCtx.pages.push(newUrl);
        saveSessionContext();
        try {
          if (current && agentControlTarget && sameTabTarget(current, agentControlTarget)) {
            agentControlTarget = { ...agentControlTarget, url: current.url, title: current.title, updatedAt: new Date().toISOString(), source: 'url_watcher' };
            await broadcastBrowserTabState();
          }
        } catch {}

        // Re-inject overlay if disconnected
        if (overlayClients.size === 0) {
          await injectOverlay();
        }
      }
    } catch {
      // Empir3 Bridge may be busy or disconnected
    }
  }
}

/** Optionally launch empir3-bridge as a child process */
async function launchBridge() {
  const binary = resolve(__dirname, '..', '..', 'desktop-client', 'bin', 'empir3-bridge');
  if (!existsSync(binary)) {
    console.log(`[Bridge] Empir3 Bridge binary not found at ${binary}`);
    console.log('[Bridge] Please start empir3-bridge manually or pass the correct path.');
    return false;
  }

  console.log(`[Bridge] Launching ${binary}...`);
  bridgeProcess = spawn(binary, [], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(EMPIR3_BRIDGE_PORT),
      BRIDGE_HEADLESS: 'false',
      BRIDGE_STEALTH: 'light',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  bridgeProcess.stdout?.on('data', (d) => {
    const line = d.toString().trim();
    if (line) console.log(`[Empir3 Bridge] ${line}`);
  });
  bridgeProcess.stderr?.on('data', (d) => {
    const line = d.toString().trim();
    if (line) console.log(`[Empir3 Bridge ERR] ${line}`);
  });
  bridgeProcess.on('exit', (code) => {
    console.log(`[Empir3 Bridge] Process exited with code ${code}`);
    bridgeReachable = false;
    cdpConnected = false;
    bridgeProcess = null;
  });

  // Wait for health
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await checkBridgeHealth()) return true;
  }
  console.log('[Bridge] Empir3 Bridge did not become healthy in 15s');
  return false;
}

// ─── Startup ─────────────────────────────────────────────────

async function main() {
  const shouldLaunch = process.argv.includes('--launch');

  startOverlayHealthLoop();

  httpServer.listen(PORT, HOST, () => {
    console.log(`\n╔══════════════════════════════════════════════════╗`);
    console.log(`║  Empir3 Browser Bridge (Empir3 Bridge Edition)         ║`);
    console.log(`║  Dashboard:  http://localhost:${PORT}                ║`);
    console.log(`║  Empir3 Bridge:   ${BRIDGE_URL}                  ║`);
    console.log(`║  CLI:        ws://localhost:${PORT}?role=cli         ║`);
    console.log(`╚══════════════════════════════════════════════════╝\n`);
  });

  if (shouldLaunch) {
    await launchBridge();
  } else {
    const ok = await checkBridgeHealth();
    if (ok) {
      console.log('[Bridge] Connected to existing Empir3 Bridge instance');
    } else {
      console.log('[Bridge] Empir3 Bridge not running — start it manually or use --launch');
      console.log(`[Bridge] Will keep polling ${BRIDGE_URL}/health...`);
    }
  }

  // Initial: leave the bridge-owned welcome page alone, then attach the
  // browser controls after the page has settled.
  if (cdpConnected) {
    const ensureOverlay = async () => {
      try { await injectOverlay(); } catch {}
    };
    await new Promise(r => setTimeout(r, 2000));
    await ensureOverlay();
    setTimeout(ensureOverlay, 2000);
    setTimeout(ensureOverlay, 4000);
    // Register the overlay as the auto-inject script for future tabs.
    setTimeout(() => injectOverlayAll().catch(() => {}), 3000);
    // Get initial URL
    try {
      await checkBridgeHealth();
      if (cdpConnected) {
        const r = await cdpPost('/evaluate', { expression: 'location.href' }, { wakeOnNotReady: false });
        currentUrl = r?.result || '';
        lastKnownUrl = currentUrl;
        sessionCtx.currentUrl = currentUrl;
      }
    } catch {}
  }

  // Start URL watcher (re-injects overlay on navigation)
  urlWatcher().catch(console.error);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Bridge] Shutting down...');
    saveSessionContext();
    if (bridgeProcess) {
      bridgeProcess.kill();
    }
    process.exit(0);
  });
}

// ─── Settings HTML (Wave 1.5 BYO-key/CLI + per-tool toggles) ──

function getSettingsHtml() {
  const signedIn = hasBridgeAuth();
  const settingsForRender = signedIn ? readBridgeSettings() : null;
  const empir3Perms = (settingsForRender?.empir3Permissions || { read: true, write: false, execute: false }) as { read: boolean; write: boolean; execute: boolean };
  const permBadge = (label: string, on: boolean) => `<div class="provider-line"><span>${label}</span><span class="${on ? 'ok' : 'bad'}">${on ? 'on' : 'off'}</span></div>`;
  const groups = ['read', 'navigate', 'interact', 'desktop', 'eval', 'recordings'] as const;
  const groupTitle: Record<string, string> = {
    read: 'Read',
    navigate: 'Navigate',
    interact: 'Interact',
    desktop: 'Desktop',
    eval: 'JavaScript',
    recordings: 'Recordings',
  };
  const groupBlurb: Record<string, string> = {
    read: 'Page text, screenshots, snapshots, and status.',
    navigate: 'URL changes, refresh, and scrolling.',
    interact: 'Clicks, typing, key presses, and form work.',
    desktop: 'OS mouse, monitor, window, and screenshot tools.',
    eval: 'Page JavaScript execution. Keep this tight.',
    recordings: 'Record and replay visible browser actions.',
  };
  const toolGroups = groups.map(g => {
    const tools = TOOL_META.filter(t => t.group === g);
    if (!tools.length) return '';
    const items = tools.map(t => `
      <label class="tool-toggle">
        <input type="checkbox" data-tool="${t.name}">
        <span>
          <strong>${escapeHtml(t.name)}</strong>
          <small>${escapeHtml(t.blurb)}</small>
        </span>
      </label>`).join('');
    return `
      <details class="tool-group" open>
        <summary><span>${escapeHtml(groupTitle[g])}</span><small>${escapeHtml(groupBlurb[g])}</small></summary>
        <div class="tool-grid">${items}</div>
      </details>`;
  }).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>empir3 Bridge Settings</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap');
  * { box-sizing: border-box; }
  :root {
    --bg: #f5efe2;
    --grid: rgba(28, 22, 10, 0.035);
    --surface: rgba(255, 252, 244, 0.92);
    --surface-strong: #fffaf0;
    --surface-soft: rgba(245, 238, 224, 0.72);
    --line: rgba(28, 22, 10, 0.13);
    --line-strong: rgba(28, 22, 10, 0.22);
    --ink: #1c160a;
    --muted: #5f5546;
    --soft: #8a8070;
    --accent: #6b4ef0;
    --good: #07885f;
    --bad: #c72432;
    --warn: #9a6500;
    --shadow: rgba(28, 22, 10, 0.08);
  }
  body {
    margin: 0;
    min-height: 100vh;
    background:
      linear-gradient(var(--grid) 1px, transparent 1px) 0 0 / 42px 42px,
      linear-gradient(90deg, var(--grid) 1px, transparent 1px) 0 0 / 42px 42px,
      var(--bg);
    color: var(--ink);
    font: 15px/1.5 'Outfit', system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  main {
    width: min(1180px, calc(100vw - 40px));
    margin: 0 auto;
    padding: 42px 0 118px;
    display: grid;
    grid-template-columns: 310px 1fr;
    gap: 34px;
    align-items: start;
  }
  .brand { position: sticky; top: 28px; padding-top: 4px; }
  .wordmark, .brand-inline {
    display: inline-flex;
    align-items: baseline;
    color: var(--ink);
    font-family: 'Outfit', system-ui, sans-serif;
    font-weight: 900;
    letter-spacing: 0;
  }
  .wordmark { font-size: 56px; line-height: 0.92; }
  .brand-inline { font-size: 1em; line-height: 1; }
  .three { color: var(--accent); }
  h1 { margin: 18px 0 10px; font-size: 32px; line-height: 1.05; letter-spacing: 0; }
  .lede { color: var(--muted); margin: 0; max-width: 28ch; font-size: 16px; }
  .path-list { margin-top: 22px; display: grid; gap: 8px; color: var(--soft); font-size: 12px; overflow-wrap: anywhere; }
  .path-list code, code { font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; font-size: 12px; color: var(--muted); }
  .nav-card { margin-top: 22px; border: 1px solid var(--line); background: var(--surface); border-radius: 8px; padding: 14px; display: grid; gap: 10px; }
  .nav-card strong { font-size: 13px; }
  .nav-card p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.35; }
  .nav-card a { color: var(--accent); font-weight: 800; text-decoration: none; }
  .stack { display: grid; gap: 14px; }
  .panel { border: 1px solid var(--line); background: var(--surface); box-shadow: 0 14px 34px var(--shadow); border-radius: 8px; padding: 20px; }
  .panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 16px; }
  h2 { margin: 0; font-size: 20px; line-height: 1.18; letter-spacing: 0; }
  .panel-head p, .muted { color: var(--muted); margin: 4px 0 0; }
  .status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  .stat { border: 1px solid var(--line); background: var(--surface-soft); border-radius: 8px; padding: 12px; min-height: 76px; }
  .stat span { display: block; color: var(--soft); font-size: 12px; margin-bottom: 6px; }
  .stat strong { display: block; font-size: 15px; overflow-wrap: anywhere; }
  .ok { color: var(--good); }
  .bad { color: var(--bad); }
  .warn { color: var(--warn); }
  .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  label.field { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
  label.field.full, .full { grid-column: 1 / -1; }
  input[type="text"], input[type="password"], input[type="number"], select, textarea {
    width: 100%; border: 1px solid var(--line-strong); background: rgba(255, 252, 244, 0.96);
    color: var(--ink); border-radius: 8px; padding: 11px 12px; font: inherit;
  }
  textarea { min-height: 96px; resize: vertical; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; font-size: 12px; }
  .segmented { display: inline-flex; padding: 4px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-soft); gap: 4px; }
  .segmented button { border: 0; background: transparent; border-radius: 999px; padding: 7px 13px; color: var(--muted); font-weight: 700; cursor: pointer; }
  .segmented button.active { background: var(--ink); color: var(--bg); }
  .mode-panel { display: none; }
  .mode-panel.active { display: block; }
  .switch-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .switch { display: grid; grid-template-columns: 44px 1fr; gap: 12px; align-items: center; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); padding: 12px; cursor: pointer; }
  .switch input, .tool-toggle input { accent-color: var(--accent); width: 18px; height: 18px; }
  .switch strong, .tool-toggle strong { display: block; color: var(--ink); font-size: 14px; }
  .switch small, .tool-toggle small { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
  .safety-switch { background: rgba(107, 78, 240, 0.08); border-color: rgba(107, 78, 240, 0.26); }
  .provider-line { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; border-top: 1px solid var(--line); margin-top: 12px; padding-top: 12px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; }
  button, a.button { appearance: none; border: 1px solid var(--line-strong); background: var(--surface-strong); color: var(--ink); border-radius: 8px; padding: 10px 14px; font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; }
  button:hover, a.button:hover { border-color: var(--accent); }
  button.primary { background: var(--ink); border-color: var(--ink); color: var(--bg); }
  button.accent { background: var(--accent); border-color: var(--accent); color: white; }
  .tool-group { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 12px; }
  .tool-group:first-child { border-top: 0; padding-top: 0; margin-top: 0; }
  .tool-group summary { cursor: pointer; display: flex; gap: 12px; align-items: baseline; }
  .tool-group summary span { font-weight: 800; }
  .tool-group summary small { color: var(--muted); }
  .tool-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
  .tool-toggle { display: grid; grid-template-columns: 24px 1fr; gap: 8px; align-items: start; border: 1px solid var(--line); background: rgba(255, 252, 244, 0.62); border-radius: 8px; padding: 10px; }
  .save-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 10; border-top: 1px solid var(--line); background: rgba(245, 239, 226, 0.94); backdrop-filter: blur(16px); padding: 12px max(20px, calc((100vw - 1180px) / 2)); display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
  #saveStatus { margin-right: auto; color: var(--muted); font-size: 13px; }
  @media (max-width: 900px) {
    main { grid-template-columns: 1fr; padding-top: 28px; }
    .brand { position: static; }
    .status-grid, .form-grid, .switch-grid, .tool-grid { grid-template-columns: 1fr; }
    .panel-head { display: grid; }
  }
</style>
</head>
<body>
<main>
  <aside class="brand">
    <div class="wordmark" aria-label="empir3">empir<span class="three">3</span></div>
    <h1>Bridge control center</h1>
    <p class="lede">This page controls this PC. MCP and local settings stay here.${signedIn ? ' Your empir3 account settings appear in the panels below.' : ''}</p>
    <div class="nav-card">
      <div>
        <strong>Local bridge safety</strong>
        <p>Final Read/Write/Execute override for every mode.</p>
      </div>
      <div>
        <strong>Local tool permissions</strong>
        <p>Tool-by-tool veto for Claude Code, OpenAI, local overlay${signedIn ? ', and empir3 agents' : ''}. Disabled here = disabled everywhere.</p>
      </div>
      ${signedIn ? `<div>
        <strong>empir3 account policy</strong>
        <p>Manage connected device permissions from <a href="https://app.empir3.com/settings">app.empir3.com/settings</a>.</p>
      </div>` : ''}
    </div>
    <div class="path-list">
      <div>chat config <code id="chatConfigPath">loading</code></div>
      <div>bridge settings <code id="bridgeSettingsPath">loading</code></div>
    </div>
  </aside>
  <section class="stack">
    <section class="panel">
      <div class="panel-head">
        <div><h2><span class="brand-inline">empir<span class="three">3</span></span> Bridge</h2><p>Current account, relay, version, and browser status.</p></div>
        <div class="actions"><button id="openWelcome">Welcome</button><button id="openBridge">Open bridge</button><button id="reloadState">Refresh</button></div>
      </div>
      <div class="status-grid">
        <div class="stat"><span>version</span><strong id="versionText">loading</strong></div>
        <div class="stat"><span>account</span><strong id="accountText">loading</strong></div>
        <div class="stat"><span>relay</span><strong id="relayText">loading</strong></div>
        <div class="stat"><span>mode</span><strong id="modeText">loading</strong></div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>Local bridge safety</h2><p>These three switches are the final PC-level override. They apply to MCP, local overlay chat${signedIn ? ', empir3 agents' : ''}, project sync, browser tools, and desktop tools.${signedIn ? ' Website settings cannot turn these back on.' : ''}</p></div></div>
      <div class="form-grid"><label class="field">Device name<input id="deviceName" type="text"></label><label class="field">Approved project root<input id="homeDirectory" type="text"></label></div>
      <div class="switch-grid" style="margin-top:12px">
        <label class="switch safety-switch"><input id="legacyRead" type="checkbox"><span><strong>Read</strong><small>Allow page reading, screenshots, system info, clipboard/file read, and sync inspection.</small></span></label>
        <label class="switch safety-switch"><input id="legacyWrite" type="checkbox"><span><strong>Write</strong><small>Allow file writes, clipboard writes, project sync writes, and stored local settings updates.</small></span></label>
        <label class="switch safety-switch"><input id="legacyExecute" type="checkbox"><span><strong>Execute</strong><small>Allow shell, app launch, browser/desktop clicks, typing, and window mutation tools.</small></span></label>
        <label class="switch"><input id="autoUpdate" type="checkbox"><span><strong>Auto-update</strong><small>Apply bridge payload updates automatically.</small></span></label>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>Local tool permissions</h2><p>These toggles veto specific tools regardless of source &mdash; MCP, local overlay${signedIn ? ', and empir3 agents' : ''}. Tools turned off here cannot be re-enabled remotely.</p></div><div class="actions"><button id="resetDefaults">Defaults</button><button id="disableRisky">Read-only-ish</button></div></div>
      ${toolGroups}
    </section>
    ${signedIn ? `
    <section class="panel">
      <div class="panel-head"><div><h2>empir3 website policy</h2><p>What empir3 agents may ask of this bridge. Set on <a href="https://app.empir3.com/settings">app.empir3.com/settings</a>. Local PC safety above always overrides &mdash; if a switch is off there, it stays off here.</p></div></div>
      <div class="switch-grid">
        ${permBadge('Read', empir3Perms.read)}
        ${permBadge('Write', empir3Perms.write)}
        ${permBadge('Execute', empir3Perms.execute)}
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>Use your subscriptions with empir3</h2><p>Let empir3 agents borrow your existing AI subscriptions for work on your behalf.</p></div><button id="probeProviders">Probe</button></div>
      <div class="switch-grid">
        <label class="switch"><input id="lendClaudeMax" type="checkbox"><span><strong>Use Claude Max with empir3</strong><small>Routes eligible empir3 agents through the Claude Code CLI logged in on this Windows account.</small></span></label>
        <label class="switch"><input id="lendCodex" type="checkbox"><span><strong>Use OpenAI Codex with empir3</strong><small>Routes eligible empir3 agents through the Codex CLI logged in on this Windows account.</small></span></label>
        <label class="switch" style="opacity:0.55"><input type="checkbox" disabled><span><strong>Use Google with empir3</strong><small>Coming soon.</small></span></label>
        <label class="switch" style="opacity:0.55"><input type="checkbox" disabled><span><strong>Use xAI with empir3</strong><small>Coming soon.</small></span></label>
      </div>
      <div class="provider-line"><span id="claudeProvider">Claude: checking</span><span id="claudeOpt" class="warn">opt-in off</span></div>
      <div class="provider-line"><span id="codexProvider">Codex: checking</span><span id="codexOpt" class="warn">opt-in off</span></div>
    </section>
    ` : ''}
    <section class="panel">
      <div class="panel-head">
        <div><h2>Local overlay chat engine</h2><p>Controls the chat panel inside the bridge browser.${signedIn ? ' This is separate from empir3 team chat at app.empir3.com.' : ''}</p></div>
        <div class="segmented" id="modeTabs"><button data-mode="api">API key</button><button data-mode="cli">Claude CLI</button></div>
      </div>
      <div id="mode-api" class="mode-panel"><div class="form-grid"><label class="field full">Anthropic API key<input id="apiKey" type="password" placeholder="leave blank to keep current key"></label><div class="muted full" id="apiKeyHint">No key loaded.</div></div></div>
      <div id="mode-cli" class="mode-panel"><div class="form-grid"><label class="field full">Claude CLI path<input id="cliPath" type="text" placeholder="C:\\Users\\name\\AppData\\Roaming\\npm\\claude.cmd"></label></div></div>
      <div class="form-grid" style="margin-top:12px">
        <label class="field">Model<select id="model"><option value="claude-opus-4-7">claude-opus-4-7</option><option value="claude-sonnet-4-6">claude-sonnet-4-6</option><option value="claude-haiku-4-5">claude-haiku-4-5</option></select></label>
        <label class="field">Max output tokens<input id="maxTokens" type="number" min="1024" max="32000" step="512"></label>
        <label class="field">Tool loop cap<input id="maxLoopIterations" type="number" min="1" max="100" step="1"></label>
        <label class="field">Bridge browser port<input id="bridgePort" type="text" disabled></label>
        <label class="field full">System prompt<textarea id="systemPrompt" placeholder="optional"></textarea></label>
      </div>
    </section>
  </section>
</main>
<div class="save-bar"><span id="saveStatus">Loading settings...</span><button id="discard">Discard</button><button class="accent" id="save">Save settings</button></div>
<script>
const TOOL_NAMES = ${JSON.stringify(TOOL_META.map(t => t.name))};
const DEFAULT_TOOLS = ${JSON.stringify(Object.fromEntries(TOOL_META.map(t => [t.name, t.defaultEnabled])))};
let state = null;
let chatMode = 'cli';
const byId = (id) => document.getElementById(id);
function safe(value, fallback) { return value === undefined || value === null || value === '' ? fallback : value; }
function statusClass(el, value, good) { el.classList.remove('ok', 'bad', 'warn'); el.classList.add(good ? 'ok' : 'warn'); if (value === false) { el.classList.remove('warn'); el.classList.add('bad'); } }
function setMode(mode) {
  chatMode = mode === 'api' ? 'api' : 'cli';
  document.querySelectorAll('#modeTabs button').forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === chatMode));
  byId('mode-api').classList.toggle('active', chatMode === 'api');
  byId('mode-cli').classList.toggle('active', chatMode === 'cli');
}
function providerText(name, provider) {
  if (!provider || !provider.available) return name + ': not found';
  return name + ': ' + safe(provider.version, 'installed') + ' - ' + safe(provider.path, 'PATH');
}
function paint(next) {
  state = next;
  const account = next.account || {};
  const bridge = next.bridge || {};
  const chat = next.chat || {};
  const providers = next.providers || {};
  byId('versionText').textContent = 'v' + safe(next.version, 'dev');
  byId('accountText').textContent = account.user?.email || 'not signed in';
  byId('relayText').textContent = account.relayConnected ? 'connected' : (account.hasAuth ? 'reconnecting' : 'not paired');
  byId('modeText').textContent = account.mode || 'unknown';
  statusClass(byId('relayText'), account.relayConnected, !!account.relayConnected || !account.hasAuth);
  byId('chatConfigPath').textContent = next.paths?.chatConfigFile || '';
  byId('bridgeSettingsPath').textContent = next.paths?.bridgeSettingsFile || '';
  byId('bridgePort').value = next.bridgeUrl || '';
  ${signedIn ? `byId('lendClaudeMax').checked = !!bridge.lendClaudeMax;
  byId('lendCodex').checked = !!bridge.lendOpenAiCodex;
  byId('claudeProvider').textContent = providerText('Claude', providers.claude);
  byId('codexProvider').textContent = providerText('Codex', providers.codex);
  byId('claudeOpt').textContent = bridge.lendClaudeMax ? 'opt-in on' : 'opt-in off';
  byId('codexOpt').textContent = bridge.lendOpenAiCodex ? 'opt-in on' : 'opt-in off';
  statusClass(byId('claudeOpt'), bridge.lendClaudeMax, !!bridge.lendClaudeMax);
  statusClass(byId('codexOpt'), bridge.lendOpenAiCodex, !!bridge.lendOpenAiCodex);` : ''}
  setMode(chat.mode || 'cli');
  byId('apiKey').value = '';
  byId('apiKeyHint').textContent = chat.anthropicApiKeySet ? 'API key is stored locally.' : 'No API key stored.';
  byId('cliPath').value = chat.claudeCliPath || '';
  byId('model').value = chat.model || 'claude-sonnet-4-6';
  byId('maxTokens').value = chat.maxTokens || 8192;
  byId('maxLoopIterations').value = chat.maxLoopIterations || 20;
  byId('systemPrompt').value = chat.systemPrompt || '';
  byId('deviceName').value = bridge.deviceName || '';
  byId('homeDirectory').value = bridge.homeDirectory || '';
  byId('autoUpdate').checked = bridge.autoUpdate !== false;
  byId('legacyRead').checked = !!(bridge.globalSafety || bridge.permissions)?.read;
  byId('legacyWrite').checked = !!(bridge.globalSafety || bridge.permissions)?.write;
  byId('legacyExecute').checked = !!(bridge.globalSafety || bridge.permissions)?.execute;
  for (const name of TOOL_NAMES) {
    const cb = document.querySelector('input[data-tool="' + name + '"]');
    if (cb) cb.checked = !!chat.enabledTools?.[name];
  }
  byId('saveStatus').textContent = 'Loaded.';
}
async function load() {
  byId('saveStatus').textContent = 'Loading settings...';
  const r = await fetch('/api/settings/state');
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || 'Settings load failed');
  paint(j);
}
function buildPatch() {
  const enabledTools = {};
  for (const name of TOOL_NAMES) {
    const cb = document.querySelector('input[data-tool="' + name + '"]');
    enabledTools[name] = !!(cb && cb.checked);
  }
  return {
    chat: {
      mode: chatMode,
      anthropicApiKey: byId('apiKey').value,
      claudeCliPath: byId('cliPath').value,
      model: byId('model').value,
      maxTokens: parseInt(byId('maxTokens').value, 10),
      maxLoopIterations: parseInt(byId('maxLoopIterations').value, 10),
      systemPrompt: byId('systemPrompt').value,
      enabledTools,
    },
    bridge: {
      deviceName: byId('deviceName').value,
      homeDirectory: byId('homeDirectory').value,
      autoUpdate: byId('autoUpdate').checked,
      ${signedIn ? `lendClaudeMax: byId('lendClaudeMax').checked,
      lendOpenAiCodex: byId('lendCodex').checked,` : ''}
      globalSafety: { read: byId('legacyRead').checked, write: byId('legacyWrite').checked, execute: byId('legacyExecute').checked },
    },
  };
}
async function save() {
  byId('saveStatus').textContent = 'Saving...';
  const r = await fetch('/api/settings/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildPatch()) });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || 'Save failed');
  paint(j);
  byId('saveStatus').textContent = 'Saved.';
}
document.querySelectorAll('#modeTabs button').forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.mode)));
byId('reloadState').addEventListener('click', () => load().catch((e) => { byId('saveStatus').textContent = 'Load failed: ' + e.message; }));
${signedIn ? `byId('probeProviders').addEventListener('click', () => load().catch((e) => { byId('saveStatus').textContent = 'Probe failed: ' + e.message; }));` : ''}
byId('discard').addEventListener('click', () => load().catch((e) => { byId('saveStatus').textContent = 'Discard failed: ' + e.message; }));
byId('save').addEventListener('click', () => save().catch((e) => { byId('saveStatus').textContent = 'Save failed: ' + e.message; }));
byId('openWelcome').addEventListener('click', () => { location.href = '/welcome'; });
byId('openBridge').addEventListener('click', async () => {
  try { await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'desktop:browse:show', params: {} }) }); }
  catch (e) { byId('saveStatus').textContent = 'Open bridge failed: ' + e.message; }
});
byId('resetDefaults').addEventListener('click', () => {
  for (const [name, enabled] of Object.entries(DEFAULT_TOOLS)) {
    const cb = document.querySelector('input[data-tool="' + name + '"]');
    if (cb) cb.checked = !!enabled;
  }
  byId('saveStatus').textContent = 'Defaults staged. Save to apply.';
});
byId('disableRisky').addEventListener('click', () => {
  for (const cb of document.querySelectorAll('input[data-tool]')) {
    const name = cb.getAttribute('data-tool') || '';
    cb.checked = /^(browser_status|browser_text|browser_snapshot|browser_screenshot|desktop_monitors|desktop_screenshot|browser_navigate|browser_scroll|browser_refresh)$/.test(name);
  }
  byId('saveStatus').textContent = 'Read-oriented tools staged. Save to apply.';
});
load().catch((e) => { byId('saveStatus').textContent = 'Load failed: ' + e.message; });
</script>
</body>
</html>`;
}

function getLegacySettingsHtml() {
  const groups = ['read', 'navigate', 'interact', 'desktop', 'eval', 'recordings'] as const;
  const groupTitle: Record<string, string> = {
    read: 'Read — page inspection (always safe)',
    navigate: 'Navigate — opens URLs, scrolls, refreshes',
    interact: 'Interact — clicks and types on pages you have open',
    desktop: 'Desktop — OS-level mouse control',
    eval: 'JavaScript eval — equivalent to opening DevTools',
    recordings: 'Recordings — replay tooling (niche)',
  };
  const groupBlurb: Record<string, string> = {
    read: 'These are on by default. Claude can read what is on the page but cannot change it.',
    navigate: 'Visible side effect, browser-scoped. On by default.',
    interact: 'Off by default. Lets Claude type and click on pages you are looking at — make sure you trust the prompt source.',
    desktop: 'Off by default. Lets Claude click physical desktop coordinates across monitors.',
    eval: 'Off by default. Unrestricted JavaScript is effectively root on the current page. Leave this off unless you know what you are doing.',
    recordings: 'Off by default. The replay tooling is for power users.',
  };
  const rows = groups.map(g => {
    const tools = TOOL_META.filter(t => t.group === g);
    if (tools.length === 0) return '';
    const items = tools.map(t => `
      <label class="tool">
        <input type="checkbox" data-tool="${t.name}">
        <div>
          <div class="name">${t.name}</div>
          <div class="blurb">${escapeHtml(t.blurb)}</div>
        </div>
      </label>`).join('');
    return `
    <section class="group">
      <header><h3>${escapeHtml(groupTitle[g])}</h3><p>${escapeHtml(groupBlurb[g])}</p></header>
      <div class="tools">${items}</div>
    </section>`;
  }).join('');
  return `<!DOCTYPE html><html><head>
<title>Bridge Settings</title>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 32px 24px 96px; }
  h1 { color: #3b82f6; font-size: 22px; margin: 0 0 4px; }
  p.lede { color: #94a3b8; margin: 0 0 24px; font-size: 13px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .card h2 { color: #93c5fd; font-size: 15px; margin: 0 0 12px; }
  label.field { display: block; margin-bottom: 12px; font-size: 13px; color: #cbd5e1; }
  label.field span { display: block; margin-bottom: 4px; color: #94a3b8; font-size: 12px; }
  input[type="text"], input[type="password"], input[type="number"], select, textarea {
    width: 100%; background: #0f172a; border: 1px solid #334155; border-radius: 8px;
    padding: 8px 10px; color: #e2e8f0; font: inherit;
  }
  textarea { min-height: 80px; resize: vertical; font-family: monospace; font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: stretch; }
  .row > * { flex: 1; }
  .mode-tabs { display: flex; gap: 4px; padding: 4px; background: #0f172a; border-radius: 8px; margin-bottom: 16px; }
  .mode-tabs button { flex: 1; padding: 8px; background: transparent; color: #94a3b8; border: none; border-radius: 6px; cursor: pointer; font: inherit; }
  .mode-tabs button.active { background: #1e293b; color: #e2e8f0; }
  section.group { margin-bottom: 18px; }
  section.group header { margin-bottom: 8px; }
  section.group h3 { color: #cbd5e1; font-size: 13px; margin: 0; }
  section.group p { color: #64748b; font-size: 12px; margin: 4px 0 0; }
  .tools { display: grid; gap: 6px; margin-top: 8px; }
  label.tool { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; cursor: pointer; }
  label.tool:hover { border-color: #334155; }
  label.tool input { margin-top: 3px; }
  .name { font-family: monospace; font-size: 12px; color: #93c5fd; }
  .blurb { color: #94a3b8; font-size: 12px; margin-top: 2px; }
  .save-bar { position: fixed; bottom: 0; left: 0; right: 0; background: #0f172a; border-top: 1px solid #334155; padding: 12px 24px; display: flex; gap: 12px; align-items: center; justify-content: flex-end; }
  .save-bar .status { flex: 1; color: #64748b; font-size: 12px; }
  button.primary { background: #3b82f6; color: white; border: none; border-radius: 8px; padding: 10px 18px; cursor: pointer; font: inherit; font-weight: 500; }
  button.primary:hover { background: #2563eb; }
  button.ghost { background: transparent; color: #94a3b8; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; cursor: pointer; font: inherit; }
  button.ghost:hover { color: #e2e8f0; border-color: #475569; }
</style></head><body>
<div class="wrap">
  <h1>Bridge Settings</h1>
  <p class="lede">Configure how Claude talks to you in the chat overlay. All settings live in <code style="color:#93c5fd;">~/.empir3-bridge/config.json</code> on your machine.</p>

  <div class="card">
    <h2>Chat mode</h2>
    <div class="mode-tabs" id="mode-tabs">
      <button data-mode="api">BYO API key</button>
      <button data-mode="cli">BYO Claude Code CLI</button>
    </div>
    <div id="mode-api">
      <label class="field"><span>Anthropic API key — get one at console.anthropic.com</span>
        <input type="password" id="apiKey" placeholder="sk-ant-…  (leave blank to keep current)"></label>
      <div id="apiKeyHint" style="font-size:12px;color:#64748b;margin-top:-6px;"></div>
    </div>
    <div id="mode-cli">
      <label class="field"><span>Path to <code>claude</code> CLI — auto-detected from PATH</span>
        <div class="row">
          <input type="text" id="cliPath" placeholder="C:\\Users\\…\\claude.cmd">
          <button class="ghost" id="redetect">Re-detect</button>
        </div></label>
      <p style="font-size:12px;color:#64748b;margin-top:-4px;">Uses your existing Claude Code subscription. v0.1.0 CLI mode is plain chat — browser tools land in v0.1.1.</p>
    </div>
  </div>

  <div class="card">
    <h2>Model + tokens</h2>
    <label class="field"><span>Model</span>
      <select id="model">
        <option value="claude-opus-4-7">claude-opus-4-7 (most capable)</option>
        <option value="claude-sonnet-4-6">claude-sonnet-4-6 (balanced)</option>
        <option value="claude-haiku-4-5">claude-haiku-4-5 (fast + cheap)</option>
      </select></label>
    <label class="field"><span>Max output tokens per turn</span>
      <input type="number" id="maxTokens" min="1024" max="32000" step="512"></label>
    <label class="field"><span>System prompt (optional — leave empty for the default)</span>
      <textarea id="systemPrompt" placeholder="Custom system prompt"></textarea></label>
    <label class="field"><span>Tool-use loop iteration cap</span>
      <input type="number" id="maxLoopIterations" min="1" max="100" step="1"></label>
  </div>

  <div class="card">
    <h2>Browser tools — what Claude can do on your behalf</h2>
    <p style="font-size:12px;color:#94a3b8;margin:0 0 12px;">Disabled tools are not even shown to the model, so it cannot hallucinate a call to one.</p>
    ${rows}
    <div style="margin-top:12px;display:flex;gap:8px;">
      <button class="ghost" id="resetDefaults">Reset to defaults</button>
      <button class="ghost" id="disableAll">Disable all interact tools</button>
    </div>
  </div>
</div>

<div class="save-bar">
  <div class="status" id="status">Loading…</div>
  <button class="ghost" onclick="window.location.reload()">Reload</button>
  <button class="primary" id="save">Save</button>
</div>

<script>
const $ = (q) => document.querySelector(q);
const TOOL_NAMES = ${JSON.stringify(TOOL_META.map(t => t.name))};
const DEFAULTS = ${JSON.stringify(Object.fromEntries(TOOL_META.map(t => [t.name, t.defaultEnabled])))};
let state = null;

function setMode(m) {
  document.querySelectorAll('#mode-tabs button').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  $('#mode-api').style.display = m === 'api' ? '' : 'none';
  $('#mode-cli').style.display = m === 'cli' ? '' : 'none';
  if (state) state.mode = m;
}
document.querySelectorAll('#mode-tabs button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

function paint(cfg) {
  state = cfg;
  setMode(cfg.mode);
  $('#apiKey').value = '';
  $('#apiKeyHint').textContent = cfg.anthropicApiKeySet ? '✓ A key is currently saved.' : 'No key saved yet.';
  $('#cliPath').value = cfg.claudeCliPath || '';
  $('#model').value = cfg.model;
  $('#maxTokens').value = cfg.maxTokens;
  $('#systemPrompt').value = cfg.systemPrompt;
  $('#maxLoopIterations').value = cfg.maxLoopIterations;
  for (const name of TOOL_NAMES) {
    const cb = document.querySelector('input[data-tool="' + name + '"]');
    if (cb) cb.checked = !!cfg.enabledTools[name];
  }
  $('#status').textContent = 'Loaded.';
}

async function load() {
  const r = await fetch('/api/config');
  paint(await r.json());
}

$('#save').addEventListener('click', async () => {
  const enabledTools = {};
  for (const name of TOOL_NAMES) {
    const cb = document.querySelector('input[data-tool="' + name + '"]');
    enabledTools[name] = !!(cb && cb.checked);
  }
  const patch = {
    mode: state.mode,
    anthropicApiKey: $('#apiKey').value,
    claudeCliPath: $('#cliPath').value,
    model: $('#model').value,
    maxTokens: parseInt($('#maxTokens').value, 10),
    systemPrompt: $('#systemPrompt').value,
    maxLoopIterations: parseInt($('#maxLoopIterations').value, 10),
    enabledTools,
  };
  $('#status').textContent = 'Saving…';
  const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  if (!r.ok) { $('#status').textContent = 'Save failed: ' + await r.text(); return; }
  paint(await r.json());
  $('#status').textContent = '✓ Saved.';
});

$('#resetDefaults').addEventListener('click', () => {
  for (const [name, on] of Object.entries(DEFAULTS)) {
    const cb = document.querySelector('input[data-tool="' + name + '"]');
    if (cb) cb.checked = !!on;
  }
  $('#status').textContent = 'Reset checkboxes — click Save to apply.';
});
$('#disableAll').addEventListener('click', () => {
  for (const cb of document.querySelectorAll('input[data-tool]')) {
    const name = cb.getAttribute('data-tool');
    // Disable interact + eval + recordings; leave read + navigate.
    if (!/^(browser_status|browser_text|browser_snapshot|browser_screenshot|desktop_monitors|desktop_screenshot|browser_navigate|browser_scroll|browser_refresh)$/.test(name)) {
      cb.checked = false;
    }
  }
  $('#status').textContent = 'Disabled interact/eval/recording — click Save to apply.';
});
$('#redetect').addEventListener('click', async () => {
  const r = await fetch('/api/config');
  const cfg = await r.json();
  $('#cliPath').value = cfg.claudeCliPath || '';
});

load();
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ─── Dashboard HTML ──────────────────────────────────────────

// Reads assets/accuracy-lab.html once and caches it. Tries the packaged path
// (alongside bundle-server.js in the payload root) first, then the dev repo
// path. Returns null (→ 404) if the asset isn't present in this build.
let _accuracyLabHtml: string | null = null;
function readAccuracyLabHtml(): string | null {
  if (_accuracyLabHtml !== null) return _accuracyLabHtml || null;
  const candidates = [
    process.env.EMPIR3_BRIDGE_ACCURACY_LAB,
    resolve(__dirname, 'accuracy-lab.html'),                  // packaged payload root
    resolve(__dirname, '..', 'assets', 'accuracy-lab.html'),  // dev repo
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try {
      const html = readFileSync(p, 'utf-8');
      if (html) { _accuracyLabHtml = html; return html; }
    } catch { /* try next */ }
  }
  _accuracyLabHtml = '';
  return null;
}

function getBridgeSmokeTestPlan() {
  // desktop_toolbar is an execute-gated tool that defaults OFF. `status` always
  // works (read-only), but `show` only works when the tool is enabled — so the
  // toolbar step is marked optional and its `show` command is gated on the
  // current enabled state to avoid an always-failing mandatory step.
  let toolbarEnabled = false;
  try { toolbarEnabled = loadConfig().enabledTools?.desktop_toolbar !== false; } catch {}
  const toolbarStep = {
    id: 'toolbar',
    label: 'Tray toolbar',
    optional: true,
    enabled: toolbarEnabled,
    commands: toolbarEnabled ? ['desktop_toolbar status', 'desktop_toolbar show'] : ['desktop_toolbar status'],
    expected: toolbarEnabled
      ? ['status reports running state', 'toolbar opens without blocking bridge commands']
      : ['status reports running:false', 'desktop_toolbar is disabled — skip `show` (enable it in the tray to test)'],
  };
  return {
    version: 1,
    name: 'Empir3 Bridge standard smoke test',
    targetPath: '/desktop-test',
    targetUrl: `http://localhost:${PORT}/desktop-test`,
    rule: 'Always open /desktop-test before quick bridge verification. Use this plan in order and stop after the first reproducible failure.',
    steps: [
      { id: 'health', label: 'Bridge health', commands: ['status', 'reliability_status', 'safety_status'] },
      { id: 'overlay', label: 'Overlay readiness', commands: ['navigate /desktop-test', 'bridge_overlay_reinject'], expected: ['bubble true', 'cursor hook true', 'websocket open or CDP mailbox usable'] },
      { id: 'browser', label: 'Browser controls', commands: ['text', 'snapshot', 'screenshot', 'click #clickTarget', 'type #nameInput', 'press Tab', 'scroll'] },
      { id: 'recording', label: 'Recording loop', commands: ['record_start', 'click #clickTarget', 'record_stop', 'recordings', 'play saved recording'], expected: ['agent selector click records once', 'playback has no coordinate warning'] },
      { id: 'desktop', label: 'Desktop tools', commands: ['desktop_monitors', 'desktop_calibration_status', 'desktop_cursor_position', 'desktop_screenshot_zoom', 'desktop_focus_status', 'desktop_release_focus'], expected: ['all detected monitors are listed', 'release focus is safe even with no region'] },
      toolbarStep,
    ],
    requiredSelectors: ['#clickTarget', '#dragSource', '#dropTarget', '#nameInput', '#emailInput', '#notesInput', '#modeKeyboard', '#modeMouse', '#agreeBox', '#prioritySelect', '#submitForm', '#scrollTarget'],
  };
}

function getDesktopTestHtml() {
  return `<!DOCTYPE html>
<html><head><title>empir3 Bridge Desktop Test</title>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@700;800;900&display=swap');
  :root { --bg:#0b1020; --panel:#121a2b; --panel-2:#172238; --ink:#e7eefb; --muted:#93a5bf; --line:#263652; --brand:#8b6ff8; --good:#39c980; --blue:#5da8ff; --warn:#f0b35a; --bad:#e65f78; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:var(--bg); color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  button, input, select, textarea { font:inherit; }
  .brand-word { font-family:'Outfit',system-ui,sans-serif; font-weight:900; letter-spacing:0; }
  .brand-word .three { color:var(--brand); }
  .top { position:sticky; top:0; z-index:10; display:flex; justify-content:space-between; gap:18px; align-items:center; padding:16px 22px; border-bottom:1px solid var(--line); background:rgba(11,16,32,.94); backdrop-filter:blur(12px); }
  h1 { font-size:20px; margin:0 0 4px; letter-spacing:0; }
  h2 { font-size:14px; margin:0 0 10px; color:#dce7fb; }
  .sub { color:var(--muted); font-size:13px; line-height:1.45; }
  .badge { display:inline-flex; align-items:center; gap:8px; padding:7px 10px; border:1px solid var(--line); border-radius:8px; background:var(--panel); color:#cfe0f8; font-size:12px; white-space:nowrap; }
  .layout { display:grid; grid-template-columns:minmax(680px,1fr) 360px; gap:18px; padding:18px; }
  .stage { position:relative; min-height:850px; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:linear-gradient(var(--panel) 1px, transparent 1px), linear-gradient(90deg, var(--panel) 1px, transparent 1px), #0c1324; background-size:40px 40px; }
  .target { position:absolute; border:2px solid var(--good); background:rgba(57,201,128,.12); color:#c9f5df; border-radius:8px; display:grid; place-items:center; font-weight:800; letter-spacing:0; user-select:none; transition:transform .16s ease, box-shadow .16s ease, background .16s ease; }
  #clickTarget { left:70px; top:82px; width:230px; height:118px; }
  #secondaryButton { position:absolute; left:316px; top:112px; width:146px; height:52px; border:1px solid #4b6d9e; border-radius:8px; color:#d9e8ff; background:#192844; cursor:pointer; font-weight:700; }
  #dragSource { left:70px; top:288px; width:170px; height:112px; border-color:var(--blue); color:#d9eaff; background:rgba(93,168,255,.12); }
  #dropTarget { left:300px; top:288px; width:210px; height:112px; border-color:var(--warn); color:#ffe4b7; background:rgba(240,179,90,.12); }
  .scroll-lane { position:absolute; left:70px; top:492px; width:490px; height:282px; border:1px solid var(--line); border-radius:8px; overflow:auto; background:rgba(18,26,43,.82); }
  .scroll-content { height:720px; padding:16px; color:#b9c8dc; }
  #scrollTarget { margin-top:520px; padding:16px; border:1px solid var(--good); border-radius:8px; color:#c9f5df; background:rgba(57,201,128,.1); }
  .test-form { display:grid; gap:10px; }
  .field { display:grid; gap:5px; }
  label, .label { font-size:12px; color:#c7d5e8; font-weight:700; }
  input, select, textarea { width:100%; border:1px solid #334765; border-radius:7px; background:#0c1324; color:var(--ink); padding:9px 10px; outline:none; }
  input:focus, select:focus, textarea:focus { border-color:var(--blue); box-shadow:0 0 0 3px rgba(93,168,255,.16); }
  textarea { min-height:66px; resize:vertical; }
  .choice-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .choice { display:flex; align-items:center; gap:8px; border:1px solid #334765; border-radius:7px; padding:8px; color:#d6e2f2; }
  .choice input { width:auto; }
  .actions { display:flex; gap:8px; }
  .btn { border:1px solid #3b5174; border-radius:7px; background:#172844; color:#eaf2ff; padding:9px 11px; cursor:pointer; font-weight:750; }
  .btn.primary { background:var(--brand); border-color:var(--brand); color:#fff; }
  .btn:active { transform:translateY(1px); }
  .side { display:grid; gap:14px; align-content:start; }
  .panel { border:1px solid var(--line); border-radius:8px; background:var(--panel); padding:14px; }
  .readout .row { display:flex; justify-content:space-between; gap:12px; padding:7px 0; border-bottom:1px solid #1f2d45; font-size:13px; }
  .readout .row:last-child { border-bottom:0; }
  code { color:#c9f5df; font-family:Consolas,'SFMono-Regular',monospace; font-size:12px; }
  .protocol ol { margin:0; padding-left:20px; color:#cbd8ea; font-size:13px; line-height:1.55; }
  .protocol li { margin:5px 0; }
  .log { height:190px; overflow:auto; margin:0; border:1px solid #1f2d45; border-radius:8px; background:#0c1324; padding:10px; font:12px/1.45 Consolas,monospace; color:#bac9dd; white-space:pre-wrap; }
  .hit { transform:translateY(-1px); box-shadow:0 0 0 6px rgba(57,201,128,.16); }
  .drop-ok { border-color:var(--good) !important; color:#c9f5df !important; background:rgba(57,201,128,.16) !important; }
  .shot-mark { position:absolute; width:34px; height:34px; border:3px solid var(--bad); border-radius:999px; transform:translate(-50%, -50%); pointer-events:none; z-index:4; box-shadow:0 0 0 5px rgba(230,95,120,.18); }
  .shot-mark::before, .shot-mark::after { content:''; position:absolute; left:50%; top:50%; background:var(--bad); transform:translate(-50%, -50%); }
  .shot-mark::before { width:48px; height:3px; }
  .shot-mark::after { width:3px; height:48px; }
  .shot-mark span { position:absolute; left:24px; top:-22px; min-width:22px; height:22px; padding:0 6px; border-radius:999px; background:var(--bad); color:#fff; font:700 12px/22px Consolas,monospace; text-align:center; }
  @media (max-width:1060px) { .layout { grid-template-columns:1fr; } .stage { min-height:850px; overflow:auto; } }
</style></head><body>
  <div class="top">
    <div><h1><span class="brand-word">empir<span class="three">3</span></span> Bridge Test Lab</h1><div class="sub">One safe harness for browser tools, desktop tools, recording, playback, screenshots, and calibration checks.</div></div>
    <div class="badge">Viewport <code id="viewport">-</code></div>
  </div>
  <main class="layout">
    <section class="stage" id="stage" aria-label="Desktop and browser test targets">
      <div class="target" id="clickTarget">CLICK TARGET</div>
      <button id="secondaryButton" type="button">SECONDARY</button>
      <div class="target" id="dragSource" draggable="false">DRAG FROM</div>
      <div class="target" id="dropTarget">DROP HERE</div>
      <div class="scroll-lane" id="scrollLane"><div class="scroll-content">Scroll lane for browser_scroll and desktop screenshot checks.<div id="scrollTarget">SCROLL TARGET</div></div></div>
    </section>
    <aside class="side">
      <section class="panel">
        <form class="test-form" id="testForm">
          <h2>Form And Input Targets</h2>
          <div class="field"><label for="nameInput">Name input</label><input id="nameInput" name="name" autocomplete="off" placeholder="Type smoke text"></div>
          <div class="field"><label for="emailInput">Email input</label><input id="emailInput" name="email" type="email" placeholder="agent@example.com"></div>
          <div class="field"><label for="notesInput">Notes textarea</label><textarea id="notesInput" name="notes" placeholder="Multi-line test notes"></textarea></div>
          <div class="choice-row">
            <label class="choice"><input id="modeKeyboard" type="radio" name="mode" value="keyboard" checked> Keyboard</label>
            <label class="choice"><input id="modeMouse" type="radio" name="mode" value="mouse"> Mouse</label>
          </div>
          <label class="choice"><input id="agreeBox" type="checkbox"> Checkbox target</label>
          <div class="field"><label for="prioritySelect">Select target</label><select id="prioritySelect"><option value="normal">Normal</option><option value="urgent">Urgent</option><option value="later">Later</option></select></div>
          <div class="actions"><button class="btn primary" id="submitForm" type="submit">Submit</button><button class="btn" id="resetHarness" type="button">Reset</button></div>
          <output id="summaryOutput" for="nameInput emailInput notesInput">No form submission yet.</output>
        </form>
      </section>
      <section class="panel protocol">
        <h2>Standard Smoke Order</h2>
        <ol>
          <li>Open <code>/desktop-test</code>, then check <code>status</code> and <code>reliability_status</code>.</li>
          <li>Run <code>bridge_overlay_reinject</code> and verify bubble, cursor hook, and transport.</li>
          <li>Exercise browser read, screenshot, click, type, press, and scroll tools on this page.</li>
          <li>Record one selector click, stop, inspect actions, then play it once.</li>
          <li>Check monitors, calibration status, cursor position, screenshot zoom, and release focus.</li>
        </ol>
      </section>
      <section class="panel readout">
        <h2>Pointer Readout</h2>
        <div class="row"><span>Last event</span><code id="lastEvent">none</code></div>
        <div class="row"><span>Client x/y</span><code id="client">-</code></div>
        <div class="row"><span>Screen x/y</span><code id="screen">-</code></div>
        <div class="row"><span>Last shot mark</span><code id="lastShot">-</code></div>
        <div class="row"><span>Click attempts</span><code id="clickTotal">0</code></div>
        <div class="row"><span>Hits / misses</span><code><span id="clickHits">0</span> / <span id="clickMisses">0</span></code></div>
        <div class="row"><span>Drag status</span><code id="dragStatus">waiting</code></div>
        <div class="row"><span>Form submits</span><code id="formSubmits">0</code></div>
      </section>
      <section class="panel">
        <h2>Event Log</h2>
        <pre class="log" id="log">ready</pre>
      </section>
    </aside>
  </main>
<script>
const $ = id => document.getElementById(id);
const state = { clickTotal:0, clickHits:0, clickMisses:0, secondaryClicks:0, formSubmits:0, dragging:false, shotMarks:0, lastEvent:'none', lastForm:null };
window.__bridgeSmokeTestPlan = ${JSON.stringify(getBridgeSmokeTestPlan())};
window.__bridgeTestSummary = () => Object.assign({}, state, {
  name: $('nameInput').value,
  email: $('emailInput').value,
  notes: $('notesInput').value,
  mode: document.querySelector('input[name="mode"]:checked')?.value || '',
  agreed: $('agreeBox').checked,
  priority: $('prioritySelect').value,
  scrollTop: $('scrollLane').scrollTop,
});
function line(text) {
  const log = $('log');
  log.textContent += '\\n' + new Date().toLocaleTimeString() + '  ' + text;
  log.scrollTop = log.scrollHeight;
}
function addShotMark(e, label) {
  const stage = $('stage');
  const rect = stage.getBoundingClientRect();
  const x = Math.round(e.clientX - rect.left);
  const y = Math.round(e.clientY - rect.top);
  const mark = document.createElement('div');
  mark.className = 'shot-mark';
  mark.style.left = x + 'px';
  mark.style.top = y + 'px';
  mark.title = label + ' client=' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' screen=' + Math.round(e.screenX) + ',' + Math.round(e.screenY);
  const badge = document.createElement('span');
  badge.textContent = String(++state.shotMarks);
  mark.appendChild(badge);
  stage.appendChild(mark);
  $('lastShot').textContent = '#' + state.shotMarks + ' ' + x + ', ' + y;
}
function paint(e, name) {
  state.lastEvent = name;
  $('lastEvent').textContent = name;
  $('client').textContent = Math.round(e.clientX) + ', ' + Math.round(e.clientY);
  $('screen').textContent = Math.round(e.screenX) + ', ' + Math.round(e.screenY);
}
function updateClickReadout() {
  $('clickTotal').textContent = String(state.clickTotal);
  $('clickHits').textContent = String(state.clickHits);
  $('clickMisses').textContent = String(state.clickMisses);
  $('formSubmits').textContent = String(state.formSubmits);
}
function updateViewport() { $('viewport').textContent = window.innerWidth + ' x ' + window.innerHeight; }
window.addEventListener('resize', updateViewport); updateViewport();
document.addEventListener('pointermove', e => paint(e, 'pointermove'));
$('stage').addEventListener('click', e => {
  if (e.target?.closest?.('.test-form, .scroll-lane')) return;
  const hit = !!e.target?.closest?.('#clickTarget');
  state.clickTotal++;
  if (hit) state.clickHits++;
  else state.clickMisses++;
  updateClickReadout();
  paint(e, hit ? 'click HIT' : 'click MISS');
  addShotMark(e, hit ? 'click HIT' : 'click MISS');
  line('click ' + (hit ? 'HIT' : 'MISS') + ' trusted=' + e.isTrusted + ' client=' + Math.round(e.clientX) + ',' + Math.round(e.clientY));
}, true);
$('clickTarget').addEventListener('click', e => {
  $('clickTarget').classList.add('hit');
  setTimeout(() => $('clickTarget').classList.remove('hit'), 350);
});
$('secondaryButton').addEventListener('click', e => {
  state.secondaryClicks++;
  line('secondary button clicked trusted=' + e.isTrusted + ' count=' + state.secondaryClicks);
});
$('dragSource').addEventListener('pointerdown', e => {
  state.dragging = true;
  $('dragStatus').textContent = 'dragging';
  $('dragSource').setPointerCapture?.(e.pointerId);
  line('drag start trusted=' + e.isTrusted + ' screen=' + Math.round(e.screenX) + ',' + Math.round(e.screenY));
});
document.addEventListener('pointerup', e => {
  if (!state.dragging) return;
  state.dragging = false;
  const drop = $('dropTarget').getBoundingClientRect();
  const ok = e.clientX >= drop.left && e.clientX <= drop.right && e.clientY >= drop.top && e.clientY <= drop.bottom;
  $('dragStatus').textContent = ok ? 'dropped on target' : 'released outside target';
  $('dropTarget').classList.toggle('drop-ok', ok);
  line('drag end ' + (ok ? 'OK' : 'MISS') + ' trusted=' + e.isTrusted + ' client=' + Math.round(e.clientX) + ',' + Math.round(e.clientY));
});
$('testForm').addEventListener('submit', e => {
  e.preventDefault();
  state.formSubmits++;
  state.lastForm = window.__bridgeTestSummary();
  $('summaryOutput').textContent = 'Submitted ' + state.lastForm.name + ' / ' + state.lastForm.priority + ' / ' + state.lastForm.mode;
  updateClickReadout();
  line('form submit count=' + state.formSubmits + ' name=' + state.lastForm.name);
});
$('resetHarness').addEventListener('click', () => {
  $('testForm').reset();
  $('summaryOutput').textContent = 'No form submission yet.';
  $('scrollLane').scrollTop = 0;
  state.clickTotal = 0; state.clickHits = 0; state.clickMisses = 0; state.secondaryClicks = 0; state.formSubmits = 0; state.lastForm = null;
  updateClickReadout();
  line('harness reset');
});
$('scrollLane').addEventListener('scroll', () => line('scroll lane top=' + $('scrollLane').scrollTop));
</script></body></html>`;
}

function getDashboardHtml() {
  return `<!DOCTYPE html>
<html><head><title>empir3 Browser Bridge</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@700;800;900&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0f172a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; }
  .brand-word { font-family: 'Outfit', system-ui, sans-serif; font-weight: 900; letter-spacing: -0.03em; }
  .brand-word .three { color: #7c5cfc; }
  h1 { color: #3b82f6; margin-bottom: 8px; }
  .subtitle { color: #64748b; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; }
  .card h3 { color: #93c5fd; font-size: 14px; margin-bottom: 8px; }
  .stat { font-size: 28px; font-weight: bold; }
  .stat.green { color: #4ade80; }
  .stat.blue { color: #60a5fa; }
  .stat.orange { color: #fb923c; }
  .stat.red { color: #ef4444; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge.empir3 { background: #1e3a5f; color: #60a5fa; }
  .safety { border-color: #334155; }
  .safety.danger { border-color: #7f1d1d; background: #241524; }
  .safety.safe { border-color: #14532d; background: #10201d; }
  .mini { color: #94a3b8; font-size: 12px; margin-top: 6px; line-height: 1.4; }
  #chat-log { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; max-height: 400px; overflow-y: auto; margin-bottom: 16px; }
  .msg { margin-bottom: 8px; padding: 8px 12px; border-radius: 8px; }
  .msg.user { background: #312e81; }
  .msg.claude { background: #1e3a5f; }
  .msg .meta { font-size: 11px; color: #64748b; }
  #cmd-input { width: 100%; padding: 12px; background: #1e293b; border: 1px solid #334155; border-radius: 8px; color: #e2e8f0; font-size: 14px; }
  #cmd-input:focus { outline: none; border-color: #3b82f6; }
  .btn { padding: 8px 16px; background: #3b82f6; color: white; border: none; border-radius: 8px; cursor: pointer; margin: 4px; }
  .btn:hover { background: #2563eb; }
  #snapshot-area { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin-top: 16px; max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 12px; white-space: pre-wrap; display: none; }
</style></head>
<body>
  <h1><span class="brand-word">empir<span class="three">3</span></span> Browser Bridge <span class="badge empir3"><span class="brand-word">empir<span class="three">3</span></span> Bridge</span></h1>
  <p class="subtitle">Real Chrome via <span class="brand-word">empir<span class="three">3</span></span> Bridge — element refs, persistent cookies, stealth mode</p>

  <div class="grid">
    <div class="card"><h3><span class="brand-word">empir<span class="three">3</span></span> Bridge</h3><div class="stat green" id="status">Connecting...</div></div>
    <div class="card"><h3>Current URL</h3><div id="current-url" style="font-size:13px;word-break:break-all;">-</div></div>
    <div class="card"><h3>Messages</h3><div class="stat blue" id="msg-count">0</div></div>
    <div class="card"><h3>Overlay</h3><div class="stat" id="overlay-status">-</div></div>
    <div class="card safety" id="safety-card"><h3>Control Safety</h3><div class="stat" id="safety-status">Checking...</div><div class="mini" id="safety-detail">-</div></div>
    <div class="card"><h3>Test Harness</h3><div class="mini">Safe page for desktop hover, click, and drag checks.</div><button class="btn" onclick="openDesktopTest()" style="margin-top:10px;background:#0d9488;">Open Desktop Test</button></div>
  </div>

  <h3 style="margin-bottom:8px;">Chat Log</h3>
  <div id="chat-log"><em style="color:#64748b;">Waiting for messages...</em></div>

  <h3 style="margin:16px 0 8px;">Commands</h3>
  <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
    <button class="btn" onclick="sendCmd({type:'screenshot'})">Screenshot</button>
    <button class="btn" onclick="sendCmd({type:'refresh'})">Refresh</button>
    <button class="btn" onclick="promptNav()">Navigate</button>
    <button class="btn" onclick="fetchSnapshot()" style="background:#0d9488;">Snapshot</button>
    <button class="btn" onclick="injectOverlay()" style="background:#7c3aed;">Inject Overlay</button>
    <button class="btn" onclick="revokeControl()" style="background:#dc2626;">Revoke Write Control</button>
  </div>
  <input id="cmd-input" placeholder="Type a message to the browser overlay..." onkeydown="if(event.key==='Enter')sendChat()">
  <div id="snapshot-area"></div>

<script>
  const ws = new WebSocket('ws://localhost:${PORT}?role=cli');
  ws.onopen = () => { refresh(); };
  ws.onclose = () => { document.getElementById('status').textContent = 'Disconnected'; document.getElementById('status').style.color = '#ef4444'; };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'user_message') addChatMsg(msg.message);
    if (msg.type === 'feedback') addChatMsg({ from: 'user', text: '[Feedback] ' + msg.entry.comment, timestamp: msg.entry.timestamp });
    refresh();
  };

  function sendCmd(cmd) { ws.send(JSON.stringify(cmd)); }
  function sendChat() {
    const input = document.getElementById('cmd-input');
    if (!input.value.trim()) return;
    sendCmd({ type: 'chat', message: input.value });
    addChatMsg({ from: 'claude', text: input.value, timestamp: new Date().toISOString() });
    input.value = '';
  }
  function promptNav() {
    const url = prompt('Navigate to URL:');
    if (url) sendCmd({ type: 'navigate', url });
  }
  async function fetchSnapshot() {
    const area = document.getElementById('snapshot-area');
    area.style.display = 'block';
    area.textContent = 'Loading snapshot...';
    try {
      const res = await fetch('/api/command', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ type:'snapshot', filter:'interactive', format:'compact' }) });
      const data = await res.json();
      area.textContent = typeof data.result?.snapshot === 'string' ? data.result.snapshot : JSON.stringify(data.result?.snapshot, null, 2);
    } catch(e) { area.textContent = 'Error: ' + e.message; }
  }
  async function injectOverlay() {
    try {
      await fetch('/api/command', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ type:'evaluate', script: await (await fetch('/overlay.js')).text() }) });
      refresh();
    } catch(e) { alert('Error: ' + e.message); }
  }
  async function openDesktopTest() {
    sendCmd({ type: 'navigate', url: 'http://localhost:${PORT}/desktop-test' });
  }
  async function revokeControl() {
    if (!confirm('Disable browser interact, desktop, eval, and recording tools?')) return;
    const r = await fetch('/api/safety/lockdown', { method: 'POST' });
    if (!r.ok) { alert('Failed to revoke control: ' + await r.text()); return; }
    await refresh();
  }
  function addChatMsg(msg) {
    const log = document.getElementById('chat-log');
    if (log.querySelector('em')) log.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'msg ' + msg.from;
    div.innerHTML = '<strong>' + (msg.from === 'user' ? 'You' : 'Claude') + ':</strong> ' + msg.text + '<div class="meta">' + new Date(msg.timestamp).toLocaleTimeString() + (msg.screenshot ? ' [screenshot]' : '') + '</div>';
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  async function refresh() {
    try {
      const res = await fetch('/api/status');
      const s = await res.json();
      document.getElementById('status').textContent = s.running ? 'Connected' : 'Disconnected';
      document.getElementById('status').style.color = s.running ? '#4ade80' : '#ef4444';
      document.getElementById('current-url').textContent = s.currentUrl || '-';
      document.getElementById('msg-count').textContent = s.messageCount;
      const overlayEl = document.getElementById('overlay-status');
      overlayEl.textContent = s.overlayInjected ? 'Active' : 'Not injected';
      overlayEl.style.color = s.overlayInjected ? '#4ade80' : '#fb923c';
      const safety = await (await fetch('/api/safety')).json();
      const safetyCard = document.getElementById('safety-card');
      const safetyStatus = document.getElementById('safety-status');
      const safetyDetail = document.getElementById('safety-detail');
      const enabled = safety.enabledWriteTools || [];
      safetyCard.classList.toggle('danger', enabled.length > 0);
      safetyCard.classList.toggle('safe', enabled.length === 0);
      safetyStatus.textContent = enabled.length > 0 ? 'Write Enabled' : 'Read Only';
      safetyStatus.className = 'stat ' + (enabled.length > 0 ? 'red' : 'green');
      safetyDetail.textContent = enabled.length > 0 ? enabled.map(t => t.name).join(', ') : 'No click/type/desktop/eval tools are enabled.';
    } catch(e) {}
  }
  setInterval(refresh, 5000);
</script>
</body></html>`;
}

// ─── Overlay Script ──────────────────────────────────────────

function getOverlayScript(bridgeNonce = '') {
  return `
(function() {
  'use strict';
  if (window.__empir3BridgeLoaded) return;
  window.__empir3BridgeLoaded = true;

  // ─── Host-CSS isolation guard ──────────────
  // Some sites ship low-specificity rules like \`div { opacity: 0.8 }\` (example.org)
  // or Tailwind-style utility classes that bleed onto our overlay because we
  // don't set every property inline. This guard immunizes anything under
  // \`[id^="empir3-"]\` against opacity/filter/blend-mode hijacking from the host.
  // Color/border/background stay free to be set by the script as before.
  (function injectHostCssGuard() {
    const s = document.createElement('style');
    s.id = 'empir3-host-css-guard';
    s.textContent =
      '[id^="empir3-"], [id^="empir3-"] *, .empir3-text-input, .empir3-annotation-input, .empir3-annotation-badge {' +
        'opacity: 1 !important;' +
        'filter: none !important;' +
        'mix-blend-mode: normal !important;' +
        '-webkit-filter: none !important;' +
      '}';
    (document.head || document.documentElement).appendChild(s);
  })();

  // Light-theme variable set. Dark is the default: every themed color in the
  // panel is written as var(--e3-x, <dark value>), so with no vars defined the
  // dark fallback applies and dark mode is byte-for-byte unchanged. Toggling
  // data-empir3-theme="light" on the panel defines these vars, which inherit
  // down to every child (including dynamically rendered message bubbles).
  (function injectEmpir3ThemeVars() {
    if (document.getElementById('empir3-theme-vars')) return;
    const s = document.createElement('style');
    s.id = 'empir3-theme-vars';
    s.textContent =
      '#empir3-chat-panel[data-empir3-theme="light"]{' +
        '--e3-panel-bg:#eef1f5;' +          // soft off-white, not stark #fff
        '--e3-toolbar-bg:#e6eaf0;' +        // a touch deeper for separation
        '--e3-divider:#d6dbe2;' +
        '--e3-input-bg:#ffffff;' +          // white field pops on the off-white panel
        '--e3-input-border:#cbd5e1;' +
        '--e3-input-ink:#0f172a;' +
        '--e3-msg-assistant-bg:#ffffff;' +  // assistant = clean white card
        '--e3-msg-user-bg:#dbe4ff;' +       // user = soft indigo
        '--e3-msg-ink:#1e293b;' +
        '--e3-msg-meta:#64748b;' +
        '--e3-brand-ink:#0f172a;' +
        '--e3-status-ink:#334155;' +
        '--e3-btn-ink:#475569;' +           // toolbar / pill button text — readable on light
        '--e3-btn-ink-dim:#64748b;' +       // header buttons
        '--e3-btn-border:#c2cad6;' +
        '--e3-mode-switch-bg:#e0e5ec;' +
      '}';
    (document.head || document.documentElement).appendChild(s);
  })();

  (function injectEmpir3Font() {
    if (document.getElementById('empir3-outfit-font')) return;
    const l = document.createElement('link');
    l.id = 'empir3-outfit-font';
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Outfit:wght@700;800;900&display=swap';
    (document.head || document.documentElement).appendChild(l);
  })();

  const BRIDGE_NONCE = ${JSON.stringify(bridgeNonce)};
  const BRIDGE_WS = 'ws://localhost:${PORT}?role=overlay' + (BRIDGE_NONCE ? '&nonce=' + encodeURIComponent(BRIDGE_NONCE) : '');
  window.__empir3_outbox = window.__empir3_outbox || [];
  window.__empir3WsOpen = false;
  window.__empir3WsLastOpenAt = 0;
  window.__empir3WsLastCloseAt = 0;
  window.__empir3_inbox = function(jsonStr) {
    // The bridge fans every broadcast out over BOTH the page WebSocket and
    // this CDP mailbox (see broadcastToOverlay). On http/file/same-origin
    // pages the socket connects, so handling the mailbox copy too would
    // double-process every message — e.g. duplicate chat bubbles. The
    // mailbox is the fallback for pages that can't hold a socket (https,
    // CDP-only): only handle it when the socket is not open. Any message
    // missed during a connect race is reconciled by the /api/chat refetch
    // on ws.onopen.
    if (window.__empir3WsOpen) return;
    try { handleServerMessage(JSON.parse(jsonStr)); } catch (_) {}
  };
  let ws = null;
  let chatOpen = false;
  let tabTargetId = '';
  let tabPresenceRole = 'unknown'; // agent | user_focus | available | unknown
  let latestTabState = null;
  const originalTabTitle = document.title || '';
  let originalFaviconHref = null;
  let feedbackMode = false;
  let hoveredEl = null;
  let chatTranscript = [];
  const EMPIR3_BRAND_FONT = "'Outfit', system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  const EMPIR3_BRAND_ACCENT = '#7c5cfc';

  function empir3BrandHtml(suffix) {
    return '<span style="font-family:' + EMPIR3_BRAND_FONT + ';font-weight:900;letter-spacing:-0.03em;color:var(--e3-brand-ink, #f8fafc);">empir<span style="color:' + EMPIR3_BRAND_ACCENT + ';">3</span></span>' + (suffix || '');
  }

  function setBridgeStatus(label, color) {
    const el = document.getElementById('empir3-status-text');
    if (!el) return;
    el.innerHTML = empir3BrandHtml(' <span style="font-weight:600;letter-spacing:0;color:' + (color || 'var(--e3-status-ink, #e2e8f0)') + ';">' + escapeHtml(label || 'Bridge') + '</span>');
  }

  let chatMode = (() => {
    try { return localStorage.getItem('empir3-chat-mode') === 'mcp' ? 'mcp' : 'empir3'; }
    catch (_) { return 'empir3'; }
  })();

  function inferChatMode(msg) {
    if (!msg) return null;
    if (msg.channel === 'mcp' || msg.chatMode === 'mcp') return 'mcp';
    if (msg.channel === 'empir3' || msg.chatMode === 'empir3') return 'empir3';
    if (msg.agentName || msg.agent || msg.projectId) return 'empir3';
    if (msg.from === 'claude') return 'mcp';
    return null;
  }

  function updateChatModeToggle() {
    const mcpBtn = document.getElementById('empir3-mode-mcp');
    const empir3Btn = document.getElementById('empir3-mode-empir3');
    const input = document.getElementById('empir3-chat-input');
    const active = chatMode === 'empir3' ? empir3Btn : mcpBtn;
    const inactive = chatMode === 'empir3' ? mcpBtn : empir3Btn;
    [mcpBtn, empir3Btn].forEach(btn => {
      if (!btn) return;
      btn.style.borderColor = 'var(--e3-btn-border, #334155)';
      btn.style.color = 'var(--e3-btn-ink, #94a3b8)';
      btn.style.background = 'transparent';
    });
    if (active) {
      active.style.borderColor = chatMode === 'empir3' ? '#7c5cfc' : '#38bdf8';
      active.style.color = '#f8fafc';
      active.style.background = chatMode === 'empir3' ? 'rgba(124,92,252,0.22)' : 'rgba(56,189,248,0.16)';
    }
    if (inactive) inactive.setAttribute('aria-pressed', 'false');
    if (active) active.setAttribute('aria-pressed', 'true');
    if (input) {
      input.placeholder = chatMode === 'empir3' ? 'Message empir3 team...' : 'Message Claude / MCP...';
      input.title = chatMode === 'empir3'
        ? 'Sends to the active empir3 team chat'
        : 'Sends to the local MCP/Claude bridge chat';
    }
  }

  function setChatMode(mode, opts) {
    const nextMode = mode === 'mcp' ? 'mcp' : 'empir3';
    const changed = chatMode !== nextMode;
    chatMode = nextMode;
    try { localStorage.setItem('empir3-chat-mode', chatMode); } catch (_) {}
    updateChatModeToggle();
    if (changed) renderChatMessages();
  }

  function syncChatModeFromMessage(msg) {
    const inferred = inferChatMode(msg);
    if (inferred) setChatMode(inferred, { auto: true });
  }

  function openBridgeUi(path) {
    window.location.href = 'http://localhost:${PORT}' + path;
  }
  function bridgeHttpHeaders(extra) {
    const h = Object.assign({}, extra || {});
    if (BRIDGE_NONCE) h['X-Empir3-Nonce'] = BRIDGE_NONCE;
    return h;
  }

  // ─── WebSocket ─────────────────────────────
  function connect() {
    ws = new WebSocket(BRIDGE_WS);
    ws.onopen = () => {
      console.log('[Bridge] Connected');
      window.__empir3WsOpen = true;
      window.__empir3WsLastOpenAt = Date.now();
      updateStatusDot(true);
      announceTabToBridge();
      // Load chat history on reconnect
      fetch('http://localhost:' + ${PORT} + '/api/chat')
        .then(r => r.json())
        .then(msgs => { replaceChatTranscript(Array.isArray(msgs) ? msgs : []); })
        .catch(() => {});
    };
    ws.onclose = () => {
      window.__empir3WsOpen = false;
      window.__empir3WsLastCloseAt = Date.now();
      updateStatusDot(false);
      // Only http / same-origin pages can hold a page-context socket; on https
      // the CDP mailbox carries the overlay, so don't reconnect-storm.
      if (location.protocol !== 'https:') setTimeout(connect, 2000);
    };
    ws.onerror = () => {
      window.__empir3WsOpen = false;
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleServerMessage(msg);
    };
  }

  function send(data) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(data));
    else {
      try { window.__empir3_outbox.push(JSON.stringify(data)); } catch (_) {}
    }
  }

  function currentTabDescriptor() {
    return { url: location.href, title: document.title || originalTabTitle || '' };
  }

  function announceTabToBridge() {
    send(Object.assign({ type:'tab_hello' }, currentTabDescriptor()));
  }

  function ensureOriginalFavicon() {
    if (originalFaviconHref !== null) return;
    const icon = document.querySelector('link[rel~="icon"]');
    originalFaviconHref = icon ? icon.getAttribute('href') || '' : '';
  }

  function setPresenceFavicon(role) {
    ensureOriginalFavicon();
    let icon = document.querySelector('link[rel~="icon"]');
    if (!icon) {
      icon = document.createElement('link');
      icon.setAttribute('rel', 'icon');
      (document.head || document.documentElement).appendChild(icon);
    }
    if (role === 'available' || role === 'unknown') {
      if (originalFaviconHref) icon.setAttribute('href', originalFaviconHref);
      else icon.remove();
      return;
    }
    const agent = role === 'agent';
    const color = agent ? '#7c5cfc' : '#38bdf8';
    const glyph = agent
      ? '<circle cx="16" cy="16" r="9" fill="' + color + '"/><circle cx="16" cy="16" r="4" fill="white"/>'
      : '<circle cx="16" cy="16" r="10" fill="none" stroke="' + color + '" stroke-width="4"/><circle cx="16" cy="16" r="3" fill="' + color + '"/>';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0a0f1e"/>' + glyph + '</svg>';
    icon.setAttribute('href', 'data:image/svg+xml,' + encodeURIComponent(svg));
  }

  function applyTabPresence() {
    const base = originalTabTitle || document.title.replace(/^(● Agent|◎ Focus) - /, '') || 'Bridge tab';
    if (tabPresenceRole === 'agent') {
      document.title = '● Agent - ' + base;
      setPresenceFavicon('agent');
    } else if (tabPresenceRole === 'user_focus') {
      document.title = '◎ Focus - ' + base;
      setPresenceFavicon('user_focus');
    } else {
      document.title = base;
      setPresenceFavicon('available');
    }
    if (typeof syncBubblePresence === 'function') syncBubblePresence();
  }

  function updateTabPresenceFromState(payload) {
    const state = payload?.state || payload || {};
    if (payload?.target?.targetId) tabTargetId = payload.target.targetId;
    latestTabState = state;
    const agent = state.agentControlTarget || null;
    const focus = state.userFocusTarget || null;
    const same = (target) => {
      if (!target) return false;
      if (tabTargetId && target.targetId) return tabTargetId === target.targetId;
      return target.url && target.url === location.href;
    };
    tabPresenceRole = same(agent) ? 'agent' : (same(focus) ? 'user_focus' : 'available');
    applyTabPresence();
  }

  // ─── Handle messages from bridge server ────
  function handleServerMessage(msg) {
    switch(msg.type) {
      case 'tab_state':
      case 'tab_state_update':
        updateTabPresenceFromState(msg);
        break;
      case 'tab_focus_ack':
        if (msg.result) updateTabPresenceFromState(msg.result);
        break;
      case 'claude_working':
        setChatMode('mcp', { auto: true });
        removeWorkingIndicator();
        const wDiv = document.createElement('div');
        wDiv.id = 'empir3-working';
        Object.assign(wDiv.style, { marginBottom:'8px', padding:'10px 14px', borderRadius:'12px', fontSize:'13px',
          color:'var(--e3-msg-meta, #94a3b8)', background:'var(--e3-msg-assistant-bg, #1e3a5f)', maxWidth:'90%', display:'flex', alignItems:'center', gap:'8px' });
        wDiv.innerHTML = '<span style="font-size:11px;color:#93c5fd;font-weight:600;">' + empir3BrandHtml() + '</span>' +
          '<span class="empir3-dots" style="display:inline-flex;gap:3px;">' +
          '<span style="width:5px;height:5px;background:#93c5fd;border-radius:50%;animation:empir3Bounce 1.2s infinite ease-in-out;animation-delay:0s"></span>' +
          '<span style="width:5px;height:5px;background:#93c5fd;border-radius:50%;animation:empir3Bounce 1.2s infinite ease-in-out;animation-delay:0.2s"></span>' +
          '<span style="width:5px;height:5px;background:#93c5fd;border-radius:50%;animation:empir3Bounce 1.2s infinite ease-in-out;animation-delay:0.4s"></span></span>';
        if (!document.getElementById('empir3-bounce-style')) {
          const s = document.createElement('style');
          s.id = 'empir3-bounce-style';
          s.textContent = '@keyframes empir3Bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-4px)}}'
          document.head.appendChild(s);
        }
        chatMessages.appendChild(wDiv);
        scrollToBottom();
        break;
      case 'claude_chat':
        removeWorkingIndicator();
        addChatMessage(msg.message);
        if (!chatOpen) {
          unreadCount++;
          updateBubbleBadge();
          flashChatButton();
        }
        break;
      case 'chat_replace':
        removeWorkingIndicator();
        replaceChatTranscript(Array.isArray(msg.messages) ? msg.messages : []);
        unreadCount = 0;
        updateBubbleBadge();
        break;
      case 'chat_cleared':
        // Wipe chat panel DOM (someone hit Start Fresh — could be us, could be another tab)
        clearChatTranscript();
        unreadCount = 0;
        updateBubbleBadge();
        break;
      case 'chat_ack':
        if (msg.chatMode) setChatMode(msg.chatMode, { auto: true });
        if (msg.screenshot) {
          const msgs = chatMessages.querySelectorAll('div');
          const lastUserMsg = msgs[msgs.length - 1];
          if (lastUserMsg) {
            const img = document.createElement('img');
            img.src = 'http://localhost:' + ${PORT} + '/feedback/' + msg.screenshot;
            Object.assign(img.style, { width:'100%', borderRadius:'8px', marginTop:'6px' });
            img.onload = scrollToBottom;
            lastUserMsg.appendChild(img);
            scrollToBottom();
          }
        }
        if (msg.error) {
          const warn = document.createElement('div');
          Object.assign(warn.style, { margin:'8px 0', padding:'8px 12px', borderRadius:'8px', fontSize:'12px',
            background:'rgba(251,191,36,0.1)', border:'1px solid rgba(251,191,36,0.3)', color:'#fbbf24',
            textAlign:'center', lineHeight:'1.5' });
          warn.innerHTML = '\\u26a0 ' + escapeHtml(msg.error);
          chatMessages.appendChild(warn);
          scrollToBottom();
        }
        break;
      case 'claude_action':
        if (String(msg.action || '').indexOf('click') !== -1) {
          _suppressRecordedClickUntil = Date.now() + 30000;
          _suppressRecordedClickSelector = String(msg.selector || '');
        }
        showActionIndicator(msg.action, msg.selector);
        break;
      case 'claude_stream_start': {
        // Replace the "thinking" dots with an empty bubble that text deltas
        // will append into. Missing this case was THE reason live chat
        // appeared hung — bridge was streaming text but overlay had no
        // handler, so users only saw the persisted reply after refresh.
        removeWorkingIndicator();
        const existing = document.getElementById('empir3-streaming');
        if (existing) existing.remove();
        const sDiv = document.createElement('div');
        sDiv.id = 'empir3-streaming';
        Object.assign(sDiv.style, { marginBottom:'8px', padding:'10px 14px', borderRadius:'12px', fontSize:'13px',
          lineHeight:'1.5', color:'#f1f5f9', background:'#1e3a5f', maxWidth:'90%', marginRight:'auto',
          wordBreak:'break-word', whiteSpace:'pre-wrap' });
        const hdr = '<div style="font-size:11px;color:#94a3b8;margin-bottom:4px;font-weight:500;">' + empir3BrandHtml() + ' \\u00b7 ' + new Date().toLocaleTimeString() + '</div>';
        sDiv.innerHTML = hdr + '<span class="empir3-stream-body" style="color:#e2e8f0;"></span>';
        chatMessages.appendChild(sDiv);
        scrollToBottom();
        break;
      }
      case 'claude_text_delta': {
        let sDiv = document.getElementById('empir3-streaming');
        if (!sDiv) {
          // Fallback: claude_stream_start was dropped/missed. Create the
          // bubble on the fly from the first delta so the message still shows.
          removeWorkingIndicator();
          sDiv = document.createElement('div');
          sDiv.id = 'empir3-streaming';
          Object.assign(sDiv.style, { marginBottom:'8px', padding:'10px 14px', borderRadius:'12px', fontSize:'13px',
            lineHeight:'1.5', color:'#f1f5f9', background:'#1e3a5f', maxWidth:'90%', marginRight:'auto',
            wordBreak:'break-word', whiteSpace:'pre-wrap' });
          const hdr = '<div style="font-size:11px;color:#94a3b8;margin-bottom:4px;font-weight:500;">' + empir3BrandHtml() + ' \\u00b7 ' + new Date().toLocaleTimeString() + '</div>';
          sDiv.innerHTML = hdr + '<span class="empir3-stream-body" style="color:#e2e8f0;"></span>';
          chatMessages.appendChild(sDiv);
        }
        const body = sDiv.querySelector('.empir3-stream-body');
        if (body) body.appendChild(document.createTextNode(msg.text || ''));
        scrollToBottom();
        break;
      }
      case 'claude_message_end': {
        const sDiv = document.getElementById('empir3-streaming');
        if (sDiv) sDiv.removeAttribute('id');  // detach so next stream creates a fresh bubble
        removeWorkingIndicator();  // belt + suspenders if stream produced no text
        if (!chatOpen) { unreadCount++; updateBubbleBadge(); flashChatButton(); }
        break;
      }
      case 'claude_error': {
        removeWorkingIndicator();
        const sDiv = document.getElementById('empir3-streaming');
        if (sDiv) sDiv.removeAttribute('id');
        const eDiv = document.createElement('div');
        Object.assign(eDiv.style, { margin:'8px 0', padding:'8px 12px', borderRadius:'8px', fontSize:'12px',
          background:'rgba(248,113,113,0.1)', border:'1px solid rgba(248,113,113,0.3)', color:'#fca5a5',
          lineHeight:'1.5' });
        eDiv.innerHTML = '\\u26a0 ' + escapeHtml(msg.message || 'Chat error');
        chatMessages.appendChild(eDiv);
        scrollToBottom();
        break;
      }
      case 'claude_tool_use':
      case 'claude_tool_result':
      case 'claude_usage':
        // No-op for now — tool calls + token usage are visible in the
        // bridge log; in-overlay surfacing can land in a later bump.
        break;
      case 'highlight':
        window.__empir3_glowElement?.(msg.selector);
        setTimeout(() => window.__empir3_clearGlow?.(), 3000);
        break;
      case 'navigated':
      case 'refreshed':
        break;
    }
  }

  // ─── AI Cursor ─────────────────────────────
  const cursor = document.createElement('div');
  cursor.id = 'empir3-cursor';
  cursor.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 3l14 8-6 2-3 7z" fill="#3b82f6" stroke="#1e40af" stroke-width="1.5"/><path d="M5 3l14 8-6 2" fill="#60a5fa"/></svg>';
  Object.assign(cursor.style, { position:'fixed', width:'24px', height:'24px', pointerEvents:'none', zIndex:'2147483647',
    transition:'left 0.85s cubic-bezier(0.22,0.85,0.25,1), top 0.85s cubic-bezier(0.22,0.85,0.25,1)',
    filter:'drop-shadow(0 0 8px rgba(59,130,246,0.8)) drop-shadow(0 0 20px rgba(59,130,246,0.4))',
    left:'-50px', top:'-50px' });
  document.body.appendChild(cursor);

  function currentCursorPoint() {
    const r = cursor.getBoundingClientRect();
    return {
      x: Number.isFinite(r.left) && r.left > -40 ? r.left : Math.round(window.innerWidth * 0.5),
      y: Number.isFinite(r.top) && r.top > -40 ? r.top : Math.round(window.innerHeight * 0.5),
    };
  }

  function cursorPulse(x, y, intent) {
    const ring = document.createElement('div');
    Object.assign(ring.style, { position:'fixed', width:'28px', height:'28px', border:'2px solid rgba(96,165,250,0.9)',
      borderRadius:'50%', pointerEvents:'none', zIndex:'2147483646', left:(x - 4)+'px', top:(y - 4)+'px',
      boxShadow:'0 0 18px rgba(59,130,246,0.45)' });
    ring.animate([{ opacity:0.9, transform:'scale(0.65)' }, { opacity:0, transform:'scale(1.8)' }], { duration:760, fill:'forwards' });
    document.body.appendChild(ring);
    setTimeout(() => ring.remove(), 820);
    if (intent === 'focus') {
      cursor.animate([{ transform:'scale(1)' }, { transform:'scale(1.08)' }, { transform:'scale(1)' }], { duration:420 });
    }
  }

  window.__empir3_moveCursor = function(x, y, opts) {
    opts = opts || {};
    x = Math.max(0, Math.min(window.innerWidth - 4, Number(x) || 0));
    y = Math.max(0, Math.min(window.innerHeight - 4, Number(y) || 0));
    const prev = currentCursorPoint();
    const dist = Math.hypot(x - prev.x, y - prev.y);
    const duration = Math.max(650, Math.min(1400, Math.round(420 + dist * 0.65)));
    cursor.style.transitionDuration = duration + 'ms';
    cursor.style.left = x + 'px';
    cursor.style.top = y + 'px';
    return new Promise(resolve => {
      setTimeout(() => {
        cursorPulse(x, y, opts.intent || 'target');
        resolve(true);
      }, duration + 60);
    });
  };

  window.__empir3_agentCursorForSelector = function(selector, intent) {
    try {
      const el = document.querySelector(selector);
      if (!el) return Promise.resolve(false);
      if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded();
      else el.scrollIntoView({ block:'center', inline:'center', behavior:'smooth' });
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + Math.max(6, Math.min(r.width / 2, r.width - 6)));
      const y = Math.round(r.top + Math.max(6, Math.min(r.height / 2, r.height - 6)));
      return window.__empir3_moveCursor(x, y, { intent:intent || 'target' });
    } catch (_) {
      return Promise.resolve(false);
    }
  };

  // ─── Element Glow ──────────────────────────
  let glowingEls = [];
  window.__empir3_glowElement = function(selector) {
    try {
      const el = document.querySelector(selector);
      if (el) {
        el.style.outline = '2px solid rgba(59,130,246,0.8)';
        el.style.outlineOffset = '2px';
        el.style.boxShadow = '0 0 15px rgba(59,130,246,0.4), 0 0 30px rgba(59,130,246,0.2)';
        glowingEls.push(el);
      }
    } catch(e) {}
  };
  window.__empir3_clearGlow = function() {
    glowingEls.forEach(el => { el.style.outline=''; el.style.outlineOffset=''; el.style.boxShadow=''; });
    glowingEls = [];
  };

  // ─── Edge Glow ─────────────────────────────
  const edgeGlow = document.createElement('div');
  edgeGlow.id = 'empir3-edge-glow';
  Object.assign(edgeGlow.style, { position:'fixed', top:0, left:0, right:0, bottom:0, pointerEvents:'none', zIndex:'2147483644',
    boxShadow:'inset 0 0 60px rgba(59,130,246,0.08), inset 0 0 120px rgba(59,130,246,0.03)',
    border:'1px solid rgba(59,130,246,0.15)' });
  edgeGlow.animate([
    { boxShadow:'inset 0 0 60px rgba(59,130,246,0.08)', borderColor:'rgba(59,130,246,0.15)' },
    { boxShadow:'inset 0 0 80px rgba(59,130,246,0.12)', borderColor:'rgba(59,130,246,0.25)' },
    { boxShadow:'inset 0 0 60px rgba(59,130,246,0.08)', borderColor:'rgba(59,130,246,0.15)' }
  ], { duration:3000, iterations:Infinity });
  document.body.appendChild(edgeGlow);

  // ─── Unified Toolbar (draggable) ────────────
  const banner = document.createElement('div');
  banner.id = 'empir3-status-pill';
  Object.assign(banner.style, { position:'fixed', bottom:'8px', left:'50%', transform:'translateX(-50%)',
    padding:'4px 8px', borderRadius:'10px',
    background:'rgba(10,15,30,0.92)', backdropFilter:'blur(12px)', color:'#94a3b8',
    display:'flex', alignItems:'center', gap:'4px',
    fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif', fontSize:'12px', fontWeight:'500',
    zIndex:'2147483645', border:'1px solid rgba(59,130,246,0.2)',
    cursor:'grab', userSelect:'none' });
  const dot = document.createElement('span');
  Object.assign(dot.style, { width:'7px', height:'7px', background:'#4ade80', borderRadius:'50%', flexShrink:'0' });
  dot.animate([{ opacity:1, boxShadow:'0 0 0 0 rgba(74,222,128,0.6)' }, { opacity:0.8, boxShadow:'0 0 0 5px rgba(74,222,128,0)' }],
    { duration:1500, iterations:Infinity });
  const statusText = document.createElement('span');
  statusText.id = 'empir3-status-text';
  Object.assign(statusText.style, { whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:'190px', minWidth:'96px',
    flex:'1 1 128px', color:'#e2e8f0' });
  setBridgeStatus('Bridge');

  // Toolbar button factory
  const _tbBtnStyle = { background:'none', border:'1px solid var(--e3-btn-border, #334155)', color:'var(--e3-btn-ink, #94a3b8)', cursor:'pointer', fontSize:'12px',
    padding:'3px 8px', borderRadius:'6px', display:'flex', alignItems:'center', justifyContent:'center',
    transition:'border-color 0.15s, color 0.15s', whiteSpace:'nowrap', fontWeight:'500', lineHeight:'1' };
  function _mkTbBtn(label, title) {
    const b = document.createElement('button');
    Object.assign(b.style, _tbBtnStyle);
    b.innerHTML = label;
    b.title = title || '';
    b.onmouseenter = () => { if (!b._active) { b.style.borderColor = '#93c5fd'; b.style.color = '#93c5fd'; } };
    b.onmouseleave = () => { if (!b._active) { b.style.borderColor = 'var(--e3-btn-border, #334155)'; b.style.color = 'var(--e3-btn-ink, #94a3b8)'; } };
    b._active = false;
    b._setActive = (on, color) => {
      b._active = on;
      b.style.borderColor = on ? (color || '#3b82f6') : 'var(--e3-btn-border, #334155)';
      b.style.color = on ? (color || '#3b82f6') : 'var(--e3-btn-ink, #94a3b8)';
    };
    return b;
  }
  function _mkSep() {
    const s = document.createElement('span');
    Object.assign(s.style, { width:'1px', height:'16px', background:'rgba(59,130,246,0.2)', margin:'0 2px', flexShrink:'0' });
    return s;
  }

  // Tool buttons
  const pillChatBtn = _mkTbBtn('\\ud83d\\udcac Chat', 'Chat (Ctrl+Shift+C)');
  const pillHomeBtn = _mkTbBtn('Home', 'Open the bridge landing page');
  pillHomeBtn.onclick = (e) => { e.stopPropagation(); openBridgeUi('/welcome'); };
  const pillSettingsBtn = _mkTbBtn('Settings', 'Open bridge settings');
  pillSettingsBtn.onclick = (e) => { e.stopPropagation(); openBridgeUi('/settings'); };
  const pillScreenshotBtn = _mkTbBtn('\\ud83d\\udcf7 Snap', 'Take screenshot');
  const pillAnnotateBtn = _mkTbBtn('\\ud83d\\udccc Annotate', 'Click to annotate element');
  const pillDrawBtn = _mkTbBtn('\\u270e Draw', 'Draw on page');

  // Draw sub-tools (floating dropdown panel, hidden initially)
  const drawSubTools = document.createElement('div');
  drawSubTools.id = 'empir3-draw-panel';
  Object.assign(drawSubTools.style, { display:'none', position:'fixed',
    padding:'8px 10px', borderRadius:'10px',
    background:'rgba(10,15,30,0.92)', backdropFilter:'blur(12px)', border:'1px solid rgba(59,130,246,0.2)',
    boxShadow:'0 8px 24px rgba(0,0,0,0.5)', zIndex:'2147483646',
    flexDirection:'column', alignItems:'center', gap:'6px',
    opacity:'0', transition:'opacity 0.15s ease',
    fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif' });

  const dtPen = _mkTbBtn('\\u270e', 'Pen');
  const dtArrow = _mkTbBtn('\\u2794', 'Arrow');
  const dtCircle = _mkTbBtn('\\u25cb', 'Circle');
  const dtText = _mkTbBtn('A', 'Text');
  const dtUndo = _mkTbBtn('\\u21a9', 'Undo (Ctrl+Z)');
  const dtClear = _mkTbBtn('\\u2715', 'Clear all');
  const dtDone = _mkTbBtn('\\u2713 Done', 'Exit draw mode');
  dtDone.style.color = '#4ade80';
  dtDone.style.borderColor = '#4ade80';

  // Color dots
  const _drawColors = ['#ef4444','#fbbf24','#34d399','#60a5fa','#ffffff'];
  const colorDots = [];
  _drawColors.forEach(c => {
    const d = document.createElement('button');
    Object.assign(d.style, { width:'14px', height:'14px', borderRadius:'50%', background:c, border:'2px solid transparent',
      cursor:'pointer', padding:'0', boxSizing:'border-box', flexShrink:'0' });
    d.onclick = (e) => { e.stopPropagation(); drawColor = c; _updateColorDots(); };
    colorDots.push(d);
  });
  function _updateColorDots() {
    colorDots.forEach((d, i) => { d.style.borderColor = drawColor === _drawColors[i] ? 'white' : 'transparent'; });
  }

  // Assemble draw sub-tools in rows: tool buttons, color dots, action buttons
  const dtToolRow = document.createElement('div');
  Object.assign(dtToolRow.style, { display:'flex', alignItems:'center', gap:'3px' });
  dtToolRow.append(dtPen, dtArrow, dtCircle, dtText);

  const dtColorRow = document.createElement('div');
  Object.assign(dtColorRow.style, { display:'flex', alignItems:'center', gap:'5px', padding:'2px 0' });
  dtColorRow.append(...colorDots);

  const dtActionRow = document.createElement('div');
  Object.assign(dtActionRow.style, { display:'flex', alignItems:'center', gap:'3px' });
  dtActionRow.append(dtUndo, dtClear, dtDone);

  drawSubTools.append(dtToolRow, dtColorRow, dtActionRow);
  // Prevent page handlers when interacting with the draw panel
  drawSubTools.addEventListener('mousedown', (e) => { e.stopPropagation(); });

  // Record/Play buttons
  const pillPlayBtn = _mkTbBtn('\\u25b6 Play', 'Open saved recordings (Ctrl+Shift+P)');
  const pillRecBtn = _mkTbBtn('\\u23fa Rec', 'Record this workflow (Ctrl+Shift+R)');

  // Collapse-to-bubble button
  const pillCollapseBtn = _mkTbBtn('\\u2013', 'Collapse to bubble');
  pillCollapseBtn.style.fontSize = '14px';
  pillCollapseBtn.style.lineHeight = '0.6';
  pillCollapseBtn.style.paddingTop = '0';

  document.body.appendChild(drawSubTools);

  // ─── Collapse-to-bubble ────────────────────
  // Floating bubble shown when toolbar is collapsed. Draggable, position persisted.
  // Unread badge increments on incoming claude_chat while collapsed, clears on expand.
  const bubble = document.createElement('div');
  bubble.id = 'empir3-bubble';
  Object.assign(bubble.style, {
    position:'fixed', display:'none', alignItems:'center', justifyContent:'center',
    width:'44px', height:'44px', borderRadius:'50%',
    background:'rgba(10,15,30,0.92)', backdropFilter:'blur(12px)',
    border:'1px solid rgba(59,130,246,0.4)', boxShadow:'0 4px 16px rgba(0,0,0,0.4)',
    cursor:'grab', zIndex:'2147483645', userSelect:'none',
    transition:'transform 0.12s ease, box-shadow 0.12s ease',
    fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif',
  });
  bubble.innerHTML = '<span style="font-size:20px;line-height:1;">\\ud83d\\udcac</span>';

  const bubbleBadge = document.createElement('span');
  bubbleBadge.id = 'empir3-bubble-badge';
  Object.assign(bubbleBadge.style, {
    position:'absolute', top:'-4px', right:'-4px', minWidth:'18px', height:'18px',
    padding:'0 5px', borderRadius:'9px', background:'#ef4444', color:'white',
    fontSize:'11px', fontWeight:'700', display:'none', alignItems:'center', justifyContent:'center',
    boxShadow:'0 2px 6px rgba(0,0,0,0.4)', boxSizing:'border-box', lineHeight:'1',
  });
  bubbleBadge.textContent = '0';
  bubble.appendChild(bubbleBadge);
  document.body.appendChild(bubble);

  const targetPanel = document.createElement('div');
  targetPanel.id = 'empir3-tab-target-panel';
  Object.assign(targetPanel.style, {
    position:'fixed', display:'none', flexDirection:'column', gap:'8px',
    width:'238px', padding:'12px', borderRadius:'14px',
    background:'rgba(10,15,30,0.96)', backdropFilter:'blur(14px)',
    border:'1px solid rgba(56,189,248,0.32)', boxShadow:'0 12px 36px rgba(0,0,0,0.48)',
    color:'#e2e8f0', zIndex:'2147483646',
    fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif', fontSize:'12px',
  });
  const targetTitle = document.createElement('div');
  targetTitle.textContent = 'This tab is available';
  Object.assign(targetTitle.style, { fontWeight:'700', color:'#f8fafc', fontSize:'13px' });
  const targetSub = document.createElement('div');
  targetSub.textContent = 'Mark it as your focus or hand it to the agent.';
  Object.assign(targetSub.style, { color:'#94a3b8', lineHeight:'1.35' });
  const targetActions = document.createElement('div');
  Object.assign(targetActions.style, { display:'grid', gap:'6px' });
  function mkTargetAction(label, action, primary) {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, {
      width:'100%', border:'1px solid ' + (primary ? '#7c5cfc' : '#334155'),
      background: primary ? 'rgba(124,92,252,0.24)' : 'rgba(15,23,42,0.86)',
      color:'#f8fafc', borderRadius:'8px', padding:'8px 10px', cursor:'pointer',
      fontSize:'12px', fontWeight:'650', textAlign:'left',
    });
    b.onclick = (e) => {
      e.stopPropagation();
      send(Object.assign({ type:'tab_focus', action }, currentTabDescriptor()));
      targetPanel.style.display = 'none';
      if (action === 'control') setBridgeStatus('Handing this tab to agent', '#c4b5fd');
      else setBridgeStatus('Marked as your focus', '#93c5fd');
    };
    return b;
  }
  targetActions.append(
    mkTargetAction('Set as my focus', 'user_focus', false),
    mkTargetAction('Hand this tab to agent', 'control', true)
  );
  const targetChat = mkTargetAction('Open chat without handoff', 'user_focus', false);
  targetChat.onclick = (e) => {
    e.stopPropagation();
    send(Object.assign({ type:'tab_focus', action:'user_focus' }, currentTabDescriptor()));
    targetPanel.style.display = 'none';
    if (!chatOpen) toggleChat();
  };
  targetActions.append(targetChat);
  targetPanel.append(targetTitle, targetSub, targetActions);
  document.body.appendChild(targetPanel);

  // Bubble hover lift
  bubble.addEventListener('mouseenter', () => { bubble.style.transform = 'scale(1.06)'; bubble.style.boxShadow = '0 6px 20px rgba(59,130,246,0.5)'; });
  bubble.addEventListener('mouseleave', () => { bubble.style.transform = ''; bubble.style.boxShadow = '0 4px 16px rgba(0,0,0,0.4)'; });

  // Bubble state + persistence
  let unreadCount = 0;
  function loadBubblePos() {
    try { const p = JSON.parse(localStorage.getItem('empir3_bubble_pos') || 'null'); return p && typeof p.left === 'number' && typeof p.top === 'number' ? p : null; }
    catch { return null; }
  }
  function saveBubblePos(left, top) { try { localStorage.setItem('empir3_bubble_pos', JSON.stringify({ left, top })); } catch {} }
  function clampBubble(left, top) {
    const r = bubble.getBoundingClientRect();
    const w = r.width || 44;
    const h = r.height || 44;
    return {
      left: Math.min(Math.max(0, left), Math.max(0, window.innerWidth - w)),
      top: Math.min(Math.max(0, top), Math.max(0, window.innerHeight - h)),
    };
  }
  function applyBubblePos() {
    const p = loadBubblePos();
    if (p) {
      const clamped = clampBubble(p.left, p.top);
      bubble.style.left = clamped.left + 'px';
      bubble.style.top = clamped.top + 'px';
      bubble.style.right = ''; bubble.style.bottom = '';
    } else {
      bubble.style.right = '16px'; bubble.style.bottom = '16px';
      bubble.style.left = ''; bubble.style.top = '';
    }
  }

  function updateBubbleBadge() {
    if (unreadCount <= 0) { bubbleBadge.style.display = 'none'; return; }
    bubbleBadge.style.display = 'flex';
    bubbleBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
  }

  function syncBubblePresence() {
    const isAgent = tabPresenceRole === 'agent';
    const isFocus = tabPresenceRole === 'user_focus';
    bubble.innerHTML = '<span style="font-size:20px;line-height:1;">' + (isAgent ? '\\ud83d\\udcac' : '◎') + '</span>';
    bubble.appendChild(bubbleBadge);
    bubble.title = isAgent
      ? 'Agent is controlling this tab. Click to open chat.'
      : (isFocus ? 'This is your focus tab. Click for tab handoff options.' : 'Bridge is available on this tab. Click to target or hand off.');
    bubble.style.borderColor = isAgent ? 'rgba(124,92,252,0.58)' : (isFocus ? 'rgba(56,189,248,0.7)' : 'rgba(56,189,248,0.42)');
    bubble.style.boxShadow = isAgent
      ? '0 4px 18px rgba(124,92,252,0.48)'
      : (isFocus ? '0 4px 18px rgba(56,189,248,0.42)' : '0 4px 16px rgba(0,0,0,0.4)');
  }

  function toggleTargetPanel() {
    if (targetPanel.style.display === 'flex') {
      targetPanel.style.display = 'none';
      return;
    }
    const r = bubble.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left - 194), Math.max(8, window.innerWidth - 250));
    const top = Math.min(Math.max(8, r.top - 142), Math.max(8, window.innerHeight - 168));
    targetPanel.style.left = left + 'px';
    targetPanel.style.top = top + 'px';
    targetTitle.textContent = tabPresenceRole === 'user_focus' ? 'This tab is your focus' : 'Target this tab';
    targetPanel.style.display = 'flex';
  }

  function syncBubbleVisibility() {
    if (chatOpen) {
      bubble.style.display = 'none';
      unreadCount = 0;
      updateBubbleBadge();
    } else {
      applyBubblePos();
      bubble.style.display = 'flex';
      syncBubblePresence();
    }
  }
  window.addEventListener('resize', () => {
    if (chatOpen) return;
    const r = bubble.getBoundingClientRect();
    const clamped = clampBubble(r.left, r.top);
    bubble.style.left = clamped.left + 'px';
    bubble.style.top = clamped.top + 'px';
    bubble.style.right = ''; bubble.style.bottom = '';
    saveBubblePos(clamped.left, clamped.top);
  });

  // Bubble drag — distinguishes click (no movement) from drag, click expands
  let _bDragging = false, _bMoved = false, _bOffX = 0, _bOffY = 0;
  bubble.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    _bDragging = true; _bMoved = false;
    const r = bubble.getBoundingClientRect();
    _bOffX = e.clientX - r.left; _bOffY = e.clientY - r.top;
    bubble.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!_bDragging) return;
    if (!_bMoved && (Math.abs(e.clientX - (_bOffX + bubble.getBoundingClientRect().left)) > 3 || Math.abs(e.clientY - (_bOffY + bubble.getBoundingClientRect().top)) > 3)) {
      _bMoved = true;
    }
    const left = e.clientX - _bOffX;
    const top = e.clientY - _bOffY;
    bubble.style.left = left + 'px'; bubble.style.top = top + 'px';
    bubble.style.right = ''; bubble.style.bottom = '';
  });
  document.addEventListener('mouseup', (e) => {
    if (!_bDragging) return;
    _bDragging = false;
    bubble.style.cursor = 'grab';
    if (_bMoved) {
      const r = bubble.getBoundingClientRect();
      const clampedL = Math.min(Math.max(0, r.left), window.innerWidth - r.width);
      const clampedT = Math.min(Math.max(0, r.top), window.innerHeight - r.height);
      bubble.style.left = clampedL + 'px'; bubble.style.top = clampedT + 'px';
      saveBubblePos(clampedL, clampedT);
    } else {
      // True click (no drag). Agent-owned tab opens chat; other tabs show
      // explicit focus/handoff actions so browsing never steals control.
      if (tabPresenceRole === 'agent') {
        if (!chatOpen) toggleChat();
      } else {
        toggleTargetPanel();
      }
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (targetPanel.style.display !== 'flex') return;
    if (targetPanel.contains(e.target) || bubble.contains(e.target)) return;
    targetPanel.style.display = 'none';
  });

  // Closed state is bubble-only; the old floating bottom toolbar is intentionally not mounted.
  applyBubblePos();
  syncBubblePresence();
  bubble.style.display = 'flex';

  function updateStatusDot(connected) {
    dot.style.background = connected ? '#4ade80' : '#ef4444';
    if (connected) setBridgeStatus('Bridge');
    else statusText.textContent = 'Bridge Disconnected';
  }

  function showActionIndicator(action, selector) {
    setBridgeStatus('is ' + action + (selector ? ': ' + selector.slice(0,30) : ''));
    setTimeout(() => { setBridgeStatus('Bridge'); }, 3000);
  }

  // ─── Chat Panel ────────────────────────────
  let chatSide = 'right'; // 'left' or 'right'
  let chatWidth = 380;
  const MIN_CHAT_WIDTH = 280;
  const MAX_CHAT_WIDTH = 700;
  const MIN_PAGE_WIDTH = 360;
  const VIEWPORT_SAFE_GUTTER = 12;

  function visibleViewportWidth() {
    const inner = window.innerWidth || MIN_CHAT_WIDTH;
    const client = document.documentElement?.clientWidth || inner;
    return Math.max(220, Math.min(inner, client));
  }

  function clampChatWidth(width) {
    const viewport = Math.max(visibleViewportWidth(), MIN_CHAT_WIDTH);
    const viewportMax = Math.max(220, viewport - VIEWPORT_SAFE_GUTTER);
    const maxForViewport = viewport > MIN_PAGE_WIDTH + MIN_CHAT_WIDTH + VIEWPORT_SAFE_GUTTER
      ? Math.min(MAX_CHAT_WIDTH, viewportMax, viewport - MIN_PAGE_WIDTH)
      : Math.min(MAX_CHAT_WIDTH, viewportMax);
    const minForViewport = Math.min(MIN_CHAT_WIDTH, maxForViewport);
    return Math.max(minForViewport, Math.min(maxForViewport, Math.round(width || chatWidth)));
  }

  const chatPanel = document.createElement('div');
  chatPanel.id = 'empir3-chat-panel';
  Object.assign(chatPanel.style, { position:'fixed', right:'-380px', top:0, bottom:0, width:chatWidth + 'px',
    background:'var(--e3-panel-bg, #0a0f1e)', borderLeft:'2px solid rgba(59,130,246,0.4)', zIndex:'2147483643',
    display:'flex', flexDirection:'column', transition:'right 0.3s ease, left 0.3s ease',
    fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif', boxShadow:'-4px 0 20px rgba(0,0,0,0.5)',
    maxWidth:'calc(100vw - ' + VIEWPORT_SAFE_GUTTER + 'px)', overflow:'hidden' });

  function applyChatWidth(width) {
    chatWidth = clampChatWidth(width);
    chatPanel.style.width = chatWidth + 'px';
    return chatWidth;
  }

  // ─── Drag-to-resize handle ────────────────
  const resizeHandle = document.createElement('div');
  Object.assign(resizeHandle.style, { position:'absolute', top:0, width:'6px', height:'100%',
    cursor:'col-resize', zIndex:'2147483644', background:'rgba(59,130,246,0.12)' });
  resizeHandle.style.left = '0';
  resizeHandle.onmouseenter = () => { resizeHandle.style.background = 'rgba(59,130,246,0.4)'; };
  resizeHandle.onmouseleave = () => { if (!resizing) resizeHandle.style.background = 'rgba(59,130,246,0.12)'; };
  chatPanel.appendChild(resizeHandle);

  let resizing = false;
  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizing = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
      const newWidth = chatSide === 'right'
        ? window.innerWidth - ev.clientX
        : ev.clientX;
      applyChatWidth(newWidth);
      chatPanel.style.transition = 'none';
      pushPage(true);
    };
    const onUp = () => {
      resizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      resizeHandle.style.background = 'rgba(59,130,246,0.12)';
      chatPanel.style.transition = 'right 0.3s ease, left 0.3s ease';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  const chatHeader = document.createElement('div');
  Object.assign(chatHeader.style, { padding:'8px 10px', borderBottom:'1px solid var(--e3-divider, #1e293b)', display:'flex', flexDirection:'column', alignItems:'stretch', gap:'6px', minWidth:'0', overflow:'hidden' });
  const chatIdentity = document.createElement('div');
  Object.assign(chatIdentity.style, { display:'flex', alignItems:'center', gap:'6px', minWidth:'0', width:'100%', flexWrap:'wrap' });
  chatIdentity.append(dot, statusText);
  const modeSwitch = document.createElement('div');
  modeSwitch.id = 'empir3-chat-mode-switch';
  Object.assign(modeSwitch.style, { display:'flex', alignItems:'center', gap:'2px', padding:'2px', border:'1px solid var(--e3-divider, #1e293b)',
    borderRadius:'999px', background:'var(--e3-mode-switch-bg, rgba(15,23,42,0.72))', flexShrink:'0' });
  const modeMcpBtn = document.createElement('button');
  modeMcpBtn.id = 'empir3-mode-mcp';
  modeMcpBtn.textContent = 'MCP';
  modeMcpBtn.title = 'Claude / local MCP chat';
  const modeEmpir3Btn = document.createElement('button');
  modeEmpir3Btn.id = 'empir3-mode-empir3';
  modeEmpir3Btn.innerHTML = 'empir<span style="color:#7c5cfc;">3</span>';
  modeEmpir3Btn.title = 'empir3 team chat';
  [modeMcpBtn, modeEmpir3Btn].forEach(btn => {
    Object.assign(btn.style, { border:'1px solid var(--e3-btn-border, #334155)', background:'transparent', color:'var(--e3-btn-ink, #94a3b8)', cursor:'pointer',
      fontSize:'11px', fontWeight:'700', padding:'3px 8px', borderRadius:'999px', lineHeight:'1', whiteSpace:'nowrap',
      fontFamily:'inherit' });
    btn.onclick = (e) => { e.stopPropagation(); setChatMode(btn === modeMcpBtn ? 'mcp' : 'empir3', { user: true }); };
  });
  modeSwitch.append(modeMcpBtn, modeEmpir3Btn);
  chatIdentity.appendChild(modeSwitch);
  const chatHeaderActions = document.createElement('div');
  Object.assign(chatHeaderActions.style, { display:'flex', alignItems:'center', justifyContent:'flex-end', gap:'4px', marginLeft:'auto', flex:'0 0 auto', minWidth:'0' });

  // Start Fresh button — wipes chat history server-side + all overlays
  const freshBtn = document.createElement('button');
  Object.assign(freshBtn.style, { background:'none', border:'1px solid var(--e3-btn-border, #334155)', color:'var(--e3-btn-ink-dim, #64748b)', cursor:'pointer', fontSize:'11px',
    padding:'3px 7px', borderRadius:'4px', whiteSpace:'nowrap', lineHeight:'1.2' });
  freshBtn.textContent = 'Fresh';
  freshBtn.title = 'Refresh / clear chat history (cannot be undone)';
  freshBtn.onmouseenter = () => { freshBtn.style.borderColor = '#fbbf24'; freshBtn.style.color = '#fbbf24'; };
  freshBtn.onmouseleave = () => { freshBtn.style.borderColor = 'var(--e3-btn-border, #334155)'; freshBtn.style.color = 'var(--e3-btn-ink-dim, #64748b)'; };
  freshBtn.onclick = () => {
    if (!confirm('Start fresh? This clears all chat history and cannot be undone.')) return;
    fetch('http://localhost:' + ${PORT} + '/api/chat', { method: 'DELETE' }).catch(() => {});
  };
  chatHeaderActions.appendChild(freshBtn);

  // Day / night toggle — flips the panel between dark (default) and light.
  const themeBtn = document.createElement('button');
  Object.assign(themeBtn.style, { background:'none', border:'1px solid var(--e3-btn-border, #334155)', color:'var(--e3-btn-ink-dim, #64748b)', cursor:'pointer', fontSize:'12px',
    padding:'3px 7px', borderRadius:'4px', whiteSpace:'nowrap', lineHeight:'1.2' });
  themeBtn.onmouseenter = () => { themeBtn.style.borderColor = '#93c5fd'; themeBtn.style.color = '#93c5fd'; };
  themeBtn.onmouseleave = () => { themeBtn.style.borderColor = 'var(--e3-btn-border, #334155)'; themeBtn.style.color = 'var(--e3-btn-ink-dim, #64748b)'; };
  function applyChatTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    chatPanel.setAttribute('data-empir3-theme', t);
    try { localStorage.setItem('empir3-chat-theme', t); } catch (_) {}
    themeBtn.textContent = t === 'light' ? '\\ud83c\\udf19' : '\\u2600\\ufe0f';
    themeBtn.title = t === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
  }
  themeBtn.onclick = (e) => { e.stopPropagation(); applyChatTheme(chatPanel.getAttribute('data-empir3-theme') === 'light' ? 'dark' : 'light'); };
  chatHeaderActions.appendChild(themeBtn);

  // Switch side button
  const sideBtn = document.createElement('button');
  Object.assign(sideBtn.style, { background:'none', border:'1px solid var(--e3-btn-border, #334155)', color:'var(--e3-btn-ink-dim, #64748b)', cursor:'pointer', fontSize:'11px',
    padding:'3px 7px', borderRadius:'4px', whiteSpace:'nowrap', lineHeight:'1.2' });
  sideBtn.textContent = '\\u21c4 Side';
  sideBtn.title = 'Move chat to other side';
  sideBtn.onmouseenter = () => { sideBtn.style.borderColor = '#93c5fd'; sideBtn.style.color = '#93c5fd'; };
  sideBtn.onmouseleave = () => { sideBtn.style.borderColor = 'var(--e3-btn-border, #334155)'; sideBtn.style.color = 'var(--e3-btn-ink-dim, #64748b)'; };
  sideBtn.onclick = () => switchSide();
  chatHeaderActions.appendChild(sideBtn);

  const closeBtn = document.createElement('button');
  Object.assign(closeBtn.style, { background:'none', border:'1px solid var(--e3-btn-border, #334155)', borderRadius:'4px', color:'var(--e3-btn-ink-dim, #64748b)', cursor:'pointer',
    fontSize:'16px', width:'24px', height:'24px', padding:'0', lineHeight:'20px', flex:'0 0 24px' });
  closeBtn.textContent = '\\u2715';
  closeBtn.title = 'Close chat';
  closeBtn.onclick = () => toggleChat();
  chatHeaderActions.appendChild(closeBtn);
  chatIdentity.appendChild(chatHeaderActions);
  chatHeader.appendChild(chatIdentity);
  chatPanel.appendChild(chatHeader);

  const chatToolbar = document.createElement('div');
  chatToolbar.id = 'empir3-status-pill';
  Object.assign(chatToolbar.style, { padding:'6px 10px', borderBottom:'1px solid var(--e3-divider, #1e293b)',
    display:'flex', alignItems:'center', gap:'4px', flexWrap:'wrap',
    background:'var(--e3-toolbar-bg, rgba(15,23,42,0.6))' });
  chatToolbar.append(pillHomeBtn, pillSettingsBtn, _mkSep(), pillScreenshotBtn, pillAnnotateBtn, pillDrawBtn, _mkSep(), pillPlayBtn, pillRecBtn);
  chatPanel.appendChild(chatToolbar);

  const chatMessages = document.createElement('div');
  chatMessages.id = 'empir3-chat-messages';
  Object.assign(chatMessages.style, { flex:'1', overflowY:'auto', padding:'12px' });
  chatPanel.appendChild(chatMessages);

  const chatInputArea = document.createElement('div');
  Object.assign(chatInputArea.style, { padding:'12px', borderTop:'1px solid var(--e3-divider, #1e293b)', display:'flex', flexDirection:'column', gap:'8px' });

  // Screenshot checkbox (hidden, controlled by toolbar snap button state)
  const screenshotCheck = document.createElement('input');
  screenshotCheck.type = 'checkbox';
  screenshotCheck.id = 'empir3-include-ss';
  screenshotCheck.checked = true;
  screenshotCheck.style.display = 'none';

  // Annotate state holder (replaces checkbox)
  const annotateCheck = { checked: false };

  // ─── Drawing Canvas System ────────────────
  let drawMode = false;
  let drawTool = 'pen'; // 'pen', 'arrow', 'circle', 'text'
  let drawColor = '#ef4444';
  let drawCanvas = null;
  let drawCtx = null;
  let isDrawing = false;
  let drawStartX = 0, drawStartY = 0;
  let drawSnapshot = null;

  // Undo history — stores canvas ImageData snapshots (max 20)
  const drawHistory = [];
  const DRAW_HISTORY_MAX = 20;
  function pushDrawHistory() {
    if (!drawCtx || !drawCanvas) return;
    drawHistory.push(drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height));
    if (drawHistory.length > DRAW_HISTORY_MAX) drawHistory.shift();
  }
  function undoDraw() {
    if (!drawCtx || !drawCanvas || drawHistory.length === 0) return;
    const prev = drawHistory.pop();
    drawCtx.putImageData(prev, 0, 0);
  }

  function createDrawCanvas() {
    if (drawCanvas) return;
    drawCanvas = document.createElement('canvas');
    drawCanvas.id = 'empir3-draw-canvas';
    drawCanvas.width = window.innerWidth;
    drawCanvas.height = window.innerHeight;
    Object.assign(drawCanvas.style, { position:'fixed', top:0, left:0, width:'100vw', height:'100vh',
      zIndex:'2147483640', pointerEvents:'none', cursor:'crosshair' });
    document.body.appendChild(drawCanvas);
    drawCtx = drawCanvas.getContext('2d');
    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';

    // Resize handler
    window.addEventListener('resize', () => {
      if (!drawCanvas) return;
      const imgData = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
      drawCanvas.width = window.innerWidth;
      drawCanvas.height = window.innerHeight;
      drawCtx.putImageData(imgData, 0, 0);
      drawCtx.lineCap = 'round';
      drawCtx.lineJoin = 'round';
    });
  }

  function _updateDrawSubTools() {
    [dtPen, dtArrow, dtCircle, dtText].forEach(b => b._setActive(false));
    if (drawTool === 'pen') dtPen._setActive(true, '#ef4444');
    if (drawTool === 'arrow') dtArrow._setActive(true, '#ef4444');
    if (drawTool === 'circle') dtCircle._setActive(true, '#ef4444');
    if (drawTool === 'text') dtText._setActive(true, '#ef4444');
    _updateColorDots();
  }

  dtPen.onclick = (e) => { e.stopPropagation(); drawTool = 'pen'; if (drawCanvas) drawCanvas.style.cursor = 'crosshair'; _updateDrawSubTools(); };
  dtArrow.onclick = (e) => { e.stopPropagation(); drawTool = 'arrow'; if (drawCanvas) drawCanvas.style.cursor = 'crosshair'; _updateDrawSubTools(); };
  dtCircle.onclick = (e) => { e.stopPropagation(); drawTool = 'circle'; if (drawCanvas) drawCanvas.style.cursor = 'crosshair'; _updateDrawSubTools(); };
  dtText.onclick = (e) => { e.stopPropagation(); drawTool = 'text'; if (drawCanvas) drawCanvas.style.cursor = 'text'; _updateDrawSubTools(); };
  dtUndo.onclick = (e) => { e.stopPropagation(); undoDraw(); };
  dtClear.onclick = (e) => { e.stopPropagation(); if (drawCtx) { pushDrawHistory(); drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height); } };
  dtDone.onclick = (e) => { e.stopPropagation(); toggleDrawMode(); };

  function toggleDrawMode() {
    drawMode = !drawMode;
    if (drawMode) {
      createDrawCanvas();
      drawCanvas.style.pointerEvents = 'auto';
      drawCanvas.style.cursor = drawTool === 'text' ? 'text' : 'crosshair';
      drawSubTools.style.display = 'flex';
      const r = pillDrawBtn.getBoundingClientRect();
      const panelW = 260;
      const panelH = drawSubTools.offsetHeight || 120;
      drawSubTools.style.left = Math.max(8, Math.min(window.innerWidth - panelW - 8, r.left)) + 'px';
      drawSubTools.style.top = Math.max(8, r.top - panelH - 8) + 'px';
      drawSubTools.style.right = '';
      drawSubTools.style.bottom = '';
      requestAnimationFrame(() => { drawSubTools.style.opacity = '1'; });
      pillDrawBtn._setActive(true, '#ef4444');
      pillDrawBtn.innerHTML = '\\u270e Drawing';
      screenshotCheck.checked = true;
      // Exit annotate mode if active
      if (feedbackMode) { feedbackMode = false; annotateCheck.checked = false; document.body.style.cursor = ''; pillAnnotateBtn._setActive(false); if (hoveredEl) { hoveredEl.style.outline = ''; hoveredEl.style.outlineOffset = ''; hoveredEl = null; } }
      _updateDrawSubTools();
    } else {
      if (drawCanvas) drawCanvas.style.pointerEvents = 'none';
      drawSubTools.style.opacity = '0';
      setTimeout(() => { if (!drawMode) drawSubTools.style.display = 'none'; }, 150);
      pillDrawBtn._setActive(false);
      pillDrawBtn.innerHTML = '\\u270e Draw';
    }
  }

  pillDrawBtn.onclick = (e) => { e.stopPropagation(); toggleDrawMode(); };

  // Drawing event handlers (delegated to document, filtered by draw mode)
  document.addEventListener('mousedown', (e) => {
    if (!drawMode || !drawCanvas || e.target.closest('#empir3-status-pill') || e.target.closest('#empir3-chat-panel') || e.target.closest('.empir3-text-input')) return;

    if (drawTool === 'text') {
      e.preventDefault();
      e.stopPropagation();
      // Remove any existing text input
      const old = document.querySelector('.empir3-text-input');
      if (old) old.remove();
      // Create inline text input at click position
      const inp = document.createElement('input');
      inp.className = 'empir3-text-input';
      inp.type = 'text';
      inp.placeholder = 'Type here...';
      Object.assign(inp.style, { position:'fixed', left: e.clientX + 'px', top: (e.clientY - 12) + 'px',
        background:'rgba(0,0,0,0.7)', border:'1px solid ' + drawColor, borderRadius:'4px',
        color: drawColor, fontSize:'16px', fontWeight:'700', fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif',
        padding:'2px 6px', outline:'none', zIndex:'2147483647', minWidth:'60px',
        caretColor: drawColor });
      document.body.appendChild(inp);
      inp.focus();
      const commitText = () => {
        const val = inp.value.trim();
        if (val && drawCtx) {
          pushDrawHistory();
          drawCtx.font = '700 16px -apple-system, BlinkMacSystemFont, sans-serif';
          drawCtx.fillStyle = drawColor;
          // Text shadow for readability
          drawCtx.strokeStyle = 'rgba(0,0,0,0.8)';
          drawCtx.lineWidth = 3;
          drawCtx.strokeText(val, e.clientX, e.clientY);
          drawCtx.fillText(val, e.clientX, e.clientY);
        }
        inp.remove();
      };
      inp.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') { ke.preventDefault(); commitText(); }
        if (ke.key === 'Escape') inp.remove();
      });
      inp.addEventListener('blur', commitText);
      return;
    }

    isDrawing = true;
    drawStartX = e.clientX;
    drawStartY = e.clientY;
    pushDrawHistory();
    if (drawTool === 'pen') {
      drawCtx.beginPath();
      drawCtx.strokeStyle = drawColor;
      drawCtx.lineWidth = 3;
      drawCtx.moveTo(e.clientX, e.clientY);
    } else {
      // Save canvas state for live preview
      drawSnapshot = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
    }
  }, true);

  function drawArrowAt(sx, sy, ex, ey) {
    drawCtx.strokeStyle = drawColor;
    drawCtx.lineWidth = 3;
    drawCtx.fillStyle = drawColor;
    drawCtx.beginPath();
    drawCtx.moveTo(sx, sy);
    drawCtx.lineTo(ex, ey);
    drawCtx.stroke();
    const angle = Math.atan2(ey - sy, ex - sx);
    const headLen = 16;
    drawCtx.beginPath();
    drawCtx.moveTo(ex, ey);
    drawCtx.lineTo(ex - headLen * Math.cos(angle - Math.PI / 6), ey - headLen * Math.sin(angle - Math.PI / 6));
    drawCtx.lineTo(ex - headLen * Math.cos(angle + Math.PI / 6), ey - headLen * Math.sin(angle + Math.PI / 6));
    drawCtx.closePath();
    drawCtx.fill();
  }

  function drawCircleAt(sx, sy, ex, ey) {
    const rx = Math.abs(ex - sx) / 2;
    const ry = Math.abs(ey - sy) / 2;
    const cx = (sx + ex) / 2;
    const cy = (sy + ey) / 2;
    drawCtx.strokeStyle = drawColor;
    drawCtx.lineWidth = 3;
    drawCtx.beginPath();
    drawCtx.ellipse(cx, cy, Math.max(rx, 5), Math.max(ry, 5), 0, 0, Math.PI * 2);
    drawCtx.stroke();
  }

  document.addEventListener('mousemove', (e) => {
    if (!isDrawing || !drawMode) return;
    if (drawTool === 'pen') {
      drawCtx.lineTo(e.clientX, e.clientY);
      drawCtx.stroke();
    } else if (drawSnapshot) {
      // Live preview: restore snapshot then draw shape at current position
      drawCtx.putImageData(drawSnapshot, 0, 0);
      if (drawTool === 'arrow') drawArrowAt(drawStartX, drawStartY, e.clientX, e.clientY);
      if (drawTool === 'circle') drawCircleAt(drawStartX, drawStartY, e.clientX, e.clientY);
    }
  }, true);

  document.addEventListener('mouseup', (e) => {
    if (!isDrawing || !drawMode) return;
    isDrawing = false;
    const endX = e.clientX, endY = e.clientY;

    // Final commit — restore snapshot first to avoid double-draw from last mousemove
    if (drawSnapshot && drawTool !== 'pen') {
      drawCtx.putImageData(drawSnapshot, 0, 0);
      drawSnapshot = null;
    }

    if (drawTool === 'arrow') drawArrowAt(drawStartX, drawStartY, endX, endY);
    if (drawTool === 'circle') drawCircleAt(drawStartX, drawStartY, endX, endY);
  }, true);

  const inputRow = document.createElement('div');
  Object.assign(inputRow.style, { display:'flex', gap:'8px' });

  const chatInput = document.createElement('textarea');
  chatInput.id = 'empir3-chat-input';
  chatInput.placeholder = 'Message empir3... (Shift+Enter for newline)';
  Object.assign(chatInput.style, { flex:'1', background:'var(--e3-input-bg, #1e293b)', border:'1px solid var(--e3-input-border, #334155)', borderRadius:'8px',
    color:'var(--e3-input-ink, #e2e8f0)', padding:'8px 12px', fontSize:'13px', resize:'none', height:'38px', maxHeight:'120px',
    fontFamily:'inherit', lineHeight:'1.4' });
  chatInput.addEventListener('focus', () => { chatInput.style.borderColor = '#3b82f6'; });
  chatInput.addEventListener('blur', () => { chatInput.style.borderColor = 'var(--e3-input-border, #334155)'; });
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });

  const sendBtn = document.createElement('button');
  Object.assign(sendBtn.style, { padding:'8px 16px', background:'#3b82f6', color:'white', border:'none',
    borderRadius:'8px', cursor:'pointer', fontWeight:'500', fontSize:'13px', whiteSpace:'nowrap', alignSelf:'flex-end' });
  sendBtn.textContent = 'Send';
  sendBtn.onmouseenter = () => { sendBtn.style.background = '#2563eb'; };
  sendBtn.onmouseleave = () => { sendBtn.style.background = '#3b82f6'; };
  sendBtn.onclick = sendChatMessage;

  inputRow.append(chatInput, sendBtn);
  chatInputArea.appendChild(inputRow);
  chatPanel.appendChild(chatInputArea);
  document.body.appendChild(chatPanel);
  applyChatTheme((function(){ try { return localStorage.getItem('empir3-chat-theme') === 'light' ? 'light' : 'dark'; } catch (_) { return 'dark'; } })());
  updateChatModeToggle();

  // ─── Annotation mode (multi-annotation) ───────────────────────
  // NOTE: annotationListContainer is created below and inserted before inputRow after definition
  let annotations = []; // Array of { id, selector, elementHtml, comment, badgeEl, markerEl, rect }
  let _annotationNextId = 1;

  // Container for annotation markers in chat input area
  const annotationListContainer = document.createElement('div');
  annotationListContainer.className = 'annotation-list-container';
  Object.assign(annotationListContainer.style, { display:'none', maxHeight:'120px', overflowY:'auto',
    borderTop:'1px solid #1e293b', paddingTop:'4px', marginBottom:'4px' });
  chatInputArea.insertBefore(annotationListContainer, inputRow);

  function _renderAnnotationList() {
    annotationListContainer.innerHTML = '';
    if (annotations.length === 0) {
      annotationListContainer.style.display = 'none';
      return;
    }
    annotationListContainer.style.display = 'block';
    annotations.forEach((ann, idx) => {
      const row = document.createElement('div');
      Object.assign(row.style, { background:'#1e293b', border:'1px solid #f97316', borderRadius:'6px',
        padding:'4px 8px', fontSize:'11px', color:'#fb923c', marginBottom:'3px', display:'flex',
        justifyContent:'space-between', alignItems:'center', cursor:'pointer', gap:'6px' });
      const label = document.createElement('span');
      label.style.overflow = 'hidden'; label.style.textOverflow = 'ellipsis'; label.style.whiteSpace = 'nowrap'; label.style.flex = '1';
      label.textContent = '\\ud83d\\udccc ' + (idx + 1) + '. ' + ann.comment + ' [' + ann.selector.slice(0, 25) + ']';
      label.onclick = () => {
        // Scroll to element and flash highlight
        try {
          const target = document.querySelector(ann.selector);
          if (target) { target.scrollIntoView({ behavior:'smooth', block:'center' }); target.style.outline = '3px solid #f97316'; setTimeout(() => { target.style.outline = ''; }, 1500); }
        } catch(_) {}
      };
      const removeBtn = document.createElement('span');
      removeBtn.textContent = '\\u2715';
      removeBtn.style.cursor = 'pointer'; removeBtn.style.flexShrink = '0'; removeBtn.style.padding = '0 2px';
      removeBtn.onclick = (ev) => { ev.stopPropagation(); _removeAnnotation(ann.id); };
      row.appendChild(label);
      row.appendChild(removeBtn);
      ann.markerEl = row;
      annotationListContainer.appendChild(row);
    });
  }

  function _removeAnnotation(id) {
    const idx = annotations.findIndex(a => a.id === id);
    if (idx === -1) return;
    const ann = annotations[idx];
    if (ann.badgeEl) ann.badgeEl.remove();
    annotations.splice(idx, 1);
    // Renumber remaining badges
    annotations.forEach((a, i) => { if (a.badgeEl) a.badgeEl.textContent = String(i + 1); });
    _renderAnnotationList();
    _renderAnnotationsOnCanvas();
  }

  function _clearAllAnnotations() {
    annotations.forEach(a => { if (a.badgeEl) a.badgeEl.remove(); });
    annotations.length = 0;
    _annotationNextId = 1;
    _renderAnnotationList();
  }

  function _renderAnnotationsOnCanvas() {
    // Re-render all annotation badges on canvas for screenshots
    if (!drawCanvas || !drawCtx) return;
    // Note: we don't clear the whole canvas here to preserve drawings.
    // Annotations are rendered fresh each time one is added/removed.
    // This is additive — for a clean screenshot, annotations are rendered at send time.
  }

  function _renderAnnotationBadgeOnCanvas(ann, num) {
    if (!drawCanvas || !drawCtx) return;
    createDrawCanvas(); // ensure canvas exists
    const r = ann.rect;
    // Draw numbered circle
    const cx = r.right - 4;
    const cy = Math.max(r.top - 4, 12);
    drawCtx.beginPath();
    drawCtx.arc(cx, cy, 12, 0, Math.PI * 2);
    drawCtx.fillStyle = 'rgba(249,115,22,0.9)';
    drawCtx.fill();
    drawCtx.fillStyle = 'white';
    drawCtx.font = '700 12px -apple-system, BlinkMacSystemFont, sans-serif';
    drawCtx.textAlign = 'center';
    drawCtx.textBaseline = 'middle';
    drawCtx.fillText(String(num), cx, cy);
    drawCtx.textAlign = 'start';
    drawCtx.textBaseline = 'alphabetic';
    // Draw comment label
    if (ann.comment) {
      const labelX = cx + 16;
      const labelY = cy;
      drawCtx.font = '700 11px -apple-system, BlinkMacSystemFont, sans-serif';
      const tw = drawCtx.measureText(ann.comment).width;
      drawCtx.fillStyle = 'rgba(249,115,22,0.85)';
      drawCtx.fillRect(labelX - 2, labelY - 8, tw + 8, 16);
      drawCtx.fillStyle = 'white';
      drawCtx.fillText(ann.comment, labelX + 2, labelY + 4);
    }
  }

  function toggleAnnotateMode() {
    feedbackMode = !feedbackMode;
    annotateCheck.checked = feedbackMode;
    document.body.style.cursor = feedbackMode ? 'crosshair' : '';
    pillAnnotateBtn._setActive(feedbackMode, '#f97316');
    // Exit draw mode if active
    if (feedbackMode && drawMode) toggleDrawMode();
    if (!feedbackMode) {
      // Clean up hoveredEl outline
      if (hoveredEl) { hoveredEl.style.outline = ''; hoveredEl.style.outlineOffset = ''; hoveredEl = null; }
      // Remove any floating annotation comment input
      document.querySelectorAll('.empir3-annotation-input').forEach(el => el.remove());
    }
  }

  pillAnnotateBtn.onclick = (e) => { e.stopPropagation(); toggleAnnotateMode(); };

  document.addEventListener('mousemove', (e) => {
    if (!feedbackMode) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== hoveredEl && !el.closest('#empir3-chat-panel') && !el.closest('#empir3-status-pill') && !el.id?.startsWith('empir3-') && !el.closest('.empir3-annotation-input') && !el.closest('.empir3-annotation-badge')) {
      if (hoveredEl) { hoveredEl.style.outline = ''; hoveredEl.style.outlineOffset = ''; }
      hoveredEl = el;
      el.style.outline = '2px dashed rgba(249,115,22,0.8)';
      el.style.outlineOffset = '2px';
    }
  });

  document.addEventListener('click', (e) => {
    if (!feedbackMode) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.closest('#empir3-chat-panel') || el.closest('#empir3-status-pill') || el.id?.startsWith('empir3-') || el.closest('.empir3-annotation-input')) return;

    // Check if clicking on an existing annotation badge — open edit mode
    const clickedBadge = el.closest('.empir3-annotation-badge');
    if (clickedBadge) {
      const annId = parseInt(clickedBadge.dataset.annotationId, 10);
      const existingAnn = annotations.find(a => a.id === annId);
      if (existingAnn) {
        e.preventDefault(); e.stopPropagation();
        _openAnnotationEditInput(existingAnn);
        return;
      }
    }

    e.preventDefault();
    e.stopPropagation();

    const selector = getCssSelector(el);
    const preview = el.outerHTML.slice(0, 200);

    // Check if this element already has an annotation
    const existingAnn = annotations.find(a => a.selector === selector);
    if (existingAnn) {
      _openAnnotationEditInput(existingAnn);
      return;
    }

    // Keep the orange outline on the selected element
    el.style.outline = '2px dashed rgba(249,115,22,0.8)';
    el.style.outlineOffset = '2px';

    // Remove any existing annotation input
    const oldInput = document.querySelector('.empir3-annotation-input');
    if (oldInput) oldInput.remove();

    // Show inline comment input floating near the element
    const rect = el.getBoundingClientRect();
    const annId = _annotationNextId++;
    _showAnnotationCommentInput(el, rect, selector, preview, annId, '');
  }, true);

  function _openAnnotationEditInput(ann) {
    // Remove any existing annotation input
    document.querySelectorAll('.empir3-annotation-input').forEach(el => el.remove());
    try {
      const target = document.querySelector(ann.selector);
      if (target) {
        const rect = target.getBoundingClientRect();
        ann.rect = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        _showAnnotationCommentInput(target, rect, ann.selector, ann.elementHtml, ann.id, ann.comment, true);
      }
    } catch(_) {}
  }

  function _showAnnotationCommentInput(el, rect, selector, preview, annId, existingComment, isEdit) {
    const commentBox = document.createElement('div');
    commentBox.className = 'empir3-annotation-input';
    Object.assign(commentBox.style, { position:'fixed', zIndex:'2147483647',
      left: Math.min(rect.left, window.innerWidth - 300) + 'px',
      top: Math.min(rect.bottom + 4, window.innerHeight - 44) + 'px',
      background:'rgba(10,15,30,0.95)', border:'1px solid #f97316', borderRadius:'8px',
      padding:'4px', display:'flex', gap:'4px', backdropFilter:'blur(8px)',
      boxShadow:'0 4px 16px rgba(0,0,0,0.5)', fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif' });

    const commentInput = document.createElement('input');
    commentInput.type = 'text';
    commentInput.value = existingComment || '';
    commentInput.placeholder = isEdit ? 'Edit comment... (Enter to save)' : 'Add comment... (Enter to save)';
    Object.assign(commentInput.style, { background:'#1e293b', border:'1px solid #334155', borderRadius:'6px',
      color:'#e2e8f0', padding:'6px 8px', fontSize:'12px', width:'230px', outline:'none',
      fontFamily:'inherit' });
    commentInput.addEventListener('focus', () => { commentInput.style.borderColor = '#f97316'; });
    commentInput.addEventListener('blur', () => { commentInput.style.borderColor = '#334155'; });

    const commitAnnotation = (text) => {
      commentBox.remove();
      el.style.outline = '';
      el.style.outlineOffset = '';
      const comment = text.trim();
      if (!comment) {
        // If editing and cleared comment, remove the annotation
        if (isEdit) _removeAnnotation(annId);
        return;
      }

      if (isEdit) {
        // Update existing annotation
        const ann = annotations.find(a => a.id === annId);
        if (ann) {
          ann.comment = comment;
          if (ann.badgeEl) ann.badgeEl.title = comment;
          _renderAnnotationList();
        }
      } else {
        // Create new annotation
        const badgeEl = document.createElement('div');
        badgeEl.className = 'empir3-annotation-badge';
        badgeEl.dataset.annotationId = String(annId);
        const num = annotations.length + 1;
        Object.assign(badgeEl.style, { position:'fixed', zIndex:'2147483641',
          left: (rect.right - 8) + 'px', top: Math.max(rect.top - 16, 0) + 'px',
          width:'24px', height:'24px', borderRadius:'50%',
          background:'rgba(249,115,22,0.9)', color:'white', fontSize:'12px', fontWeight:'700',
          display:'flex', alignItems:'center', justifyContent:'center',
          cursor:'pointer', userSelect:'none',
          fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif',
          boxShadow:'0 2px 8px rgba(0,0,0,0.4)', border:'2px solid white' });
        badgeEl.textContent = String(num);
        badgeEl.title = comment;
        badgeEl.onclick = (ev) => { ev.stopPropagation(); ev.preventDefault(); _openAnnotationEditInput(annotations.find(a => a.id === annId)); };
        document.body.appendChild(badgeEl);

        const ann = { id: annId, selector, elementHtml: preview, comment, badgeEl, markerEl: null,
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } };
        annotations.push(ann);
        _renderAnnotationList();

        // Render on canvas for screenshots
        _renderAnnotationBadgeOnCanvas(ann, num);

        // Open chat panel if not already open
        if (!chatOpen) toggleChat();
        chatInput.focus();
      }
      // Stay in annotate mode so user can annotate more elements
    };

    commentInput.addEventListener('keydown', (ke) => {
      ke.stopPropagation();
      if (ke.key === 'Enter') { ke.preventDefault(); commitAnnotation(commentInput.value); }
      if (ke.key === 'Escape') {
        commentBox.remove();
        el.style.outline = '';
        el.style.outlineOffset = '';
        // If new and no comment, just cancel. Stay in annotate mode.
        if (!isEdit && !commentInput.value.trim()) { /* nothing to clean up */ }
      }
    });

    commentBox.appendChild(commentInput);
    document.body.appendChild(commentBox);
    commentInput.focus();
  }

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text && annotations.length === 0) return;

    // Build annotation text for display and transmission
    let annotationText = '';
    const annotationData = annotations.map((a, i) => ({ selector: a.selector, comment: a.comment, elementHtml: a.elementHtml }));
    if (annotations.length > 0) {
      annotationText = '\\n\\ud83d\\udccc Annotations:\\n' + annotations.map((a, i) => (i + 1) + '. ' + a.selector + ' \\u2014 ' + a.comment).join('\\n');
    }

    const msg = {
      type: 'chat',
      text: text + annotationText,
      chatMode,
      includeScreenshot: screenshotCheck.checked,
      url: window.location.href,
      annotations: annotationData.length > 0 ? annotationData : undefined,
      // Legacy single-annotation fields for backward compat
      selector: annotationData.length === 1 ? annotationData[0].selector : undefined,
      elementHtml: annotationData.length === 1 ? annotationData[0].elementHtml : undefined
    };
    send(msg);
    addChatMessage({ from: 'user', text: (text || '') + annotationText, timestamp: new Date().toISOString(), channel: chatMode });
    chatInput.value = '';
    chatInput.style.height = '38px';

    // Exit annotate mode if active
    if (feedbackMode) { feedbackMode = false; annotateCheck.checked = false; document.body.style.cursor = ''; pillAnnotateBtn._setActive(false); }
    if (hoveredEl) { hoveredEl.style.outline = ''; hoveredEl.style.outlineOffset = ''; hoveredEl = null; }

    // Clear drawing and annotation badges after send (with small delay so screenshot captures them)
    setTimeout(() => {
      if (drawCanvas && drawCtx) {
        drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
        drawHistory.length = 0;
        if (drawMode) toggleDrawMode(); // exit draw mode
      }
      _clearAllAnnotations();
    }, 500);
  }

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function removeWorkingIndicator() {
    const w = document.getElementById('empir3-working');
    if (w) w.remove();
  }

  function chatModeForMessage(msg) {
    return inferChatMode(msg) || 'mcp';
  }

  function normalizeChatMessage(msg) {
    const normalized = Object.assign({}, msg || {});
    const inferred = chatModeForMessage(normalized);
    if (!normalized.channel) normalized.channel = inferred;
    return normalized;
  }

  function clearChatTranscript() {
    chatTranscript = [];
    const list = document.getElementById('empir3-chat-messages');
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
  }

  function replaceChatTranscript(messages) {
    chatTranscript = (messages || []).filter(Boolean).map(normalizeChatMessage);
    const lastMode = chatTranscript.map(inferChatMode).filter(Boolean).pop();
    if (lastMode) setChatMode(lastMode, { auto: true });
    renderChatMessages();
  }

  function renderChatMessages() {
    const list = document.getElementById('empir3-chat-messages');
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    chatTranscript
      .filter(msg => chatModeForMessage(msg) === chatMode)
      .forEach(msg => renderChatMessage(msg, list));
    list.scrollTop = list.scrollHeight;
  }

  function renderChatMessage(msg, list) {
    const div = document.createElement('div');
    const isUser = msg.from === 'user';
    Object.assign(div.style, { marginBottom:'8px', padding:'10px 14px', borderRadius:'12px', fontSize:'13px', lineHeight:'1.5',
      color:'var(--e3-msg-ink, #f1f5f9)', background: isUser ? 'var(--e3-msg-user-bg, #312e81)' : 'var(--e3-msg-assistant-bg, #1e3a5f)', maxWidth:'90%', marginLeft: isUser ? 'auto' : '0',
      marginRight: isUser ? '0' : 'auto', wordBreak:'break-word', whiteSpace:'pre-wrap' });
    const sender = isUser ? 'You' : (msg.agentName || msg.agent ? escapeHtml(msg.agentName || msg.agent) : empir3BrandHtml());
    const time = msg.timestamp ? new Date(msg.timestamp) : new Date();
    div.innerHTML = '<div style="font-size:11px;color:var(--e3-msg-meta, #94a3b8);margin-bottom:4px;font-weight:500;">' + sender + ' \\u00b7 ' + time.toLocaleTimeString() + '</div>' + '<span style="color:var(--e3-msg-ink, #e2e8f0);">' + escapeHtml(msg.text) + '</span>';
    list.appendChild(div);
    if (msg.screenshot) {
      const img = document.createElement('img');
      img.src = 'http://localhost:' + ${PORT} + '/feedback/' + msg.screenshot;
      Object.assign(img.style, { width:'100%', borderRadius:'8px', marginTop:'6px' });
      img.onload = scrollToBottom;
      div.appendChild(img);
    }
  }

  function addChatMessage(msg) {
    if (!msg) return;
    const normalized = normalizeChatMessage(msg);
    syncChatModeFromMessage(normalized);
    chatTranscript.push(normalized);
    if (chatModeForMessage(normalized) === chatMode) {
      renderChatMessage(normalized, chatMessages);
      scrollToBottom();
    }
  }

  function isBridgeChromeElement(el) {
    const id = el.id || '';
    const tag = (el.tagName || '').toUpperCase();
    return id.startsWith('empir3-') || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'META';
  }

  function shiftCandidates() {
    return Array.from(document.body.children).filter(el => !isBridgeChromeElement(el));
  }

  function paneBaseTransform(origTransform) {
    const t = (origTransform || '').trim();
    return t && t !== 'none' ? t : 'translateZ(0)';
  }

  function measurePaneContentWidth(el) {
    const rootLeft = el.getBoundingClientRect().left;
    let width = Math.max(el.clientWidth || 0, el.scrollWidth || 0);
    Array.from(el.querySelectorAll('*')).forEach(child => {
      if (isBridgeChromeElement(child)) return;
      const cs = getComputedStyle(child);
      if (cs.position === 'fixed' || cs.pointerEvents === 'none' || cs.display === 'none' || cs.visibility === 'hidden') return;
      const r = child.getBoundingClientRect();
      if (r.width > 10 && r.height > 10) width = Math.max(width, Math.ceil(r.right - rootLeft));
    });
    return Math.max(width, el.clientWidth || 0);
  }

  function pushPage(noTransition) {
    applyChatWidth(chatWidth);
    const viewport = visibleViewportWidth();
    const panelInset = chatOpen ? chatWidth : 0;
    const gutter = chatOpen ? Math.min(20, Math.max(8, Math.round((viewport - panelInset) * 0.025))) : 0;
    const contentWidth = chatOpen ? Math.max(0, viewport - panelInset - gutter * 2) : 0;
    const availableWidth = chatOpen ? contentWidth + 'px' : '';
    const leftInset = chatOpen ? ((chatSide === 'left' ? panelInset : 0) + gutter) + 'px' : '';
    const rightInset = chatOpen ? ((chatSide === 'right' ? panelInset : 0) + gutter) + 'px' : '';
    document.documentElement.classList.toggle('empir3-chat-split-active', chatOpen);
    if (chatOpen) {
      document.documentElement.style.setProperty('--empir3-chat-pane-width', chatWidth + 'px');
      document.documentElement.style.setProperty('--empir3-content-pane-width', availableWidth);
    } else {
      document.documentElement.style.removeProperty('--empir3-chat-pane-width');
      document.documentElement.style.removeProperty('--empir3-content-pane-width');
    }
    document.documentElement.style.overflowX = chatOpen ? 'hidden' : '';
    document.body.style.overflowX = chatOpen ? 'hidden' : '';
    shiftCandidates().forEach(el => {
      if (!el.__empir3LayoutOrig) {
        const legacy = el.__empir3ShiftOrig || null;
        el.__empir3LayoutOrig = {
          width: el.style.width || '',
          maxWidth: el.style.maxWidth || '',
          minWidth: el.style.minWidth || '',
          marginLeft: el.style.marginLeft || '',
          marginRight: el.style.marginRight || '',
          boxSizing: el.style.boxSizing || '',
          overflowX: el.style.overflowX || '',
          transform: legacy ? legacy.transform : (el.style.transform || ''),
          transformOrigin: el.style.transformOrigin || '',
          transition: el.style.transition || '',
          willChange: legacy ? legacy.willChange : (el.style.willChange || ''),
          zoom: el.style.zoom || '',
        };
        if (el.__empir3ShiftOrig) delete el.__empir3ShiftOrig;
      }
      const orig = el.__empir3LayoutOrig;
      el.style.transition = noTransition ? 'none' : 'width 0.3s ease, max-width 0.3s ease, margin-left 0.3s ease, margin-right 0.3s ease, transform 0.3s ease';
      if (chatOpen) {
        const baseTransform = paneBaseTransform(orig.transform);
        el.style.zoom = orig.zoom;
        el.style.boxSizing = 'border-box';
        el.style.minWidth = '0';
        el.style.width = availableWidth;
        el.style.maxWidth = availableWidth;
        el.style.marginLeft = leftInset;
        el.style.marginRight = rightInset;
        el.style.overflowX = 'hidden';
        el.style.transformOrigin = 'top left';
        el.style.transform = baseTransform;
        const neededWidth = measurePaneContentWidth(el);
        const numericContentWidth = parseFloat(availableWidth) || contentWidth;
        const scale = neededWidth > numericContentWidth + 2
          ? Math.min(1, Math.max(0.55, numericContentWidth / neededWidth))
          : 1;
        if (scale < 0.995) {
          const scaledLayoutWidth = Math.ceil(numericContentWidth / scale);
          el.style.width = scaledLayoutWidth + 'px';
          el.style.maxWidth = scaledLayoutWidth + 'px';
          el.style.transform = baseTransform + ' scale(' + scale.toFixed(4) + ')';
        }
        el.style.willChange = 'width, margin-left, margin-right, transform';
      } else {
        el.style.width = orig.width;
        el.style.maxWidth = orig.maxWidth;
        el.style.minWidth = orig.minWidth;
        el.style.marginLeft = orig.marginLeft;
        el.style.marginRight = orig.marginRight;
        el.style.boxSizing = orig.boxSizing;
        el.style.overflowX = orig.overflowX;
        el.style.transform = orig.transform;
        el.style.transformOrigin = orig.transformOrigin;
        el.style.willChange = orig.willChange;
        el.style.zoom = orig.zoom;
        if (!noTransition) setTimeout(() => { el.style.transition = orig.transition; }, 320);
        else el.style.transition = orig.transition;
      }
    });
  }

  function positionPanel() {
    applyChatWidth(chatWidth);
    if (chatSide === 'right') {
      chatPanel.style.right = chatOpen ? '0' : '-' + chatWidth + 'px';
      chatPanel.style.left = 'auto';
      chatPanel.style.borderLeft = '2px solid rgba(59,130,246,0.4)';
      chatPanel.style.borderRight = 'none';
      chatPanel.style.boxShadow = '-4px 0 20px rgba(0,0,0,0.5)';
      resizeHandle.style.left = '0';
      resizeHandle.style.right = 'auto';
      resizeHandle.style.boxShadow = 'inset 1px 0 0 rgba(147,197,253,0.7)';
    } else {
      chatPanel.style.left = chatOpen ? '0' : '-' + chatWidth + 'px';
      chatPanel.style.right = 'auto';
      chatPanel.style.borderRight = '2px solid rgba(59,130,246,0.4)';
      chatPanel.style.borderLeft = 'none';
      chatPanel.style.boxShadow = '4px 0 20px rgba(0,0,0,0.5)';
      resizeHandle.style.right = '0';
      resizeHandle.style.left = 'auto';
      resizeHandle.style.boxShadow = 'inset -1px 0 0 rgba(147,197,253,0.7)';
    }
  }

  function toggleChat() {
    chatOpen = !chatOpen;
    syncBubbleVisibility();
    chatToggle.style.display = 'none';
    positionPanel();
    pushPage(false);
  }

  function switchSide() {
    chatSide = chatSide === 'right' ? 'left' : 'right';
    chatPanel.style.transition = 'none';
    positionPanel();
    pushPage(true);
    requestAnimationFrame(() => {
      chatPanel.style.transition = 'right 0.3s ease, left 0.3s ease';
    });
  }

  window.addEventListener('resize', () => {
    if (!chatOpen) return;
    applyChatWidth(chatWidth);
    positionPanel();
    pushPage(true);
  });

  function flashChatButton() {
    const target = (typeof bubble !== 'undefined' && bubble && typeof bubble.animate === 'function') ? bubble : null;
    if (!target) return;
    try { target.animate([{ transform:'scale(1)' }, { transform:'scale(1.15)' }, { transform:'scale(1)' }], { duration:500, iterations:3 }); } catch (_) {}
    const prevBorder = target.style.borderColor;
    target.style.borderColor = '#22c55e';
    setTimeout(() => { target.style.borderColor = prevBorder; }, 3000);
  }

  function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function getCssSelector(el) {
    if (el.id) return '#' + el.id;
    const parts = [];
    while (el && el !== document.body) {
      let sel = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.split(/\\s+/).filter(c => c && !c.startsWith('empir3')).slice(0, 2);
        if (classes.length) sel += '.' + classes.join('.');
      }
      parts.unshift(sel);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  // Chat toggle reference (no floating button — pill button used instead)
  const chatToggle = { style: { display: 'none' } }; // Stub for compatibility

  // ─── Recording System ──────────────────────
  let _recording = false;
  let _recordActionCount = 0;
  let _typingBuffer = '';
  let _typingTimer = null;
  let _lastTypedSelector = '';
  let _suppressRecordedClickUntil = 0;
  let _suppressRecordedClickSelector = '';

  // Record button is now in the pill — keep references for state updates
  const recordBtn = pillRecBtn;
  recordBtn.id = 'empir3-record-btn';
  const recordBadge = document.createElement('span');
  Object.assign(recordBadge.style, { background:'#ef4444', color:'white', fontSize:'9px', fontWeight:'bold',
    borderRadius:'8px', padding:'0 4px', marginLeft:'2px', display:'none' });
  pillRecBtn.appendChild(recordBadge);
  function setRecordButtonLabel(label) {
    pillRecBtn.innerHTML = label;
    pillRecBtn.appendChild(recordBadge);
  }

  function toggleRecording() {
    if (_recording) {
      flushTypingBuffer();
      _recording = false;
      setRecordButtonLabel('\\u23fa Rec');
      pillRecBtn.style.color = '#94a3b8';
      pillRecBtn.style.borderColor = '#334155';
      pillRecBtn.getAnimations().forEach(a => a.cancel());

      const saveDialog = document.createElement('div');
      saveDialog.id = 'empir3-save-dialog';
      Object.assign(saveDialog.style, { position:'fixed', bottom:'86px', right:'20px', background:'#1e293b',
        border:'2px solid #3b82f6', borderRadius:'12px', padding:'12px', zIndex:'2147483646', width:'280px',
        fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif', boxShadow:'0 8px 32px rgba(0,0,0,0.5)' });
      saveDialog.innerHTML = '<div style="color:#93c5fd;font-size:13px;font-weight:600;margin-bottom:8px;">Save Recording (' + _recordActionCount + ' actions)</div>';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = 'recording-' + new Date().toISOString().slice(0,10);
      nameInput.placeholder = 'Recording name...';
      Object.assign(nameInput.style, { width:'100%', padding:'8px', background:'#0f172a', border:'1px solid #334155',
        borderRadius:'6px', color:'#e2e8f0', fontSize:'13px', marginBottom:'8px', boxSizing:'border-box' });

      const btnRow = document.createElement('div');
      Object.assign(btnRow.style, { display:'flex', gap:'8px' });

      const saveBtn = document.createElement('button');
      Object.assign(saveBtn.style, { flex:'1', padding:'6px', background:'#3b82f6', color:'white', border:'none',
        borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'500' });
      saveBtn.textContent = 'Save';
      saveBtn.onclick = () => {
        const name = nameInput.value.trim() || 'recording-' + Date.now();
        send({ type: 'command', data: { type: 'record_stop', text: name } });
        _recordActionCount = 0;
        recordBadge.style.display = 'none';
        statusText.textContent = 'Recording saved: ' + name;
        setTimeout(() => { setBridgeStatus('Bridge'); }, 3000);
        saveDialog.remove();
      };

      const cancelBtn = document.createElement('button');
      Object.assign(cancelBtn.style, { flex:'1', padding:'6px', background:'#374151', color:'#9ca3af', border:'none',
        borderRadius:'6px', cursor:'pointer', fontSize:'12px' });
      cancelBtn.textContent = 'Discard';
      cancelBtn.onclick = () => {
        send({ type: 'command', data: { type: 'record_stop', text: '__discard__' } });
        _recordActionCount = 0;
        recordBadge.style.display = 'none';
        setBridgeStatus('Bridge');
        saveDialog.remove();
      };

      btnRow.append(saveBtn, cancelBtn);
      saveDialog.append(nameInput, btnRow);
      document.body.appendChild(saveDialog);
      nameInput.focus();
      nameInput.select();

      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveBtn.click();
        if (e.key === 'Escape') cancelBtn.click();
        e.stopPropagation();
      });
    } else {
      send({ type: 'command', data: { type: 'record_start' } });
      _recording = true;
      _recordActionCount = 0;
      setRecordButtonLabel('\\u23f9 Stop');
      pillRecBtn.style.color = '#ef4444';
      pillRecBtn.style.borderColor = '#ef4444';
      statusText.textContent = '\\ud83d\\udd34 Recording...';
    }
  }

  function recordAction(action) {
    if (!_recording) return;
    // Tag with the URL the tab was on — playback uses this to route to the right tab
    action.pageUrl = window.location.href;
    _recordActionCount++;
    recordBadge.textContent = _recordActionCount.toString();
    recordBadge.style.display = 'block';
    send({ type: 'record_action', action });
  }

  function bufferTyping(char, selector) {
    if (_lastTypedSelector !== selector && _typingBuffer) {
      flushTypingBuffer();
    }
    _lastTypedSelector = selector;
    _typingBuffer += char;
    clearTimeout(_typingTimer);
    _typingTimer = setTimeout(flushTypingBuffer, 1500);
  }

  function flushTypingBuffer() {
    if (_typingBuffer) {
      recordAction({ action:'type', text:_typingBuffer, selector:_lastTypedSelector, delay:0 });
      _typingBuffer = '';
    }
  }

  // ─── Event Capture for Recording ──────────
  document.addEventListener('click', (e) => {
    if (!_recording) return;
    const el = e.target;
    if (el.closest('#empir3-chat-panel') || el.closest('#empir3-play-panel') || el.closest('#empir3-save-dialog') || el.closest('#empir3-status-pill')) return;
    const selector = getCssSelector(el);
    if (Date.now() < _suppressRecordedClickUntil) {
      const suppressed = !_suppressRecordedClickSelector || _suppressRecordedClickSelector === selector || selector === _suppressRecordedClickSelector;
      if (suppressed) {
        _suppressRecordedClickUntil = 0;
        _suppressRecordedClickSelector = '';
        return;
      }
    }
    flushTypingBuffer();
    recordAction({ action:'click', x:e.clientX, y:e.clientY, selector:selector, delay:0 });
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!_recording) return;
    const el = e.target;
    if (el.closest('#empir3-chat-panel') || el.closest('#empir3-record-btn') || el.closest('#empir3-save-dialog')) return;

    if (e.key === 'Tab' || e.key === 'Enter' || e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Delete'
        || (e.ctrlKey && e.key !== 'Control') || (e.altKey && e.key !== 'Alt')) {
      flushTypingBuffer();
      const combo = (e.ctrlKey ? 'Control+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '') + e.key;
      recordAction({ action:'press', key:combo, delay:0 });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
      bufferTyping(e.key, getCssSelector(el));
    }
  }, true);

  let _lastUrl = window.location.href;
  const _navObserver = new MutationObserver(() => {
    if (window.location.href !== _lastUrl) {
      const newUrl = window.location.href;
      _lastUrl = newUrl;
      announceTabToBridge();
      if (_recording) {
        flushTypingBuffer();
        recordAction({ action:'navigate', url:newUrl, delay:0 });
      }
    }
  });
  _navObserver.observe(document, { subtree:true, childList:true });

  // Tab focus capture — detect when user switches to this tab via browser tab bar
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      announceTabToBridge();
      if (!_recording) return;
      flushTypingBuffer();
      recordAction({ action:'tab_focus', url:window.location.href, delay:0 });
    }
  });

  // Scroll capture — handles both window and inner container scrolls (RN Web)
  let _scrollTimer = null;
  let _scrollTarget = null;
  let _scrollStartTop = 0;
  let _scrollStartLeft = 0;

  document.addEventListener('scroll', (e) => {
    if (!_recording) return;
    var target = e.target;
    // Track the first scroll target per gesture
    if (!_scrollTimer) {
      _scrollTarget = (target === document || target === document.documentElement) ? null : target;
      if (_scrollTarget) {
        _scrollStartTop = _scrollTarget.scrollTop || 0;
        _scrollStartLeft = _scrollTarget.scrollLeft || 0;
      } else {
        _scrollStartTop = window.scrollY;
        _scrollStartLeft = window.scrollX;
      }
    }
    clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(() => {
      var dy, dx;
      if (_scrollTarget) {
        dy = (_scrollTarget.scrollTop || 0) - _scrollStartTop;
        dx = (_scrollTarget.scrollLeft || 0) - _scrollStartLeft;
      } else {
        dy = window.scrollY - _scrollStartTop;
        dx = window.scrollX - _scrollStartLeft;
      }
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        recordAction({ action:'scroll', x:dx, y:dy, delay:0 });
      }
      _scrollTimer = null;
      _scrollTarget = null;
    }, 300);
  }, true);

  // Handle recording/playback state from server
  function handleRecordingState(msg) {
    if (msg.type === 'recording_state') {
      _recording = msg.recording;
      if (_recording) {
        setRecordButtonLabel('\\u23f9 Stop');
        pillRecBtn.style.color = '#ef4444';
        pillRecBtn.style.borderColor = '#ef4444';
        statusText.textContent = '\\ud83d\\udd34 Recording...';
      } else {
        setRecordButtonLabel('\\u23fa Rec');
        pillRecBtn.style.color = '#94a3b8';
        pillRecBtn.style.borderColor = '#334155';
      }
    }
    if (msg.type === 'recording_action') {
      _recordActionCount = msg.count;
      recordBadge.textContent = msg.count.toString();
      recordBadge.style.display = 'block';
      // Show ref info if available
      if (msg.ref) {
        statusText.textContent = '\\ud83d\\udd34 Recording... [' + msg.ref + (msg.refLabel ? ': ' + msg.refLabel.slice(0,20) : '') + ']';
      }
    }
    if (msg.type === 'playback_state') {
      if (msg.playing) {
        statusText.textContent = '\\u25b6 Playing: ' + msg.name;
        edgeGlow.style.borderColor = 'rgba(34,197,94,0.4)';
        transportShow(msg.name, msg.total);
      } else {
        statusText.textContent = msg.passed !== undefined
          ? (msg.stopped ? '\\u23f9 Stopped: ' : '\\u2713 Playback: ') + msg.passed + '/' + (msg.passed + msg.failed) + ' ran'
          : '';
        edgeGlow.style.borderColor = 'rgba(59,130,246,0.15)';
        if (msg.passed === undefined) setBridgeStatus('Bridge');
        transportFinish(msg);
        setTimeout(() => { setBridgeStatus('Bridge'); }, 5000);
      }
    }
    if (msg.type === 'playback_step') {
      statusText.textContent = '\\u25b6 Step ' + msg.step + '/' + msg.total + ': ' + msg.action + (msg.ref ? ' [' + msg.ref + ']' : '');
    }
    if (msg.type === 'playback_transport') {
      transportUpdate(msg);
    }
  }

  const _origHandle = handleServerMessage;
  handleServerMessage = function(msg) {
    _origHandle(msg);
    handleRecordingState(msg);
  };

  // ─── Playback Transport (scrubber + controls) ──────────
  // Appears while a recording plays. Pause/resume, stop, single-step, a
  // draggable scrubber (seek/rewind/fast-forward) and a live speed selector.
  // Controls go out over the same WS/CDP-mailbox command path as Rec/Stop, so
  // they work on both http and https pages.
  let transportTotal = 0, transportCurrent = 0, transportPaused = false, transportSpeed = 1;
  let transportScrubbing = false, transportHideTimer = null;
  const TRANSPORT_SPEEDS = [0.5, 1, 2, 4];

  const transportBar = document.createElement('div');
  transportBar.id = 'empir3-transport';
  Object.assign(transportBar.style, { position:'fixed', bottom:'46px', left:'50%', transform:'translateX(-50%)',
    background:'rgba(10,15,30,0.96)', backdropFilter:'blur(12px)', border:'1px solid rgba(59,130,246,0.3)',
    borderRadius:'14px', padding:'10px 14px 12px', zIndex:'2147483646', width:'380px', maxWidth:'90vw',
    boxShadow:'0 10px 40px rgba(0,0,0,0.6)', display:'none', flexDirection:'column', gap:'7px',
    fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif', userSelect:'none' });
  transportBar.addEventListener('mousedown', (e) => e.stopPropagation());

  const tHead = document.createElement('div');
  Object.assign(tHead.style, { display:'flex', alignItems:'center', justifyContent:'space-between', gap:'8px' });
  const tTitle = document.createElement('div');
  Object.assign(tTitle.style, { color:'#e2e8f0', fontSize:'12px', fontWeight:'600', overflow:'hidden',
    textOverflow:'ellipsis', whiteSpace:'nowrap', flex:'1', minWidth:'0' });
  const tCounter = document.createElement('div');
  Object.assign(tCounter.style, { color:'#94a3b8', fontSize:'11px', fontWeight:'500', flexShrink:'0', fontVariantNumeric:'tabular-nums' });
  tHead.append(tTitle, tCounter);

  const tTrack = document.createElement('div');
  Object.assign(tTrack.style, { position:'relative', height:'8px', background:'#1e293b', borderRadius:'5px',
    cursor:'pointer', margin:'3px 6px', touchAction:'none' });
  const tFill = document.createElement('div');
  Object.assign(tFill.style, { position:'absolute', left:'0', top:'0', bottom:'0', width:'0%',
    background:'linear-gradient(90deg,#3b82f6,#22c55e)', borderRadius:'5px', pointerEvents:'none' });
  const tThumb = document.createElement('div');
  Object.assign(tThumb.style, { position:'absolute', top:'50%', left:'0%', width:'14px', height:'14px',
    background:'#fff', border:'2px solid #3b82f6', borderRadius:'50%', transform:'translate(-50%,-50%)',
    boxShadow:'0 1px 4px rgba(0,0,0,0.5)', pointerEvents:'none' });
  tTrack.append(tFill, tThumb);

  const tAction = document.createElement('div');
  Object.assign(tAction.style, { color:'#64748b', fontSize:'10px', whiteSpace:'nowrap', overflow:'hidden',
    textOverflow:'ellipsis', minHeight:'12px', padding:'0 6px' });

  const tControls = document.createElement('div');
  Object.assign(tControls.style, { display:'flex', alignItems:'center', gap:'4px', justifyContent:'center', flexWrap:'wrap' });

  const tRestart = _mkTbBtn('\\u23ee', 'Restart from beginning');
  const tPause = _mkTbBtn('\\u23f8', 'Pause');
  const tStep = _mkTbBtn('\\u23ed', 'Step one action (while paused)');
  const tStop = _mkTbBtn('\\u23f9', 'Stop playback');
  tStop._setActive(true, '#f87171');

  const tSep = document.createElement('span');
  Object.assign(tSep.style, { width:'1px', height:'16px', background:'rgba(148,163,184,0.25)', margin:'0 3px', flexShrink:'0' });

  const speedBtns = TRANSPORT_SPEEDS.map(s => {
    const b = _mkTbBtn(s + '\\u00d7', 'Playback speed ' + s + '\\u00d7');
    b.style.fontSize = '11px'; b.style.padding = '3px 6px';
    b.onclick = (e) => { e.stopPropagation(); setTransportSpeed(s); };
    return b;
  });

  tControls.append(tRestart, tPause, tStep, tStop, tSep);
  speedBtns.forEach(b => tControls.appendChild(b));
  transportBar.append(tHead, tTrack, tAction, tControls);
  document.body.appendChild(transportBar);

  function sendPlaybackCtl(data) {
    try { send({ type: 'command', data }); } catch (_) {}
  }

  function renderTransport() {
    const total = Math.max(1, transportTotal);
    const cur = Math.max(0, Math.min(transportCurrent, total - 1));
    const pct = total <= 1 ? 0 : (cur / (total - 1)) * 100;
    if (!transportScrubbing) {
      tFill.style.width = pct + '%';
      tThumb.style.left = pct + '%';
      tCounter.textContent = (transportTotal ? (cur + 1) : 0) + ' / ' + transportTotal;
    }
    tPause.innerHTML = transportPaused ? '\\u25b6' : '\\u23f8';
    tPause.title = transportPaused ? 'Resume' : 'Pause';
    tStep.style.opacity = transportPaused ? '1' : '0.4';
    tStep.style.pointerEvents = transportPaused ? 'auto' : 'none';
    speedBtns.forEach((b, idx) => b._setActive(Math.abs(TRANSPORT_SPEEDS[idx] - transportSpeed) < 0.001, '#22c55e'));
  }

  function transportShow(name, total) {
    if (typeof total === 'number' && total > 0) transportTotal = total;
    transportCurrent = 0;
    transportPaused = false;
    if (transportHideTimer) { clearTimeout(transportHideTimer); transportHideTimer = null; }
    tTitle.textContent = '\\u25b6 ' + (name || 'Playing');
    tAction.textContent = 'Starting\\u2026';
    transportBar.style.display = 'flex';
    renderTransport();
  }

  function transportUpdate(msg) {
    if (typeof msg.total === 'number' && msg.total > 0) transportTotal = msg.total;
    if (!transportScrubbing && typeof msg.current === 'number') transportCurrent = msg.current;
    if (typeof msg.paused === 'boolean') transportPaused = msg.paused;
    if (typeof msg.speed === 'number') transportSpeed = msg.speed;
    if (msg.name) tTitle.textContent = (transportPaused ? '\\u23f8 ' : '\\u25b6 ') + msg.name;
    if (msg.action) tAction.textContent = (msg.seeking ? '\\u2026 ' : '') + msg.action + (msg.ref ? ' [' + msg.ref + ']' : '');
    else if (msg.seeking) tAction.textContent = '\\u2026 seeking';
    if (msg.active === false) { transportFinish(msg); return; }
    if (transportBar.style.display === 'none') transportBar.style.display = 'flex';
    renderTransport();
  }

  function transportFinish(msg) {
    transportPaused = false;
    if (msg && msg.stopped) tAction.textContent = 'Stopped';
    else if (msg && typeof msg.passed === 'number') tAction.textContent = 'Done \\u2014 ' + msg.passed + '/' + (msg.passed + (msg.failed || 0)) + ' ran';
    renderTransport();
    if (transportHideTimer) clearTimeout(transportHideTimer);
    transportHideTimer = setTimeout(() => { transportBar.style.display = 'none'; }, 2500);
  }

  function setTransportSpeed(s) {
    transportSpeed = s;
    renderTransport();
    sendPlaybackCtl({ type: 'playback_speed', speed: s });
  }

  tRestart.onclick = (e) => { e.stopPropagation(); sendPlaybackCtl({ type: 'playback_seek', step: 0 }); };
  tStop.onclick = (e) => { e.stopPropagation(); sendPlaybackCtl({ type: 'playback_stop' }); tAction.textContent = 'Stopping\\u2026'; };
  tStep.onclick = (e) => { e.stopPropagation(); if (!transportPaused) return; sendPlaybackCtl({ type: 'playback_step' }); };
  tPause.onclick = (e) => {
    e.stopPropagation();
    transportPaused = !transportPaused;          // optimistic — server confirms via playback_transport
    sendPlaybackCtl({ type: transportPaused ? 'playback_pause' : 'playback_resume' });
    renderTransport();
  };

  // Scrubber drag — seek on release (rewind if backward, fast-forward if ahead)
  function transportPctFromEvent(e) {
    const rect = tTrack.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }
  function transportIndexFromPct(p) {
    return Math.round(p * Math.max(0, transportTotal - 1));
  }
  function transportPreview(p) {
    tFill.style.width = (p * 100) + '%';
    tThumb.style.left = (p * 100) + '%';
    tCounter.textContent = (transportIndexFromPct(p) + 1) + ' / ' + transportTotal;
  }
  tTrack.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    transportScrubbing = true;
    try { tTrack.setPointerCapture(e.pointerId); } catch (_) {}
    transportPreview(transportPctFromEvent(e));
  });
  tTrack.addEventListener('pointermove', (e) => {
    if (!transportScrubbing) return;
    transportPreview(transportPctFromEvent(e));
  });
  function transportEndScrub(e) {
    if (!transportScrubbing) return;
    transportScrubbing = false;
    const idx = transportIndexFromPct(transportPctFromEvent(e));
    transportCurrent = idx;
    sendPlaybackCtl({ type: 'playback_seek', step: idx });
    renderTransport();
  }
  tTrack.addEventListener('pointerup', (e) => { e.stopPropagation(); transportEndScrub(e); });
  tTrack.addEventListener('pointercancel', (e) => { transportEndScrub(e); });

  // ─── Playback Panel ────────────────────────

  let playPanelOpen = false;
  const playPanel = document.createElement('div');
  playPanel.id = 'empir3-play-panel';
  Object.assign(playPanel.style, { position:'fixed', bottom:'42px', left:'50%', transform:'translateX(-50%)',
    background:'#0f172a', border:'1px solid #334155', borderRadius:'12px', padding:'0', zIndex:'2147483646',
    width:'340px', maxHeight:'440px', fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif',
    boxShadow:'0 8px 32px rgba(0,0,0,0.6)', display:'none', overflow:'hidden' });

  const playHeader = document.createElement('div');
  Object.assign(playHeader.style, { padding:'10px 16px', borderBottom:'1px solid #1e293b', display:'flex',
    justifyContent:'space-between', alignItems:'center' });
  playHeader.innerHTML = '<span style="color:#94a3b8;font-weight:600;font-size:13px;letter-spacing:0.5px;">RECORDINGS</span>';
  const playClose = document.createElement('span');
  playClose.textContent = '\\u2715';
  Object.assign(playClose.style, { color:'#475569', cursor:'pointer', fontSize:'14px' });
  playClose.onclick = () => togglePlayPanel();
  playHeader.appendChild(playClose);

  const playList = document.createElement('div');
  Object.assign(playList.style, { maxHeight:'380px', overflowY:'auto', padding:'6px' });

  playPanel.append(playHeader, playList);
  document.body.appendChild(playPanel);

  // Starred recordings persisted in localStorage
  function getStarred() {
    try { return JSON.parse(localStorage.getItem('empir3_starred') || '[]'); } catch { return []; }
  }
  function setStarred(list) {
    localStorage.setItem('empir3_starred', JSON.stringify(list));
  }
  function toggleStar(name) {
    const starred = getStarred();
    const idx = starred.indexOf(name);
    if (idx >= 0) starred.splice(idx, 1);
    else starred.push(name);
    setStarred(starred);
    loadRecordings();
  }

  function togglePlayPanel() {
    playPanelOpen = !playPanelOpen;
    playPanel.style.display = playPanelOpen ? 'block' : 'none';
    if (playPanelOpen) loadRecordings();
  }

  async function loadRecordings() {
    playList.innerHTML = '<div style="color:#475569;padding:12px;text-align:center;font-size:12px;">Loading...</div>';
    try {
      const res = await fetch('http://localhost:${PORT}/api/recordings');
      const recordings = await res.json();
      playList.innerHTML = '';
      const filtered = recordings.filter(r => r.name !== '__discard__');
      if (filtered.length === 0) {
        playList.innerHTML = '<div style="color:#475569;padding:16px;text-align:center;font-size:12px;">No recordings yet</div>';
        return;
      }
      // Sort: starred first, then by date (newest first)
      const starred = getStarred();
      filtered.sort((a, b) => {
        const aStarred = starred.includes(a.name) ? 1 : 0;
        const bStarred = starred.includes(b.name) ? 1 : 0;
        if (aStarred !== bStarred) return bStarred - aStarred;
        return new Date(b.recorded || 0).getTime() - new Date(a.recorded || 0).getTime();
      });

      filtered.forEach(rec => {
        const isStarred = starred.includes(rec.name);
        const item = document.createElement('div');
        Object.assign(item.style, { padding:'8px 10px', borderRadius:'6px', marginBottom:'3px',
          display:'flex', alignItems:'center', gap:'8px',
          background: isStarred ? '#1a1f35' : '#141926', transition:'background 0.15s',
          borderLeft: isStarred ? '2px solid #7c3aed' : '2px solid transparent' });
        item.onmouseenter = () => { item.style.background = '#1e293b'; };
        item.onmouseleave = () => { item.style.background = isStarred ? '#1a1f35' : '#141926'; };

        // Star button
        const starBtn = document.createElement('span');
        starBtn.textContent = isStarred ? '\\u2605' : '\\u2606';
        Object.assign(starBtn.style, { cursor:'pointer', fontSize:'14px', color: isStarred ? '#a78bfa' : '#334155',
          flexShrink:'0', transition:'color 0.15s' });
        starBtn.onmouseenter = () => { starBtn.style.color = '#a78bfa'; };
        starBtn.onmouseleave = () => { starBtn.style.color = isStarred ? '#a78bfa' : '#334155'; };
        starBtn.onclick = (e) => { e.stopPropagation(); toggleStar(rec.name); };

        // Info
        const info = document.createElement('div');
        Object.assign(info.style, { flex:'1', minWidth:'0' });
        info.innerHTML = '<div style="color:#cbd5e1;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(rec.name) + '</div>' +
          '<div style="color:#475569;font-size:10px;margin-top:1px;">' + rec.actionCount + ' actions \\u00b7 ' +
          (rec.duration / 1000).toFixed(1) + 's</div>';

        // Action buttons
        const actions = document.createElement('div');
        Object.assign(actions.style, { display:'flex', gap:'4px', flexShrink:'0' });

        const playItemBtn = document.createElement('button');
        Object.assign(playItemBtn.style, { background:'#1e293b', color:'#94a3b8', border:'1px solid #334155', borderRadius:'4px',
          padding:'3px 8px', cursor:'pointer', fontSize:'11px', fontWeight:'500', whiteSpace:'nowrap', transition:'all 0.15s' });
        playItemBtn.textContent = '\\u25b6';
        playItemBtn.title = 'Play';
        playItemBtn.onmouseenter = () => { playItemBtn.style.background = '#334155'; playItemBtn.style.color = '#e2e8f0'; };
        playItemBtn.onmouseleave = () => { playItemBtn.style.background = '#1e293b'; playItemBtn.style.color = '#94a3b8'; };
        playItemBtn.onclick = (e) => { e.stopPropagation(); playRecordingFromUI(rec.name); };

        const delBtn = document.createElement('button');
        Object.assign(delBtn.style, { background:'none', color:'#334155', border:'none', borderRadius:'4px',
          padding:'3px 4px', cursor:'pointer', fontSize:'11px', transition:'color 0.15s' });
        delBtn.textContent = '\\u2715';
        delBtn.title = 'Delete';
        delBtn.onmouseenter = () => { delBtn.style.color = '#ef4444'; };
        delBtn.onmouseleave = () => { delBtn.style.color = '#334155'; };
        delBtn.onclick = (e) => {
          e.stopPropagation();
          if (confirm('Delete recording "' + rec.name + '"?')) {
            deleteRecording(rec.name);
          }
        };

        actions.append(playItemBtn, delBtn);
        item.append(starBtn, info, actions);
        playList.appendChild(item);
      });
    } catch(e) {
      playList.innerHTML = '<div style="color:#ef4444;padding:12px;text-align:center;font-size:12px;">Failed to load</div>';
    }
  }

  async function deleteRecording(name) {
    try {
      await fetch('http://localhost:${PORT}/api/command', {
        method:'POST', headers: bridgeHttpHeaders({'Content-Type':'application/json'}),
        body:JSON.stringify({ type:'delete_recording', recording: name })
      });
      // Also remove from starred
      const starred = getStarred().filter(s => s !== name);
      setStarred(starred);
      loadRecordings();
    } catch(e) {
      statusText.textContent = 'Delete failed';
    }
  }

  function playRecordingFromUI(name) {
    togglePlayPanel();
    statusText.textContent = '\\u25b6 Starting: ' + name;
    transportShow(name);  // show the scrubber immediately; populated by playback_state/_transport
    fetch('http://localhost:${PORT}/api/command', {
      method:'POST', headers: bridgeHttpHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({ type:'play', recording:name, speed:1, variables:{} })
    }).then(r => r.json()).then(result => {
      if (result.ok) {
        const r = result.result;
        statusText.textContent = '\\u2713 ' + r.passed + '/' + r.total + ' passed';
        setTimeout(() => { setBridgeStatus('Bridge'); }, 5000);
      } else {
        statusText.textContent = '\\u2717 ' + (result.error || 'Failed');
      }
    }).catch(e => {
      statusText.textContent = '\\u2717 Error: ' + e.message;
    });
  }

  pillPlayBtn.onclick = (e) => { e.stopPropagation(); togglePlayPanel(); };
  pillRecBtn.onclick = (e) => { e.stopPropagation(); toggleRecording(); };
  if (pillChatBtn) pillChatBtn.onclick = (e) => { e.stopPropagation(); toggleChat(); };

  // Screenshot button — takes a screenshot via bridge API
  pillScreenshotBtn.onclick = (e) => {
    e.stopPropagation();
    pillScreenshotBtn.innerHTML = '\\u23f3';
    fetch('http://localhost:${PORT}/api/command', {
      method:'POST', headers: bridgeHttpHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({ type:'screenshot' })
    }).then(r => r.json()).then(result => {
      pillScreenshotBtn.innerHTML = '\\ud83d\\udcf7 Snap';
      if (result.ok && (result.path || result.result?.path)) {
        statusText.textContent = '\\u2713 Screenshot saved';
        setTimeout(() => { setBridgeStatus('Bridge'); }, 2000);
      } else {
        statusText.textContent = 'Screenshot failed';
        setTimeout(() => { setBridgeStatus('Bridge'); }, 2000);
      }
    }).catch(() => {
      pillScreenshotBtn.innerHTML = '\\ud83d\\udcf7 Snap';
      statusText.textContent = 'Screenshot error';
      setTimeout(() => { setBridgeStatus('Bridge'); }, 2000);
    });
  };

  // ─── Keyboard Shortcuts ────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'C') { toggleChat(); e.preventDefault(); }
    if (e.ctrlKey && e.shiftKey && e.key === 'R') { toggleRecording(); e.preventDefault(); }
    if (e.ctrlKey && e.shiftKey && e.key === 'P') { togglePlayPanel(); e.preventDefault(); }
    // Ctrl+Z for undo in draw mode
    if (e.ctrlKey && e.key === 'z' && drawMode) { e.preventDefault(); undoDraw(); }
    // Escape exits draw mode or annotate mode
    if (e.key === 'Escape' && drawMode) { toggleDrawMode(); e.preventDefault(); return; }
    if (e.key === 'Escape' && feedbackMode) { toggleAnnotateMode(); e.preventDefault(); return; }
    if (e.key === 'Escape' && chatOpen) toggleChat();
    if (e.key === 'Escape' && playPanelOpen) togglePlayPanel();
  });

  // ─── Connect ───────────────────────────────
  // A page-context ws:// to localhost is blocked from https pages
  // (mixed-content / Private Network Access), so on https the bridge drives
  // this overlay over the CDP mailbox instead — it pushes inbound by calling
  // window.__empir3_inbox and drains window.__empir3_outbox over CDP. The
  // socket only ever connects on http / same-origin pages (e.g. the bridge
  // dashboard at :3006), so don't open it on https — it would just stall and
  // retry forever for no gain, and falsely show "Disconnected".
  if (location.protocol === 'https:') {
    window.__empir3MailboxMode = true;
    updateStatusDot(true); // mailbox transport is live; show healthy
  } else {
    connect();
  }
  setTimeout(announceTabToBridge, 500);
  setTimeout(announceTabToBridge, 1800);
  console.log('[Empir3 Bridge] Overlay loaded. Ctrl+Shift+C=chat, Ctrl+Shift+R=record, Ctrl+Shift+P=playback.');
})();
`;
}

main().catch(console.error);
