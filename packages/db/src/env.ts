/**
 * Small env-reading helper shared by drizzle.config.ts, src/client.ts, and
 * every script in this package that needs a Postgres connection string.
 *
 * Kept dependency-free (no zod, no dotenv) so it can be imported from
 * drizzle-kit's config file without pulling in extra runtime behavior.
 */

/**
 * The Postgres connection string, e.g.
 * "postgresql://katnor:katnor@localhost:5432/katnor".
 *
 * Throws immediately (at import time of whichever module reads this) with a
 * clear message if DATABASE_URL is unset, rather than letting drizzle or
 * the postgres client fail later with a confusing connection error.
 */
export function getDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value || value.trim().length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env at the repo root and set ' +
        'DATABASE_URL (see docker-compose.yml for the local dev default: ' +
        'postgresql://katnor:katnor@localhost:5432/katnor).',
    );
  }
  return value;
}

export const DATABASE_URL = getDatabaseUrl();
