import type { ModelProvider } from '@katnor/core';
import { eq } from 'drizzle-orm';
import { db } from '../client.js';
import { providerConfig } from '../schema/index.js';

export type ProviderConfigRow = typeof providerConfig.$inferSelect;

/**
 * Looks up the single `provider_config` row for `provider`, or `undefined`
 * if the owner has never configured it in Settings. Used by
 * `apps/server/src/modelCatalog.ts` (model catalog refresh) and
 * `@katnor/llm`'s non-Anthropic adapters (e.g. ./openaiCompatible.ts) to
 * resolve a company-wide base URL / encrypted API key at call time, rather
 * than each caller re-querying `db`/`providerConfig` directly.
 */
export async function getByProvider(
  provider: ModelProvider,
): Promise<ProviderConfigRow | undefined> {
  const [row] = await db
    .select()
    .from(providerConfig)
    .where(eq(providerConfig.provider, provider))
    .limit(1);
  return row;
}
