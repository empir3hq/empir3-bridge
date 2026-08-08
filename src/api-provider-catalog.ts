/**
 * Key-backed text providers shared by the Empir3 website and Bridge.
 *
 * Keep this list aligned with server/src/providers/templates in the app repo.
 * Media-only and search-only providers intentionally do not appear here: every
 * provider shown in the Bridge API section must be executable as a chat route.
 */

export type ApiProviderProtocol = 'openai-compatible' | 'anthropic' | 'google';

export interface ApiProviderDefinition {
  slug: string;
  relaySlug: string;
  name: string;
  protocol: ApiProviderProtocol;
  apiBaseUrl: string;
  keyPlaceholder: string;
  defaultModels: string[];
}

export const API_PROVIDERS: readonly ApiProviderDefinition[] = [
  {
    slug: 'anthropic', relaySlug: 'bridge-api-anthropic', name: 'Anthropic',
    protocol: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', keyPlaceholder: 'sk-ant-…',
    defaultModels: [
      'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
      'claude-opus-4-5-20251101', 'claude-opus-4-1-20250805', 'claude-opus-4-20250514',
      'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001',
    ],
  },
  {
    slug: 'deepseek', relaySlug: 'bridge-api-deepseek', name: 'DeepSeek',
    protocol: 'openai-compatible', apiBaseUrl: 'https://api.deepseek.com', keyPlaceholder: 'sk-…',
    defaultModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    slug: 'google', relaySlug: 'bridge-api-google', name: 'Google AI',
    protocol: 'google', apiBaseUrl: 'https://generativelanguage.googleapis.com', keyPlaceholder: 'AIza…',
    defaultModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-pro-preview', 'gemini-3-flash-preview'],
  },
  {
    slug: 'groq', relaySlug: 'bridge-api-groq', name: 'Groq',
    protocol: 'openai-compatible', apiBaseUrl: 'https://api.groq.com/openai/v1', keyPlaceholder: 'gsk_…',
    defaultModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  },
  {
    slug: 'mistral', relaySlug: 'bridge-api-mistral', name: 'Mistral AI',
    protocol: 'openai-compatible', apiBaseUrl: 'https://api.mistral.ai/v1', keyPlaceholder: '…',
    defaultModels: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
  },
  {
    slug: 'moonshot', relaySlug: 'bridge-api-moonshot', name: 'Moonshot AI',
    protocol: 'openai-compatible', apiBaseUrl: 'https://api.moonshot.ai/v1', keyPlaceholder: 'sk-…',
    defaultModels: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2.5'],
  },
  {
    slug: 'openai', relaySlug: 'bridge-api-openai', name: 'OpenAI',
    protocol: 'openai-compatible', apiBaseUrl: 'https://api.openai.com/v1', keyPlaceholder: 'sk-…',
    defaultModels: ['gpt-5.5', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
  },
  {
    slug: 'openrouter', relaySlug: 'bridge-api-openrouter', name: 'OpenRouter',
    protocol: 'openai-compatible', apiBaseUrl: 'https://openrouter.ai/api/v1', keyPlaceholder: 'sk-or-…',
    defaultModels: ['anthropic/claude-sonnet-4', 'openai/gpt-4o', 'google/gemini-2.5-pro', 'deepseek/deepseek-r1'],
  },
  {
    slug: 'perplexity', relaySlug: 'bridge-api-perplexity', name: 'Perplexity',
    protocol: 'openai-compatible', apiBaseUrl: 'https://api.perplexity.ai', keyPlaceholder: 'pplx-…',
    defaultModels: ['sonar', 'sonar-pro', 'sonar-reasoning', 'sonar-reasoning-pro', 'sonar-deep-research'],
  },
  {
    slug: 'xai', relaySlug: 'bridge-api-xai', name: 'xAI (Grok)',
    protocol: 'openai-compatible', apiBaseUrl: 'https://api.x.ai/v1', keyPlaceholder: 'xai-…',
    defaultModels: ['grok-3', 'grok-3-mini', 'grok-2-vision-1212'],
  },
  {
    slug: 'zai', relaySlug: 'bridge-api-zai', name: 'z.ai',
    protocol: 'openai-compatible', apiBaseUrl: 'https://api.z.ai/api/paas/v4', keyPlaceholder: '…',
    defaultModels: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5v'],
  },
] as const;

export const API_PROVIDER_SLUGS = API_PROVIDERS.map(provider => provider.slug);

export function apiProviderDefinition(slug: string): ApiProviderDefinition | undefined {
  return API_PROVIDERS.find(provider => provider.slug === slug);
}

/** The model list endpoints include audio, image, moderation, and embedding
 * models. Do not advertise those as chat routes in the Agent Builder. */
export function isTextChatModel(model: string): boolean {
  const id = String(model || '').toLowerCase();
  if (!id) return false;
  return !/(^|[-_/])(embedding|embed|moderation|whisper|transcribe|transcription|tts|speech|audio|realtime|image|imagen|video|veo|sora|dall-e)([-_/]|$)/i.test(id);
}

export function uniqueChatModels(models: unknown[], fallback: string[] = []): string[] {
  const normalized = models
    .map(model => String(model || '').replace(/^models\//, '').trim())
    .filter(model => model.length > 0 && model.length <= 200 && isTextChatModel(model));
  const unique = [...new Set(normalized)].slice(0, 250);
  return unique.length > 0 ? unique : [...fallback];
}
