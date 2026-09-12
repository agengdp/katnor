import { eq } from 'drizzle-orm';
import { db } from '../client.js';
import { secret } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type SecretRow = typeof secret.$inferSelect;

export async function list(): Promise<SecretRow[]> {
  return db.select().from(secret);
}

export async function getByName(name: string): Promise<SecretRow | undefined> {
  const [row] = await db.select().from(secret).where(eq(secret.name, name)).limit(1);
  return row;
}

/** Creates the secret if `name` is new, or replaces its value if it already exists. */
export async function upsert(name: string, valueEncrypted: string): Promise<SecretRow> {
  const existing = await getByName(name);
  if (existing) {
    const [updated] = await db
      .update(secret)
      .set({ value_encrypted: valueEncrypted, updated_at: new Date() })
      .where(eq(secret.id, existing.id))
      .returning();
    if (!updated) throw new Error(`upsert(secret): update returned no row for "${name}"`);
    return updated;
  }
  const [created] = await db
    .insert(secret)
    .values({ id: ulid(), name, value_encrypted: valueEncrypted })
    .returning();
  if (!created) throw new Error(`upsert(secret): insert returned no row for "${name}"`);
  return created;
}

export async function remove(name: string): Promise<void> {
  await db.delete(secret).where(eq(secret.name, name));
}
