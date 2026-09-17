import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../client.js';
import { kgEdge, kgNode } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type KgEdgeRow = typeof kgEdge.$inferSelect;
export type CreateKgEdgeInput = Omit<
  typeof kgEdge.$inferInsert,
  'id' | 'created_at' | 'updated_at'
>;

export async function create(input: CreateKgEdgeInput): Promise<KgEdgeRow> {
  const [created] = await db
    .insert(kgEdge)
    .values({ id: ulid(), ...input })
    .returning();
  if (!created) throw new Error('create(kgEdge): insert returned no row');
  return created;
}

/** The one edge between (from_id, to_id, type), if it already exists - the Librarian's dedupe check before creating a new one. */
export async function getExisting(
  fromId: string,
  toId: string,
  type: string,
): Promise<KgEdgeRow | undefined> {
  const [row] = await db
    .select()
    .from(kgEdge)
    .where(and(eq(kgEdge.from_id, fromId), eq(kgEdge.to_id, toId), eq(kgEdge.type, type)))
    .limit(1);
  return row;
}

/** Creates the edge only if an identical (from_id, to_id, type) triple doesn't already exist - the KG's "insert edge" is otherwise pure duplication with nothing else to update. */
export async function createIfMissing(input: CreateKgEdgeInput): Promise<KgEdgeRow> {
  const existing = await getExisting(input.from_id, input.to_id, input.type);
  if (existing) return existing;
  return create(input);
}

/**
 * Every edge with at least one endpoint in `projectId`'s node set - the
 * graph explorer's data source. Two queries (node ids, then edges) rather
 * than a join, since kg_edge has no project_id column of its own (only its
 * endpoint nodes do, and a cross-project edge - rare but not disallowed -
 * should still show up from either project's view).
 */
export async function listForProject(projectId: string): Promise<KgEdgeRow[]> {
  const nodes = await db
    .select({ id: kgNode.id })
    .from(kgNode)
    .where(eq(kgNode.project_id, projectId));
  const nodeIds = nodes.map((n) => n.id);
  if (nodeIds.length === 0) return [];
  return db
    .select()
    .from(kgEdge)
    .where(or(inArray(kgEdge.from_id, nodeIds), inArray(kgEdge.to_id, nodeIds)));
}

/** Both directions - a node's full edge set (incoming and outgoing), e.g. for a graph detail panel. */
export async function listForNode(nodeId: string): Promise<KgEdgeRow[]> {
  return db
    .select()
    .from(kgEdge)
    .where(or(eq(kgEdge.from_id, nodeId), eq(kgEdge.to_id, nodeId)));
}
