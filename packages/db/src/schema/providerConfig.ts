import { boolean, jsonb, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
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
  // Optional, owner-entered $/million-token rates - unlike ./enums.js's
  // `anthropic` provider (priced from @katnor/llm's hand-maintained
  // pricing.ts table), an arbitrary third-party/self-hosted endpoint has
  // no generic price table this system could know ahead of time, so
  // ./openaiCompatible.ts and ./google.ts (well, @katnor/llm's versions of
  // those, not this package) always reported `costUsd: 0` - real but
  // invisible to budgets/cost dashboards. NULL (the default) keeps that
  // exact behavior; a value here is a single flat rate applied to every
  // model run under this provider row, a deliberate v1 simplification
  // (one rate per provider connection, not per model) rather than a
  // precise per-model catalog.
  input_cost_per_mtok: numeric('input_cost_per_mtok', { precision: 12, scale: 6 }),
  output_cost_per_mtok: numeric('output_cost_per_mtok', { precision: 12, scale: 6 }),
});
