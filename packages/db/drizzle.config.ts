import { defineConfig } from 'drizzle-kit';

/**
 * Read inline (no ./src/* import): drizzle-kit loads this config through
 * CJS resolution, where a `.js`-suffixed import of a `.ts` source file
 * fails with "Cannot find module". DATABASE_URL must already be in the
 * environment (export it from the repo-root .env before running).
 */
function getDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value || value.trim().length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env at the repo root, ' +
        'export it (set -a; . ./.env; set +a), then retry.',
    );
  }
  return value;
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: getDatabaseUrl(),
  },
});
