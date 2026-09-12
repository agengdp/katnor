import { eq } from 'drizzle-orm';
import { db } from '../client.js';
import { agent } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type AgentRow = typeof agent.$inferSelect;
export type CreateAgentInput = Omit<typeof agent.$inferInsert, 'id' | 'created_at' | 'updated_at'>;
export type UpdateAgentInput = Partial<Omit<typeof agent.$inferInsert, 'id' | 'created_at'>>;

export async function create(input: CreateAgentInput): Promise<AgentRow> {
  const [created] = await db
    .insert(agent)
    .values({ id: ulid(), ...input })
    .returning();
  if (!created) {
    throw new Error('create(agent): insert returned no row');
  }
  return created;
}

export async function list(): Promise<AgentRow[]> {
  return db.select().from(agent);
}

export async function getById(id: string): Promise<AgentRow | undefined> {
  const [row] = await db.select().from(agent).where(eq(agent.id, id)).limit(1);
  return row;
}

/** Always bumps `updated_at`, in addition to whatever fields are in `patch`. */
export async function update(id: string, patch: UpdateAgentInput): Promise<AgentRow | undefined> {
  const [updated] = await db
    .update(agent)
    .set({ ...patch, updated_at: new Date() })
    .where(eq(agent.id, id))
    .returning();
  return updated;
}
