import { existsSync } from 'fs';
import { join } from 'path';

export interface UpdateRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type UpdateRunner = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number; maxBytes?: number; cwd?: string },
) => Promise<UpdateRunResult>;

interface NpmMetadata {
  versions?: Record<string, unknown>;
  'dist-tags'?: Record<string, string>;
}

function stableVersionParts(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || '').trim());
  return match ? match.slice(1).map(Number) : null;
}

function compareStableVersions(a: string, b: string): number {
  const pa = stableVersionParts(a) || [0, 0, 0];
  const pb = stableVersionParts(b) || [0, 0, 0];
  for (let index = 0; index < 3; index++) {
    if (pa[index] !== pb[index]) return pa[index] - pb[index];
  }
  return 0;
}

export function selectLatestMatchedClaudeVersion(root: NpmMetadata, platform: NpmMetadata): string | null {
  const platformVersions = new Set(Object.keys(platform?.versions || {}));
  const latest = String(root?.['dist-tags']?.latest || '');
  if (stableVersionParts(latest) && platformVersions.has(latest)) return latest;
  const matched = Object.keys(root?.versions || {})
    .filter(version => stableVersionParts(version) && platformVersions.has(version))
    .sort(compareStableVersions);
  return matched.at(-1) || null;
}

function versionFromOutput(value: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(String(value || ''))?.[1] || null;
}

function platformPackage(arch: string): string {
  if (arch === 'x64') return '@anthropic-ai/claude-code-win32-x64';
  if (arch === 'arm64') return '@anthropic-ai/claude-code-win32-arm64';
  throw new Error(`Safe Claude updater does not support Windows ${arch}`);
}

function commandFailure(label: string, result: UpdateRunResult): Error {
  const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(-1200);
  return new Error(`${label} failed${detail ? `: ${detail}` : ''}`);
}

export async function safeUpdateClaudeOnWindows(options: {
  claudeCommand: string;
  npmCommand: string;
  nodeCommand?: string;
  arch?: string;
  npmGlobalRoot?: string;
  run: UpdateRunner;
  fetchMetadata: (packageName: string) => Promise<NpmMetadata>;
  fileExists?: (path: string) => boolean;
}): Promise<any> {
  const run = options.run;
  const nodeCommand = options.nodeCommand || process.execPath;
  const arch = options.arch || process.arch;
  const fileExists = options.fileExists || existsSync;
  const packageName = '@anthropic-ai/claude-code';
  const nativePackage = platformPackage(arch);

  const before = await run(options.claudeCommand, ['--version'], { timeoutMs: 20_000, maxBytes: 128 * 1024 });
  const previousVersion = before.code === 0 ? versionFromOutput(`${before.stdout}\n${before.stderr}`) : null;
  if (!previousVersion) throw commandFailure('Reading the currently working Claude version', before);

  const [rootMetadata, platformMetadata] = await Promise.all([
    options.fetchMetadata(packageName),
    options.fetchMetadata(nativePackage),
  ]);
  const targetVersion = selectLatestMatchedClaudeVersion(rootMetadata, platformMetadata);
  if (!targetVersion) throw new Error(`npm has no Claude release with a matching ${nativePackage} package`);
  if (targetVersion === previousVersion) {
    return { ok: true, updated: false, previousVersion, version: previousVersion, targetVersion, verified: true };
  }

  let globalRoot = options.npmGlobalRoot || '';
  if (!globalRoot) {
    const rootResult = await run(options.npmCommand, ['root', '-g'], { timeoutMs: 30_000, maxBytes: 128 * 1024 });
    if (rootResult.code !== 0) throw commandFailure('Resolving the global npm directory', rootResult);
    globalRoot = rootResult.stdout.trim();
  }
  if (!globalRoot) throw new Error('npm returned an empty global package directory');
  const packageDir = join(globalRoot, '@anthropic-ai', 'claude-code');

  const installAndVerify = async (version: string): Promise<string> => {
    const installed = await run(options.npmCommand, ['install', '--global', `${packageName}@${version}`], {
      timeoutMs: 5 * 60_000,
      maxBytes: 2 * 1024 * 1024,
    });
    if (installed.code !== 0 || installed.timedOut) throw commandFailure(`Installing Claude ${version}`, installed);
    const installScript = join(packageDir, 'install.cjs');
    if (!fileExists(installScript)) throw new Error(`Claude ${version} installed without install.cjs`);
    // npm allow-scripts can skip the package postinstall for global installs.
    // Running the fixed vendor script explicitly completes the native binary
    // wiring instead of leaving the claude shim pointed at a missing exe.
    const wired = await run(nodeCommand, [installScript], {
      cwd: packageDir,
      timeoutMs: 2 * 60_000,
      maxBytes: 2 * 1024 * 1024,
    });
    if (wired.code !== 0 || wired.timedOut) throw commandFailure(`Wiring Claude ${version}'s native executable`, wired);
    const verified = await run(options.claudeCommand, ['--version'], { timeoutMs: 30_000, maxBytes: 128 * 1024 });
    const observed = verified.code === 0 ? versionFromOutput(`${verified.stdout}\n${verified.stderr}`) : null;
    if (observed !== version) throw commandFailure(`Verifying Claude ${version} (observed ${observed || 'no version'})`, verified);
    return observed;
  };

  try {
    const version = await installAndVerify(targetVersion);
    return { ok: true, updated: true, previousVersion, targetVersion, version, verified: true };
  } catch (updateError: any) {
    try {
      const restoredVersion = await installAndVerify(previousVersion);
      return {
        ok: false,
        updated: false,
        rolledBack: true,
        previousVersion,
        targetVersion,
        version: restoredVersion,
        verified: true,
        error: `Claude ${targetVersion} failed verification and was rolled back to ${restoredVersion}: ${updateError?.message || updateError}`,
      };
    } catch (rollbackError: any) {
      throw new Error(
        `Claude ${targetVersion} update failed (${updateError?.message || updateError}); rollback to ${previousVersion} also failed (${rollbackError?.message || rollbackError})`,
      );
    }
  }
}
