import { authRouter } from './routers/auth.js';
import { healthRouter } from './routers/health.js';
import { settingsRouter } from './routers/settings.js';
import { router } from './trpc.js';

// No `superjson` (or other) transformer is configured: it isn't in this
// phase's pinned dependency list, and nothing here needs to cross the wire
// as anything richer than plain JSON yet (see health.ping's comment for the
// one place that would otherwise want `Date` support). Add one here - and
// to the client in apps/web - together, if a later phase needs it.
export const appRouter = router({
  health: healthRouter,
  auth: authRouter,
  settings: settingsRouter,
});

/**
 * The router's type, with no runtime import of this file's dependencies -
 * this is what apps/web imports (`import type { AppRouter } from
 * '@katnor/server'`) to get a fully-typed tRPC client without pulling in
 * the server's actual code. See apps/web/src/lib/trpc.ts for where that
 * import currently stands in as `AppRouter = any` until this package is
 * wired up as a dependency there.
 */
export type AppRouter = typeof appRouter;
