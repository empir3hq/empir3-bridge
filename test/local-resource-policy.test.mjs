import test from 'node:test';
import assert from 'node:assert/strict';
import { safeConversationId, safeFlatResourceName } from '../src/local-resource-policy.mjs';

test('conversation ids are flat bounded identifiers', () => {
  assert.equal(safeConversationId('42f8c9b7-30bd-4be2-a00d-734534b7dc7e'), '42f8c9b7-30bd-4be2-a00d-734534b7dc7e');
  for (const value of ['../secret', '..\\secret', 'a/b', 'a%2fb', '', '.hidden/child']) {
    assert.equal(safeConversationId(value), null, value);
  }
});
test('recording and screenshot names cannot traverse their storage roots', () => {
  assert.equal(safeFlatResourceName('demo one', { appendExtension: '.json', extensions: ['.json'] }), 'demo one.json');
  assert.equal(safeFlatResourceName('shot-1.jpg', { extensions: ['.jpg', '.png'] }), 'shot-1.jpg');
  for (const value of ['../secret.json', '..%2fsecret.json', '%2e%2e%5csecret.json', 'C:%5csecret.json', 'nested/file.json', 'x%00.json']) {
    assert.equal(safeFlatResourceName(value, { appendExtension: '.json', extensions: ['.json'] }), null, value);
  }
});
