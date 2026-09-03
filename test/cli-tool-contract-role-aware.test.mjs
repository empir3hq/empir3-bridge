import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Source-level contract for the tool preamble every lent-CLI turn carries.
// A coordinator turn (dispatch_specialist in the toolkit) must be told that
// dispatching IS the work; a specialist turn keeps the do-it-yourself wording.
// Regression guard for Empir3 board 10ffac37: Vincent on a flash-class CLI
// model read the specialist contract above his own prompt and generated the
// hero images himself instead of dispatching Zara.
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('one shared, role-aware tool contract feeds both CLI prompt builders', () => {
  assert.match(server, /function empir3ToolContractLines\(toolNames: string\[\]\): string\[\]/);
  assert.match(server, /const coordinator = toolNames\.includes\('dispatch_specialist'\)/);
  // Both builders consume the helper rather than carrying their own copy.
  const uses = server.match(/\.\.\.empir3ToolContractLines\(/g) || [];
  assert.equal(uses.length, 2, 'buildCodexBridgePrompt and buildPlainCliPrompt both use the shared contract');
  // The old inline copies are gone — the wording lives in exactly one place.
  const inlineMust = server.match(/you MUST call the appropriate Empir3 project tools and complete the work before answering/g) || [];
  assert.equal(inlineMust.length, 1, 'specialist wording appears once, inside the helper');
});

test('coordinator turns are told dispatch_specialist is the work tool and production tools belong to specialists', () => {
  assert.match(server, /dispatch_specialist is the tool that does it/);
  assert.match(server, /belong to the specialists you dispatch/);
  assert.match(server, /wait for it and then present it/);
});

test('the Codex builder receives the tool list, not a boolean', () => {
  assert.match(server, /function buildCodexBridgePrompt\(system: string, messages: any\[\], tools: Array<\{ name\?: string \}> = \[\]\): string/);
  assert.match(server, /buildCodexBridgePrompt\(String\(payload\?\.system \|\| ''\), messages, turnTools\)/);
  assert.doesNotMatch(server, /buildCodexBridgePrompt\([^)]*turnTools\.length > 0\)/);
});
