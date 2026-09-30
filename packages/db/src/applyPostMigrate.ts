/**
 * Runs the one-off, idempotent SQL that drizzle-kit's migrations don't
 * (and shouldn't) own, because it isn't a table/column change:
 *
 *   1. A `katnor_notify_event()` plpgsql function that `pg_notify`s the
 *      `katnor_events` channel with the inserted row as JSON.
 *   2. A trigger on the `event` table that calls that function
 *      `AFTER INSERT`, so every appended event is broadcast live - see
 *      src/listen.ts for the subscriber side.
 *
 * Both of these need the `event` table to exist, so this runs AFTER the
 * migrations. `CREATE EXTENSION vector` used to be the first statement
 * here and has moved to ./applyPreMigrate.ts - it has the opposite
 * requirement (the migrations cannot run without it), and having both
 * halves in one after-the-fact script made the whole chain impossible to
 * satisfy on a fresh database. See that file for the full story.
 *
 * The chain is: generate -> pre-migrate -> migrate -> post-migrate ->
 * (the setup wizard, or db:seed).
 *
 * Every statement here is written to be safe to run repeatedly (CREATE OR
 * REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE TRIGGER).
 */
import { client } from './client.js';

async function main() {
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

  console.log('[applyPostMigrate] done: event notify trigger installed.');
  await client.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[applyPostMigrate] failed:', err);
  await client.end({ timeout: 1 });
  process.exit(1);
});
