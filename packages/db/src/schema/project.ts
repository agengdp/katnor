import type { BoardSettings, ProjectRepo } from '@katnor/core';
import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';

export const project = pgTable('project', {
  ...baseColumns,
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  // Array of { owner, repo, default_branch } - see ProjectRepo in @katnor/core.
  repos: jsonb('repos').$type<ProjectRepo[]>().notNull().default([]),
  // External workspace/sandbox identifier (e.g. a dockerode container/volume id).
  workspace_id: text('workspace_id'),
  // { columns: [{ id, name, status }] } - see BoardSettings in @katnor/core.
  board_settings: jsonb('board_settings').$type<BoardSettings>().notNull(),
  wiki_path: text('wiki_path').notNull(),
});
