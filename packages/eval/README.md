# @katnor/eval

PLAN.md Phase 5's eval harness: "a set of scripted company tasks with graded outcomes, run in CI
against prompt and tool changes."

## What it does

`pnpm start` (`tsx src/runner.ts`) creates a small fixture project and a cheap fixture agent ("Eval
Bot", `claude-haiku-4-5`) if they don't already exist, then for each task in `src/tasks.ts`:

1. Creates a real `task` row and its task-thread channel.
2. Enqueues a real `agent-run` job via `@katnor/agents`' `triggerRun` - the exact same path a human
   assigning a task through the dashboard goes through.
3. Polls the `run` row until it reaches a terminal status or the task's timeout elapses.
4. Grades the outcome (`src/tasks.ts`'s `grade()` per task) against `run.summary` and/or any
   artifacts the agent saved.

Exits non-zero if any task fails or times out, printing a `PASS`/`FAIL` line with a reason for each.

## Requirements to actually run this

This is an integration test, not a unit test - it needs a real, running stack:

- `DATABASE_URL` pointing at a migrated Postgres (pgvector extension enabled, `db:post-migrate` run).
- `ANTHROPIC_API_KEY` set (the eval agent runs on the `anthropic` provider).
- `@katnor/worker` actually running and processing `agent-run` jobs from the same database - this
  script only enqueues the job and polls for its result, it does not execute agent runs itself.

None of the eval tasks use the `shell`/`claude_code`/`codex` work tools or a project with configured
repos, so no Docker/sandbox setup is required - `SANDBOX_MODE`/workspace containers are irrelevant
here.

## Honesty note

This package was written with no way to boot Postgres, a worker process, or reach the real
Anthropic API from this sandbox. The task/run/artifact shapes it builds against were read directly
from `@katnor/db`'s repositories and `@katnor/agents`' `companyTools.ts`/`hiring.ts` (matching their
exact field shapes rather than guessing), but the harness itself has never actually been executed
end to end. `.github/workflows/eval.yml` is the first real place this would run - see its own
comments for the same caveat about the workflow YAML never having executed in a real GitHub Actions
run either.
