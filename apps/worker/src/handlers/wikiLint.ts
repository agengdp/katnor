import { postMessage } from '@katnor/agents';
import { channelRepo, projectRepo } from '@katnor/db';
import { formatLintReport, isLintReportEmpty, runWikiLint } from '@katnor/knowledge';
import type PgBoss from 'pg-boss';

/** The Librarian is a system job, not a hired employee (PLAN.md 6.2.6) - `message.author_id` has no FK constraint precisely so a non-agent-row author like this is representable (see @katnor/db's message.ts schema comment). */
const LIBRARIAN_AUTHOR_ID = 'librarian';

async function lintOneProject(boss: PgBoss, projectId: string): Promise<void> {
  const project = await projectRepo.getById(projectId);
  if (!project) return;

  const report = await runWikiLint(project.id);
  if (isLintReportEmpty(report)) return;

  const channels = await channelRepo.list({ project_id: project.id });
  const projectChannel = channels.find((c) => c.kind === 'project');
  if (!projectChannel) {
    console.warn(
      `[worker] wiki-lint: project "${project.id}" has no project channel to report into - skipping`,
    );
    return;
  }

  await postMessage(boss, {
    channelId: projectChannel.id,
    authorType: 'agent',
    authorId: LIBRARIAN_AUTHOR_ID,
    content: formatLintReport(report),
  });
}

/**
 * Runs @katnor/knowledge's wiki lint (PLAN.md §4.5) and, if it found
 * anything, posts a report into the project's channel. `projectId` is set
 * for a manual trigger (apps/server's `knowledge.lintProject`); omitted
 * for the weekly `boss.schedule()` firing (apps/worker/src/index.ts),
 * which means "every project" - see @katnor/agents' queues.ts doc comment.
 */
export function createWikiLintHandler(boss: PgBoss) {
  return async function wikiLint(
    jobs: PgBoss.Job<{ projectId?: string }>[],
  ): Promise<{ ok: true }> {
    for (const job of jobs) {
      try {
        const projectIds = job.data.projectId
          ? [job.data.projectId]
          : (await projectRepo.list()).map((p) => p.id);
        for (const projectId of projectIds) {
          await lintOneProject(boss, projectId);
        }
      } catch (err) {
        console.error(`[worker] wiki-lint job ${job.id} threw:`, err);
      }
    }
    return { ok: true };
  };
}
