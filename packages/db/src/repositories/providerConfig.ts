import type { ModelProvider } from '@katnor/core';
import { asc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { providerConfig } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type ProviderConfigRow = typeof providerConfig.$inferSelect;

/**
 * The default connection for a provider type: first enabled row,
 * oldest first. Used by the legacy compat path (old Model entries and
 * direct `{provider, model}` hires that name a type, not a connection)
 * and by adapters whose caller passes no connection id.
 */
export async function getDefaultByProvider(
  provider: ModelProvider,
): Promise<ProviderConfigRow | undefined> {
  const rows = await db
    .select()
    .from(providerConfig)
    .where(eq(providerConfig.provider, provider))
    .orderBy(asc(providerConfig.created_at));
  return rows.find((row) => row.enabled) ?? rows[0];
}

/**
 * Looks up one connection by id. `undefined` when removed - callers
 * treat that as a config error for the Model entry pointing at it, not
 * as a reason to silently pick another connection.
 */
export async function getById(id: string): Promise<ProviderConfigRow | undefined> {
  const [row] = await db.select().from(providerConfig).where(eq(providerConfig.id, id)).limit(1);
  return row;
}

export async function list(): Promise<ProviderConfigRow[]> {
  return db.select().from(providerConfig).orderBy(asc(providerConfig.created_at));
}

export interface CreateProviderConnectionInput {
  name: string;
  provider: ModelProvider;
  apiKeyEncrypted?: string | null;
  baseUrl?: string | null;
  enabled?: boolean;
  inputCostPerMtok?: string | null;
  outputCostPerMtok?: string | null;
}

export async function create(input: CreateProviderConnectionInput): Promise<ProviderConfigRow> {
  const [created] = await db
    .insert(providerConfig)
    .values({
      id: ulid(),
      name: input.name.trim(),
      provider: input.provider,
      api_key_encrypted: input.apiKeyEncrypted ?? null,
      base_url: input.baseUrl ?? null,
      enabled: input.enabled ?? true,
      input_cost_per_mtok: input.inputCostPerMtok ?? null,
      output_cost_per_mtok: input.outputCostPerMtok ?? null,
    })
    .returning();
  if (!created) {
    throw new Error('create(providerConfig): insert returned no row');
  }
  return created;
}

export interface UpdateProviderConnectionInput {
  name?: string;
  apiKeyEncrypted?: string | null;
  baseUrl?: string | null;
  enabled?: boolean;
  inputCostPerMtok?: string | null;
  outputCostPerMtok?: string | null;
  modelCatalogCache?: Record<string, unknown> | null;
  modelCatalogCachedAt?: Date | null;
}

export async function update(
  id: string,
  patch: UpdateProviderConnectionInput,
): Promise<ProviderConfigRow | undefined> {
  const [updated] = await db
    .update(providerConfig)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.apiKeyEncrypted !== undefined ? { api_key_encrypted: patch.apiKeyEncrypted } : {}),
      ...(patch.baseUrl !== undefined ? { base_url: patch.baseUrl } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.inputCostPerMtok !== undefined
        ? { input_cost_per_mtok: patch.inputCostPerMtok }
        : {}),
      ...(patch.outputCostPerMtok !== undefined
        ? { output_cost_per_mtok: patch.outputCostPerMtok }
        : {}),
      ...(patch.modelCatalogCache !== undefined
        ? { model_catalog_cache: patch.modelCatalogCache }
        : {}),
      ...(patch.modelCatalogCachedAt !== undefined
        ? { model_catalog_cached_at: patch.modelCatalogCachedAt }
        : {}),
      updated_at: new Date(),
    })
    .where(eq(providerConfig.id, id))
    .returning();
  return updated;
}

export async function remove(id: string): Promise<void> {
  await db.delete(providerConfig).where(eq(providerConfig.id, id));
}

/**
 * Back-compat for callers that still name a provider type
 * (`getByProvider('google')` in the LLM adapters): resolves to the
 * default connection. New code should pass a connection id to `getById`
 * instead - this stays until the adapters are migrated.
 */
export async function getByProvider(
  provider: ModelProvider,
): Promise<ProviderConfigRow | undefined> {
  return getDefaultByProvider(provider);
}
