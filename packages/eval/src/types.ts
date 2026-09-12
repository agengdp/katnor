import type { agentRepo, artifactRepo, runRepo, taskRepo } from '@katnor/db';

// @katnor/db exports its repositories as namespaces (see its index.ts doc
// comment: several share function names like `create`/`list`), so their
// row types aren't top-level exports either - derived the same way
// @katnor/agents' src/context.ts already does.
type AgentRow = NonNullable<Awaited<ReturnType<typeof agentRepo.getById>>>;
type RunRow = NonNullable<Awaited<ReturnType<typeof runRepo.getById>>>;
type TaskRow = NonNullable<Awaited<ReturnType<typeof taskRepo.getById>>>;
type ArtifactRow = Awaited<ReturnType<typeof artifactRepo.listLatest>>[number];

/** Everything a task's `grade` function needs to decide pass/fail. */
export interface EvalGradeContext {
  run: RunRow;
  task: TaskRow;
  /**
   * Every artifact linked to `task.id`, latest version of each group,
   * newest first - see @katnor/db's `artifactRepo.listLatest`.
   */
  artifacts: ArtifactRow[];
  agent: AgentRow;
}

export interface EvalGradeResult {
  passed: boolean;
  /**
   * Always set - the reason a passing check passed is as useful in the
   * report as why a failing one failed.
   */
  reason: string;
}

/**
 * One scripted company task: PLAN.md Phase 5's "a set of scripted company
 * tasks with graded outcomes". Each definition is turned into a real
 * `task` row assigned to a fresh eval agent, run through the actual
 * agent-run loop (@katnor/agents' `triggerRun`/`runAgentExecutor` -
 * exactly what a real hire's task would go through, not a mock), and
 * graded once the resulting `run` reaches a terminal status.
 */
export interface EvalTaskDef {
  /**
   * Short, stable identifier - used in log output and as a task title
   * suffix so runs stay identifiable in the dashboard.
   */
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  /**
   * How long to wait for the run to reach a terminal status before giving
   * up and failing it as a timeout.
   */
  timeoutMs: number;
  grade(ctx: EvalGradeContext): EvalGradeResult | Promise<EvalGradeResult>;
}

export interface EvalOutcome {
  key: string;
  passed: boolean;
  reason: string;
  durationMs: number;
}
