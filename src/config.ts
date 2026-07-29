/**
 * Bridge config — BYO-key (Anthropic API) or BYO-CLI (claude binary).
 *
 * Persisted at ~/.empir3-bridge/config.json. Created on first read with
 * sensible defaults so a fresh user never sees a "config missing" error.
 *
 * Default mode = 'cli' if `claude` is on PATH, else 'api'. Either mode is
 * fine; the chat loop branches on `mode` and the unused field stays empty.
 *
 * Secrets (anthropicApiKey) live in this file. chmod 600 on write best-effort
 * — Windows ignores POSIX modes, but per-user data dir already gates access.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { defaultEnabledTools, ALL_TOOL_NAMES } from './tool-defaults.js';

export type ChatMode = 'api' | 'cli';

export interface BridgeConfig {
  mode: ChatMode;
  anthropicApiKey: string;       // empty when not set — legacy field, mirrored into apiKeys.anthropic
  claudeCliPath: string;          // empty = let cli-runner auto-detect
  model: string;                  // claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5
  maxTokens: number;
  systemPrompt: string;           // empty = use built-in
  enabledTools: Record<string, boolean>;
  maxLoopIterations: number;      // safety cap on tool-use loop
  // Provider API keys. Each empty when unset. The legacy `anthropicApiKey`
  // field stays for backward-compat with older configs + the API-mode chat
  // path; new providers (openai, google, xai) only flow through here.
  apiKeys: {
    anthropic: string;
    openai: string;
    google: string;
    xai: string;
  };
}

const CONFIG_DIR = join(homedir(), '.empir3-bridge');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const LEGACY_CONFIG_FILE = join(homedir(), '.claude-bridge', 'config.json');

// Sonnet by default — it's the right cost/quality tradeoff for browser
// automation chat. Users pick Opus in /settings when they want it.
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_LOOP_CAP = 20;

function detectClaudeOnPath(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    // On Windows, `where` returns both the unix shim (`claude`) and the
    // batch shim (`claude.cmd`). Node's spawn can only run `.cmd` directly
    // — the bare unix file is a shell script and ENOENTs. Prefer `.cmd`.
    if (process.platform === 'win32') {
      const cmdShim = lines.find(l => l.toLowerCase().endsWith('.cmd'));
      if (cmdShim) return cmdShim;
    }
    return lines[0];
  } catch {
    return null;
  }
}

function defaultConfig(): BridgeConfig {
  const cliPath = detectClaudeOnPath();
  return {
    mode: cliPath ? 'cli' : 'api',
    anthropicApiKey: '',
    claudeCliPath: cliPath || '',
    model: DEFAULT_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    systemPrompt: '',
    enabledTools: defaultEnabledTools(),
    maxLoopIterations: DEFAULT_LOOP_CAP,
    apiKeys: { anthropic: '', openai: '', google: '', xai: '' },
  };
}

/**
 * Merge persisted config over defaults so fields added in newer versions
 * always have a value, and per-tool toggles for tools the user has never
 * seen pick up the default (rather than being silently disabled because
 * the JSON is missing the key).
 */
function hydrate(raw: Partial<BridgeConfig>): BridgeConfig {
  const base = defaultConfig();
  const enabled = { ...base.enabledTools };
  if (raw.enabledTools && typeof raw.enabledTools === 'object') {
    // Migration: openai_chat → custom_llm (renamed pre-public-launch to
    // avoid collision with OpenAI Codex CLI, which is unrelated). If the
    // old key is present and the new key has not been explicitly set,
    // carry the user's prior choice forward. The old key falls out
    // automatically — it's not in ALL_TOOL_NAMES anymore.
    const legacy: any = raw.enabledTools;
    if (typeof legacy.openai_chat === 'boolean' && typeof legacy.custom_llm !== 'boolean') {
      legacy.custom_llm = legacy.openai_chat;
    }
    for (const k of ALL_TOOL_NAMES) {
      if (typeof raw.enabledTools[k] === 'boolean') enabled[k] = raw.enabledTools[k];
    }
  }
  const rawKeys: any = (raw as any).apiKeys || {};
  const legacyAnthropic = typeof raw.anthropicApiKey === 'string' ? raw.anthropicApiKey : '';
  const apiKeys = {
    // Legacy field wins if the new field is empty — keeps old configs working.
    anthropic: typeof rawKeys.anthropic === 'string' && rawKeys.anthropic ? rawKeys.anthropic : legacyAnthropic,
    openai: typeof rawKeys.openai === 'string' ? rawKeys.openai : '',
    google: typeof rawKeys.google === 'string' ? rawKeys.google : '',
    xai: typeof rawKeys.xai === 'string' ? rawKeys.xai : '',
  };
  return {
    mode: raw.mode === 'api' || raw.mode === 'cli' ? raw.mode : base.mode,
    anthropicApiKey: apiKeys.anthropic,
    claudeCliPath: typeof raw.claudeCliPath === 'string' && raw.claudeCliPath ? raw.claudeCliPath : base.claudeCliPath,
    model: typeof raw.model === 'string' && raw.model ? raw.model : base.model,
    maxTokens: typeof raw.maxTokens === 'number' && raw.maxTokens > 0 ? raw.maxTokens : base.maxTokens,
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '',
    enabledTools: enabled,
    maxLoopIterations: typeof raw.maxLoopIterations === 'number' && raw.maxLoopIterations > 0
      ? raw.maxLoopIterations : base.maxLoopIterations,
    apiKeys,
  };
}

export function loadConfig(): BridgeConfig {
  try {
    const file = existsSync(CONFIG_FILE)
      ? CONFIG_FILE
      : existsSync(LEGACY_CONFIG_FILE)
        ? LEGACY_CONFIG_FILE
        : '';
    if (!file) return defaultConfig();
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    return hydrate(raw);
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(patch: Partial<BridgeConfig>): BridgeConfig {
  const current = loadConfig();
  const mergedKeys = { ...current.apiKeys, ...((patch as any).apiKeys || {}) };
  const next: BridgeConfig = {
    ...current,
    ...patch,
    enabledTools: { ...current.enabledTools, ...(patch.enabledTools || {}) },
    apiKeys: mergedKeys,
    // Keep the legacy field in sync with the new one so any consumer still
    // reading anthropicApiKey directly continues to work.
    anthropicApiKey: mergedKeys.anthropic,
  };
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  try { chmodSync(CONFIG_FILE, 0o600); } catch { /* Windows; best-effort */ }
  return next;
}

/**
 * Sanitized config for the /api/config GET response — NEVER returns the raw
 * API key, just whether one is set. Settings UI uses this to render a
 * masked field that re-asks for the key only when the user wants to change it.
 */
export function publicConfig(c: BridgeConfig = loadConfig()) {
  return {
    mode: c.mode,
    anthropicApiKeySet: c.apiKeys.anthropic.length > 0,
    claudeCliPath: c.claudeCliPath,
    model: c.model,
    maxTokens: c.maxTokens,
    systemPrompt: c.systemPrompt,
    enabledTools: c.enabledTools,
    maxLoopIterations: c.maxLoopIterations,
    apiKeysSet: {
      anthropic: c.apiKeys.anthropic.length > 0,
      openai: c.apiKeys.openai.length > 0,
      google: c.apiKeys.google.length > 0,
      xai: c.apiKeys.xai.length > 0,
    },
  };
}

export function configReady(c: BridgeConfig = loadConfig()): { ready: boolean; reason?: string } {
  if (c.mode === 'api') {
    if (!c.anthropicApiKey) return { ready: false, reason: 'Anthropic API key not set. Open localhost:3006/settings to configure.' };
    return { ready: true };
  }
  if (c.mode === 'cli') {
    if (!c.claudeCliPath) return { ready: false, reason: '`claude` CLI not found on PATH. Install Claude Code or switch to API mode at localhost:3006/settings.' };
    return { ready: true };
  }
  return { ready: false, reason: `Unknown mode: ${c.mode}` };
}
