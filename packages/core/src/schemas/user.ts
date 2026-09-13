import { z } from 'zod';
import { withBase } from './base.js';

/**
 * A human who can log in (PLAN.md Phase 5's "multi-user auth"). Deliberately
 * flat - no role/permission field: every logged-in user has the same access
 * as every other (the same access "the owner" had in the single-user
 * scheme this replaces). PLAN.md never specifies a permission hierarchy
 * beyond "logged in or not," so this doesn't invent one; a role field is a
 * natural later addition if that's ever needed, not something this pass
 * builds speculatively.
 */
export const userFields = {
  name: z.string().min(1),
  email: z.string().email(),
  // scrypt hash, "<saltHex>:<hashHex>" - see @katnor/db's crypto.ts
  // hashPassword/verifyPassword. Never sent to the client - see
  // publicUserSchema below, which every API response actually uses.
  password_hash: z.string(),
};

export const userSchema = withBase(userFields);
export type User = z.infer<typeof userSchema>;

/**
 * What a caller supplies to create an account - a raw password, hashed
 * application-side before storage.
 */
export const createUserInputSchema = z.object({
  name: userFields.name,
  email: userFields.email,
  password: z.string().min(8),
});
export type CreateUserInput = z.infer<typeof createUserInputSchema>;

/** The shape it's safe to send to the client - omits `password_hash` unconditionally. */
export const publicUserSchema = userSchema.omit({ password_hash: true });
export type PublicUser = z.infer<typeof publicUserSchema>;
