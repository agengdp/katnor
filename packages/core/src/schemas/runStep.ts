import { z } from 'zod';
import { RUN_STEP_KINDS } from '../enums.js';
import { withBase } from './base.js';

export const runStepFields = {
  run_id: z.string(),
  seq: z.number().int().nonnegative(),
  kind: z.enum(RUN_STEP_KINDS),
  payload: z.record(z.string(), z.unknown()),
  tokens: z.number().int().nonnegative().nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
};

export const runStepSchema = withBase(runStepFields);
export type RunStep = z.infer<typeof runStepSchema>;

export const createRunStepInputSchema = z.object({
  ...runStepFields,
  tokens: runStepFields.tokens.optional(),
  duration_ms: runStepFields.duration_ms.optional(),
});
export type CreateRunStepInput = z.infer<typeof createRunStepInputSchema>;
