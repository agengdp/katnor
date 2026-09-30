/**
 * Installs the `vector` extension. Must run BEFORE `db:migrate`.
 *
 * This used to live at the top of ./applyPostMigrate.ts, which runs after
 * the migrations - and that ordering cannot work on a fresh database. The
 * generated migration creates `kg_node` and `wiki_page` with
 * `"embedding" vector(1536)` columns, and Postgres cannot parse the type
 * `vector` until the extension exists. So `db:migrate` failed on the very
 * first table that used it, on every genuinely fresh install:
 *
 *   type "vector" does not exist
 *
 * Nobody had seen it because `db:generate` had never worked either, so
 * `db:migrate` had only ever been handed an empty migration, which
 * trivially "succeeded".
 *
 * The chain is therefore: generate -> pre-migrate -> migrate ->
 * post-migrate -> (the setup wizard, or db:seed).
 *
 * Idempotent, like everything in this pair: `CREATE EXTENSION IF NOT
 * EXISTS` is safe to run on every deploy.
 */
import { client } from './client.js';

async function main() {
  console.log('[applyPreMigrate] CREATE EXTENSION IF NOT EXISTS vector;');
  await client`CREATE EXTENSION IF NOT EXISTS vector;`;

  console.log('[applyPreMigrate] done: pgvector is available, migrations can run.');
  await client.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[applyPreMigrate] failed:', err);
  await client.end({ timeout: 1 });
  process.exit(1);
});
