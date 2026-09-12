import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { artifactKindEnum } from './enums.js';
import { baseColumns } from './columns.js';
import { project } from './project.js';
import { run } from './run.js';
import { task } from './task.js';

export const artifact = pgTable(
  'artifact',
  {
    ...baseColumns,
    project_id: text('project_id').references(() => project.id),
    task_id: text('task_id').references(() => task.id),
    run_id: text('run_id').references(() => run.id),
    // Groups versions of "the same" artifact together. Generated
    // application-side (a fresh id for a new artifact, or an existing
    // group's id when adding a new version) - see @katnor/artifacts.
    artifact_group_id: text('artifact_group_id').notNull(),
    version: integer('version').notNull().default(1),
    kind: artifactKindEnum('kind').notNull(),
    title: text('title').notNull(),
    // Key/path into the artifact store (MinIO in prod, local FS in dev).
    storage_key: text('storage_key').notNull(),
    mime: text('mime'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    index('artifact_project_id_idx').on(table.project_id),
    index('artifact_task_id_idx').on(table.task_id),
    index('artifact_run_id_idx').on(table.run_id),
  ],
);
