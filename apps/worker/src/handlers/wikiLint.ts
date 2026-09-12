import { postMessage } from '@katnor/agents';
import { channelRepo, projectRepo } from '@katnor/db';
import { formatLintReport, isLintReportEmpty, runWikiLint } from '@katnor/knowledge';
import type PgBoss from 'pg-boss';

/** The Librarian is a system job, not a hired employee (PLAN.md 6.2.6) - `message.author_id` has no FK constraint precisely so a non-agent-row author like this is representable (see @katnor/db's message.ts schema comment). */
const LIBRARIAN_AUTHOR_ID = 'librarian';

/**
 * Runs @katnor/knowledge's wiki lint (PLAN.md §4.5) for one project and, if
 * it found anything, posts a report into the project's channel. Triggered
 * manually today via apps/server's `knowledge.lintProject` mutation - see
 * @katnor/agents' queues.ts doc comment on why real scheduling is deferred.
 */
export function createWikiLintHandler(boss: PgBoss) {
  return async function wikiLint(jobs: PgBoss.Job<{ projectId: string }>[]): Promise<{ ok: true }> {
    for (const job of jobs) {
      try {
        const project = await projectRepo.getById(job.data.projectId);
        if (!project) continue;

        const report = await runWikiLint(project.id);
        if (isLintReportEmpty(report)) continue;

        const channels = await channelRepo.list({ project_id: project.id });
        const projectChannel = channels.find((c) => c.kind === 'project');
        if (!projectChannel) {
          console.warn(`[worker] wiki-lint: project "${project.id}" has no project channel to report into - skipping`);
          continue;
        }

        await postMessage(boss, {
          channelId: projectChannel.id,
          authorType: 'agent',
          authorId: LIBRARIAN_AUTHOR_ID,
          content: formatLintReport(report),
        });
      } catch (err) {
        console.error(`[worker] wiki-lint job ${job.id} threw:`, err);
      }
    }
    return { ok: true };
  };
}
