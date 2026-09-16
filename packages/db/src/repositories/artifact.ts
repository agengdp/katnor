import { and, desc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { artifact } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type ArtifactRow = typeof artifact.$inferSelect;

export interface CreateArtifactInput {
  project_id?: string | null;
  task_id?: string | null;
  run_id?: string | null;
  /** Adds a new version to this existing group instead of starting a new one. */
  artifact_group_id?: string;
  kind: ArtifactRow['kind'];
  title: string;
  storage_key: string;
  mime?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Creates an artifact. When `artifact_group_id` is omitted, this starts a
 * brand new group (using the new row's own id as the group id - a
 * version-1 artifact groups with itself) at version 1; when given an
 * existing group id, this inserts the next version in that group
 * (`MAX(version) + 1`, computed from the current rows rather than trusted
 * from the caller).
 */
export async function create(input: CreateArtifactInput): Promise<ArtifactRow> {
  const id = ulid();
  let groupId = input.artifact_group_id;
  let version = 1;

  if (groupId) {
    const existingVersions = await db
      .select({ version: artifact.version })
      .from(artifact)
      .where(eq(artifact.artifact_group_id, groupId));
    version = existingVersions.reduce((max, row) => Math.max(max, row.version), 0) + 1;
  } else {
    groupId = id;
  }

  const [created] = await db
    .insert(artifact)
    .values({
      id,
      project_id: input.project_id ?? null,
      task_id: input.task_id ?? null,
      run_id: input.run_id ?? null,
      artifact_group_id: groupId,
      version,
      kind: input.kind,
      title: input.title,
      storage_key: input.storage_key,
      mime: input.mime ?? null,
      metadata: input.metadata ?? {},
    })
    .returning();
  if (!created) throw new Error('create(artifact): insert returned no row');
  return created;
}

export async function getById(id: string): Promise<ArtifactRow | undefined> {
  const [row] = await db.select().from(artifact).where(eq(artifact.id, id)).limit(1);
  return row;
}

/** Looks an artifact up by its storage key - apps/server's `/artifacts/raw/:key` route uses this to resolve the right `mime` for the response header. */
export async function getByStorageKey(storageKey: string): Promise<ArtifactRow | undefined> {
  const [row] = await db
    .select()
    .from(artifact)
    .where(eq(artifact.storage_key, storageKey))
    .limit(1);
  return row;
}

/** Every version in a group, newest first. */
export async function listGroup(artifactGroupId: string): Promise<ArtifactRow[]> {
  return db
    .select()
    .from(artifact)
    .where(eq(artifact.artifact_group_id, artifactGroupId))
    .orderBy(desc(artifact.version));
}

export interface ListArtifactsFilter {
  project_id?: string;
  task_id?: string;
  run_id?: string;
}

/**
 * The *latest* version of every distinct group matching the filter, newest
 * first - the natural listing for an Artifacts page or a task drawer
 * (nobody wants to see every superseded version in the main list).
 */
export async function listLatest(filter: ListArtifactsFilter = {}): Promise<ArtifactRow[]> {
  const conditions = [];
  if (filter.project_id !== undefined) conditions.push(eq(artifact.project_id, filter.project_id));
  if (filter.task_id !== undefined) conditions.push(eq(artifact.task_id, filter.task_id));
  if (filter.run_id !== undefined) conditions.push(eq(artifact.run_id, filter.run_id));

  const rows =
    conditions.length === 0
      ? await db.select().from(artifact).orderBy(desc(artifact.created_at))
      : await db
          .select()
          .from(artifact)
          .where(and(...conditions))
          .orderBy(desc(artifact.created_at));

  const latestByGroup = new Map<string, ArtifactRow>();
  for (const row of rows) {
    const existing = latestByGroup.get(row.artifact_group_id);
    if (!existing || row.version > existing.version) {
      latestByGroup.set(row.artifact_group_id, row);
    }
  }
  return [...latestByGroup.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}
