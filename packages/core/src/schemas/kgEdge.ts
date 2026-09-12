import { z } from 'zod';
import { withBase } from './base.js';

export const kgEdgeEvidenceSchema = z.object({
  // 'system' is for edges a background job produces with no single
  // run/artifact/message behind it (e.g. @katnor/knowledge's code indexer -
  // `id` is then a short free-form job name like "code-indexer", not a
  // real row id).
  kind: z.enum(['run', 'artifact', 'message', 'system']),
  id: z.string(),
});
export type KgEdgeEvidence = z.infer<typeof kgEdgeEvidenceSchema>;

export const kgEdgeFields = {
  from_id: z.string(),
  to_id: z.string(),
  type: z.string(),
  weight: z.number().nullable(),
  evidence: kgEdgeEvidenceSchema,
};

export const kgEdgeSchema = withBase(kgEdgeFields);
export type KgEdge = z.infer<typeof kgEdgeSchema>;

export const createKgEdgeInputSchema = z.object({
  ...kgEdgeFields,
  weight: kgEdgeFields.weight.optional(),
});
export type CreateKgEdgeInput = z.infer<typeof createKgEdgeInputSchema>;
