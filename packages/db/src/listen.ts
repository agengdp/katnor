/**
 * LISTEN/NOTIFY subscriber for the `katnor_events` Postgres channel (see
 * src/applyPostMigrate.ts for the trigger that publishes to it on every
 * insert into the `event` table).
 *
 * Driver choice: `pg` (node-postgres), not `postgres` (postgres.js) - even
 * though `postgres` is this package's main driver everywhere else (see
 * src/client.ts). `pg`'s LISTEN/NOTIFY surface
 * (`client.query('LISTEN <channel>')` + `client.on('notification', ...)`)
 * is small and has been stable for years; this file was written with no
 * registry access to install and double-check the exact shape of
 * postgres.js's own `.listen()` sugar (its return value, how you stop
 * listening, etc.) against the pinned `postgres@^3.4.5`. Rather than guess,
 * `pg` + `@types/pg` are added as a small, narrowly-scoped extra
 * dependency of this package just for this one file - see package.json.
 */
import { Client } from 'pg';
import { getDatabaseUrl } from './env.js';

const CHANNEL = 'katnor_events';

export interface EventSubscription {
  /** Stops listening and closes the dedicated connection. Safe to call once. */
  close(): Promise<void>;
}

/**
 * Opens a dedicated connection (separate from the pooled `client`/`db` in
 * ./client.ts - a connection doing `LISTEN` shouldn't also serve ordinary
 * queries), issues `LISTEN katnor_events`, and calls `onEvent` with the
 * JSON-parsed payload of every notification received (each payload is
 * `row_to_json(NEW)` from the `event` table row that was just inserted).
 */
export function subscribeToEvents(onEvent: (row: unknown) => void): EventSubscription {
  const client = new Client({ connectionString: getDatabaseUrl() });

  client.on('notification', (msg) => {
    if (msg.channel !== CHANNEL || msg.payload === undefined) return;
    try {
      onEvent(JSON.parse(msg.payload));
    } catch (err) {
      console.error(`[listen] failed to parse payload from "${CHANNEL}":`, err);
    }
  });

  client.on('error', (err) => {
    console.error(`[listen] connection error on "${CHANNEL}" listener:`, err);
  });

  const ready = client.connect().then(() => client.query(`LISTEN ${CHANNEL}`));
  // Attach a handler eagerly so a failed connect/LISTEN doesn't surface as
  // an unhandled promise rejection; `close()` below awaits the same
  // promise (with its own no-op catch) to shut down in an orderly way.
  ready.catch((err) => {
    console.error(`[listen] failed to start listening on "${CHANNEL}":`, err);
  });

  let closed = false;

  return {
    async close() {
      if (closed) return;
      closed = true;
      await ready.catch(() => undefined);
      await client.end();
    },
  };
}
