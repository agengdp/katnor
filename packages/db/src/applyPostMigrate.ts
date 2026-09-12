/**
 * Runs the one-off, idempotent SQL that drizzle-kit's migrations don't
 * (and shouldn't) own, because it isn't a table/column change:
 *
 *   1. `CREATE EXTENSION IF NOT EXISTS vector;` - required before any
 *      `vector(n)` column (kg_node.embedding, wiki_page.embedding) can be
 *      used. Must run before everything else below.
 *   2. A `katnor_notify_event()` plpgsql function that `pg_notify`s the
 *      `katnor_events` channel with the inserted row as JSON.
 *   3. A trigger on the `event` table that calls that function
 *      `AFTER INSERT`, so every appended event is broadcast live - see
 *      src/listen.ts for the subscriber side.
 *
 * Run this after `db:migrate`, e.g.:
 *   pnpm db:generate && pnpm db:migrate && pnpm db:post-migrate
 *
 * Every statement here is written to be safe to run repeatedly (CREATE
 * EXTENSION IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF
 * EXISTS + CREATE TRIGGER).
 */
import { client } from './client.js';

async function main() {
  console.log('[applyPostMigrate] CREATE EXTENSION IF NOT EXISTS vector;');
  await client`CREATE EXTENSION IF NOT EXISTS vector;`;

  console.log('[applyPostMigrate] CREATE OR REPLACE FUNCTION katnor_notify_event();');
  await client`
    CREATE OR REPLACE FUNCTION katnor_notify_event() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('katnor_events', row_to_json(NEW)::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `;

  console.log('[applyPostMigrate] DROP TRIGGER IF EXISTS katnor_event_notify ON "event";');
  await client`DROP TRIGGER IF EXISTS katnor_event_notify ON "event";`;

  console.log('[applyPostMigrate] CREATE TRIGGER katnor_event_notify ON "event";');
  await client`
    CREATE TRIGGER katnor_event_notify
    AFTER INSERT ON "event"
    FOR EACH ROW
    EXECUTE FUNCTION katnor_notify_event();
  `;

  console.log('[applyPostMigrate] done: vector extension ensured, event notify trigger installed.');
  await client.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[applyPostMigrate] failed:', err);
  await client.end({ timeout: 1 });
  process.exit(1);
});
