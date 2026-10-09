import type { LegacyModelComboEntry, ModelEntry } from '@katnor/core';
import { eq } from 'drizzle-orm';
import { db } from '../client.js';
import { modelCombo } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type ModelComboRow = typeof modelCombo.$inferSelect;

/** A row's entries: new shape, or legacy `{provider, model}` pre-connections. */
export type StoredModelEntries = (ModelEntry | LegacyModelComboEntry)[];

export interface CreateModelComboInput {
  name: string;
  entries: ModelEntry[];
  strategy?: 'round_robin' | 'fallback' | 'router';
}

// New entries validate `model` trimmed-nonempty via the core schema, but
// a caller bypassing the Settings UI could still send padding - sanitize
// here so it never reaches a real provider API. Legacy entries pass
// through untouched (read-only compat, never rewritten on read).
function sanitizeEntries(entries: ModelEntry[]): ModelEntry[] {
  return entries.map((entry) => ({ ...entry, model: entry.model.trim() }));
}

export async function create(input: CreateModelComboInput): Promise<ModelComboRow> {
  const [created] = await db
    .insert(modelCombo)
    .values({
      id: ulid(),
      name: input.name.trim(),
      entries: sanitizeEntries(input.entries),
      strategy: input.strategy ?? 'fallback',
    })
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
  entries?: ModelEntry[];
  strategy?: 'round_robin' | 'fallback' | 'router';
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
      ...(patch.strategy !== undefined ? { strategy: patch.strategy } : {}),
      updated_at: new Date(),
    })
    .where(eq(modelCombo.id, id))
    .returning();
  return updated;
}

export async function remove(id: string): Promise<void> {
  await db.delete(modelCombo).where(eq(modelCombo.id, id));
}
