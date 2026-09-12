import { runRepo, runStepRepo } from '@katnor/db';
import { z } from 'zod';
import { publicProcedure, router } from '../trpc.js';

export const runsRouter = router({
  list: publicProcedure
    .input(z.object({ agent_id: z.string().optional(), task_id: z.string().optional() }))
    .query(({ input }) => runRepo.list(input)),

  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const run = await runRepo.getById(input.id);
    if (!run) return undefined;
    const steps = await runStepRepo.list(input.id);
    return { ...run, steps };
  }),
});
