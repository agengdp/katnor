import type { PublicUser } from '@katnor/core';
import { userRepo } from '@katnor/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { attemptLogin, serializeLogoutCookie, serializeSessionCookie } from '../../auth.js';
import { publicProcedure, router } from '../trpc.js';

function toPublicUser(row: NonNullable<Awaited<ReturnType<typeof userRepo.getById>>>): PublicUser {
  const { password_hash: _passwordHash, ...publicUser } = row;
  return publicUser;
}

export const authRouter = router({
  /**
   * Never throws - lets the web app render a logged-out state instead of
   * an error. `user` is looked up fresh on every call (not decoded from
   * the session token itself, which only carries the id) so a renamed
   * user or one removed since the token was issued is reflected
   * immediately, not just after the token expires.
   */
  me: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.session.userId) return { authenticated: false, user: null };
    const user = await userRepo.getById(ctx.session.userId);
    if (!user) return { authenticated: false, user: null };
    return { authenticated: true, user: toPublicUser(user) };
  }),

  login: publicProcedure
    .input(z.object({ email: z.string().email(), password: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const result = await attemptLogin(input.email, input.password);
      if (!result) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid email or password' });
      }
      // `resHeaders` is applied to the actual outgoing HTTP response by
      // tRPC's fetch adapter (see src/index.ts) - this is the tRPC
      // equivalent of Hono's `c.header(..., { append: true })`, used the
      // same way in src/auth.ts's plain `loginHandler`.
      ctx.resHeaders.append('set-cookie', serializeSessionCookie(result.token));
      return { ok: true as const, user: result.user };
    }),

  logout: publicProcedure.mutation(({ ctx }) => {
    ctx.resHeaders.append('set-cookie', serializeLogoutCookie());
    return { ok: true as const };
  }),
});
