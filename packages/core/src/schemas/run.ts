import { z } from 'zod';
import { RUN_STATUSES, RUN_TRIGGERS } from '../enums.js';
import { withBase } from './base.js';

export const runFields = {
  agent_id: z.string(),
  task_id: z.string().nullable(),
  /** The channel whose message woke this run, if any - see the schema column's doc comment in @katnor/db. */
  channel_id: z.string().nullable(),
  trigger: z.enum(RUN_TRIGGERS),
  status: z.enum(RUN_STATUSES),
  started_at: z.date(),
  finished_at: z.date().nullable(),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  summary: z.string().nullable(),
};

export const runSchema = withBase(runFields);
export type Run = z.infer<typeof runSchema>;

/**
 * A caller only chooses what triggered the run; status, timings, token
 * counts, cost, and summary are filled in by the run executor as it
 * progresses.
 */
export const createRunInputSchema = z.object({
  agent_id: runFields.agent_id,
  task_id: runFields.task_id.optional(),
  channel_id: runFields.channel_id.optional(),
  trigger: runFields.trigger,
});
export type CreateRunInput = z.infer<typeof createRunInputSchema>;
