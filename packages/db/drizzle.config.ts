import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit's config. Note it reads `DATABASE_URL` itself rather than
 * importing `getDatabaseUrl` from ./src/env.ts, which is what it used to
 * do - and which meant `db:generate` had never once run successfully:
 *
 *   Reading config file '.../packages/db/drizzle.config.ts'
 *   Cannot find module './src/env.js'
 *
 * This package is ESM with `moduleResolution: NodeNext`, so its source
 * spells every relative import with a `.js` extension that TypeScript
 * resolves back to the `.ts` file. drizzle-kit loads this config by
 * transpiling it to CommonJS and `require`-ing it, and that `require`
 * resolves `./src/env.js` literally - against a file that does not exist
 * on disk.
 *
 * So the config stays standalone: a tool that loads this file through its
 * own loader, with its own module semantics, should not be coupled to the
 * package's ESM source. The duplicated env read below is three lines, and
 * it is the reason this works at all.
 */
function databaseUrl(): string {
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

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: databaseUrl(),
  },
});
