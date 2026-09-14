import type { ModelComboEntry } from '@katnor/core';
import { eq } from 'drizzle-orm';
import { db } from '../client.js';
import { modelCombo } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type ModelComboRow = typeof modelCombo.$inferSelect;

export interface CreateModelComboInput {
  name: string;
  entries: ModelComboEntry[];
}

// `@katnor/core`'s modelComboEntrySchema validates `model` as a non-empty
// string but doesn't trim it (unlike `name`, trimmed both here and in
// apps/server's modelCombos router) - a caller that bypasses the Settings
// UI's own trimming and sends e.g. "gpt-4 " would otherwise have that
// padding stored and passed straight to the real provider's API, where
// it'd likely be rejected as an unknown model id.
function sanitizeEntries(entries: ModelComboEntry[]): ModelComboEntry[] {
  return entries.map((entry) => ({ ...entry, model: entry.model.trim() }));
}

export async function create(input: CreateModelComboInput): Promise<ModelComboRow> {
  const [created] = await db
    .insert(modelCombo)
    .values({ id: ulid(), name: input.name.trim(), entries: sanitizeEntries(input.entries) })
    .returning();
  if (!created) {
    throw new Error('create(modelCombo): insert returned no row');
  }
  return created;
}

export async function getById(id: string): Promise<ModelComboRow | undefined> {
  const [row] = await db.select().from(modelCombo).where(eq(modelCombo.id, id)).limit(1);
  return row;
}

export async function getByName(name: string): Promise<ModelComboRow | undefined> {
  const [row] = await db.select().from(modelCombo).where(eq(modelCombo.name, name)).limit(1);
  return row;
}

export async function list(): Promise<ModelComboRow[]> {
  return db.select().from(modelCombo);
}

export interface UpdateModelComboInput {
  name?: string;
  entries?: ModelComboEntry[];
}

export async function update(
  id: string,
  patch: UpdateModelComboInput,
): Promise<ModelComboRow | undefined> {
  const [updated] = await db
    .update(modelCombo)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.entries !== undefined ? { entries: sanitizeEntries(patch.entries) } : {}),
      updated_at: new Date(),
    })
    .where(eq(modelCombo.id, id))
    .returning();
  return updated;
}

export async function remove(id: string): Promise<void> {
  await db.delete(modelCombo).where(eq(modelCombo.id, id));
}
