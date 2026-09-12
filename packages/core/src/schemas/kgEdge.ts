import { z } from 'zod';
import { withBase } from './base.js';

export const kgEdgeEvidenceSchema = z.object({
  kind: z.enum(['run', 'artifact', 'message']),
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
