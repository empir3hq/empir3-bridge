/** Generic capability-rail contracts. Pure Node: no local endpoint required. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const core = require('../src/capability-core.js');
const { MAX_SYNC_FILE_BYTES } = require('../src/sync-limits.js');
const handlerSource = readFileSync(new URL('../src/handlers/capability.ts', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const transportSource = readFileSync(new URL('../src/asset-transport.ts', import.meta.url), 'utf8');

test('kind and wire validation is closed, with absent kind preserving chat providers', () => {
  assert.deepEqual(core.validateCapabilityProviderFields({}), {
    ok: true, kind: 'chat', wire: undefined, workflowJson: undefined,
  });
  assert.equal(core.validateCapabilityProviderFields({ kind: 'stt', wire: 'whisper-http' }).ok, true);
  assert.equal(core.validateCapabilityProviderFields({ kind: 'tts', wire: 'kokoro-native' }).ok, true);
  assert.equal(core.validateCapabilityProviderFields({ kind: 'image', wire: 'a1111' }).ok, true);
  assert.equal(core.validateCapabilityProviderFields({ kind: 'image', wire: 'arbitrary-forwarder' }).ok, false);
  assert.equal(core.validateCapabilityProviderFields({ kind: 'embeddings', wire: 'openai' }).ok, false);
});

test('ComfyUI workflow is capped, parsed first, and requires %PROMPT%', () => {
  const missing = core.validateCapabilityProviderFields({
    kind: 'image', wire: 'comfyui', workflowJson: JSON.stringify({ node: { inputs: { text: 'fixed' } } }),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /%PROMPT%/);
  const valid = core.validateCapabilityProviderFields({
    kind: 'image', wire: 'comfyui', workflowJson: JSON.stringify({ node: { inputs: { text: '%PROMPT%' } } }),
  });
  assert.equal(valid.ok, true);
  const oversized = core.validateCapabilityProviderFields({
    kind: 'image', wire: 'comfyui', workflowJson: JSON.stringify({ prompt: '%PROMPT%', padding: 'x'.repeat(300_000) }),
  });
  assert.equal(oversized.ok, false);
  assert.match(oversized.error, /exceeds/);
});

test('workflow substitution is value-level and quote-safe', () => {
  const parsed = core.parseWorkflowJson(JSON.stringify({
    text: '%PROMPT%', width: '%WIDTH%', nested: ['prefix %PROMPT% suffix'],
  }));
  assert.equal(parsed.ok, true);
  const prompt = 'a "quoted" prompt with \\slashes';
  const output = core.substituteWorkflowValues(parsed.workflow, { '%PROMPT%': prompt, '%WIDTH%': 1536 });
  assert.equal(output.text, prompt);
  assert.equal(output.width, 1536);
  assert.equal(output.nested[0], `prefix ${prompt} suffix`);
  assert.doesNotThrow(() => JSON.stringify(output));
});

test('tier boundary uses the existing sync math at MAX_SYNC_FILE_BYTES ± 1', () => {
  assert.equal(core.assetTier(Buffer.alloc(MAX_SYNC_FILE_BYTES - 1)), 'inline');
  assert.equal(core.assetTier(Buffer.alloc(MAX_SYNC_FILE_BYTES)), 'inline');
  assert.equal(core.assetTier(Buffer.alloc(MAX_SYNC_FILE_BYTES + 1)), 'upload');
});

test('inbound media rejects oversize before endpoint reachability', () => {
  const atCap = core.decodeInboundBase64(Buffer.alloc(MAX_SYNC_FILE_BYTES).toString('base64'), 'audio');
  assert.equal(atCap.ok, true);
  const over = core.decodeInboundBase64(Buffer.alloc(MAX_SYNC_FILE_BYTES + 1).toString('base64'), 'audio');
  assert.equal(over.ok, false);
  assert.match(over.error, new RegExp(String(MAX_SYNC_FILE_BYTES + 1)));
  const validateIdx = handlerSource.indexOf("decodeInboundBase64(input.audio_base64");
  const fetchIdx = handlerSource.indexOf("const response = await fetch", validateIdx);
  assert.ok(validateIdx > 0 && fetchIdx > validateIdx, 'STT bytes are validated before fetch');
});

test('native Whisper uses its audio multipart field while OpenAI keeps file', () => {
  assert.match(handlerSource, /provider\.wire === 'openai-transcriptions' \? 'file' : 'audio'/);
  assert.match(handlerSource, /form\.append\(audioField,/);
});

test('abort stops queued/running work and ComfyUI receives an interrupt', () => {
  assert.match(handlerSource, /params\.signal\?\.aborted/);
  assert.match(serverSource, /activeCapabilityRuns\.get\(id\)\?\.abort/);
  assert.match(handlerSource, /endpoint\(provider\.apiBaseUrl, 'interrupt'\)/);
  assert.match(handlerSource, /while \(!signal\.aborted\)/);
});

test('unknown action, opt-out, and upload-stage errors stay distinct', () => {
  assert.match(serverSource, /stage: 'unknown_action'/);
  assert.match(serverSource, /stage: 'opted_out'/);
  assert.match(serverSource, /Make this available to my Empir3 agents/);
  assert.match(transportSource, /asset upload HTTP/);
  assert.match(handlerSource, /stage = String\(error\?\.stage \|\| \(\/upload\/i/);
});

test('safe advertisement maps every provider kind to the matching Builder capability', () => {
  assert.deepEqual(core.capabilitiesForKind('chat'), ['chat', 'code']);
  assert.deepEqual(core.capabilitiesForKind('stt'), ['stt']);
  assert.deepEqual(core.capabilitiesForKind('tts'), ['tts']);
  assert.deepEqual(core.capabilitiesForKind('image'), ['imagegen']);
  assert.match(serverSource, /capabilities: capabilitiesForKind\(p\.kind\)/);
  assert.match(serverSource, /kind: normalizeProviderKind\(p\.kind\) \|\| 'chat'/);
});

test('provider probes use the native health or discovery route for each wire', () => {
  assert.equal(core.capabilityProbePath('stt', 'whisper-http'), '/health');
  assert.equal(core.capabilityProbePath('tts', 'kokoro-native'), '/health');
  assert.equal(core.capabilityProbePath('image', 'a1111'), '/sdapi/v1/sd-models');
  assert.equal(core.capabilityProbePath('image', 'comfyui'), '/system_stats');
  assert.equal(core.capabilityProbePath('stt', 'openai-transcriptions'), '/models');
});

test('OpenAI-compatible image providers use multipart edits when reference pixels are present', () => {
  assert.match(handlerSource, /endpoint\(provider\.apiBaseUrl, 'images\/edits', true\)/);
  assert.match(handlerSource, /form\.append\('image', new Blob/);
  assert.match(handlerSource, /decodeInboundBase64\(referenceRaw, 'reference image'\)/);
  assert.match(handlerSource, /headers: authHeaders\(provider\), body: form/);
  assert.match(handlerSource, /endpoint\(provider\.apiBaseUrl, 'images\/generations', true\)/);
});

test('Agy and Higgsfield use the same two-tier deliverAsset path', () => {
  const higgsfield = readFileSync(new URL('../src/handlers/higgsfield-cli.ts', import.meta.url), 'utf8');
  assert.match(serverSource, /deliverAsset\(out\.result\.bytes, out\.result\.mimeType, payload\?\.upload\)/);
  assert.match(higgsfield, /deliverAsset\(bytes, mimeType, payload\?\.upload\)/);
  assert.match(serverSource, /upload_id: delivered\.uploadId/);
  assert.match(higgsfield, /upload_id: delivered\.uploadId/);
});
