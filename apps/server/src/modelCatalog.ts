import { providerConfigRepo, type ProviderConfigRow } from '@katnor/db';
import type { ModelProvider } from '@katnor/core';
import { decryptSecret } from './crypto.js';

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
// Anthropic's API requires a version pin on every request; this is the
// stable, long-lived version string, not tied to any particular model.
const ANTHROPIC_VERSION = '2023-06-01';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface ModelSummary {
  id: string;
  display_name: string;
}

/** Back-compat alias - the old Anthropic-only name. */
export type AnthropicModelSummary = ModelSummary;

interface AnthropicModelsResponse {
  data: ModelSummary[];
}

interface OpenAiModelsResponse {
  data: { id: string }[];
}

interface GoogleModelsResponse {
  models?: { name?: string; displayName?: string }[];
}

/**
 * Calls Anthropic's `GET /v1/models` and returns the parsed
 * `{id, display_name}[]` list. Throws (with the raw response body text) on
 * any non-200 response, so a bad/revoked key surfaces the provider's own
 * error message rather than a generic failure.
 *
 * Verified by hand against the real endpoint with a deliberately invalid
 * key while writing this: a bad key comes back `401` with a structured JSON
 * body (`{"type":"error","error":{"type":"authentication_error",...}}`),
 * not a network-level failure - confirming the request shape (headers,
 * path) below is correct.
 */
export async function fetchAnthropicModelCatalog(apiKey: string): Promise<ModelSummary[]> {
  const response = await fetch(ANTHROPIC_MODELS_URL, {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Anthropic model catalog request failed with status ${response.status}: ${body}`,
    );
  }

  const json = (await response.json()) as AnthropicModelsResponse;
  return json.data ?? [];
}

/**
 * `GET {baseUrl}/models` (OpenAI wire format) - covers plain
 * "openai_compatible" and any OpenAI-shim endpoint (OpenRouter,
 * Together, Groq, vLLM, LM Studio, ...). No auth header when the
 * connection has no key (keyless local servers).
 */
export async function fetchOpenAiModelCatalog(
  baseUrl: string,
  apiKey?: string,
): Promise<ModelSummary[]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    method: 'GET',
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenAI-compatible model catalog request failed (${response.status}): ${body}`,
    );
  }
  const json = (await response.json()) as OpenAiModelsResponse;
  return (json.data ?? []).map((m) => ({ id: m.id, display_name: m.id }));
}

/**
 * `GET {baseUrl}/v1beta/models?key=...` (Gemini wire format). The key
 * travels as a query param - the documented auth for this plain-GET
 * models-list endpoint (unlike generateContent, which uses a header).
 */
export async function fetchGoogleModelCatalog(
  baseUrl: string,
  apiKey: string,
): Promise<ModelSummary[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google model catalog request failed (${response.status}): ${body}`);
  }
  const json = (await response.json()) as GoogleModelsResponse;
  return (json.models ?? [])
    .filter((m) => typeof m.name === 'string' && m.name.length > 0)
    .map((m) => {
      const id = String(m.name).replace(/^models\//, '');
      return { id, display_name: m.displayName ?? id };
    });
}

/**
 * Dispatches to the right list endpoint for a connection row. Ollama
 * speaks the OpenAI wire format against its own default base URL when
 * the row leaves `base_url` unset - same default as its adapter (see
 * @katnor/llm's openaiCompatible.ts). Anthropic ignores `base_url`
 * (proxies unsupported here - the SDK client reads the env key).
 */
export async function fetchCatalogForConnection(
  row: ProviderConfigRow,
): Promise<ModelSummary[]> {
  const apiKey = row.api_key_encrypted ? decryptSecret(row.api_key_encrypted) : undefined;
  if (row.provider === 'anthropic') {
    if (!apiKey) throw new Error('This Anthropic connection has no API key configured.');
    return fetchAnthropicModelCatalog(apiKey);
  }
  if (row.provider === 'google') {
    if (!apiKey) throw new Error('This Google connection has no API key configured.');
    const base = row.base_url ?? 'https://generativelanguage.googleapis.com';
    return fetchGoogleModelCatalog(base, apiKey);
  }
  if (row.provider === 'openai_compatible' || row.provider === 'ollama') {
    const base =
      row.base_url ?? (row.provider === 'ollama' ? 'http://localhost:11434/v1' : undefined);
    if (!base) {
      throw new Error('This connection has no base URL configured - set one first.');
    }
    return fetchOpenAiModelCatalog(base, apiKey);
  }
  const exhaustive: ModelProvider = row.provider;
  throw new Error(`No model catalog source for provider "${exhaustive}" yet`);
}

/**
 * Back-compat for callers that still name a provider type: resolves to
 * the default connection first. New code should pass a connection id to
 * refreshConnectionCatalog / getCachedConnectionCatalog instead.
 */
export async function refreshModelCatalog(provider: ModelProvider): Promise<ModelSummary[]> {
  const row = await providerConfigRepo.getDefaultByProvider(provider);
  if (!row) {
    throw new Error(`refreshModelCatalog: no provider_config row for provider "${provider}"`);
  }
  return refreshConnectionCatalog(row.id);
}

/**
 * Force-fetches a fresh catalog for one *connection* and writes it into
 * that row's `model_catalog_cache` / `model_catalog_cached_at`.
 *
 * Throws when the row is missing/disabled or the provider answers badly
 * (bad key, unreachable endpoint) - the message carries the provider's
 * own error, so the Settings UI can show whether the key/URL works.
 * This doubles as "test connection": a successful fetch proves the
 * credentials reach a real API.
 */
export async function refreshConnectionCatalog(connectionId: string): Promise<ModelSummary[]> {
  const row = await providerConfigRepo.getById(connectionId);
  if (!row) {
    throw new Error(`No provider connection "${connectionId}".`);
  }
  if (!row.enabled) {
    throw new Error(`Provider connection "${row.name}" is disabled.`);
  }
  const models = await fetchCatalogForConnection(row);
  await providerConfigRepo.update(row.id, {
    modelCatalogCache: { models },
    modelCatalogCachedAt: new Date(),
  });
  return models;
}

/**
 * Returns one connection's catalog, reading from its
 * `model_catalog_cache` when younger than six hours, re-fetching
 * otherwise. Returns `[]` (never throws) when the row is missing or has
 * no key yet - the UI treats that as "no models listed yet", and the
 * explicit Refresh button (refreshConnectionCatalog) is where errors
 * surface.
 */
export async function getCachedConnectionCatalog(
  connectionId: string,
): Promise<ModelSummary[]> {
  const row = await providerConfigRepo.getById(connectionId);
  if (!row) return [];
  const cache = row.model_catalog_cache as { models?: ModelSummary[] } | null | undefined;
  const cachedAt = row.model_catalog_cached_at ?? null;
  const isFresh =
    cache != null && cachedAt != null && Date.now() - cachedAt.getTime() < CACHE_TTL_MS;
  if (isFresh) return cache.models ?? [];
  try {
    return await refreshConnectionCatalog(connectionId);
  } catch {
    // Offline/unconfigured: fall back to whatever stale cache exists (or
    // empty) rather than breaking the Settings page on load.
    return cache?.models ?? [];
  }
}

/**
 * Back-compat: default-connection catalog with the old cache behavior.
 */
export async function getCachedModelCatalog(provider: ModelProvider): Promise<ModelSummary[]> {
  const row = await providerConfigRepo.getDefaultByProvider(provider);
  if (!row) return [];
  return getCachedConnectionCatalog(row.id);
}
