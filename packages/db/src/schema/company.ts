import type { CompanySettings } from '@katnor/core';
import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';

/**
 * The company. Exactly one row is expected to exist in v1 - enforced at
 * the application layer (see src/repositories/company.ts's `getOrCreate`),
 * not by a database constraint.
 */
export const company = pgTable('company', {
  ...baseColumns,
  name: text('name').notNull(),
  // { default_model, budgets, approval_policy } - see CompanySettings in
  // @katnor/core. Typed as `Partial<CompanySettings>` rather than the full
  // required shape: src/seed.ts seeds this with @katnor/core's
  // DEFAULT_COMPANY_SETTINGS (a complete CompanySettings) so a fresh
  // install has sane values from the start, but the column itself stays
  // Partial because it's still possible for an older/hand-edited row to be
  // missing a key - every reader goes through
  // companyRepo.getSettings()/mergeCompanySettings() rather than assuming
  // every key is present.
  settings: jsonb('settings').$type<Partial<CompanySettings>>().notNull(),
});
