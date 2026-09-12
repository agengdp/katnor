import { z } from 'zod';

/**
 * Fields present on every persisted entity. Kept separate from the
 * per-entity field schemas so callers can compose them explicitly
 * (e.g. `withBase(taskFields)`) without repeating id/timestamp rules.
 */
export const baseFields = {
  id: z.string(),
  created_at: z.date(),
  updated_at: z.date(),
};

const baseSchema = z.object(baseFields);
export type BaseFields = z.infer<typeof baseSchema>;

/**
 * Merge an entity's own field shape with the shared base fields
 * (id, created_at, updated_at) into a single zod object schema.
 */
export function withBase<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object({ ...baseFields, ...shape });
}
