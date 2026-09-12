import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';
import { runStepKindEnum } from './enums.js';
import { run } from './run.js';

/** One step (LLM call, tool call/result, message, thinking summary) within a run's trace. */
export const runStep = pgTable(
  'run_step',
  {
    ...baseColumns,
    run_id: text('run_id')
      .notNull()
      .references(() => run.id),
    seq: integer('seq').notNull(),
    kind: runStepKindEnum('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    tokens: integer('tokens'),
    duration_ms: integer('duration_ms'),
  },
  (table) => [index('run_step_run_id_idx').on(table.run_id)],
);
