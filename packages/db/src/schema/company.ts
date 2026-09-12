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
  // required shape: the company row is created up front (see src/seed.ts,
  // which seeds `{}`) before the onboarding flow has collected a default
  // model, budgets, or an approval policy, so an incomplete settings
  // object is a valid, expected state - "is the company fully onboarded"
  // is an application-level check, not a DB constraint.
  settings: jsonb('settings').$type<Partial<CompanySettings>>().notNull(),
});
