import type { WikiPageFrontmatter } from '@katnor/core';
import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';
import { project } from './project.js';
import { vector } from './vector.js';

export const wikiPage = pgTable(
  'wiki_page',
  {
    ...baseColumns,
    project_id: text('project_id')
      .notNull()
      .references(() => project.id),
    path: text('path').notNull(),
    title: text('title').notNull(),
    // { type?, tags?, sources? } - see WikiPageFrontmatter in @katnor/core.
    frontmatter: jsonb('frontmatter').$type<WikiPageFrontmatter>().notNull().default({}),
    // Hash of `content` (the page body lives on disk/object storage under
    // `path`, keyed by @katnor/knowledge - not duplicated in Postgres).
    content_hash: text('content_hash').notNull(),
    // Requires `CREATE EXTENSION IF NOT EXISTS vector;` - see
    // src/applyPostMigrate.ts and ./vector.ts for the column type itself.
    embedding: vector('embedding', { dimensions: 1536 }),
  },
  (table) => [index('wiki_page_project_id_idx').on(table.project_id)],
);
