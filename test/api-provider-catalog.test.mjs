import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = readFileSync(join(root, 'src', 'api-provider-catalog.ts'), 'utf8');
const server = readFileSync(join(root, 'src', 'server.ts'), 'utf8');

test('Bridge API catalog matches the website text-provider catalog', () => {
  const slugs = [...catalog.matchAll(/slug: '([^']+)', relaySlug:/g)].map(match => match[1]);
  assert.deepEqual(slugs, [
    'anthropic', 'deepseek', 'google', 'groq', 'mistral', 'moonshot',
    'openai', 'openrouter', 'perplexity', 'xai', 'zai',
  ]);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.doesNotMatch(catalog, /slug: '(?:tavily|cartesia|elevenlabs|higgsfield)'/);
});

test('built-in API providers are validated, advertised, and executed locally', () => {
  assert.match(server, /buildLentCustomProvidersState[\s\S]*readConfiguredApiProviders/);
  assert.match(server, /runLentCustomProviderTurn[\s\S]*readConfiguredApiProviders/);
  assert.match(server, /\/api\/api-providers\//);
  assert.match(server, /provider\.protocol === 'anthropic'/);
  assert.match(server, /provider\.protocol === 'google'/);
  assert.match(server, /\/v1\/messages/);
  assert.match(server, /:generateContent/);
});

test('API provider relay metadata remains privacy safe', () => {
  const fn = server.slice(
    server.indexOf('async function buildLentCustomProvidersState'),
    server.indexOf('function canonicalContentText'),
  );
  assert.match(fn, /slug: p\.slug/);
  assert.match(fn, /name: p\.name/);
  assert.match(fn, /models,/);
  assert.doesNotMatch(fn, /apiKey:/);
  assert.doesNotMatch(fn, /apiBaseUrl:/);
});
