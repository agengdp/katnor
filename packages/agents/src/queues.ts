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
 * - LIBRARIAN_INGEST: wiki + knowledge-graph ingestion of a run/artifact/
 *   message (PLAN.md §4.4/§4.5). Implemented in Phase 3.
 * - WIKI_LINT: the scheduled contradiction/orphan-page/stale-fact sweep
 *   (PLAN.md §4.5). Implemented in Phase 3.
 */
export const QUEUES = {
  AGENT_RUN: 'agent-run',
  LIBRARIAN_INGEST: 'librarian-ingest',
  WIKI_LINT: 'wiki-lint',
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
