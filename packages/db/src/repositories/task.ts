import { eq } from 'drizzle-orm';
import { db } from '../client.js';
import { task } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type TaskRow = typeof task.$inferSelect;
export type CreateTaskInput = Omit<typeof task.$inferInsert, 'id' | 'created_at' | 'updated_at'>;
export type UpdateTaskInput = Partial<Omit<typeof task.$inferInsert, 'id' | 'created_at'>>;

export interface ListTasksFilter {
  project_id?: string;
}

export async function create(input: CreateTaskInput): Promise<TaskRow> {
  const [created] = await db
    .insert(task)
    .values({ id: ulid(), ...input })
    .returning();
  if (!created) {
    throw new Error('create(task): insert returned no row');
  }
  return created;
}

export async function list(filter: ListTasksFilter = {}): Promise<TaskRow[]> {
  if (filter.project_id !== undefined) {
    return db.select().from(task).where(eq(task.project_id, filter.project_id));
  }
  return db.select().from(task);
}

export async function getById(id: string): Promise<TaskRow | undefined> {
  const [row] = await db.select().from(task).where(eq(task.id, id)).limit(1);
  return row;
}

/** Always bumps `updated_at`, in addition to whatever fields are in `patch`. */
export async function update(id: string, patch: UpdateTaskInput): Promise<TaskRow | undefined> {
  const [updated] = await db
    .update(task)
    .set({ ...patch, updated_at: new Date() })
    .where(eq(task.id, id))
    .returning();
  return updated;
}
