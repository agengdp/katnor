import type { RunTrigger } from '@katnor/core';
import { runRepo } from '@katnor/db';
import type PgBoss from 'pg-boss';
import { QUEUES } from './queues.js';

export interface TriggerRunInput {
  agentId: string;
  taskId?: string | null;
  /** The channel whose message is waking this agent, if any - see the `run.channel_id` schema comment in @katnor/db. */
  channelId?: string | null;
  trigger: RunTrigger;
  /**
   * Free-text context for a trigger that isn't naturally a channel message -
   * e.g. "Your hire request for Maya was approved." when a pending approval
   * is decided. Passed through the pg-boss job payload (not persisted on
   * the `run` row - a schema column felt like overkill for one string only
   * the executor's very first prompt ever reads) to
   * ./runExecutor.ts's `runAgentExecutor`, which forwards it to
   * ./promptBuilder.ts's `buildInitialUserMessage` as `triggerNote`. Message
   * triggers don't need this - the message itself is what happened, and the
   * executor already renders it via `run.channel_id`'s recent messages.
   */
  note?: string;
}

/**
 * Creates a queued `run` row for `agentId` and enqueues the `agent-run` job
 * that will actually execute it (see ./runExecutor.ts, wired up by
 * apps/worker's src/handlers/agentRun.ts).
 *
 * Called from three places: ./messaging.ts's `postMessage` (a message
 * mentions/DMs an agent), ./companyTools.ts's `delegate_task` (a task is
 * assigned), and apps/server's tasks/approvals routers (a human assigns a
 * task or answers a question/approval through the dashboard directly,
 * bypassing chat). Both apps/server and apps/worker can call this because
 * both build their own pg-boss client via `createBossClient()` - see
 * ./queues.ts's doc comment on why that's safe.
 *
 * Does NOT emit a `run.started` event - that happens when the executor
 * actually begins processing the job (transitioning `queued` -> `running`),
 * which is a more useful moment for the dashboard/office to render "X just
 * started working" than the instant it was merely queued.
 */
export async function triggerRun(
  boss: PgBoss,
  input: TriggerRunInput,
): Promise<Awaited<ReturnType<typeof runRepo.create>>> {
  const created = await runRepo.create({
    agent_id: input.agentId,
    task_id: input.taskId ?? null,
    channel_id: input.channelId ?? null,
    trigger: input.trigger,
  });
  await boss.send(QUEUES.AGENT_RUN, { runId: created.id, note: input.note });
  return created;
}
