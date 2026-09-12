import { createBossClient } from '@katnor/agents';

/**
 * The server's own pg-boss client, separate from apps/worker's - both
 * point at the same Postgres database and it's safe for each process to
 * have its own instance (see @katnor/agents' `createBossClient` doc
 * comment). The server only ever *sends* jobs (via tRPC mutations that
 * call `triggerRun`/`postMessage` when a human acts through the
 * dashboard) - it never calls `.work()` to consume them; that's
 * apps/worker's job.
 *
 * Top-level await is safe here (this package is ESM, "type": "module")
 * and keeps `boss` usable as a plain imported singleton everywhere else,
 * the same way `db` is imported from @katnor/db - see src/trpc/context.ts.
 */
export const boss = createBossClient();
await boss.start();
