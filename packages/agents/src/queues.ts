import { getDatabaseUrl } from '@katnor/db';
import PgBoss from 'pg-boss';

/**
 * pg-boss queue topic names, shared between every producer (apps/server's
 * tRPC mutations via `triggerRun` below, the Phase 3 Librarian) and the
 * handlers apps/worker registers on them. Moved here from apps/worker in
 * Phase 1 once apps/server also needed to enqueue jobs - see
 * `triggerRun`'s doc comment.
 *
 * - AGENT_RUN: one agent's turn through the LLM tool-use loop (PLAN.md
 *   §4.1). Implemented in Phase 1 - see ./runExecutor.ts.
 * - LIBRARIAN_INGEST: wiki + knowledge-graph ingestion of one finished,
 *   task-scoped run (PLAN.md §4.4/§4.5). Implemented in Phase 3 - see
 *   ./runExecutor.ts (the enqueue side) and @katnor/knowledge's
 *   librarian.ts (the handler logic, wired up by apps/worker).
 * - WIKI_LINT: the contradiction/orphan-page/stale-fact/missing-page sweep
 *   (PLAN.md §4.5). Implemented in Phase 3 - see @katnor/knowledge's
 *   wikiLint.ts. Triggered manually (apps/server's `knowledge.lintProject`)
 *   for now; real scheduling ("weekly wiki lint") is PLAN.md Phase 5.
 * - CODE_INDEX: the heuristic import-graph indexer over a project's
 *   configured repos (PLAN.md §4.4's code indexer). Implemented in
 *   Phase 3 - see @katnor/knowledge's codeIndexer.ts. Triggered manually
 *   (apps/server's `knowledge.reindexCode`) - PLAN.md's "incremental, per
 *   commit" automatic triggering is deferred, same reasoning as WIKI_LINT.
 */
export const QUEUES = {
  AGENT_RUN: 'agent-run',
  LIBRARIAN_INGEST: 'librarian-ingest',
  WIKI_LINT: 'wiki-lint',
  CODE_INDEX: 'code-index',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * Builds a pg-boss client against the shared Postgres database. Safe to
 * call from more than one process (apps/worker AND apps/server each build
 * their own instance) - pg-boss is designed for multiple
 * producers/consumers against the same backing tables, and `.start()`
 * (which creates/migrates its dedicated `pgboss` schema) is idempotent.
 */
export function createBossClient(): PgBoss {
  return new PgBoss(getDatabaseUrl());
}
