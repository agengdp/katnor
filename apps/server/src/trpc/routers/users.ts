import type { PublicUser } from '@katnor/core';
import { hashPassword, userRepo, verifyPassword } from '@katnor/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';

type UserRow = NonNullable<Awaited<ReturnType<typeof userRepo.getById>>>;

function toPublicUser(row: UserRow): PublicUser {
  const { password_hash: _passwordHash, ...publicUser } = row;
  return publicUser;
}

async function requireSingleUser(): Promise<UserRow> {
  const row = await userRepo.getSingleUser();
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'No account exists yet - finish setup first.' });
  }
  return row;
}

/**
 * Single-user account management (Settings > Account). Every procedure
 * here requires being logged in already. There is exactly one account per
 * install - created once at setup - so there is no list/create/remove:
 * the owner can rename themselves and rotate their own passcode, and
 * changing the passcode requires proving the current one first.
 */
export const usersRouter = router({
  profile: protectedProcedure.query(async () => {
    return toPublicUser(await requireSingleUser());
  }),

  updateName: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(120) }))
    .mutation(async ({ input }) => {
      const current = await requireSingleUser();
      await userRepo.updateName(current.id, input.name);
      const updated = await requireSingleUser();
      return toPublicUser(updated);
    }),

  updatePasscode: protectedProcedure
    .input(
      z.object({
        currentPasscode: z.string().min(1),
        newPasscode: z.string().min(4),
      }),
    )
    .mutation(async ({ input }) => {
      const current = await requireSingleUser();
      if (!verifyPassword(input.currentPasscode, current.password_hash)) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Current passcode is wrong.' });
      }
      await userRepo.updatePasscodeHash(current.id, hashPassword(input.newPasscode));
      return { ok: true as const };
    }),
});
