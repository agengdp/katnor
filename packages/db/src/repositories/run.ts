import { and, desc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { run } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type RunRow = typeof run.$inferSelect;
export type CreateRunInput = Omit<
  typeof run.$inferInsert,
  'id' | 'created_at' | 'updated_at' | 'started_at' | 'status' | 'tokens_in' | 'tokens_out' | 'cost_usd'
>;
export type UpdateRunInput = Partial<Omit<typeof run.$inferInsert, 'id' | 'created_at' | 'agent_id'>>;

export interface ListRunsFilter {
  agent_id?: string;
  task_id?: string;
}

export async function create(input: CreateRunInput): Promise<RunRow> {
  const [created] = await db
    .insert(run)
    .values({ id: ulid(), status: 'queued', ...input })
    .returning();
  if (!created) {
    throw new Error('create(run): insert returned no row');
  }
  return created;
}

export async function getById(id: string): Promise<RunRow | undefined> {
  const [row] = await db.select().from(run).where(eq(run.id, id)).limit(1);
  return row;
}

/** Always bumps `updated_at`, in addition to whatever fields are in `patch`. */
export async function update(id: string, patch: UpdateRunInput): Promise<RunRow | undefined> {
  const [updated] = await db
    .update(run)
    .set({ ...patch, updated_at: new Date() })
    .where(eq(run.id, id))
    .returning();
  return updated;
}

/**
 * Most recent first - the natural order for a Runs page.
 *
 * Built as two full, separately-typed query chains (rather than starting
 * one chain and conditionally calling `.where()` on it afterward) because
 * drizzle's query builder narrows its own type after `.orderBy()`/`.limit()`
 * in a way that no longer offers `.where()` - matching the same pattern
 * `./task.ts`'s `list()` already uses for its one optional filter.
 */
export async function list(filter: ListRunsFilter = {}): Promise<RunRow[]> {
  const conditions = [];
  if (filter.agent_id !== undefined) conditions.push(eq(run.agent_id, filter.agent_id));
  if (filter.task_id !== undefined) conditions.push(eq(run.task_id, filter.task_id));

  if (conditions.length === 0) {
    return db.select().from(run).orderBy(desc(run.started_at)).limit(200);
  }
  return db
    .select()
    .from(run)
    .where(and(...conditions))
    .orderBy(desc(run.started_at))
    .limit(200);
}
