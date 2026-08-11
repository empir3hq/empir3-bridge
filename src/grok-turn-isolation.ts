import { constants as fsConstants } from 'fs';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join, parse } from 'path';

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

async function copyAuthOnly(realHome: string, isolatedGrokDir: string): Promise<void> {
  const source = join(realHome, '.grok', 'auth.json');
  try {
    await access(source, fsConstants.R_OK);
  } catch {
    // API-key auth can be inherited from the process environment, so auth.json
    // is optional. Never link the whole .grok directory: it contains config,
    // sessions, locks, history, and the shared leader socket.
    return;
  }
  const target = join(isolatedGrokDir, 'auth.json');
  await copyFile(source, target);
  try { await chmod(target, 0o600); } catch { /* Windows ACLs own this */ }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    await rename(tempPath, path);
  } catch (error) {
    try { await rm(tempPath, { force: true }); } catch {}
    throw error;
  }
}

/**
 * Creates a complete per-turn Grok home. Only the user's auth token is copied;
 * config, history, locks, active sessions, and leader socket never cross turns.
 */
export async function createGrokTurnIsolation(
  turnId: string,
  shimUrl = '',
  options: { realHome?: string; tempRoot?: string } = {},
): Promise<GrokTurnIsolation> {
  const id = safeTurnId(turnId);
  const realHome = options.realHome || homedir();
  const root = await mkdtemp(join(options.tempRoot || tmpdir(), `empir3-grok-${id}-`));
  const grokDir = join(root, '.grok');
  await mkdir(grokDir, { recursive: true, mode: 0o700 });

  try {
    await copyAuthOnly(realHome, grokDir);
    const serverName = `empir3-${id}`;
    const configPath = join(grokDir, 'config.toml');
    const leaderSocket = join(grokDir, `leader-${id}.sock`);
    await atomicWrite(configPath, shimUrl ? grokMcpSection(serverName, shimUrl) : '');

    const parsed = parse(root);
    const homePath = root.slice(parsed.root.length - (parsed.root.endsWith('\\') ? 1 : 0));
    const env: NodeJS.ProcessEnv = {
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
      extraArgs: ['--always-approve', '--leader-socket', leaderSocket],
      cleanup: async () => {
        try { await rm(root, { recursive: true, force: true }); } catch {}
      },
    };
  } catch (error) {
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
