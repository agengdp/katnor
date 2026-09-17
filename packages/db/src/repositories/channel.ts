import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client.js';
import { channel } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type ChannelRow = typeof channel.$inferSelect;
export type CreateChannelInput = Omit<
  typeof channel.$inferInsert,
  'id' | 'created_at' | 'updated_at'
>;

export interface ListChannelsFilter {
  project_id?: string;
  team_id?: string;
}

export async function create(input: CreateChannelInput): Promise<ChannelRow> {
  const [created] = await db
    .insert(channel)
    .values({ id: ulid(), ...input })
    .returning();
  if (!created) {
    throw new Error('create(channel): insert returned no row');
  }
  return created;
}

export async function getById(id: string): Promise<ChannelRow | undefined> {
  const [row] = await db.select().from(channel).where(eq(channel.id, id)).limit(1);
  return row;
}

export async function list(filter: ListChannelsFilter = {}): Promise<ChannelRow[]> {
  if (filter.project_id !== undefined) {
    return db.select().from(channel).where(eq(channel.project_id, filter.project_id));
  }
  if (filter.team_id !== undefined) {
    return db.select().from(channel).where(eq(channel.team_id, filter.team_id));
  }
  return db.select().from(channel);
}

/**
 * Returns the one company-wide `#general` channel (kind = "general",
 * project_id/team_id both null), creating it if it doesn't exist yet.
 * Normally seeded once at `db:seed` time (see ../seed.ts) - this exists so
 * any later code path that needs #general never has to special-case "it
 * might not exist yet."
 */
export async function getOrCreateGeneral(): Promise<ChannelRow> {
  const [existing] = await db
    .select()
    .from(channel)
    .where(and(eq(channel.kind, 'general'), isNull(channel.project_id), isNull(channel.team_id)))
    .limit(1);
  if (existing) return existing;

  return create({
    project_id: null,
    team_id: null,
    kind: 'general',
    name: 'general',
    task_id: null,
  });
}

/**
 * Returns the owner's one-on-one DM channel with `agentId`, creating it if
 * it doesn't exist yet. v1 has exactly one human (the owner), so a DM
 * channel is identified purely by which agent it's with - `name` is the
 * literal string `dm:<agentId>`, checked here rather than enforced by a DB
 * uniqueness constraint (an app-level check, same tradeoff Phase 0 made
 * elsewhere - see packages/db/README.md's other "not added" notes).
 */
export async function getOrCreateDm(agentId: string): Promise<ChannelRow> {
  const name = `dm:${agentId}`;
  const [existing] = await db
    .select()
    .from(channel)
    .where(and(eq(channel.kind, 'dm'), eq(channel.name, name)))
    .limit(1);
  if (existing) return existing;

  return create({
    project_id: null,
    team_id: null,
    kind: 'dm',
    name,
    task_id: null,
  });
}

/**
 * Returns the task-thread channel for `taskId`, creating it if it doesn't
 * exist yet. One task has at most one thread.
 */
export async function getOrCreateTaskThread(
  taskId: string,
  projectId: string,
): Promise<ChannelRow> {
  const [existing] = await db.select().from(channel).where(eq(channel.task_id, taskId)).limit(1);
  if (existing) return existing;

  return create({
    project_id: projectId,
    team_id: null,
    kind: 'task_thread',
    name: null,
    task_id: taskId,
  });
}
