import { DEFAULT_BOARD_COLUMNS } from '@katnor/core';
import { channelRepo, eventRepo, projectRepo } from '@katnor/db';
import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '../trpc.js';

export const projectsRouter = router({
  list: publicProcedure.query(() => projectRepo.list()),

  getById: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => projectRepo.getById(input.id)),

  /**
   * Mirrors @katnor/agents' `create_project` tool (same default board
   * columns, same auto-created project channel) for a human creating a
   * project directly from the dashboard rather than through the CEO.
   */
  create: protectedProcedure
    .input(z.object({ name: z.string().min(1), description: z.string().default('') }))
    .mutation(async ({ input }) => {
      const created = await projectRepo.create({
        name: input.name,
        description: input.description,
        repos: [],
        workspace_id: null,
        board_settings: { columns: DEFAULT_BOARD_COLUMNS },
        wiki_path: `wiki/${
          input.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'project'
        }`,
      });
      await eventRepo.append({
        type: 'project.created',
        payload: { project_id: created.id, name: created.name },
      });
      await channelRepo.create({
        project_id: created.id,
        team_id: null,
        kind: 'project',
        name: created.name,
        task_id: null,
      });
      return created;
    }),
});
