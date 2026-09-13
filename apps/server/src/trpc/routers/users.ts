import type { PublicUser } from '@katnor/core';
import { userRepo } from '@katnor/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';

type UserRow = NonNullable<Awaited<ReturnType<typeof userRepo.getById>>>;

function toPublicUser(row: UserRow): PublicUser {
  const { password_hash: _passwordHash, ...publicUser } = row;
  return publicUser;
}

/**
 * Settings > Team members (PLAN.md Phase 5's "multi-user auth"). Every
 * procedure here requires being logged in already - there's no self-serve
 * signup (see @katnor/db's src/seed.ts for how the very first account gets
 * created) - and, per @katnor/core's schemas/user.ts, no role/permission
 * tier beyond that: any logged-in user can add or remove another.
 */
export const usersRouter = router({
  list: protectedProcedure.query(async () => {
    const rows = await userRepo.list();
    return rows.map(toPublicUser);
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().email(),
        password: z.string().min(8),
      }),
    )
    .mutation(async ({ input }) => {
      const existing = await userRepo.getByEmail(input.email);
      if (existing) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `A user with email "${input.email}" already exists.`,
        });
      }
      const created = await userRepo.create(input);
      return toPublicUser(created);
    }),

  remove: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const all = await userRepo.list();
    if (all.length <= 1) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Cannot remove the last remaining user account - nobody could log in afterward.',
      });
    }
    if (!all.some((row) => row.id === input.id)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `No user "${input.id}".` });
    }
    await userRepo.remove(input.id);
    return { ok: true as const };
  }),
});
