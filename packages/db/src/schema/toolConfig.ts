import { boolean, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';
import { toolConfigKindEnum } from './enums.js';

export const toolConfig = pgTable('tool_config', {
  ...baseColumns,
  kind: toolConfigKindEnum('kind').notNull(),
  name: text('name').notNull(),
  // Set for kind = "mcp" stdio servers.
  command: text('command'),
  // Set for kind = "mcp" HTTP/SSE servers.
  url: text('url'),
  // Names of secrets (resolved via the secrets store, never the raw
  // values) that must be present in the tool's environment.
  env_secret_refs: jsonb('env_secret_refs').$type<string[]>().notNull().default([]),
  enabled: boolean('enabled').notNull().default(true),
});
