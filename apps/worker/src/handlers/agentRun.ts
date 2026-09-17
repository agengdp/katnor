import { runAgentExecutor } from '@katnor/agents';
import type PgBoss from 'pg-boss';

/**
 * Runs one agent's turn through the LLM tool-use loop for each queued
 * `agent-run` job - see @katnor/agents' `runAgentExecutor` for the actual
 * loop (PLAN.md §4.1). `boss` is threaded through so the executor's tools
 * (e.g. `delegate_task`, `send_message`) can enqueue further runs they
 * trigger, using the same client this worker process already has running.
 */
export function createAgentRunHandler(boss: PgBoss) {
  return async function agentRun(
    jobs: PgBoss.Job<{ runId: string; note?: string }>[],
  ): Promise<{ ok: true }> {
    for (const job of jobs) {
      try {
        await runAgentExecutor(boss, job.data.runId, job.data.note);
      } catch (err) {
        console.error(`[worker] agent-run job ${job.id} (run ${job.data.runId}) threw:`, err);
      }
    }
    return { ok: true };
  };
}
