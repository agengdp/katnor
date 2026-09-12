import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';

/**
 * Append-only event log. Every insert here fires the `katnor_event_notify`
 * trigger (installed by src/applyPostMigrate.ts), which `pg_notify`s the
 * `katnor_events` channel so the server can fan events out over WebSocket -
 * see src/listen.ts.
 *
 * `type` is deliberately plain `text`, not a pgEnum: the set of event types
 * (see `EVENT_TYPES` / `EventPayload` in @katnor/core) is expected to grow
 * as features ship, and a pgEnum would require a migration for every new
 * event type. `payload`'s shape is keyed by `type` - see `EventPayload` in
 * @katnor/core for the discriminated union.
 *
 * `created_at` / `updated_at` come from the shared `baseColumns` (every
 * table carries them); `occurred_at` is the semantic event timestamp and is
 * expected to equal `created_at` in practice, since events are immutable
 * and never updated after insert.
 */
export const event = pgTable(
  'event',
  {
    ...baseColumns,
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurred_at: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('event_occurred_at_idx').on(table.occurred_at)],
);
