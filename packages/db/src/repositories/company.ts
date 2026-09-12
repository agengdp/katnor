import { db } from '../client.js';
import { company } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type CompanyRow = typeof company.$inferSelect;
export type CreateCompanyInput = Omit<typeof company.$inferInsert, 'id' | 'created_at' | 'updated_at'>;

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
