import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from './context.js';

/**
 * The single tRPC instance and procedure builders, kept in their own module
 * (rather than inline in router.ts) so router.ts and every file under
 * routers/*.ts can both import from here without a circular dependency:
 * router.ts imports the individual routers, and each of those routers
 * imports `router`/`publicProcedure`/`protectedProcedure` from here.
 */
const t = initTRPC.context<Context>().create();

export const router = t.router;
export const middleware = t.middleware;
export const publicProcedure = t.procedure;

/**
 * A procedure that 401s (as a `TRPCError`) unless the request carried a
 * valid `katnor_session` cookie. Used by every settings.* procedure - the
 * owner must be logged in to read or change provider configuration.
 */
export const protectedProcedure = publicProcedure.use(
  middleware(({ ctx, next }) => {
    if (!ctx.session.authenticated) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Owner login required' });
    }
    return next({ ctx });
  }),
);
