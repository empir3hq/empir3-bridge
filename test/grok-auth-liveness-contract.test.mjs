import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('Grok relay classifies auth rejection before toolless MCP failure', () => {
  const decisiveClose = server.lastIndexOf("child.on('close', async (code) =>");
  const closeHandler = server.slice(
    decisiveClose,
    server.indexOf("child.on('error'", decisiveClose),
  );
  assert.ok(closeHandler.indexOf('classifyGrokAuthFailure') >= 0);
  assert.ok(closeHandler.indexOf('const ranToolless') > closeHandler.indexOf('classifyGrokAuthFailure'));
  assert.match(closeHandler, /stage: 'auth'/);
  assert.match(closeHandler, /markGrokAuthInvalid/);
});

test('Grok authorization UI exposes explicit live verification truth', () => {
  assert.match(server, /url\.pathname === '\/api\/cli\/verify-auth'/);
  assert.match(server, /async function verifyGrokAuthLive/);
  assert.match(server, /data-cli-verify-auth="grok"/);
  assert.match(server, /onCliVerifyAuthClick/);
  assert.match(server, /CREDENTIALS FOUND · VERIFY/);
  assert.match(server, /NEEDS RE-AUTH/);
  assert.match(server, /Last live check/);
});

test('manual verification and plain relay use deterministic Grok output mode', () => {
  assert.match(server, /Reply with exactly \$\{marker\} and no other text\./);
  assert.match(server, /'--output-format', 'plain'/);
  assert.match(server, /baseArgs: \['--output-format', 'plain'\]/);
});
