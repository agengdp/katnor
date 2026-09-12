import type PgBoss from 'pg-boss';

// TODO(Phase 3, PLAN.md §4.5): implement the real Librarian ingest job here -
// read the source run/artifact/task/thread, decide which wiki pages to
// create or update, write them under wiki/pages/<slug>.md (and wiki/decisions
// for ADRs), refresh wiki/index.md and wiki/log.md, commit to the project's
// wiki git repo, and feed extracted entities/relations into the knowledge
// graph (kg_node/kg_edge) per PLAN.md §4.4. This stub only proves the
// pg-boss `librarian-ingest` queue wiring end-to-end until that lands.

/**
 * Will ingest a completed run, artifact, or important thread into the
 * project's markdown wiki and knowledge graph for a queued
 * `librarian-ingest` job - see PLAN.md §4.5.
 */
export async function librarianIngest(jobs: PgBoss.Job<unknown>[]): Promise<{ ok: true }> {
  for (const job of jobs) {
    console.log(`[worker] librarian-ingest fired (job ${job.id})`);
  }
  return { ok: true };
}
