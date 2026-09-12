import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';
import { approvalKindEnum, approvalStatusEnum } from './enums.js';
import { run } from './run.js';

export const approval = pgTable(
  'approval',
  {
    ...baseColumns,
    // The run whose tool call raised this - e.g. the CEO's `hire_agent`
    // call, or any agent's `ask_human` call. Every approval in v1
    // originates from an in-flight run.
    run_id: text('run_id')
      .notNull()
      .references(() => run.id),
    kind: approvalKindEnum('kind').notNull(),
    // The thing being approved (a proposed hire, tool call, or spend) -
    // shape depends on `kind`, so this is left as an open jsonb blob rather
    // than a pgEnum-discriminated set of columns.
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: approvalStatusEnum('status').notNull().default('pending'),
    // "human", or an agent id, once decided.
    decided_by: text('decided_by'),
    decided_at: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('approval_status_idx').on(table.status),
    index('approval_run_id_idx').on(table.run_id),
  ],
);
