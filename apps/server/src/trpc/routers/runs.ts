import { companyRepo, runRepo, runStepRepo } from '@katnor/db';
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

  /**
   * Spend so far "today" (the server's local calendar day - v1 has no
   * per-owner timezone setting) against the company's daily budget -
   * feeds the header's cost meter chip (a Phase 0 TODO left unwired until
   * now) and the office's day/night tint (PLAN.md 4.8).
   */
  todaySpend: publicProcedure.query(async () => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const [spentUsd, settings] = await Promise.all([runRepo.sumCostSince(startOfToday), companyRepo.getSettings()]);
    return { spentUsd, budgetUsd: settings.budgets.company_daily_usd };
  }),
});
