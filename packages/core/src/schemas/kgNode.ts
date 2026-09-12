import { z } from 'zod';
import { withBase } from './base.js';

export const EMBEDDING_DIMENSIONS = 1536;

/** A pgvector(1536) embedding, or null when not yet computed. */
export const embeddingSchema = z.array(z.number()).length(EMBEDDING_DIMENSIONS).nullable();
export type Embedding = z.infer<typeof embeddingSchema>;

export const kgNodeFields = {
  project_id: z.string().nullable(),
  type: z.string(),
  name: z.string().min(1),
  summary: z.string().nullable(),
  properties: z.record(z.string(), z.unknown()),
  embedding: embeddingSchema,
};

export const kgNodeSchema = withBase(kgNodeFields);
export type KgNode = z.infer<typeof kgNodeSchema>;

export const createKgNodeInputSchema = z.object({
  ...kgNodeFields,
  project_id: kgNodeFields.project_id.optional(),
  summary: kgNodeFields.summary.optional(),
  properties: kgNodeFields.properties.default({}),
  embedding: kgNodeFields.embedding.optional(),
});
export type CreateKgNodeInput = z.infer<typeof createKgNodeInputSchema>;
