import { ingestRun } from '@katnor/knowledge';
import type PgBoss from 'pg-boss';

/**
 * Ingests one finished, task-scoped run into its project's wiki and
 * knowledge graph - see @katnor/knowledge's librarian.ts for the actual
 * logic (extraction, node/edge upsert, wiki page writes, git commit).
 * Enqueued by @katnor/agents' runExecutor.ts on every successful run that
 * has a task, per PLAN.md §4.4/§4.5.
 */
export async function librarianIngest(
  jobs: PgBoss.Job<{ runId: string }>[],
): Promise<{ ok: true }> {
  for (const job of jobs) {
    try {
      await ingestRun(job.data.runId);
    } catch (err) {
      console.error(`[worker] librarian-ingest job ${job.id} (run ${job.data.runId}) threw:`, err);
    }
  }
  return { ok: true };
}
