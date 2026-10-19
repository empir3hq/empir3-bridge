'use strict';

const MAX_MODELS = 200;
const MAX_MODEL_ID_LENGTH = 180;
const MAX_MODEL_NAME_LENGTH = 120;

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function cleanModelId(value) {
  const id = cleanText(value, MAX_MODEL_ID_LENGTH);
  return id && /^[a-z0-9][a-z0-9._:/-]*$/i.test(id) ? id : '';
}

function uniqueModels(rawModels) {
  const seen = new Set();
  const models = [];
  for (const raw of rawModels) {
    if (models.length >= MAX_MODELS) break;
    const id = cleanModelId(raw?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: cleanText(raw?.name, MAX_MODEL_NAME_LENGTH) || id,
      ...(raw?.default === true ? { default: true } : {}),
      ...(Number.isFinite(raw?.context_window) && raw.context_window > 0
        ? { context_window: Math.min(Math.round(raw.context_window), 10_000_000) }
        : {}),
      ...(raw?.api_supported === true ? { api_supported: true } : {}),
      ...(Array.isArray(raw?.reasoning_efforts) && raw.reasoning_efforts.length > 0
        ? { reasoning_efforts: raw.reasoning_efforts.map((value) => cleanText(value, 24)).filter(Boolean).slice(0, 12) }
        : {}),
    });
  }
  return models;
}

function catalogResult(models, error = null) {
  const clean = uniqueModels(models);
  return clean.length > 0
    ? { ok: true, models: clean, error: null }
    : { ok: false, models: [], error: error || 'empty_catalog' };
}

function parseCodexModelCatalog(stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout || '')); } catch { return catalogResult([], 'invalid_catalog'); }
  if (!Array.isArray(parsed?.models)) return catalogResult([], 'invalid_catalog');
  return catalogResult(parsed.models
    .filter((raw) => raw?.visibility === 'list')
    .map((raw) => ({
      id: raw?.slug,
      name: raw?.display_name,
      context_window: Number(raw?.context_window),
      api_supported: raw?.supported_in_api === true,
      reasoning_efforts: Array.isArray(raw?.supported_reasoning_levels)
        ? [...new Set(raw.supported_reasoning_levels.map((entry) => cleanText(entry?.effort, 24)).filter(Boolean))]
        : [],
    })));
}

function parseGrokModelCatalog(stdout) {
  const text = String(stdout || '');
  const defaultMatch = text.match(/^\s*Default model:\s*([^\s()]+)\s*$/im);
  const defaultId = cleanModelId(defaultMatch?.[1]);
  const models = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[*+-]|\d+[.)])\s+([^\s()]+)(?:\s+\(default\))?\s*$/i);
    const id = cleanModelId(match?.[1]);
    if (id) models.push({ id, name: id, default: id === defaultId || /\(default\)/i.test(line) });
  }
  if (defaultId && !models.some((model) => model.id === defaultId)) {
    models.unshift({ id: defaultId, name: defaultId, default: true });
  }
  return catalogResult(models);
}

function parseAgyModelCatalog(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return catalogResult([]);
  try {
    const parsed = JSON.parse(text);
    const rawModels = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : [];
    if (rawModels.length > 0) {
      return catalogResult(rawModels.map((raw) => typeof raw === 'string'
        ? { id: raw, name: raw }
        : {
            id: raw?.id || raw?.name || raw?.model,
            name: raw?.display_name || raw?.displayName || raw?.name || raw?.id,
            default: raw?.default === true || raw?.isDefault === true,
          }));
    }
  } catch {}

  const models = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(available\s+models?|models?|name\s+id|[-=]{2,})\s*:?$/i.test(trimmed)) continue;
    const match = trimmed.match(/^(?:[*+-]\s+)?([a-z0-9][a-z0-9._:/-]*)(?:\s+\(default\))?(?:(?:\t+| {2,})(.*))?$/i);
    const id = cleanModelId(match?.[1]);
    if (id) models.push({
      id,
      name: cleanText(match?.[2], MAX_MODEL_NAME_LENGTH) || id,
      default: /\bdefault\b/i.test(trimmed),
    });
  }
  return catalogResult(models);
}

module.exports = {
  parseAgyModelCatalog,
  parseCodexModelCatalog,
  parseGrokModelCatalog,
};
