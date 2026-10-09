import { eq, ilike, inArray } from 'drizzle-orm';
import { db } from '../client.js';
import { agent, channel, message, team } from '../schema/index.js';
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

export async function getByName(name: string): Promise<TeamRow | undefined> {
  const [row] = await db
    .select()
    .from(team)
    .where(ilike(team.name, escapeLike(name)))
    .limit(1);
  return row;
}

/** `%`/`_`/`\` in a name must not act as LIKE wildcards. */
function escapeLike(name: string): string {
  return name.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Deletes a team and unassigns its members (`agent.team_id` → null —
 * nobody is fired) plus drops the team's channels and their messages.
 * Every FK into `team` is NO ACTION, so children go first.
 */
export async function remove(id: string): Promise<void> {
  await db.update(agent).set({ team_id: null, updated_at: new Date() }).where(eq(agent.team_id, id));
  const channels = await db.select({ id: channel.id }).from(channel).where(eq(channel.team_id, id));
  if (channels.length > 0) {
    const ids = channels.map((c) => c.id);
    await db.delete(message).where(inArray(message.channel_id, ids));
    await db.delete(channel).where(inArray(channel.id, ids));
  }
  await db.delete(team).where(eq(team.id, id));
}
