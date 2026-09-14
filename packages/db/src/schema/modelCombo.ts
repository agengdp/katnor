import type { ModelComboEntry } from '@katnor/core';
import { jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';

/**
 * A named, ordered fallback chain across providers/models - see
 * @katnor/core's schemas/modelCombo.ts for the full concept and
 * @katnor/llm's src/combo.ts for the `LLMProvider` that actually walks
 * `entries` in order. `entries` is jsonb rather than a join table: it's
 * always read/written as one whole ordered list (never queried by a
 * single entry's fields), the same reasoning `agent.tool_allowlist`
 * already uses for its own ordered string array.
 */
export const modelCombo = pgTable(
  'model_combo',
  {
    ...baseColumns,
    name: text('name').notNull(),
    entries: jsonb('entries').$type<ModelComboEntry[]>().notNull(),
  },
  (table) => [uniqueIndex('model_combo_name_idx').on(table.name)],
);
