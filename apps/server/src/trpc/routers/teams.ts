import { agentRepo, eventRepo, teamRepo } from '@katnor/db';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';

export const teamsRouter = router({
  list: protectedProcedure.query(() => teamRepo.list()),

  create: protectedProcedure
    .input(
      z.object({ name: z.string().min(1), lead_agent_id: z.string().nullable().default(null) }),
    )
    .mutation(async ({ input }) => {
      const created = await teamRepo.create(input);
      await eventRepo.append({
        type: 'team.created',
        payload: { team_id: created.id, name: created.name },
      });
      return created;
    }),

  /**
   * Owner-only hard delete (member `team_id` → null, team channels + their
   * messages dropped — nobody is fired). Agents reach the same outcome
   * through the CEO-only `delete_team` tool, not this HTTP surface.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const existing = await teamRepo.getById(input.id);
      if (!existing) return undefined;
      await teamRepo.remove(input.id);
      await eventRepo.append({
        type: 'team.deleted',
        payload: { team_id: existing.id, name: existing.name },
      });
      return { id: existing.id };
    }),
});
