import { eq, ilike, inArray, or } from 'drizzle-orm';
import { db } from '../client.js';
import {
  approval,
  artifact,
  channel,
  kgEdge,
  kgNode,
  message,
  project,
  run,
  runStep,
  task,
  wikiPage,
} from '../schema/index.js';
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

export async function getById(id: string): Promise<ProjectRow | undefined> {
  const [row] = await db.select().from(project).where(eq(project.id, id)).limit(1);
  return row;
}

export async function getByName(name: string): Promise<ProjectRow | undefined> {
  const [row] = await db
    .select()
    .from(project)
    .where(ilike(project.name, escapeLike(name)))
    .limit(1);
  return row;
}

/** `%`/`_`/`\` in a name must not act as LIKE wildcards. */
function escapeLike(name: string): string {
  return name.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Deletes a project with its whole subtree: runs (+ steps, approvals,
 * run artifacts), artifacts, channel messages, channels (project + task
 * threads), tasks (children before parents — `parent_id` is NO ACTION),
 * knowledge-graph nodes/edges, and wiki index rows. Every FK out of these
 * tables is NO ACTION, so children go before parents in this order.
 *
 * The wiki git dir on disk is NOT removed here (@katnor/db must not
 * depend on @katnor/knowledge — that would be circular) — callers remove
 * `projectWikiDir(id)` themselves. Event history (`event` rows) is kept.
 */
export async function remove(id: string): Promise<void> {
  const taskIds = (
    await db.select({ id: task.id }).from(task).where(eq(task.project_id, id))
  ).map((t) => t.id);
  const channelIds = (
    await db.select({ id: channel.id }).from(channel).where(eq(channel.project_id, id))
  ).map((c) => c.id);

  // Runs via their task, or via their channel (mention-triggered, taskless).
  const runConds = [];
  if (taskIds.length > 0) runConds.push(inArray(run.task_id, taskIds));
  if (channelIds.length > 0) runConds.push(inArray(run.channel_id, channelIds));
  if (runConds.length > 0) {
    const runIds = (
      await db.select({ id: run.id }).from(run).where(or(...runConds))
    ).map((r) => r.id);
    if (runIds.length > 0) {
      await db.delete(approval).where(inArray(approval.run_id, runIds));
      await db.delete(runStep).where(inArray(runStep.run_id, runIds));
      await db.delete(artifact).where(inArray(artifact.run_id, runIds));
      await db.delete(run).where(inArray(run.id, runIds));
    }
  }

  const artifactConds = [eq(artifact.project_id, id)];
  if (taskIds.length > 0) artifactConds.push(inArray(artifact.task_id, taskIds));
  await db.delete(artifact).where(or(...artifactConds));

  if (channelIds.length > 0) {
    await db.delete(message).where(inArray(message.channel_id, channelIds));
    await db.delete(channel).where(inArray(channel.id, channelIds));
  }

  // Tasks bottom-up: a parent goes only after nothing references it.
  let remaining = [...taskIds];
  while (remaining.length > 0) {
    const parents = new Set(
      (
        await db
          .select({ parent: task.parent_id })
          .from(task)
          .where(inArray(task.id, remaining))
      )
        .map((r) => r.parent)
        .filter((p): p is string => p !== null),
    );
    const leaves = remaining.filter((tid) => !parents.has(tid));
    if (leaves.length === 0) break; // cycle guard — should never happen
    await db.delete(task).where(inArray(task.id, leaves));
    remaining = remaining.filter((tid) => !leaves.includes(tid));
  }

  const nodeIds = (
    await db.select({ id: kgNode.id }).from(kgNode).where(eq(kgNode.project_id, id))
  ).map((n) => n.id);
  if (nodeIds.length > 0) {
    await db.delete(kgEdge).where(or(inArray(kgEdge.from_id, nodeIds), inArray(kgEdge.to_id, nodeIds)));
    await db.delete(kgNode).where(inArray(kgNode.id, nodeIds));
  }
  await db.delete(wikiPage).where(eq(wikiPage.project_id, id));

  await db.delete(project).where(eq(project.id, id));
}
