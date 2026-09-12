import { z } from 'zod';
import { TASK_STATUSES } from '../enums.js';
import { withBase } from './base.js';

export const projectRepoSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  default_branch: z.string(),
});
export type ProjectRepo = z.infer<typeof projectRepoSchema>;

export const boardColumnSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(TASK_STATUSES),
});
export type BoardColumn = z.infer<typeof boardColumnSchema>;

export const boardSettingsSchema = z.object({
  columns: z.array(boardColumnSchema),
});
export type BoardSettings = z.infer<typeof boardSettingsSchema>;

/**
 * The default kanban columns a new project's board starts with (PLAN.md
 * 4.7): Backlog/Todo/In progress/Review/Done, with "blocked" shown as a
 * badge on a card rather than its own column. Shared by @katnor/agents'
 * `create_project` tool and apps/server's `projects.create` mutation, so a
 * project created by the CEO and one created by a human from the
 * dashboard start identical.
 */
export const DEFAULT_BOARD_COLUMNS: BoardSettings['columns'] = [
  { id: 'backlog', name: 'Backlog', status: 'backlog' },
  { id: 'todo', name: 'Todo', status: 'todo' },
  { id: 'in_progress', name: 'In progress', status: 'in_progress' },
  { id: 'review', name: 'Review', status: 'review' },
  { id: 'done', name: 'Done', status: 'done' },
];

export const projectFields = {
  name: z.string().min(1),
  description: z.string(),
  repos: z.array(projectRepoSchema),
  workspace_id: z.string().nullable(),
  board_settings: boardSettingsSchema,
  wiki_path: z.string(),
};

export const projectSchema = withBase(projectFields);
export type Project = z.infer<typeof projectSchema>;

export const createProjectInputSchema = z.object({
  ...projectFields,
  description: projectFields.description.default(''),
  repos: projectFields.repos.default([]),
  workspace_id: projectFields.workspace_id.optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
