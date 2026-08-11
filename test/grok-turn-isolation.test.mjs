import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupStaleGrokMcpSections, createGrokTurnIsolation } from '../src/grok-turn-isolation.ts';

test('concurrent Grok turns receive separate homes, configs, auth copies, and leader sockets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empir3-grok-isolation-test-'));
  const realHome = join(root, 'real-home');
  const turnRoot = join(root, 'turns');
  await mkdir(join(realHome, '.grok'), { recursive: true });
  await mkdir(turnRoot, { recursive: true });
  await writeFile(join(realHome, '.grok', 'auth.json'), '{"access_token":"test-secret"}', 'utf-8');
  const sharedConfig = '[ui]\nscreen_mode = "minimal"\n';
  await writeFile(join(realHome, '.grok', 'config.toml'), sharedConfig, 'utf-8');

  const [a, b] = await Promise.all([
    createGrokTurnIsolation('user-a-project-a', 'http://127.0.0.1:41001/mcp', { realHome, tempRoot: turnRoot }),
    createGrokTurnIsolation('user-b-project-b', 'http://127.0.0.1:41002/mcp', { realHome, tempRoot: turnRoot }),
  ]);

  try {
    assert.notEqual(a.root, b.root);
    assert.notEqual(a.configPath, b.configPath);
    assert.notEqual(a.leaderSocket, b.leaderSocket);
    assert.equal(a.env.HOME, a.root);
    assert.equal(a.env.USERPROFILE, a.root);
    assert.equal(b.env.HOME, b.root);
    assert.deepEqual(a.extraArgs.slice(-2), ['--leader-socket', a.leaderSocket]);
    assert.deepEqual(b.extraArgs.slice(-2), ['--leader-socket', b.leaderSocket]);

    const [configA, configB, authA, authB, sharedAfter] = await Promise.all([
      readFile(a.configPath, 'utf-8'),
      readFile(b.configPath, 'utf-8'),
      readFile(join(a.root, '.grok', 'auth.json'), 'utf-8'),
      readFile(join(b.root, '.grok', 'auth.json'), 'utf-8'),
      readFile(join(realHome, '.grok', 'config.toml'), 'utf-8'),
    ]);
    assert.match(configA, /41001/);
    assert.doesNotMatch(configA, /41002/);
    assert.match(configB, /41002/);
    assert.doesNotMatch(configB, /41001/);
    assert.equal(authA, '{"access_token":"test-secret"}');
    assert.equal(authB, '{"access_token":"test-secret"}');
    assert.equal(sharedAfter, sharedConfig);
  } finally {
    await Promise.all([a.cleanup(), b.cleanup()]);
    assert.equal(existsSync(a.root), false);
    assert.equal(existsSync(b.root), false);
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
