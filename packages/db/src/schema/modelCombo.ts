import type { ModelEntry } from '@katnor/core';
import { jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';

/**
 * A named Model mapping - see @katnor/core's schemas/modelCombo.ts for
 * the concept and @katnor/llm's router for the runtime. `entries` is
 * jsonb rather than a join table: always read/written as one whole
 * ordered list (never queried by a single entry's fields), the same
 * reasoning `agent.tool_allowlist` already uses. Old rows may still hold
 * legacy `{provider, model}` entries (pre-connections) - the router
 * resolves those at call time, so no data migration rewrites them.
 */
export const modelCombo = pgTable(
  'model_combo',
  {
    ...baseColumns,
    name: text('name').notNull(),
    entries: jsonb('entries').$type<ModelEntry[]>().notNull(),
    strategy: text('strategy').notNull().default('fallback'),
  },
  (table) => [uniqueIndex('model_combo_name_idx').on(table.name)],
);
