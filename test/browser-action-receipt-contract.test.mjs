import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const bridge = readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const mcp = readFileSync(new URL('../src/mcp-server.ts', import.meta.url), 'utf8');

test('selector and ref clicks require a trusted event receipt', () => {
  assert.match(bridge, /event\.isTrusted/);
  assert.match(bridge, /received no trusted pointer event/);
  assert.match(bridge, /clickBrowserTarget\(String\(body\.selector\)/);
  assert.doesNotMatch(bridge, /document\.querySelector\(\$\{JSON\.stringify\(body\.selector\)\}\)\?\.click/);
});

test('selector and ref typing uses real focus and keyboard events then verifies the value', () => {
  assert.match(bridge, /await clickBrowserTarget\(selector, label\)/);
  assert.match(bridge, /await pressKey\('Control\+a'\)/);
  assert.match(bridge, /Typing verification failed/);
  assert.match(server, /cdpPost\('\/action', \{ kind: 'type', selector: cmd\.selector/);
  assert.match(server, /cdpPost\('\/action', \{ kind: 'type', ref: cmd\.ref/);
});

test('MCP surfaces return action receipts instead of unconditional success prose', () => {
  assert.match(mcp, /const result = await bridgeCommand\(\{ type: 'click', selector \}\);\s*return jsonResult\(result\)/);
  assert.match(mcp, /const result = await bridgeCommand\(\{ type: 'type_ref', ref, text \}\);\s*return jsonResult\(result\)/);
  assert.doesNotMatch(mcp, /return textResult\(`Clicked: \$\{selector\}`\)/);
});

test('browser close targets one tab and reports success only after disappearance is verified', () => {
  assert.match(bridge, /browserSend\('Target\.closeTarget', \{ targetId \}\)/);
  assert.match(bridge, /if \(!chromeProcess \|\| chromeClosedByUser\) \{\s*closed = true/);
  assert.match(bridge, /Chrome did not confirm target \$\{targetId\} closed/);
  assert.match(server, /cdpPost\('\/close-target', \{ targetId: resolvedTargetId \}/);
  assert.match(server, /success: result\?\.closed === true/);
  assert.doesNotMatch(server, /case 'close':\s*return \{ success: true, closed: false/);
});
