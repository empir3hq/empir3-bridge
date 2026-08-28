'use strict';

const { existsSync, readFileSync, statSync } = require('node:fs');
const { MAX_SYNC_FILE_BYTES, fitsSyncFrame } = require('./sync-limits.js');

const CAPABILITY_KINDS = Object.freeze(['chat', 'stt', 'tts', 'image']);
const CAPABILITY_WIRES = Object.freeze({
  chat: Object.freeze([]),
  stt: Object.freeze(['openai-transcriptions', 'whisper-http']),
  tts: Object.freeze(['openai-speech', 'kokoro-native']),
  image: Object.freeze(['a1111', 'comfyui', 'openai-images']),
});
const COMFY_WORKFLOW_MAX_BYTES = 256 * 1024;

function normalizeProviderKind(value) {
  const kind = String(value || 'chat').trim().toLowerCase();
  return CAPABILITY_KINDS.includes(kind) ? kind : null;
}

function capabilitiesForKind(value) {
  const kind = normalizeProviderKind(value);
  if (kind === 'stt') return ['stt'];
  if (kind === 'tts') return ['tts'];
  if (kind === 'image') return ['imagegen'];
  return ['chat', 'code'];
}

function capabilityProbePath(kindValue, wireValue) {
  const kind = normalizeProviderKind(kindValue);
  const wire = String(wireValue || '').trim().toLowerCase();
  if (kind === 'stt' && wire === 'whisper-http') return '/health';
  if (kind === 'tts' && wire === 'kokoro-native') return '/health';
  if (kind === 'image' && wire === 'a1111') return '/sdapi/v1/sd-models';
  if (kind === 'image' && wire === 'comfyui') return '/system_stats';
  return '/models';
}

function validateCapabilityProviderFields(raw) {
  const kind = normalizeProviderKind(raw && raw.kind);
  if (!kind) return { ok: false, error: '`kind` must be chat, stt, tts, or image' };
  if (kind === 'chat') return { ok: true, kind: 'chat', wire: undefined, workflowJson: undefined };

  const wire = String((raw && raw.wire) || '').trim().toLowerCase();
  if (!CAPABILITY_WIRES[kind].includes(wire)) {
    return { ok: false, error: `\`wire\` must be one of: ${CAPABILITY_WIRES[kind].join(', ')}` };
  }

  let workflowJson;
  if (wire === 'comfyui') {
    workflowJson = String((raw && raw.workflowJson) || '').trim();
    if (!workflowJson) return { ok: false, error: '`workflowJson` is required for ComfyUI' };
    const parsed = parseWorkflowJson(workflowJson);
    if (!parsed.ok) return parsed;
    if (!workflowContainsPlaceholder(parsed.workflow, '%PROMPT%')) {
      return { ok: false, error: 'ComfyUI workflow is missing required placeholder %PROMPT%' };
    }
  }
  return { ok: true, kind, wire, workflowJson };
}

function parseWorkflowJson(raw) {
  const source = String(raw || '').trim();
  if (!source) return { ok: false, error: 'ComfyUI workflow is empty' };
  let text = source;
  try {
    if (!source.startsWith('{') && !source.startsWith('[') && existsSync(source)) {
      const stat = statSync(source);
      if (!stat.isFile()) return { ok: false, error: 'ComfyUI workflow path is not a file' };
      if (stat.size > COMFY_WORKFLOW_MAX_BYTES) {
        return { ok: false, error: `ComfyUI workflow exceeds ${COMFY_WORKFLOW_MAX_BYTES} bytes` };
      }
      text = readFileSync(source, 'utf8');
    }
  } catch (error) {
    return { ok: false, error: `Could not read ComfyUI workflow: ${error && error.message ? error.message : error}` };
  }
  if (Buffer.byteLength(text, 'utf8') > COMFY_WORKFLOW_MAX_BYTES) {
    return { ok: false, error: `ComfyUI workflow exceeds ${COMFY_WORKFLOW_MAX_BYTES} bytes` };
  }
  try {
    const workflow = JSON.parse(text);
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
      return { ok: false, error: 'ComfyUI workflow must be a JSON object' };
    }
    return { ok: true, workflow };
  } catch (error) {
    return { ok: false, error: `ComfyUI workflow is not valid JSON: ${error && error.message ? error.message : error}` };
  }
}

function workflowContainsPlaceholder(value, placeholder) {
  if (typeof value === 'string') return value.includes(placeholder);
  if (Array.isArray(value)) return value.some((entry) => workflowContainsPlaceholder(entry, placeholder));
  if (value && typeof value === 'object') {
    return Object.values(value).some((entry) => workflowContainsPlaceholder(entry, placeholder));
  }
  return false;
}

/** Substitute only after JSON parsing. Exact placeholder values retain typed
 * numbers; embedded placeholders stay strings. The JSON source is never
 * spliced, so quotes in prompts cannot corrupt the graph. */
function substituteWorkflowValues(value, replacements) {
  if (typeof value === 'string') {
    if (Object.prototype.hasOwnProperty.call(replacements, value)) return replacements[value];
    let next = value;
    for (const [token, replacement] of Object.entries(replacements)) {
      next = next.split(token).join(String(replacement ?? ''));
    }
    return next;
  }
  if (Array.isArray(value)) return value.map((entry) => substituteWorkflowValues(entry, replacements));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = substituteWorkflowValues(entry, replacements);
    return out;
  }
  return value;
}

function decodeInboundBase64(raw, label) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: `${label} is required` };
  const normalized = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    return { ok: false, error: `${label} is not valid base64` };
  }
  const bytes = Buffer.from(normalized, 'base64');
  if (!bytes.length) return { ok: false, error: `${label} decoded to zero bytes` };
  if (bytes.length > MAX_SYNC_FILE_BYTES) {
    return { ok: false, error: `${label} is ${bytes.length} bytes; maximum inline input is ${MAX_SYNC_FILE_BYTES} bytes` };
  }
  return { ok: true, bytes };
}

function assetTier(bytes) {
  const base64 = Buffer.from(bytes).toString('base64');
  return fitsSyncFrame(base64, true) ? 'inline' : 'upload';
}

module.exports = {
  CAPABILITY_KINDS,
  CAPABILITY_WIRES,
  COMFY_WORKFLOW_MAX_BYTES,
  MAX_SYNC_FILE_BYTES,
  normalizeProviderKind,
  capabilitiesForKind,
  capabilityProbePath,
  validateCapabilityProviderFields,
  parseWorkflowJson,
  workflowContainsPlaceholder,
  substituteWorkflowValues,
  decodeInboundBase64,
  assetTier,
};
