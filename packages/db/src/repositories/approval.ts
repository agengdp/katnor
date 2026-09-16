import { desc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { approval } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type ApprovalRow = typeof approval.$inferSelect;
export type CreateApprovalInput = Omit<
  typeof approval.$inferInsert,
  'id' | 'created_at' | 'updated_at' | 'status' | 'decided_by' | 'decided_at'
>;
export type DecideApprovalInput = Pick<typeof approval.$inferInsert, 'status' | 'decided_by'> & {
  /** Merged into the existing `payload` (e.g. adding `answer` to a question) rather than replacing it. */
  payloadPatch?: Record<string, unknown>;
};

export async function create(input: CreateApprovalInput): Promise<ApprovalRow> {
  const [created] = await db
    .insert(approval)
    .values({ id: ulid(), status: 'pending', decided_by: null, decided_at: null, ...input })
    .returning();
  if (!created) {
    throw new Error('create(approval): insert returned no row');
  }
  return created;
}

export async function getById(id: string): Promise<ApprovalRow | undefined> {
  const [row] = await db.select().from(approval).where(eq(approval.id, id)).limit(1);
  return row;
}

export async function list(
  status?: (typeof approval.$inferSelect)['status'],
): Promise<ApprovalRow[]> {
  if (status !== undefined) {
    return db
      .select()
      .from(approval)
      .where(eq(approval.status, status))
      .orderBy(desc(approval.created_at));
  }
  return db.select().from(approval).orderBy(desc(approval.created_at));
}

/**
 * Records a human's (or, later, an auto-policy's) decision. Reads the
 * current row first so `payloadPatch` can be merged into `payload` rather
 * than clobbering it - e.g. answering a question needs to keep `question`
 * and add `answer`, not replace the whole payload with just `{answer}`.
 * Returns `undefined` if `id` doesn't exist.
 */
export async function decide(
  id: string,
  input: DecideApprovalInput,
): Promise<ApprovalRow | undefined> {
  const existing = await getById(id);
  if (!existing) return undefined;

  const [updated] = await db
    .update(approval)
    .set({
      status: input.status,
      decided_by: input.decided_by,
      decided_at: new Date(),
      payload: { ...existing.payload, ...input.payloadPatch },
      updated_at: new Date(),
    })
    .where(eq(approval.id, id))
    .returning();
  return updated;
}
