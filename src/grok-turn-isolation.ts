import { constants as fsConstants } from 'fs';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join, parse } from 'path';

import { atomicWrite, grokRefreshGate, writeBackRefreshedAuth } from './grok-refresh-gate.js';

export interface GrokTurnIsolation {
  root: string;
  configPath: string;
  leaderSocket: string;
  serverName: string;
  env: NodeJS.ProcessEnv;
  extraArgs: string[];
  cleanup: () => Promise<void>;
}

function safeTurnId(turnId: string): string {
  return String(turnId || 'turn').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'turn';
}

function grokMcpSection(serverName: string, shimUrl: string): string {
  const safeUrl = String(shimUrl || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    `[mcp_servers.${serverName}]`,
    `url = "${safeUrl}"`,
    'type = "http"',
    'enabled = true',
    '',
  ].join('\n');
}

function grokIsolationConfig(serverName: string, shimUrl: string): string {
  // Grok 1.0.5 imports Claude and Cursor MCP catalogs by default, separately
  // from its own GROK_HOME config. A clean home therefore still is not an
  // isolated turn on a developer workstation. Disable every compatibility
  // surface in the private turn config; the one intended Empir3 MCP server is
  // then appended explicitly for relay turns.
  const compatibility = [
    '[compat.cursor]',
    'skills = false',
    'rules = false',
    'agents = false',
    'mcps = false',
    'hooks = false',
    'sessions = false',
    '',
    '[compat.claude]',
    'skills = false',
    'rules = false',
    'agents = false',
    'mcps = false',
    'hooks = false',
    'sessions = false',
    '',
    '[compat.codex]',
    'sessions = false',
    '',
  ].join('\n');
  return compatibility + (shimUrl ? grokMcpSection(serverName, shimUrl) : '');
}

async function copyAuthOnly(realHome: string, isolatedGrokDir: string): Promise<string | null> {
  const source = join(realHome, '.grok', 'auth.json');
  let original: string;
  try {
    original = await readFile(source, 'utf-8');
  } catch {
    // API-key auth can be inherited from the process environment, so auth.json
    // is optional. Never link the whole .grok directory: it contains config,
    // sessions, locks, history, and the shared leader socket.
    return null;
  }
  const target = join(isolatedGrokDir, 'auth.json');
  await copyFile(source, target);
  try { await chmod(target, 0o600); } catch { /* Windows ACLs own this */ }
  return original;
}

/**
 * Creates a complete per-turn Grok home. Only the user's auth token is copied;
 * config, history, locks, active sessions, and leader socket never cross turns.
 */
export async function createGrokTurnIsolation(
  turnId: string,
  shimUrl = '',
  options: { realHome?: string; tempRoot?: string; allowNativeTools?: boolean } = {},
): Promise<GrokTurnIsolation> {
  const id = safeTurnId(turnId);
  const realHome = options.realHome || homedir();
  const root = await mkdtemp(join(options.tempRoot || tmpdir(), `empir3-grok-${id}-`));
  const grokDir = join(root, '.grok');
  await mkdir(grokDir, { recursive: true, mode: 0o700 });

  try {
    const originalAuth = await copyAuthOnly(realHome, grokDir);
    // The refresh gate eagerly watches every live isolated auth copy so a
    // rotated token is CAS-persisted to the real home the moment it appears —
    // reopening the serialized pool without waiting for turn cleanup. `root`
    // is the registration key because mkdtemp guarantees it is unique even
    // when two turns share a truncated turn id.
    if (originalAuth !== null) grokRefreshGate.registerIsolation(root, realHome, grokDir, originalAuth);
    const serverName = `empir3-${id}`;
    const configPath = join(grokDir, 'config.toml');
    const leaderSocket = join(grokDir, `leader-${id}.sock`);
    await atomicWrite(configPath, grokIsolationConfig(serverName, shimUrl));

    const parsed = parse(root);
    const homePath = root.slice(parsed.root.length - (parsed.root.endsWith('\\') ? 1 : 0));
    const env: NodeJS.ProcessEnv = {
      // Grok has its own explicit config-root override. HOME/USERPROFILE are
      // not sufficient on Windows: a managed install can still resolve its
      // real ~/.grok and start user-configured MCP servers during a headless
      // verification turn. Point GROK_HOME at the auth-only isolated config.
      GROK_HOME: grokDir,
      CLAUDE_CONFIG_DIR: join(root, '.claude'),
      GROK_CLAUDE_MCPS_ENABLED: 'false',
      GROK_CURSOR_MCPS_ENABLED: 'false',
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, '.config'),
      ...(process.platform === 'win32' ? {
        HOMEDRIVE: parsed.root.replace(/[\\/]$/, ''),
        HOMEPATH: homePath.startsWith('\\') ? homePath : `\\${homePath}`,
      } : {}),
    };

    return {
      root,
      configPath,
      leaderSocket,
      serverName,
      env,
      // Relay turns must never mutate the Bridge machine with Grok's native
      // Read/Write/Edit/Bash-style toolkit. Project tools arrive separately
      // through the per-turn Empir3 MCP server; --tools "" removes only the
      // built-ins, so a failed lazy MCP attach cannot silently fall through to
      // Bridge-local files and report them as Empir3 project work. Grok 1.0.4
      // was probed to keep ordinary no-tool text replies working with this
      // flag, which preserves the reason eager attach verification is off.
      extraArgs: [
        '--always-approve',
        ...(options.allowNativeTools ? [] : ['--tools', '']),
        '--leader-socket', leaderSocket,
      ],
      cleanup: async () => {
        // The eager watcher may already have advanced the baseline past the
        // turn's original copy; a final write-back must compare against the
        // newest synced state or a second in-turn rotation would be dropped.
        try {
          const baseline = grokRefreshGate.baselineFor(root) ?? originalAuth;
          await writeBackRefreshedAuth(realHome, grokDir, baseline);
        } catch {}
        grokRefreshGate.unregisterIsolation(root);
        try { await rm(root, { recursive: true, force: true }); } catch {}
      },
    };
  } catch (error) {
    grokRefreshGate.unregisterIsolation(root);
    try { await rm(root, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

const STALE_EMPIR3_SECTION = /(?:^|\r?\n)\[mcp_servers\.empir3-[^\]\r\n]+\][\s\S]*?(?=\r?\n\[|$)/g;

/** Removes only sections written by older Bridge versions, preserving every
 * user-owned Grok setting. New turns never write the shared config at all. */
export async function cleanupStaleGrokMcpSections(realHome = homedir()): Promise<{ removed: number }> {
  const configPath = join(realHome, '.grok', 'config.toml');
  let current = '';
  try { current = await readFile(configPath, 'utf-8'); } catch { return { removed: 0 }; }
  const matches = current.match(STALE_EMPIR3_SECTION) || [];
  if (!matches.length) return { removed: 0 };
  const next = current.replace(STALE_EMPIR3_SECTION, '\n').replace(/^\s+/, '').replace(/\s+$/, '') + '\n';
  await atomicWrite(configPath, next);
  return { removed: matches.length };
}
