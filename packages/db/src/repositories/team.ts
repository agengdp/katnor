import { eq } from 'drizzle-orm';
import { db } from '../client.js';
import { team } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type TeamRow = typeof team.$inferSelect;
export type CreateTeamInput = Omit<typeof team.$inferInsert, 'id' | 'created_at' | 'updated_at'>;
export type UpdateTeamInput = Partial<Omit<typeof team.$inferInsert, 'id' | 'created_at'>>;

export async function create(input: CreateTeamInput): Promise<TeamRow> {
  const [created] = await db
    .insert(team)
    .values({ id: ulid(), ...input })
    .returning();
  if (!created) {
    throw new Error('create(team): insert returned no row');
  }
  return created;
}

export async function list(): Promise<TeamRow[]> {
  return db.select().from(team);
}

export async function getById(id: string): Promise<TeamRow | undefined> {
  const [row] = await db.select().from(team).where(eq(team.id, id)).limit(1);
  return row;
}

export async function update(id: string, patch: UpdateTeamInput): Promise<TeamRow | undefined> {
  const [updated] = await db
    .update(team)
    .set({ ...patch, updated_at: new Date() })
    .where(eq(team.id, id))
    .returning();
  return updated;
}
