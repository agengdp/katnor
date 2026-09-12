import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';

/**
 * A named, encrypted secret - referenced by name from
 * `tool_config.env_secret_refs` (e.g. an MCP server that needs a
 * GITHUB_TOKEN in its environment). `value_encrypted` uses the same
 * AES-256-GCM format as `provider_config.api_key_encrypted` - see
 * ../crypto.ts, the only place that encrypts/decrypts either.
 */
export const secret = pgTable(
  'secret',
  {
    ...baseColumns,
    name: text('name').notNull(),
    value_encrypted: text('value_encrypted').notNull(),
  },
  (table) => [uniqueIndex('secret_name_idx').on(table.name)],
);
