import type { agentRepo, runRepo, taskRepo } from '@katnor/db';
import type PgBoss from 'pg-boss';

type AgentRow = Awaited<ReturnType<typeof agentRepo.getById>>;
type RunRow = Awaited<ReturnType<typeof runRepo.getById>>;
type TaskRow = Awaited<ReturnType<typeof taskRepo.getById>>;

/**
 * What every company/org tool (./companyTools.ts, ./orgTools.ts) gets to
 * work with. Built once per run by ./runExecutor.ts and passed to
 * @katnor/tools' generic `ToolRegistry.execute()`, which is why this lives
 * in its own module rather than inline in runExecutor.ts - companyTools.ts
 * and orgTools.ts both need the type without importing the executor.
 */
export interface AgentToolContext {
  boss: PgBoss;
  /** The agent making the tool call. */
  agent: NonNullable<AgentRow>;
  /** The run this tool call happens within. */
  run: NonNullable<RunRow>;
  /** Loaded once by the executor if `run.task_id` is set. */
  task: NonNullable<TaskRow> | null;
  /**
   * Set by the `ask_human` tool to signal the executor that this run
   * should end after the current tool result is appended, rather than
   * looping for another `step()` call - see ./companyTools.ts and
   * ./runExecutor.ts's read of this field after every tool execution.
   */
  pauseRequested: { approvalId: string } | null;
}
