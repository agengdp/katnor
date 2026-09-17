import { and, asc, eq, gt } from 'drizzle-orm';
import { db } from '../client.js';
import { message } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type MessageRow = typeof message.$inferSelect;
export type CreateMessageInput = Omit<
  typeof message.$inferInsert,
  'id' | 'created_at' | 'updated_at'
>;

export interface ListMessagesFilter {
  /** Only messages created after this one (exclusive) - for polling/"since last read". */
  after_id?: string;
}

export async function create(input: CreateMessageInput): Promise<MessageRow> {
  const [created] = await db
    .insert(message)
    .values({ id: ulid(), ...input })
    .returning();
  if (!created) {
    throw new Error('create(message): insert returned no row');
  }
  return created;
}

/** Oldest first - the natural order for a chat thread. Capped at the most recent 200. */
export async function list(
  channel_id: string,
  filter: ListMessagesFilter = {},
): Promise<MessageRow[]> {
  if (filter.after_id !== undefined) {
    // ULIDs are lexicographically sortable by creation time (see ../ulid.ts),
    // so "created after id X" is just "id > X" - no need to look X's
    // timestamp up first.
    const rows = await db
      .select()
      .from(message)
      .where(and(eq(message.channel_id, channel_id), gt(message.id, filter.after_id)))
      .orderBy(asc(message.id))
      .limit(200);
    return rows;
  }
  return db
    .select()
    .from(message)
    .where(eq(message.channel_id, channel_id))
    .orderBy(asc(message.id))
    .limit(200);
}
