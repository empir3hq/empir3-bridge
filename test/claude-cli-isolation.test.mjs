import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('lent Claude turns preserve OAuth while isolating owner customizations', () => {
  const envBlock = server.match(/function claudeCliEnv\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert.match(envBlock, /delete env\.ANTHROPIC_API_KEY/);
  assert.match(envBlock, /delete env\.ANTHROPIC_AUTH_TOKEN/);
  assert.match(envBlock, /delete env\.CLAUDE_CODE_SAFE_MODE/);
  assert.doesNotMatch(envBlock, /env\.CLAUDE_CODE_SAFE_MODE\s*=/);
});

test('lent Claude turns only accept MCP servers from the per-turn shim', () => {
  const turnBlock = server.match(/async function startClaudeCliTurn[\s\S]*?function abortClaudeCliTurn/)?.[0] || '';
  assert.match(turnBlock, /'--strict-mcp-config'/);
  assert.match(turnBlock, /'--setting-sources='/);
  assert.match(turnBlock, /'--disable-slash-commands'/);
  assert.match(turnBlock, /'--mcp-config', cfgPath/);
  assert.match(turnBlock, /'--allowedTools', allowed\.join\(','\)/);
  assert.match(turnBlock, /'--disallowedTools', CLAUDE_CLI_DISALLOWED_BUILTINS\.join\(','\)/);
  assert.match(turnBlock, /cwd: turnTempDir/);
  assert.doesNotMatch(turnBlock, /cwd: process\.cwd\(\)/);
});

test('Claude vision keeps OAuth but does not load owner settings, skills, or MCP servers', () => {
  const visionBlock = server.match(/async function runClaudeCliSee[\s\S]*?async function runCodexCliSee/)?.[0] || '';
  assert.match(visionBlock, /'--strict-mcp-config'/);
  assert.match(visionBlock, /'--setting-sources='/);
  assert.match(visionBlock, /'--disable-slash-commands'/);
  assert.match(visionBlock, /unsetEnv: \['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_SAFE_MODE'\]/);
  assert.match(visionBlock, /cwd: tempDir/);
});
