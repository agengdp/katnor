import type PgBoss from 'pg-boss';

// TODO(Phase 1, PLAN.md §4.1): implement the real agent run executor here -
// build the cache-friendly prompt (company prompt, persona, tool defs, then
// working context and the trigger), call the agent's LLM provider adapter
// with its allowlisted tools, execute tool calls and feed results back,
// repeat until the model ends the turn or a step/token/budget limit trips,
// and record every LLM call and tool call as a `run_step` (tokens, cost,
// duration). This stub only proves the pg-boss `agent-run` queue wiring
// end-to-end until that lands.

/**
 * Will run one agent's turn through the LLM tool-use loop for a queued
 * `agent-run` job (trigger: task assignment, mention, colleague question,
 * scheduled check-in, or human message) - see PLAN.md §4.1.
 */
export async function agentRun(jobs: PgBoss.Job<unknown>[]): Promise<{ ok: true }> {
  for (const job of jobs) {
    console.log(`[worker] agent-run fired (job ${job.id})`);
  }
  return { ok: true };
}
