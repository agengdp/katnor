import { projectRepo } from '@katnor/db';
import { indexProjectRepos } from '@katnor/knowledge';
import type PgBoss from 'pg-boss';

/**
 * Runs @katnor/knowledge's heuristic code indexer (PLAN.md §4.4) over one
 * project's configured repos. Triggered manually via apps/server's
 * `knowledge.reindexCode` mutation - see @katnor/agents' queues.ts doc
 * comment on why automatic per-commit triggering is deferred.
 */
export async function codeIndex(jobs: PgBoss.Job<{ projectId: string }>[]): Promise<{ ok: true }> {
  for (const job of jobs) {
    try {
      const project = await projectRepo.getById(job.data.projectId);
      if (!project) continue;
      await indexProjectRepos({ id: project.id, name: project.name, repos: project.repos }, project.id);
    } catch (err) {
      console.error(`[worker] code-index job ${job.id} threw:`, err);
    }
  }
  return { ok: true };
}
