import { and, eq, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { kgNode } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type KgNodeRow = typeof kgNode.$inferSelect;
export type CreateKgNodeInput = Omit<typeof kgNode.$inferInsert, 'id' | 'created_at' | 'updated_at'>;
export type UpdateKgNodeInput = Partial<Omit<typeof kgNode.$inferInsert, 'id' | 'created_at'>>;

export async function create(input: CreateKgNodeInput): Promise<KgNodeRow> {
  const [created] = await db
    .insert(kgNode)
    .values({ id: ulid(), ...input })
    .returning();
  if (!created) throw new Error('create(kgNode): insert returned no row');
  return created;
}

export async function getById(id: string): Promise<KgNodeRow | undefined> {
  const [row] = await db.select().from(kgNode).where(eq(kgNode.id, id)).limit(1);
  return row;
}

/** Exact match on (project_id, type, name) - the primary dedupe key the Librarian upserts against (PLAN.md 4.4). */
export async function getByName(
  projectId: string | null,
  type: string,
  name: string,
): Promise<KgNodeRow | undefined> {
  const projectCondition = projectId === null ? sql`${kgNode.project_id} is null` : eq(kgNode.project_id, projectId);
  const [row] = await db
    .select()
    .from(kgNode)
    .where(and(projectCondition, eq(kgNode.type, type), eq(kgNode.name, name)))
    .limit(1);
  return row;
}

export async function update(id: string, patch: UpdateKgNodeInput): Promise<KgNodeRow | undefined> {
  const [updated] = await db
    .update(kgNode)
    .set({ ...patch, updated_at: new Date() })
    .where(eq(kgNode.id, id))
    .returning();
  return updated;
}

export interface ListKgNodesFilter {
  project_id?: string | null;
  type?: string;
}

export async function list(filter: ListKgNodesFilter = {}): Promise<KgNodeRow[]> {
  const conditions = [];
  if (filter.project_id !== undefined) {
    conditions.push(filter.project_id === null ? sql`${kgNode.project_id} is null` : eq(kgNode.project_id, filter.project_id));
  }
  if (filter.type !== undefined) conditions.push(eq(kgNode.type, filter.type));

  if (conditions.length === 0) return db.select().from(kgNode);
  return db
    .select()
    .from(kgNode)
    .where(and(...conditions));
}

export interface KgNodeSearchHit extends KgNodeRow {
  score: number;
}

/**
 * Cosine-similarity search over nodes that have an embedding, within
 * `projectId` if given. `score` is `1 - cosine_distance` (pgvector's `<=>`
 * operator), so 1.0 is an exact match and 0.0 is orthogonal.
 *
 * NOTE: written with no way to run this against a live Postgres+pgvector
 * instance in this sandbox - the `<=>` operator and `::vector` cast on a
 * bound text parameter are pgvector's long-documented, stable SQL surface
 * (matching ../schema/vector.ts's `toDriver` text format), but this
 * specific query has not been executed for real.
 */
export async function searchByEmbedding(
  embedding: number[],
  opts: { projectId?: string | null; limit?: number } = {},
): Promise<KgNodeSearchHit[]> {
  const limit = opts.limit ?? 10;
  const vectorLiteral = `[${embedding.join(',')}]`;
  const projectFilter =
    opts.projectId === undefined
      ? sql``
      : opts.projectId === null
        ? sql`and ${kgNode.project_id} is null`
        : sql`and ${kgNode.project_id} = ${opts.projectId}`;

  // Not asserting a generic type param on `db.execute()` - its exact result
  // shape for the postgres-js driver (a plain iterable row array vs. a
  // `{rows: [...]}` wrapper) couldn't be confirmed against a live install
  // in this sandbox; spreading it and casting is robust to either since
  // both are iterable.
  const result = await db.execute(sql`
    select *, 1 - (embedding <=> ${vectorLiteral}::vector) as score
    from kg_node
    where embedding is not null ${projectFilter}
    order by embedding <=> ${vectorLiteral}::vector
    limit ${limit}
  `);
  return [...result] as unknown as KgNodeSearchHit[];
}

/** Plain substring search over name/summary - the keyword half of hybrid search, and the only half available when embeddings aren't configured. */
export async function searchByKeyword(
  query: string,
  opts: { projectId?: string | null; limit?: number } = {},
): Promise<KgNodeRow[]> {
  const limit = opts.limit ?? 10;
  const pattern = `%${query}%`;
  const conditions = [sql`(${kgNode.name} ilike ${pattern} or ${kgNode.summary} ilike ${pattern})`];
  if (opts.projectId !== undefined) {
    conditions.push(opts.projectId === null ? sql`${kgNode.project_id} is null` : eq(kgNode.project_id, opts.projectId));
  }
  return db
    .select()
    .from(kgNode)
    .where(and(...conditions))
    .limit(limit);
}
