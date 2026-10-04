/**
 * Permissions-page security claim vs MCP inventory (Work Board 22e20910, P1),
 * plus the inventory/doc mismatches from the same audit (P3).
 *
 * Observed: the page said disabled tools "never appear in the MCP client's
 * inventory", yet 24 desktop_* tools and every interact/eval/recording tool
 * were listed by tools/list while disabled — enforcement is at call time
 * ("MCP tool disabled locally: <tool>"). Because MCP inventories are fixed at
 * connect time, call-time enforcement is the robust model; the claim was the
 * bug. This contract is the refusal proof the card asked for: the page must
 * not claim invisibility, it must describe call-time refusal, and the
 * dispatcher must still refuse a disabled tool.
 *
 * Proof run (2026-09-13): re-inserting "Disabled tools never appear in the
 * MCP client's inventory" into the lede turns `page does not claim` red;
 * restoring the wording turns it green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const mcp = readFileSync(new URL('../src/mcp-server.ts', import.meta.url), 'utf8');
const defaults = readFileSync(new URL('../src/tool-defaults.ts', import.meta.url), 'utf8');

function permissionsLede() {
  const m = /data-pane="permissions">[\s\S]*?<p class="pane-lede">([\s\S]*?)<\/p>/.exec(server);
  assert.ok(m, 'Permissions pane lede present');
  const disclosure = /<details class="permission-help">([\s\S]*?)<\/details>/.exec(server);
  return m[1] + (disclosure ? disclosure[1] : '');
}

test('Permissions page does not claim disabled tools are invisible to MCP clients', () => {
  const lede = permissionsLede();
  assert.doesNotMatch(lede, /never appear in the MCP client/i, 'page must not claim inventory filtering the MCP layer does not do');
  assert.doesNotMatch(lede, /never appear/i);
});

test('Permissions page describes call-time enforcement and the fixed MCP inventory', () => {
  const lede = permissionsLede();
  assert.match(lede, /refused the moment an agent calls it/);
  assert.match(lede, /MCP tool disabled locally/);
  assert.match(lede, /inventories are fixed at connect time/);
  assert.match(lede, /explicit consent, no AI judgment/);
});

test('the dispatcher refuses a disabled tool at call time with that exact wording', () => {
  // The refusal the page now describes must exist in enforceCommandPolicy.
  assert.match(server, /if \(cfg\.enabledTools\?\.\[toolName\] === false\)/);
  assert.match(server, /error: `MCP tool disabled locally: \$\{toolName\}`/);
});

test('tool-defaults header describes both surfaces the same way', () => {
  assert.match(defaults, /MCP clients \(Claude Code, Codex, Cursor, …\) receive the full tool\s*\*\s*inventory at connect time/);
  assert.doesNotMatch(defaults, /disabled tools never appear in the\s*\*\s*model's tool inventory/);
});

test('MCP does not filter per-tool enabled state from tools/list (only families and provider-gated tools)', () => {
  // Guard against a half-implemented filter that would make the page wrong again.
  assert.doesNotMatch(mcp, /enabledTools\?\.\[[^\]]+\] === false/);
  assert.match(mcp, /if \(isHandlerFamilyEnabled\('higgsfield'\)\)/);
  assert.match(mcp, /if \(hasAnyCustomProvider\(\)\)/);
});

test('every Permissions-page tool that is not family/provider gated is registered with MCP', () => {
  const names = [...defaults.matchAll(/\{\s*name:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(names.length > 40, 'tool meta parsed');
  const registered = new Set([...mcp.matchAll(/server\.tool\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));
  const gated = new Set(['custom_llm', 'custom_capability', 'higgsfield_status', 'higgsfield_list', 'higgsfield_models', 'higgsfield_generate']);
  const missing = names.filter((n) => !gated.has(n) && !registered.has(n));
  assert.deepEqual(missing, [], `Permissions-page tools absent from tools/list: ${missing.join(', ')}`);
  assert.ok(registered.has('browser_audit_page'), 'browser_audit_page reaches the inventory');
  assert.ok(registered.has('browser_run_checks'), 'browser_run_checks reaches the inventory');
});

test('custom_llm inventory rule matches the Permissions-page rule (custom chat provider OR API key)', () => {
  assert.match(mcp, /Object\.values\(apiKeys\)\.some\(\(v\) => typeof v === 'string' && v\.trim\(\)\)/);
  assert.match(server, /!apiProvidersState\.some\(provider => provider\.keySet\)/);
});

test('snapshot ref docs use the real e<snapshot>_<index> form', () => {
  for (const [file, text] of [['mcp-server.ts', mcp], ['tool-defaults.ts', defaults], ['server.ts', server]]) {
    const stale = [...text.matchAll(/\(e\.g\.,? "?e\d+"?\)/g)].map((m) => m[0]);
    assert.deepEqual(stale, [], `${file} still documents refs as e<digits>: ${stale.join(', ')}`);
  }
  assert.match(mcp, /e3_0/);
  assert.match(server, /refs \(e3_0, e3_1/);
  assert.match(mcp, /refs are e<snapshot>_<index>/);
});

test('target on input tools is documented as a guard, not a selector', () => {
  assert.match(mcp, /const guardTargetSchema=controlTargetSchema\.describe\('Optional safety guard, NOT a tab selector/);
  assert.match(mcp, /target:guardTargetSchema\.optional\(\)/);
  assert.match(mcp, /browser_tab_close','Close the exact current agent-controlled tab\. `target` must name the tab that is ALREADY current \(it is a guard, not a selector\)/);
});

test('activate and tab_focus promise verified switching; tab_state documents agentTab', () => {
  assert.match(mcp, /bridge_control_activate','[^']*success:true means the switch was VERIFIED/);
  assert.match(mcp, /`agentTab` is the single agent-controlled tab/);
  assert.match(server, /const outcome = await waitForActivation\(\(\) => listBrowserTabs\(\), wanted\);/);
  assert.match(server, /agentTab: state\.agentTab,/);
});

test('observe exposes compact and maxElements; emulate exposes reload', () => {
  assert.match(mcp, /compact:z\.boolean\(\)\.optional\(\)\.describe\('Browser targets: omit null\/false\/empty fields/);
  assert.match(mcp, /reload: z\.boolean\(\)\.optional\(\)\.describe\('Reload the page after applying/);
});
