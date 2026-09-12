import { db } from '../client.js';
import { event } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type EventRow = typeof event.$inferSelect;
export type AppendEventInput = Omit<typeof event.$inferInsert, 'id' | 'created_at' | 'updated_at'>;

/**
 * Inserts a row into the append-only `event` table. Does NOT call
 * `pg_notify` itself - the `katnor_event_notify` trigger installed by
 * src/applyPostMigrate.ts does that for every insert. See src/listen.ts
 * for the subscriber side.
 */
export async function append(input: AppendEventInput): Promise<EventRow> {
  const [created] = await db
    .insert(event)
    .values({ id: ulid(), ...input })
    .returning();
  if (!created) {
    throw new Error('append(event): insert returned no row');
  }
  return created;
}
