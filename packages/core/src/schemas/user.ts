import { z } from 'zod';
import { withBase } from './base.js';

/**
 * The single human who can log in. Single-user by design: one Katnor
 * install has exactly one account, created once at setup, that logs in
 * with only a passcode - no email, no password. Deliberately flat: no
 * role/permission field, because with one user there is nobody to
 * distinguish from.
 */
export const userFields = {
  name: z.string().min(1),
  // scrypt hash, "<saltHex>:<hashHex>" - see @katnor/db's crypto.ts
  // hashPassword/verifyPassword, applied to the passcode. Never sent to
  // the client - see publicUserSchema below, which every API response
  // actually uses.
  password_hash: z.string(),
};

export const userSchema = withBase(userFields);
export type User = z.infer<typeof userSchema>;

/**
 * What setup supplies to create the single account - a display name and a
 * raw passcode, the latter hashed application-side before storage.
 */
export const createUserInputSchema = z.object({
  name: userFields.name,
  passcode: z.string().min(4),
});
export type CreateUserInput = z.infer<typeof createUserInputSchema>;

/** The shape it's safe to send to the client - omits `password_hash` unconditionally. */
export const publicUserSchema = userSchema.omit({ password_hash: true });
export type PublicUser = z.infer<typeof publicUserSchema>;
