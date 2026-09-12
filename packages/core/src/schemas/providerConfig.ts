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
});
export type CreateProviderConfigInput = z.infer<typeof createProviderConfigInputSchema>;
