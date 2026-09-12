import { z } from 'zod';
import { ARTIFACT_KINDS } from '../enums.js';
import { withBase } from './base.js';

export const artifactFields = {
  project_id: z.string().nullable(),
  task_id: z.string().nullable(),
  run_id: z.string().nullable(),
  artifact_group_id: z.string(),
  version: z.number().int().positive(),
  kind: z.enum(ARTIFACT_KINDS),
  title: z.string().min(1),
  storage_key: z.string(),
  mime: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
};

export const artifactSchema = withBase(artifactFields);
export type Artifact = z.infer<typeof artifactSchema>;

export const createArtifactInputSchema = z.object({
  ...artifactFields,
  project_id: artifactFields.project_id.optional(),
  task_id: artifactFields.task_id.optional(),
  run_id: artifactFields.run_id.optional(),
  // Defaults to a fresh group (this becomes version 1 of a new artifact)
  // when the caller isn't adding a version to an existing group.
  artifact_group_id: artifactFields.artifact_group_id.optional(),
  version: artifactFields.version.default(1),
  mime: artifactFields.mime.optional(),
  metadata: artifactFields.metadata.default({}),
});
export type CreateArtifactInput = z.infer<typeof createArtifactInputSchema>;
