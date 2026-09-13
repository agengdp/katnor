import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';
import { db, type Database } from '@katnor/db';
import type PgBoss from 'pg-boss';
import { boss } from '../boss.js';
import { readCookie, SESSION_COOKIE_NAME, verifySessionToken } from '../auth.js';

export interface Session {
  authenticated: boolean;
  /**
   * The logged-in user's id, or `null` when `authenticated` is false. Set
   * together - never `authenticated: true` with a `null` userId or vice
   * versa.
   */
  userId: string | null;
}

export interface Context {
  /** The shared @katnor/db drizzle client - every procedure's DB access goes through this. */
  db: Database;
  /** The shared pg-boss client - procedures that trigger a run (messages.send, tasks.update, approvals.decide) send through this. */
  boss: PgBoss;
  session: Session;
  /**
   * The outgoing response's mutable header bag, supplied by tRPC's fetch
   * adapter (see src/index.ts, which mounts that adapter on `/trpc/*`).
   * Procedures that need to set a cookie (auth.login, auth.logout in
   * src/trpc/routers/auth.ts) append to this directly, since there is no
   * Hono `Context` available inside a tRPC procedure.
   */
  resHeaders: Headers;
}

/**
 * Builds the per-request tRPC context: the shared `db` client, the caller's
 * auth state (derived from the `katnor_session` cookie, if any), and the
 * response header bag for procedures that need to set/clear that cookie.
 *
 * This is passed as `createContext` to `@trpc/server/adapters/fetch`'s
 * `fetchRequestHandler` in src/index.ts, so `opts.req` is a standard Fetch
 * API `Request` (Hono's `c.req.raw`) - hence reading the cookie header via
 * `req.headers.get('cookie')` rather than any Hono-specific cookie helper.
 */
export function createContext({ req, resHeaders }: FetchCreateContextFnOptions): Context {
  const token = readCookie(req.headers.get('cookie'), SESSION_COOKIE_NAME);
  const userId = verifySessionToken(token);
  return { db, boss, session: { authenticated: userId !== null, userId }, resHeaders };
}
