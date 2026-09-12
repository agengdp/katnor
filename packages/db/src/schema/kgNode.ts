import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';
import { project } from './project.js';
import { vector } from './vector.js';

/** A node in the project knowledge graph (a task, a decision, a module, a person, ...). */
export const kgNode = pgTable(
  'kg_node',
  {
    ...baseColumns,
    project_id: text('project_id').references(() => project.id),
    // Open-ended (e.g. "task", "decision", "module", "person", ...) - see
    // KgNodeType in @katnor/knowledge. Left as plain text rather than a
    // pgEnum since new node types are expected to be added without a
    // schema migration.
    type: text('type').notNull(),
    name: text('name').notNull(),
    summary: text('summary'),
    properties: jsonb('properties').$type<Record<string, unknown>>().notNull().default({}),
    // Requires `CREATE EXTENSION IF NOT EXISTS vector;` - see
    // src/applyPostMigrate.ts and ./vector.ts for the column type itself.
    embedding: vector('embedding', { dimensions: 1536 }),
  },
  (table) => [index('kg_node_project_id_idx').on(table.project_id)],
);
