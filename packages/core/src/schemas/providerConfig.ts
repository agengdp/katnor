import { z } from 'zod';
import { MODEL_PROVIDERS } from '../enums.js';
import { withBase } from './base.js';

export const providerConfigFields = {
  provider: z.enum(MODEL_PROVIDERS),
  api_key_encrypted: z.string().nullable(),
  base_url: z.string().nullable(),
  enabled: z.boolean(),
  model_catalog_cache: z.record(z.string(), z.unknown()).nullable(),
  model_catalog_cached_at: z.date().nullable(),
  // Optional owner-entered $/million-token rates for providers with no
  // generic price table (everything but "anthropic" - see
  // @katnor/db's schema/providerConfig.ts for the full rationale). null
  // means "untracked", matching @katnor/llm's openaiCompatible.ts/
  // google.ts reporting costUsd: 0 when unset. Upper bound of 999,999
  // matches the DB column's `numeric(12, 6)` precision (6 digits before
  // the decimal point) - a value at or past that would otherwise fail as
  // a raw, unfriendly Postgres numeric-overflow error at write time.
  input_cost_per_mtok: z.number().min(0).max(999_999).nullable(),
  output_cost_per_mtok: z.number().min(0).max(999_999).nullable(),
};

export const providerConfigSchema = withBase(providerConfigFields);
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const createProviderConfigInputSchema = z.object({
  ...providerConfigFields,
  api_key_encrypted: providerConfigFields.api_key_encrypted.optional(),
  base_url: providerConfigFields.base_url.optional(),
  enabled: providerConfigFields.enabled.default(true),
  model_catalog_cache: providerConfigFields.model_catalog_cache.optional(),
  model_catalog_cached_at: providerConfigFields.model_catalog_cached_at.optional(),
  input_cost_per_mtok: providerConfigFields.input_cost_per_mtok.optional(),
  output_cost_per_mtok: providerConfigFields.output_cost_per_mtok.optional(),
});
export type CreateProviderConfigInput = z.infer<typeof createProviderConfigInputSchema>;
