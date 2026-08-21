import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  parseAgyModelCatalog,
  parseCodexModelCatalog,
  parseGrokModelCatalog,
} = require('../src/cli-model-catalog.js');

test('Codex catalog exposes only sanitized list-visible fields', () => {
  const parsed = parseCodexModelCatalog(JSON.stringify({ models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      visibility: 'list',
      supported_in_api: true,
      context_window: 400000,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'high' }],
      base_instructions: 'must never cross the Bridge wire',
    },
    { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
    { slug: 'bad model', display_name: 'Bad', visibility: 'list' },
  ] }));
  assert.deepEqual(parsed.models, [{
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    context_window: 400000,
    api_supported: true,
    reasoning_efforts: ['low', 'high'],
  }]);
  assert.doesNotMatch(JSON.stringify(parsed), /base_instructions|must never/);
});

test('Grok account-visible text catalog is parsed without login prose', () => {
  const parsed = parseGrokModelCatalog(`You are logged in with grok.com.\n\nDefault model: grok-4.5\n\nAvailable models:\n  * grok-4.5 (default)\n  * grok-4-fast\n`);
  assert.deepEqual(parsed.models, [
    { id: 'grok-4.5', name: 'grok-4.5', default: true },
    { id: 'grok-4-fast', name: 'grok-4-fast' },
  ]);
  assert.doesNotMatch(JSON.stringify(parsed), /logged in|grok\.com/i);
});

test('Agy accepts bounded JSON or line catalogs and rejects prose', () => {
  assert.deepEqual(parseAgyModelCatalog('{"models":[{"id":"gemini-3-pro","displayName":"Gemini 3 Pro","isDefault":true}]}').models, [
    { id: 'gemini-3-pro', name: 'Gemini 3 Pro', default: true },
  ]);
  assert.deepEqual(parseAgyModelCatalog('Available models:\n- gemini-3-pro (default)\n- nano-banana-pro-2').models, [
    { id: 'gemini-3-pro', name: 'gemini-3-pro', default: true },
    { id: 'nano-banana-pro-2', name: 'nano-banana-pro-2' },
  ]);
  assert.equal(parseAgyModelCatalog('OAuth login required before continuing').ok, false);
});

test('all model parsers fail closed on malformed output', () => {
  assert.equal(parseCodexModelCatalog('not json').error, 'invalid_catalog');
  assert.equal(parseGrokModelCatalog('nothing useful').error, 'empty_catalog');
  assert.equal(parseAgyModelCatalog('').error, 'empty_catalog');
});
