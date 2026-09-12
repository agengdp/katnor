import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { agent } from './agent.js';
import { baseColumns } from './columns.js';

/**
 * `lead_agent_id` and `agent.team_id` form a mutual (cross-table) foreign
 * key reference. Both sides use the lazy-closure form of `.references()`
 * (`() => agent.id` / `() => team.id`, annotated `AnyPgColumn` to sidestep
 * the resulting circular type inference) - the same technique drizzle's own
 * docs use for a single self-referencing column, generalized to two tables
 * that reference each other. This is safe because `.references()` stores
 * the callback and only invokes it later (when FK metadata is actually
 * needed), never during the `pgTable()` call itself - so it does not matter
 * that `agent.ts` and `team.ts` import each other.
 */
export const team = pgTable('team', {
  ...baseColumns,
  name: text('name').notNull(),
  lead_agent_id: text('lead_agent_id').references((): AnyPgColumn => agent.id),
});
