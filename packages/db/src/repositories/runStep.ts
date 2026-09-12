import { asc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { runStep } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type RunStepRow = typeof runStep.$inferSelect;
export type CreateRunStepInput = Omit<
  typeof runStep.$inferInsert,
  'id' | 'created_at' | 'updated_at'
>;

/**
 * `seq` is assigned by the caller (the run executor keeps its own
 * in-process counter for the run it's driving), not computed here - a
 * single run only ever has one executor writing its steps at a time, so
 * there's no concurrent-writer race to guard against with a DB-side
 * `COUNT(*)`/`MAX(seq)` query.
 */
export async function create(input: CreateRunStepInput): Promise<RunStepRow> {
  const [created] = await db
    .insert(runStep)
    .values({ id: ulid(), ...input })
    .returning();
  if (!created) {
    throw new Error('create(runStep): insert returned no row');
  }
  return created;
}

/** In step order - the natural order for a run's trace view. */
export async function list(run_id: string): Promise<RunStepRow[]> {
  return db.select().from(runStep).where(eq(runStep.run_id, run_id)).orderBy(asc(runStep.seq));
}
