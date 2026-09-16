import type { ArtifactKind } from '@katnor/core';
import { artifactRepo, eventRepo, ulid } from '@katnor/db';
import { getStorage } from './storage/index.js';
import { slugify } from './slug.js';

export interface SaveArtifactInput {
  projectId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  /** Adds a new version to this existing group instead of starting a new one - see @katnor/db's artifact repo. */
  artifactGroupId?: string;
  kind: ArtifactKind;
  title: string;
  /** A string is UTF-8 encoded - use a Buffer directly for binary content (e.g. an image). */
  content: Buffer | string;
  contentType?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The one path anything in the system uses to produce an artifact -
 * agents' `save_artifact` tool (@katnor/agents) and every auto-capture hook
 * (a work tool that opens a PR, writes a file, or takes a screenshot) both
 * call this, so "store the bytes, record the row, tell the dashboard"
 * only has to be correct once. See PLAN.md 4.6.
 */
export async function saveArtifact(
  input: SaveArtifactInput,
): Promise<Awaited<ReturnType<typeof artifactRepo.create>>> {
  const storage = getStorage();
  const body =
    typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : input.content;
  const key = `${ulid()}-${slugify(input.title)}`;

  await storage.put({ key, body, contentType: input.contentType });

  const created = await artifactRepo.create({
    project_id: input.projectId ?? null,
    task_id: input.taskId ?? null,
    run_id: input.runId ?? null,
    artifact_group_id: input.artifactGroupId,
    kind: input.kind,
    title: input.title,
    storage_key: key,
    mime: input.contentType ?? null,
    metadata: input.metadata ?? {},
  });

  await eventRepo.append({
    type: 'artifact.created',
    payload: {
      artifact_id: created.id,
      project_id: created.project_id,
      task_id: created.task_id,
      kind: created.kind,
      title: created.title,
    },
  });

  return created;
}

type ArtifactRow = Awaited<ReturnType<typeof artifactRepo.getById>>;

export async function readArtifactContent(row: NonNullable<ArtifactRow>): Promise<Buffer> {
  return getStorage().get(row.storage_key);
}

export async function getArtifactUrl(row: NonNullable<ArtifactRow>): Promise<string> {
  return getStorage().getUrl(row.storage_key);
}
