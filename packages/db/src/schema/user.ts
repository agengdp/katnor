import { pgTable, text } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';

/**
 * The single human who can log in. Single-user by design - one row max,
 * authenticated by passcode only (PLAN.md's single-owner access).
 * `email` is gone: it was never used for anything but a login identifier,
 * and with no second user there is nothing to identify. The passcode's
 * scrypt hash lives in `password_hash` (name kept, so no data migration
 * beyond dropping the column - existing installs keep working login hash).
 */
export const user = pgTable('user', {
  ...baseColumns,
  name: text('name').notNull(),
  // scrypt hash, "<saltHex>:<hashHex>" - see ../crypto.ts. Never selected
  // back to the client unmasked - every reader goes through
  // ../repositories/user.ts's shapes that omit it, or @katnor/core's
  // publicUserSchema.
  password_hash: text('password_hash').notNull(),
});
