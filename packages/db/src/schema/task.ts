import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { agent } from './agent.js';
import { baseColumns } from './columns.js';
import { taskPriorityEnum, taskStatusEnum } from './enums.js';
import { project } from './project.js';

export const task = pgTable(
  'task',
  {
    ...baseColumns,
    project_id: text('project_id')
      .notNull()
      .references(() => project.id),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    acceptance_criteria: text('acceptance_criteria').notNull().default(''),
    status: taskStatusEnum('status').notNull().default('backlog'),
    priority: taskPriorityEnum('priority').notNull().default('medium'),
    assignee_id: text('assignee_id').references(() => agent.id),
    // Either an agent id or the literal string "human" - not a FK, so left
    // as plain text rather than a pgEnum or a `.references()` column.
    created_by: text('created_by').notNull(),
    parent_id: text('parent_id').references((): AnyPgColumn => task.id),
    // Array of task ids this task depends on. Left as jsonb rather than a
    // join table for v1 simplicity, matching the domain model.
    depends_on: jsonb('depends_on').$type<string[]>().notNull().default([]),
    due_at: timestamp('due_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('task_project_id_idx').on(table.project_id),
    index('task_status_idx').on(table.status),
    index('task_assignee_id_idx').on(table.assignee_id),
  ],
);
