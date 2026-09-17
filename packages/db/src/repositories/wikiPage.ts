import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { wikiPage } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type WikiPageRow = typeof wikiPage.$inferSelect;
export type CreateWikiPageInput = Omit<
  typeof wikiPage.$inferInsert,
  'id' | 'created_at' | 'updated_at'
>;
export type UpdateWikiPageInput = Partial<
  Omit<typeof wikiPage.$inferInsert, 'id' | 'created_at' | 'project_id' | 'path'>
>;

export async function list(projectId: string): Promise<WikiPageRow[]> {
  return db.select().from(wikiPage).where(eq(wikiPage.project_id, projectId));
}

export async function getByPath(projectId: string, path: string): Promise<WikiPageRow | undefined> {
  const [row] = await db
    .select()
    .from(wikiPage)
    .where(and(eq(wikiPage.project_id, projectId), eq(wikiPage.path, path)))
    .limit(1);
  return row;
}

export async function getById(id: string): Promise<WikiPageRow | undefined> {
  const [row] = await db.select().from(wikiPage).where(eq(wikiPage.id, id)).limit(1);
  return row;
}

/**
 * Creates the page (a new `project_id`+`path`) or updates it in place - the
 * DB row mirrors the file @katnor/knowledge's wikiStorage.ts writes, so
 * "the page changed" is always create-or-replace, never versioned like an
 * artifact.
 */
export async function upsert(input: CreateWikiPageInput): Promise<WikiPageRow> {
  const existing = await getByPath(input.project_id, input.path);
  if (existing) {
    const [updated] = await db
      .update(wikiPage)
      .set({
        title: input.title,
        frontmatter: input.frontmatter,
        content_hash: input.content_hash,
        embedding: input.embedding,
        updated_at: new Date(),
      })
      .where(eq(wikiPage.id, existing.id))
      .returning();
    if (!updated) throw new Error(`upsert(wikiPage): update returned no row for "${input.path}"`);
    return updated;
  }
  const [created] = await db
    .insert(wikiPage)
    .values({ id: ulid(), ...input })
    .returning();
  if (!created) throw new Error(`upsert(wikiPage): insert returned no row for "${input.path}"`);
  return created;
}

export async function remove(id: string): Promise<void> {
  await db.delete(wikiPage).where(eq(wikiPage.id, id));
}

export interface WikiPageSearchHit extends WikiPageRow {
  score: number;
}

/** Cosine-similarity search over pages that have an embedding - see kgNode.ts's `searchByEmbedding` for the same caveat on this query never having run against a live database. */
export async function searchByEmbedding(
  embedding: number[],
  opts: { projectId?: string; limit?: number } = {},
): Promise<WikiPageSearchHit[]> {
  const limit = opts.limit ?? 10;
  const vectorLiteral = `[${embedding.join(',')}]`;
  const projectFilter =
    opts.projectId === undefined ? sql`` : sql`and project_id = ${opts.projectId}`;

  const result = await db.execute(sql`
    select *, 1 - (embedding <=> ${vectorLiteral}::vector) as score
    from wiki_page
    where embedding is not null ${projectFilter}
    order by embedding <=> ${vectorLiteral}::vector
    limit ${limit}
  `);
  return [...result] as unknown as WikiPageSearchHit[];
}

/**
 * Title/path substring match only - the page body isn't stored in Postgres
 * (only `content_hash`; the actual markdown lives on disk via
 * @katnor/knowledge's wikiStorage.ts), so this alone is a weak keyword
 * fallback. @katnor/knowledge/src/search.ts additionally reads candidate
 * pages' real content for a body-text keyword check when embeddings aren't
 * configured - this function is just the cheap first pass to narrow which
 * pages are worth reading.
 */
export async function searchByKeyword(
  query: string,
  opts: { projectId?: string; limit?: number } = {},
): Promise<WikiPageRow[]> {
  const limit = opts.limit ?? 10;
  const pattern = `%${query}%`;
  const conditions = [or(ilike(wikiPage.title, pattern), sql`${wikiPage.path} ilike ${pattern}`)];
  if (opts.projectId !== undefined) conditions.push(eq(wikiPage.project_id, opts.projectId));
  return db
    .select()
    .from(wikiPage)
    .where(and(...conditions))
    .limit(limit);
}
