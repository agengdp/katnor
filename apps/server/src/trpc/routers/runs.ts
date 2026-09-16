import { agentRepo, companyRepo, projectRepo, runRepo, runStepRepo } from '@katnor/db';
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
    const [spentUsd, settings] = await Promise.all([
      runRepo.sumCostSince(startOfToday),
      companyRepo.getSettings(),
    ]);
    return { spentUsd, budgetUsd: settings.budgets.company_daily_usd };
  }),

  /**
   * Today's spend broken down by agent and by project (PLAN.md Phase 5's
   * cost dashboard), alongside the budgets @katnor/agents' runExecutor.ts
   * enforces as hard stops - so the dashboard and the enforcement always
   * show the same numbers. Names are joined in application code rather
   * than via SQL - `costByAgentSince`/`costByProjectSince` only return
   * ids, and there are never more than a few dozen agents/projects to
   * look up.
   */
  costBreakdown: publicProcedure.query(async () => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const [byAgentRaw, byProjectRaw, agents, projects, settings] = await Promise.all([
      runRepo.costByAgentSince(startOfToday),
      runRepo.costByProjectSince(startOfToday),
      agentRepo.list(),
      projectRepo.list(),
      companyRepo.getSettings(),
    ]);
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const projectsById = new Map(projects.map((project) => [project.id, project]));

    return {
      budgets: settings.budgets,
      byAgent: byAgentRaw
        .map((row) => ({
          agentId: row.agentId,
          name: agentsById.get(row.agentId)?.name ?? row.agentId,
          budgetUsd: agentsById.get(row.agentId)
            ? Number(agentsById.get(row.agentId)!.budget_daily_usd)
            : 0,
          totalUsd: row.totalUsd,
        }))
        .sort((a, b) => b.totalUsd - a.totalUsd),
      byProject: byProjectRaw
        .filter((row) => row.projectId !== null)
        .map((row) => ({
          projectId: row.projectId,
          name: projectsById.get(row.projectId)?.name ?? row.projectId,
          totalUsd: row.totalUsd,
        }))
        .sort((a, b) => b.totalUsd - a.totalUsd),
    };
  }),
});
