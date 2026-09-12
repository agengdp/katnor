import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { attemptOwnerLogin, serializeLogoutCookie, serializeSessionCookie } from '../../auth.js';
import { publicProcedure, router } from '../trpc.js';

export const authRouter = router({
  /** Never throws - lets the web app render a logged-out state instead of an error. */
  me: publicProcedure.query(({ ctx }) => ({ authenticated: ctx.session.authenticated })),

  login: publicProcedure
    .input(z.object({ password: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      const token = attemptOwnerLogin(input.password);
      if (!token) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid password' });
      }
      // `resHeaders` is applied to the actual outgoing HTTP response by
      // tRPC's fetch adapter (see src/index.ts) - this is the tRPC
      // equivalent of Hono's `c.header(..., { append: true })`, used the
      // same way in src/auth.ts's plain `loginHandler`.
      ctx.resHeaders.append('set-cookie', serializeSessionCookie(token));
      return { ok: true as const };
    }),

  logout: publicProcedure.mutation(({ ctx }) => {
    ctx.resHeaders.append('set-cookie', serializeLogoutCookie());
    return { ok: true as const };
  }),
});
