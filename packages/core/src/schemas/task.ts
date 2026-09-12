import { z } from 'zod';
import { TASK_PRIORITIES, TASK_STATUSES } from '../enums.js';
import { withBase } from './base.js';

export const taskFields = {
  project_id: z.string(),
  title: z.string().min(1),
  description: z.string(),
  acceptance_criteria: z.string(),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  assignee_id: z.string().nullable(),
  created_by: z.string(),
  parent_id: z.string().nullable(),
  depends_on: z.array(z.string()),
  due_at: z.date().nullable(),
};

export const taskSchema = withBase(taskFields);
export type Task = z.infer<typeof taskSchema>;

export const createTaskInputSchema = z.object({
  ...taskFields,
  description: taskFields.description.default(''),
  acceptance_criteria: taskFields.acceptance_criteria.default(''),
  status: taskFields.status.default('backlog'),
  priority: taskFields.priority.default('medium'),
  assignee_id: taskFields.assignee_id.optional(),
  parent_id: taskFields.parent_id.optional(),
  depends_on: taskFields.depends_on.default([]),
  due_at: taskFields.due_at.optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
