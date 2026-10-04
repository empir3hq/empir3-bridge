import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createGrokTurnIsolation } from '../src/grok-turn-isolation.ts';

async function main() {
  const marker = 'EMPIR3_GROK_ISOLATION_PROBE';
  const bin = join(homedir(), '.grok', 'bin', 'grok.exe');
  const turn = await createGrokTurnIsolation('local-compat-probe');
  try {
  const started = Date.now();
  const result = spawnSync(bin, [
    '--single', `Reply with exactly ${marker} and no other text.`,
    '--output-format', 'plain', '--no-subagents', '--max-turns', '1',
    '--disable-web-search', ...turn.extraArgs,
  ], {
    cwd: turn.root,
    env: { ...process.env, ...turn.env },
    encoding: 'utf8',
    timeout: 90_000,
  });
  console.log(JSON.stringify({
    exitCode: result.status,
    marker: result.stdout.includes(marker),
    elapsedMs: Date.now() - started,
    stderr: result.stderr.trim().slice(0, 500),
  }));
    if (result.status !== 0 || !result.stdout.includes(marker)) process.exitCode = 1;
  } finally {
    await turn.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
