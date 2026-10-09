import { DEFAULT_BOARD_COLUMNS } from '@katnor/core';
import { channelRepo, eventRepo, projectRepo } from '@katnor/db';
import { rm } from 'node:fs/promises';
import { projectWikiDir } from '@katnor/knowledge';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';

export const projectsRouter = router({
  list: protectedProcedure.query(() => projectRepo.list()),

  getById: protectedProcedure
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

  /**
   * Owner-only hard delete: the project row with its tasks, runs, channels,
   * artifacts, KG nodes, wiki index rows, and the wiki git dir on disk.
   * Same outcome the CEO reaches through the CEO-only `delete_project` tool.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const existing = await projectRepo.getById(input.id);
      if (!existing) return undefined;
      await projectRepo.remove(input.id);
      await rm(projectWikiDir(input.id), { recursive: true, force: true });
      await eventRepo.append({
        type: 'project.deleted',
        payload: { project_id: existing.id, name: existing.name },
      });
      return { id: existing.id };
    }),
});
