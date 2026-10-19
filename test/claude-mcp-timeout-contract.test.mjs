import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('Claude tool turns align the total and idle MCP ceilings', () => {
  const envBlock = server.match(/const turnEnv = claudeCliEnv\(\);[\s\S]{0,1800}const cleanupAttempt/)?.[0] || '';

  assert.ok(envBlock, 'Claude turn environment block should exist');
  assert.match(envBlock, /turnEnv\.MCP_TIMEOUT = String\(MCP_TOOL_CALL_TIMEOUT_MS\)/);
  assert.match(envBlock, /turnEnv\.MCP_TOOL_TIMEOUT = String\(MCP_TOOL_CALL_TIMEOUT_MS\)/);
  assert.match(envBlock, /turnEnv\.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = String\(MCP_TOOL_CALL_TIMEOUT_MS\)/);
  assert.doesNotMatch(envBlock, /CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = ['\"]?0/);
});
