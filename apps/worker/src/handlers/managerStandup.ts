import { runManagerStandup } from '@katnor/agents';
import { projectRepo } from '@katnor/db';
import type PgBoss from 'pg-boss';

/**
 * PLAN.md §4.2's daily manager stand-up - see @katnor/agents' standup.ts
 * for the actual logic. `projectId` is omitted for the daily
 * `boss.schedule()` firing (apps/worker/src/index.ts), which means "every
 * project" - same fan-out convention as wiki-lint's handler.
 */
export function createManagerStandupHandler(boss: PgBoss) {
  return async function managerStandup(
    jobs: PgBoss.Job<{ projectId?: string }>[],
  ): Promise<{ ok: true }> {
    for (const job of jobs) {
      try {
        const projectIds = job.data.projectId
          ? [job.data.projectId]
          : (await projectRepo.list()).map((p) => p.id);
        for (const projectId of projectIds) {
          await runManagerStandup(projectId, boss);
        }
      } catch (err) {
        console.error(`[worker] manager-standup job ${job.id} threw:`, err);
      }
    }
    return { ok: true };
  };
}
