import { TASK_PRIORITIES, TASK_STATUSES } from '@katnor/core';
import { triggerRun } from '@katnor/agents';
import { eventRepo, taskRepo } from '@katnor/db';
import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '../trpc.js';

export const tasksRouter = router({
  list: publicProcedure
    .input(z.object({ project_id: z.string().optional() }))
    .query(({ input }) => taskRepo.list(input)),

  getById: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => taskRepo.getById(input.id)),

  create: protectedProcedure
    .input(
      z.object({
        project_id: z.string(),
        title: z.string().min(1),
        description: z.string().default(''),
        acceptance_criteria: z.string().default(''),
        priority: z.enum(TASK_PRIORITIES).default('medium'),
        assignee_id: z.string().nullable().default(null),
      }),
    )
    .mutation(async ({ input }) => {
      const created = await taskRepo.create({
        project_id: input.project_id,
        title: input.title,
        description: input.description,
        acceptance_criteria: input.acceptance_criteria,
        status: 'backlog',
        priority: input.priority,
        assignee_id: input.assignee_id,
        created_by: 'human',
        parent_id: null,
        depends_on: [],
        due_at: null,
      });
      await eventRepo.append({
        type: 'task.created',
        payload: { task_id: created.id, project_id: created.project_id, title: created.title },
      });
      return created;
    }),

  /**
   * Drives the kanban board (PLAN.md 4.7): dragging a card to a new column
   * calls this with a new `status`, reassigning calls it with a new
   * `assignee_id`. Mirrors @katnor/agents' `update_task` company tool's
   * "moving a card to Todo with an assignee triggers a run" rule (also
   * generalized to a fresh reassignment) - a human dragging a card should
   * wake the assignee exactly the same way an agent doing it does.
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        status: z.enum(TASK_STATUSES).optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        assignee_id: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...patch } = input;
      const reassigning = 'assignee_id' in patch;
      const updated = await taskRepo.update(id, patch);
      if (!updated) return undefined;

      await eventRepo.append({
        type: 'task.updated',
        payload: {
          task_id: updated.id,
          project_id: updated.project_id,
          status: updated.status,
          assignee_id: updated.assignee_id,
        },
      });

      if (updated.assignee_id && (patch.status === 'todo' || reassigning)) {
        await triggerRun(ctx.boss, {
          agentId: updated.assignee_id,
          taskId: updated.id,
          trigger: 'task',
        });
      }

      return updated;
    }),
});
