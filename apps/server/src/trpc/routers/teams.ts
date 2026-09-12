import { eventRepo, teamRepo } from '@katnor/db';
import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '../trpc.js';

export const teamsRouter = router({
  list: publicProcedure.query(() => teamRepo.list()),

  create: protectedProcedure
    .input(z.object({ name: z.string().min(1), lead_agent_id: z.string().nullable().default(null) }))
    .mutation(async ({ input }) => {
      const created = await teamRepo.create(input);
      await eventRepo.append({ type: 'team.created', payload: { team_id: created.id, name: created.name } });
      return created;
    }),
});
