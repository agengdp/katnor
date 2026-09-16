import { eq } from 'drizzle-orm';
import { db, providerConfig } from '@katnor/db';
import type { ModelProvider } from '@katnor/core';
import { decryptSecret } from './crypto.js';

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
// Anthropic's API requires a version pin on every request; this is the
// stable, long-lived version string, not tied to any particular model.
const ANTHROPIC_VERSION = '2023-06-01';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface AnthropicModelSummary {
  id: string;
  display_name: string;
}

interface AnthropicModelsResponse {
  data: AnthropicModelSummary[];
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
export async function fetchAnthropicModelCatalog(apiKey: string): Promise<AnthropicModelSummary[]> {
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

async function getProviderRow(provider: ModelProvider) {
  const [row] = await db
    .select()
    .from(providerConfig)
    .where(eq(providerConfig.provider, provider))
    .limit(1);
  return row;
}

/**
 * Force-fetches a fresh catalog for `provider` from its API and writes it
 * into `provider_config.model_catalog_cache` / `model_catalog_cached_at`.
 * Only "anthropic" is wired up so far (the other providers in
 * `MODEL_PROVIDERS` don't have a models-list endpoint defined yet).
 *
 * Throws if there is no `provider_config` row for `provider`, or no API key
 * configured on it - callers (`getCachedModelCatalog` below, and later the
 * settings UI) should make sure a key is set first.
 */
export async function refreshModelCatalog(
  provider: ModelProvider,
): Promise<AnthropicModelSummary[]> {
  if (provider !== 'anthropic') {
    throw new Error(
      `refreshModelCatalog: no model catalog source implemented for provider "${provider}" yet`,
    );
  }

  const row = await getProviderRow(provider);
  if (!row) {
    throw new Error(`refreshModelCatalog: no provider_config row for provider "${provider}"`);
  }
  if (!row.api_key_encrypted) {
    throw new Error(`refreshModelCatalog: provider "${provider}" has no API key configured`);
  }

  const apiKey = decryptSecret(row.api_key_encrypted);
  const models = await fetchAnthropicModelCatalog(apiKey);

  await db
    .update(providerConfig)
    .set({
      model_catalog_cache: { models },
      model_catalog_cached_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(providerConfig.id, row.id));

  return models;
}

/**
 * Returns the model catalog for `provider`, reading from
 * `provider_config.model_catalog_cache` when it exists and is younger than
 * six hours, and transparently calling `refreshModelCatalog` (re-fetching
 * from the provider and updating the cache) otherwise.
 */
export async function getCachedModelCatalog(
  provider: ModelProvider,
): Promise<AnthropicModelSummary[]> {
  const row = await getProviderRow(provider);

  const cache = row?.model_catalog_cache as { models?: AnthropicModelSummary[] } | null | undefined;
  const cachedAt = row?.model_catalog_cached_at ?? null;
  const isFresh =
    cache != null && cachedAt != null && Date.now() - cachedAt.getTime() < CACHE_TTL_MS;

  if (isFresh) {
    return cache.models ?? [];
  }

  return refreshModelCatalog(provider);
}
