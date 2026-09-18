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
 * valid `katnor_session` cookie.
 *
 * This is the default for the whole API: every procedure in every router
 * except `auth.*` and `health.ping` is built from this one. The app is
 * login-only - there is no anonymous read tier, so a reader needs a
 * session exactly as much as a writer does.
 *
 * `publicProcedure` above stays exported for the handful that cannot
 * require a session without a chicken-and-egg problem:
 *
 *   - `auth.login` is how a session is obtained in the first place.
 *   - `auth.me` is how the dashboard asks whether it has one; requiring a
 *     session to ask would make "logged out" indistinguishable from
 *     "server down".
 *   - `auth.logout` is idempotent and clears a cookie - 401ing a caller
 *     who is already logged out would be pure noise.
 *   - `health.ping` is for load balancers and uptime checks, which have no
 *     credentials and must not be given any.
 *
 * Anything else added later belongs on `protectedProcedure`. Login is
 * checked here rather than per-role: any logged-in user may use the whole
 * API (PLAN.md Phase 5's multi-user auth - see @katnor/core's
 * schemas/user.ts, which carries a role for future use but does not gate
 * on it yet).
 */
export const protectedProcedure = publicProcedure.use(
  middleware(({ ctx, next }) => {
    if (!ctx.session.authenticated) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Login required' });
    }
    return next({ ctx });
  }),
);
