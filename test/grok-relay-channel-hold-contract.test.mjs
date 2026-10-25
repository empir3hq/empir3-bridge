import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Contracts for the 0.3.88 relay channel-hold repair. A grok relay turn's
// concurrency channel is released only when the child EXITS, so every path
// that lets a finished-or-abandoned child keep running holds a channel for
// the full timeout_sec. Three structural guarantees:
//   1. No-tools turns get the SAME per-turn isolation as tool turns
//      (real-home no-flag runs intermittently hang after the final answer,
//      and bypass both the cross-tenant boundary and the refresh gate).
//   2. A pending MCP tools/call can never outlive its turn, and an abort
//      that lands while no child is registered still terminates the child
//      that spawns moments later.
//   3. Wall-hits and orphaned/dropped tool results are LOUD in bridge.log.

const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('grok relay spec wires no-tools turns through the same isolation as tool turns', () => {
  assert.match(source, /noToolsSetup: \(turnId, bridge\) => grokMcpSetup\(turnId, bridge, ''\)/);
  // The runner actually consumes the hook for text-only turns.
  assert.match(source, /else if \(spec\.noToolsSetup\) \{/);
  assert.match(source, /mcpHandle = await spec\.noToolsSetup\(id, bridgeName\);/);
  assert.match(source, /stage: 'turn_isolation'/);
});

test('pending tools/call waits are capped by the turn budget, not the 20-min default', () => {
  assert.match(source, /toolCallTimeoutMs: timeoutMs > 90_000 \? timeoutMs - 30_000 : timeoutMs/);
  assert.match(source, /opts\.toolCallTimeoutMs \?\? MCP_TOOL_CALL_TIMEOUT_MS/);
  // Cap can shrink but never exceed the historic default.
  assert.match(source, /Math\.min\(MCP_TOOL_CALL_TIMEOUT_MS, opts\.toolCallTimeoutMs \?\? MCP_TOOL_CALL_TIMEOUT_MS\)/);
});

test('an abort with no live child marks the turn so a later spawn is terminated', () => {
  assert.match(source, /const preSpawnAbortedTurns = new Set<string>\(\);/);
  assert.match(source, /markPreSpawnAbort\(id\);/);
  assert.match(source, /if \(preSpawnAbortedTurns\.delete\(id\)\) \{/);
  assert.match(source, /aborted during setup/);
  // Expiry so ids from turns that never spawn cannot leak.
  assert.match(source, /setTimeout\(\(\) => preSpawnAbortedTurns\.delete\(id\), 5 \* 60_000\)/);
});

test('channel-hold diagnostics are loud: wall-hits, slow pending calls, dropped results', () => {
  // Turn timeout emission now logs and reports since-last-output + pending calls.
  assert.match(source, /TIMEOUT after \$\{Math\.round\(duration_ms \/ 1000\)\}s/);
  assert.match(source, /pending tool call\(s\) at kill/);
  assert.match(source, /since_last_output_ms/);
  assert.match(source, /pending_tool_calls/);
  // A tools/call pending >2 min warns while it waits, and an orphaned call is named.
  assert.match(source, /channel held waiting on server tool result/);
  assert.match(source, /ORPHANED — no server result within/);
  // Late/unroutable tool results are visible instead of silently dropped.
  assert.match(source, /tool:result DROPPED — no pending map for turn/);
  assert.match(source, /tool:result DROPPED — unknown callId/);
});

test('grok is opted OUT of eager attach verification — lazy MCP client since 1.0.5', () => {
  // A no-tool-needed prompt on grok 1.0.5 exits without ever fetching
  // tools/list; verification hard-failed those healthy answers (two burned
  // CLI runs + hosted failover per prompt). The spec must carry the lazy
  // rationale and the flag must be off.
  assert.match(source, /Grok 1\.0\.5 became a LAZY MCP client/);
  const grokSpec = source.slice(source.indexOf('const GROK_PLAIN_CLI_SPEC'), source.indexOf('async function handleGrokCliCommand'));
  assert.match(grokSpec, /verifyMcpAttach: false/);
  // Gemini stays verified — probed eager.
  const geminiSpec = source.slice(source.indexOf('const GEMINI_PLAIN_CLI_SPEC'), source.indexOf('async function handleGeminiCliCommand'));
  assert.match(geminiSpec, /verifyMcpAttach: true/);
});

test('grok relay isolation removes native file tools so lazy attach cannot write to the Bridge PC', () => {
  const isolation = readFileSync(new URL('../src/grok-turn-isolation.ts', import.meta.url), 'utf8');
  assert.match(isolation, /\.\.\.\(options\.allowNativeTools \? \[\] : \['--tools', ''\]\)/);
  assert.match(isolation, /failed lazy MCP attach cannot silently fall through/);
});
