import { channelRepo } from '@katnor/db';
import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '../trpc.js';

export const channelsRouter = router({
  list: publicProcedure
    .input(z.object({ project_id: z.string().optional(), team_id: z.string().optional() }))
    .query(({ input }) => channelRepo.list(input)),

  getById: publicProcedure.input(z.object({ id: z.string() })).query(({ input }) => channelRepo.getById(input.id)),

  getGeneral: publicProcedure.query(() => channelRepo.getOrCreateGeneral()),

  /** Starts (or resumes) a DM with `agentId` - the Chat page calls this when the owner picks someone to message. */
  getOrCreateDm: protectedProcedure
    .input(z.object({ agent_id: z.string() }))
    .mutation(({ input }) => channelRepo.getOrCreateDm(input.agent_id)),
});
