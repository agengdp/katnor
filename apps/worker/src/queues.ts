import PgBoss from 'pg-boss';
import { env } from './env.js';

/**
 * pg-boss queue topic names, shared between whatever enqueues jobs (the
 * server's tRPC mutations, the Phase 1 scheduler, the Phase 3 Librarian) and
 * the handlers registered on them in src/index.ts.
 *
 * - AGENT_RUN: one agent's turn through the LLM tool-use loop
 *   (PLAN.md §4.1). Implemented in Phase 1.
 * - LIBRARIAN_INGEST: wiki + knowledge-graph ingestion of a run/artifact/
 *   message (PLAN.md §4.4/§4.5). Implemented in Phase 3.
 * - WIKI_LINT: the scheduled contradiction/orphan-page/stale-fact sweep
 *   (PLAN.md §4.5). Implemented in Phase 3; no handler is registered for it
 *   yet in this Phase 0 skeleton.
 */
export const QUEUES = {
  AGENT_RUN: 'agent-run',
  LIBRARIAN_INGEST: 'librarian-ingest',
  WIKI_LINT: 'wiki-lint',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * Builds a pg-boss client against the worker's Postgres database.
 *
 * pg-boss creates and migrates its own schema (a dedicated `pgboss` schema
 * holding its job tables) the first time `.start()` is called on the
 * returned instance, so there is nothing else to set up here.
 */
export function createBossClient(): PgBoss {
  return new PgBoss(env.DATABASE_URL);
}
