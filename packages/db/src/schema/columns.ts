import { text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Shared column set spread into every table in this schema:
 *
 *   - `id`: a text primary key. IDs are ULIDs (see ../ulid.ts) generated
 *     application-side before insert - Postgres never generates them, so
 *     there is no `.default(...)` here.
 *   - `created_at` / `updated_at`: timestamptz columns, defaulting to
 *     `now()` on insert. `updated_at` is NOT auto-touched on UPDATE by a
 *     trigger - callers (repositories) are responsible for setting it
 *     explicitly on update statements.
 *
 * Field names intentionally match the snake_case names used throughout
 * `@katnor/core`'s zod schemas (e.g. `created_at`, not `createdAt`), so a
 * row returned by drizzle can be passed straight into a core schema's
 * `.parse()` without a case-mapping step.
 */
export const baseColumns = {
  id: text('id').primaryKey(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
};
