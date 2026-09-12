import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { DATABASE_URL } from './env.js';
import * as schema from './schema/index.js';

/**
 * The raw `postgres` (postgres.js) client, exported alongside `db` so
 * one-off scripts (seed, post-migrate) can `await client.end()` when
 * they're done and let the process exit cleanly.
 */
export const client = postgres(DATABASE_URL);

/**
 * The app-wide drizzle db singleton, wired to the full schema module
 * (tables + relations) so relational queries
 * (`db.query.<table>.findMany({ with: {...} })`) are available, not just
 * the plain query builder.
 */
export const db = drizzle(client, { schema });

export type Database = typeof db;
