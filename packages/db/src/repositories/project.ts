import { db } from '../client.js';
import { project } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type ProjectRow = typeof project.$inferSelect;
export type CreateProjectInput = Omit<
  typeof project.$inferInsert,
  'id' | 'created_at' | 'updated_at'
>;

export async function create(input: CreateProjectInput): Promise<ProjectRow> {
  const [created] = await db
    .insert(project)
    .values({ id: ulid(), ...input })
    .returning();
  if (!created) {
    throw new Error('create(project): insert returned no row');
  }
  return created;
}

export async function list(): Promise<ProjectRow[]> {
  return db.select().from(project);
}
