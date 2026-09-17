import type { CompanySettings } from '@katnor/core';
import { mergeCompanySettings } from '@katnor/core';
import { eq } from 'drizzle-orm';
import { db } from '../client.js';
import { company } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type CompanyRow = typeof company.$inferSelect;
export type CreateCompanyInput = Omit<
  typeof company.$inferInsert,
  'id' | 'created_at' | 'updated_at'
>;

/**
 * Returns the single company row, inserting it first (using `input`) if no
 * row exists yet. Exactly one row is expected to ever exist in v1; an
 * existing row is returned as-is and `input` is ignored in that case.
 */
export async function getOrCreate(input: CreateCompanyInput): Promise<CompanyRow> {
  const [existing] = await db.select().from(company).limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(company)
    .values({ id: ulid(), ...input })
    .returning();
  if (!created) {
    throw new Error('getOrCreate(company): insert returned no row');
  }
  return created;
}

/** The single company row, as-is (not defaulted) - throws if it doesn't exist yet. */
export async function get(): Promise<CompanyRow> {
  const [existing] = await db.select().from(company).limit(1);
  if (!existing) {
    throw new Error('get(company): no company row exists - run `pnpm db:seed` first');
  }
  return existing;
}

/**
 * The single company row's settings, fully defaulted via
 * `mergeCompanySettings` - safe to call even if the stored `settings` jsonb
 * is `{}` (Phase 0's seed) or missing individual keys. Throws if the
 * company row doesn't exist yet at all (it always should by the time
 * anything calls this - `db:seed` creates it).
 */
export async function getSettings(): Promise<CompanySettings> {
  const [existing] = await db.select().from(company).limit(1);
  if (!existing) {
    throw new Error('getSettings(company): no company row exists - run `pnpm db:seed` first');
  }
  return mergeCompanySettings(existing.settings);
}

/**
 * Merges `patch` into the company's settings, one top-level key at a time
 * (see `mergeCompanySettings`'s doc comment on why the merge isn't deeper
 * than that), and persists the fully-defaulted result - so after this call
 * `settings` is always a complete `CompanySettings`, never a partial one.
 */
export async function updateSettings(patch: Partial<CompanySettings>): Promise<CompanyRow> {
  const [existing] = await db.select().from(company).limit(1);
  if (!existing) {
    throw new Error('updateSettings(company): no company row exists - run `pnpm db:seed` first');
  }
  const merged = mergeCompanySettings({ ...mergeCompanySettings(existing.settings), ...patch });
  const [updated] = await db
    .update(company)
    .set({ settings: merged, updated_at: new Date() })
    .where(eq(company.id, existing.id))
    .returning();
  if (!updated) {
    throw new Error('updateSettings(company): update returned no row');
  }
  return updated;
}
