import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupStaleGrokMcpSections, createGrokTurnIsolation } from '../src/grok-turn-isolation.ts';

test('five concurrent Grok turns receive separate homes, configs, auth copies, and leader sockets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empir3-grok-isolation-test-'));
  const realHome = join(root, 'real-home');
  const turnRoot = join(root, 'turns');
  await mkdir(join(realHome, '.grok'), { recursive: true });
  await mkdir(turnRoot, { recursive: true });
  await writeFile(join(realHome, '.grok', 'auth.json'), '{"access_token":"test-secret"}', 'utf-8');
  const sharedConfig = '[ui]\nscreen_mode = "minimal"\n';
  await writeFile(join(realHome, '.grok', 'config.toml'), sharedConfig, 'utf-8');

  const turns = await Promise.all(Array.from({ length: 5 }, (_, index) => (
    createGrokTurnIsolation(
      `user-${index}-project-${index}`,
      `http://127.0.0.1:${41001 + index}/mcp`,
      { realHome, tempRoot: turnRoot },
    )
  )));

  try {
    assert.equal(new Set(turns.map(turn => turn.root)).size, 5);
    assert.equal(new Set(turns.map(turn => turn.configPath)).size, 5);
    assert.equal(new Set(turns.map(turn => turn.leaderSocket)).size, 5);

    const configs = await Promise.all(turns.map(turn => readFile(turn.configPath, 'utf-8')));
    const authCopies = await Promise.all(turns.map(turn => readFile(join(turn.root, '.grok', 'auth.json'), 'utf-8')));
    const sharedAfter = await readFile(join(realHome, '.grok', 'config.toml'), 'utf-8');
    turns.forEach((turn, index) => {
      assert.equal(turn.env.HOME, turn.root);
      assert.equal(turn.env.USERPROFILE, turn.root);
      assert.deepEqual(turn.extraArgs.slice(-2), ['--leader-socket', turn.leaderSocket]);
      assert.match(configs[index], new RegExp(String(41001 + index)));
      configs.forEach((otherConfig, otherIndex) => {
        if (otherIndex !== index) assert.doesNotMatch(configs[index], new RegExp(String(41001 + otherIndex)));
      });
    });
    assert.ok(authCopies.every(auth => auth === '{"access_token":"test-secret"}'));
    assert.equal(sharedAfter, sharedConfig);
  } finally {
    await Promise.all(turns.map(turn => turn.cleanup()));
    assert.ok(turns.every(turn => !existsSync(turn.root)));
    await rm(root, { recursive: true, force: true });
  }
});

test('startup cleanup removes only legacy Empir3 MCP sections atomically', async () => {
  const home = await mkdtemp(join(tmpdir(), 'empir3-grok-stale-test-'));
  await mkdir(join(home, '.grok'), { recursive: true });
  await writeFile(join(home, '.grok', 'config.toml'), [
    '[ui]',
    'screen_mode = "minimal"',
    '',
    '[mcp_servers.user-owned]',
    'url = "https://example.invalid/mcp"',
    '',
    '[mcp_servers.empir3-old-turn]',
    'url = "http://127.0.0.1:1/mcp"',
    'enabled = true',
    '',
    '[mcp_servers.empir3-another-turn]',
    'url = "http://127.0.0.1:2/mcp"',
    'enabled = true',
    '',
  ].join('\n'), 'utf-8');

  try {
    assert.deepEqual(await cleanupStaleGrokMcpSections(home), { removed: 2 });
    const after = await readFile(join(home, '.grok', 'config.toml'), 'utf-8');
    assert.match(after, /\[ui\]/);
    assert.match(after, /\[mcp_servers\.user-owned\]/);
    assert.doesNotMatch(after, /mcp_servers\.empir3-/);
    assert.deepEqual(await cleanupStaleGrokMcpSections(home), { removed: 0 });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
