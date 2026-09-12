import { index, pgTable, text } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';
import { channelKindEnum } from './enums.js';
import { project } from './project.js';
import { task } from './task.js';
import { team } from './team.js';

export const channel = pgTable(
  'channel',
  {
    ...baseColumns,
    project_id: text('project_id').references(() => project.id),
    team_id: text('team_id').references(() => team.id),
    kind: channelKindEnum('kind').notNull(),
    name: text('name'),
    // Set only for kind = "task_thread".
    task_id: text('task_id').references(() => task.id),
  },
  (table) => [
    index('channel_project_id_idx').on(table.project_id),
    index('channel_team_id_idx').on(table.team_id),
    index('channel_task_id_idx').on(table.task_id),
  ],
);
