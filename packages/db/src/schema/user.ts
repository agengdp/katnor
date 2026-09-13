import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';

/**
 * A human who can log in (PLAN.md Phase 5's "multi-user auth" - see
 * @katnor/core's schemas/user.ts for why this has no role/permission
 * field). `email` is stored already lowercased/trimmed by
 * ../repositories/user.ts, so the unique index is a plain equality index
 * rather than needing a case-insensitive expression index.
 */
export const user = pgTable(
  'user',
  {
    ...baseColumns,
    name: text('name').notNull(),
    email: text('email').notNull(),
    // scrypt hash, "<saltHex>:<hashHex>" - see ../crypto.ts. Never selected
    // back to the client unmasked - every reader goes through
    // ../repositories/user.ts's shapes that omit it, or @katnor/core's
    // publicUserSchema.
    password_hash: text('password_hash').notNull(),
  },
  (table) => [uniqueIndex('user_email_idx').on(table.email)],
);
