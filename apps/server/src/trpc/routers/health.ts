import { publicProcedure, router } from '../trpc.js';

export const healthRouter = router({
  /**
   * Liveness check. Returns an ISO-8601 string (not a `Date`) since tRPC
   * v10's default JSON transport doesn't round-trip `Date` on its own and
   * this app doesn't use a `superjson`-style transformer (see the note in
   * src/trpc/router.ts).
   */
  ping: publicProcedure.query(() => ({ ok: true as const, time: new Date().toISOString() })),
});
