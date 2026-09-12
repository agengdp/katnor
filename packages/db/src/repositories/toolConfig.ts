import { eq } from 'drizzle-orm';
import { db } from '../client.js';
import { toolConfig } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type ToolConfigRow = typeof toolConfig.$inferSelect;
export type CreateToolConfigInput = Omit<typeof toolConfig.$inferInsert, 'id' | 'created_at' | 'updated_at'>;
export type UpdateToolConfigInput = Partial<Omit<typeof toolConfig.$inferInsert, 'id' | 'created_at'>>;

export async function list(): Promise<ToolConfigRow[]> {
  return db.select().from(toolConfig);
}

export async function listEnabled(): Promise<ToolConfigRow[]> {
  return db.select().from(toolConfig).where(eq(toolConfig.enabled, true));
}

export async function getById(id: string): Promise<ToolConfigRow | undefined> {
  const [row] = await db.select().from(toolConfig).where(eq(toolConfig.id, id)).limit(1);
  return row;
}

export async function create(input: CreateToolConfigInput): Promise<ToolConfigRow> {
  const [created] = await db
    .insert(toolConfig)
    .values({ id: ulid(), ...input })
    .returning();
  if (!created) throw new Error('create(toolConfig): insert returned no row');
  return created;
}

export async function update(id: string, patch: UpdateToolConfigInput): Promise<ToolConfigRow | undefined> {
  const [updated] = await db
    .update(toolConfig)
    .set({ ...patch, updated_at: new Date() })
    .where(eq(toolConfig.id, id))
    .returning();
  return updated;
}

export async function remove(id: string): Promise<void> {
  await db.delete(toolConfig).where(eq(toolConfig.id, id));
}
