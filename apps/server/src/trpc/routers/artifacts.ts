import { getArtifactUrl } from '@katnor/artifacts';
import { artifactRepo } from '@katnor/db';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';

/**
 * Artifacts v1 (PLAN.md 4.6): read-only from tRPC's side - creation only
 * ever happens through @katnor/artifacts' `saveArtifact` (the
 * `save_artifact` company tool, or a work tool's auto-capture), never
 * through this router. `getUrl` is what the dashboard's viewers call to get
 * something they can point an `<img>`/`<iframe>`/download link at - a
 * presigned S3 URL in prod, or `/artifacts/raw/:key` (served by
 * apps/server/src/index.ts) in local dev.
 */
export const artifactsRouter = router({
  listLatest: protectedProcedure
    .input(
      z.object({
        projectId: z.string().optional(),
        taskId: z.string().optional(),
        runId: z.string().optional(),
      }),
    )
    .query(({ input }) =>
      artifactRepo.listLatest({
        project_id: input.projectId,
        task_id: input.taskId,
        run_id: input.runId,
      }),
    ),

  listGroup: protectedProcedure
    .input(z.object({ artifactGroupId: z.string() }))
    .query(({ input }) => artifactRepo.listGroup(input.artifactGroupId)),

  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => artifactRepo.getById(input.id)),

  getUrl: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const row = await artifactRepo.getById(input.id);
    if (!row) {
      throw new Error(`No artifact "${input.id}".`);
    }
    return { url: await getArtifactUrl(row) };
  }),
});
