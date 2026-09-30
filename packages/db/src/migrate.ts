/**
 * Applies the committed SQL migrations in ../drizzle, using drizzle-orm's
 * own migrator.
 *
 * Why this exists next to `db:migrate` (which is `drizzle-kit migrate`):
 * deployment. A deployed stack is images and a compose file, with no
 * checkout, no pnpm and no drizzle-kit CLI on the host - so the schema has
 * to be brought up by something that runs inside the server image. That
 * image carries `drizzle-orm` (a runtime dependency) and `tsx`, which is
 * all this needs. drizzle-kit is a build-time tool that expects a config
 * file, a project layout and its own CLI; leaning on it at deploy time
 * means shipping the toolchain to production to run one statement set.
 *
 * Both paths apply the same files from the same folder and share
 * drizzle's `__drizzle_migrations` bookkeeping table, so it does not
 * matter which one ran first - neither re-applies what the other did.
 * Use `db:migrate` while developing (it sits right next to
 * `db:generate`), and this one in a container.
 *
 * The folder is resolved from this module's own location rather than from
 * `process.cwd()`: the migrate container runs with a working directory
 * that has no fixed relationship to this package.
 */
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { client, db } from './client.js';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

async function main() {
  console.log(`[migrate] applying migrations from ${MIGRATIONS_FOLDER}`);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  console.log('[migrate] done - schema is up to date.');
  await client.end();
  process.exit(0);
}

main().catch(async (err) => {
  // The most likely first failure is an empty or missing folder, which
  // means `pnpm db:generate` was never run and its output never
  // committed. Say so, rather than letting a bare ENOENT stand.
  console.error('[migrate] failed:', err);
  console.error(
    `[migrate] if ${MIGRATIONS_FOLDER} is missing or empty, run \`pnpm --filter @katnor/db db:generate\` ` +
      'and commit the result - deployed images carry the committed SQL, they do not generate it.',
  );
  await client.end({ timeout: 1 });
  process.exit(1);
});
