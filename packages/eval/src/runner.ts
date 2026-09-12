import { createBossClient, triggerRun } from '@katnor/agents';
import { agentRepo, artifactRepo, channelRepo, runRepo, taskRepo } from '@katnor/db';
import { ensureFixtures } from './fixtures.js';
import { EVAL_TASKS } from './tasks.js';
import type { EvalOutcome, EvalTaskDef } from './types.js';

const POLL_INTERVAL_MS = 3_000;

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'waiting_human']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `run` until it reaches a terminal status (@katnor/core's
 * `RUN_STATUSES`) or `timeoutMs` elapses. `waiting_human` counts as
 * terminal here - nobody is watching the Inbox during a CI run to answer
 * an `ask_human` call, so a task that ends up parked there can't make any
 * more progress and should be graded (and almost certainly fail) as-is
 * rather than hang until the timeout.
 */
async function waitForTerminalRun(runId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await runRepo.getById(runId);
    if (!run) throw new Error(`run "${runId}" disappeared while polling`);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
    if (Date.now() >= deadline) return run;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function runOne(
  def: EvalTaskDef,
  fixtures: { projectId: string; agentId: string },
  boss: ReturnType<typeof createBossClient>,
): Promise<EvalOutcome> {
  const startedAt = Date.now();

  const task = await taskRepo.create({
    project_id: fixtures.projectId,
    title: def.title,
    description: def.description,
    acceptance_criteria: def.acceptanceCriteria,
    assignee_id: fixtures.agentId,
    created_by: 'human',
  });

  // Same channel a real assignment gets - `delegate_task`'s task-thread
  // channel (@katnor/db's `channelRepo.getOrCreateTaskThread`), not a
  // simplified stand-in, so `run.channel_id` and the recent-messages
  // context the run executor builds match production exactly.
  const thread = await channelRepo.getOrCreateTaskThread(task.id, fixtures.projectId);

  const created = await triggerRun(boss, {
    agentId: fixtures.agentId,
    taskId: task.id,
    channelId: thread.id,
    trigger: 'task',
  });

  const run = await waitForTerminalRun(created.id, def.timeoutMs);
  if (!TERMINAL_RUN_STATUSES.has(run.status)) {
    return {
      key: def.key,
      passed: false,
      reason:
        `timed out after ${def.timeoutMs}ms waiting for the run to finish ` +
        `(last status: "${run.status}")`,
      durationMs: Date.now() - startedAt,
    };
  }

  const [artifacts, agent] = await Promise.all([
    artifactRepo.listLatest({ task_id: task.id }),
    agentRepo.getById(fixtures.agentId),
  ]);
  if (!agent) {
    return {
      key: def.key,
      passed: false,
      reason: 'eval agent disappeared before grading could run',
      durationMs: Date.now() - startedAt,
    };
  }

  const result = await def.grade({ run, task, artifacts, agent });
  return {
    key: def.key,
    passed: result.passed,
    reason: result.reason,
    durationMs: Date.now() - startedAt,
  };
}

async function main(): Promise<void> {
  const boss = createBossClient();
  boss.on('error', (error) => {
    console.error('[eval] pg-boss error:', error);
  });
  await boss.start();

  const fixtures = await ensureFixtures();

  const outcomes: EvalOutcome[] = [];
  // Sequential, not parallel: eval tasks share one fixture agent, and
  // @katnor/worker's agent-run handler processes one job per fixed queue
  // subscription at a time per its default pg-boss concurrency, so running
  // these one at a time keeps each run's step trace easy to attribute to
  // exactly one eval task if something needs debugging.
  for (const def of EVAL_TASKS) {
    console.log(`[eval] running "${def.key}"...`);
    try {
      const outcome = await runOne(def, fixtures, boss);
      outcomes.push(outcome);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcomes.push({ key: def.key, passed: false, reason: `threw: ${message}`, durationMs: 0 });
    }
  }

  await boss.stop();

  console.log('\n[eval] results:');
  let allPassed = true;
  for (const outcome of outcomes) {
    const icon = outcome.passed ? 'PASS' : 'FAIL';
    console.log(`  ${icon}  ${outcome.key} (${outcome.durationMs}ms) - ${outcome.reason}`);
    if (!outcome.passed) allPassed = false;
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('[eval] fatal error:', err);
  process.exit(1);
});
