import { boolean, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';
import { modelProviderEnum } from './enums.js';

export const providerConfig = pgTable('provider_config', {
  ...baseColumns,
  provider: modelProviderEnum('provider').notNull(),
  // Encrypted at rest by the application layer (AES key from env) - never
  // stored in plaintext, and never selected back to the client unmasked.
  api_key_encrypted: text('api_key_encrypted'),
  base_url: text('base_url'),
  enabled: boolean('enabled').notNull().default(true),
  model_catalog_cache: jsonb('model_catalog_cache').$type<Record<string, unknown>>(),
  model_catalog_cached_at: timestamp('model_catalog_cached_at', {
    withTimezone: true,
    mode: 'date',
  }),
});
