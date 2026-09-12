import { index, integer, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { agent } from './agent.js';
import { baseColumns } from './columns.js';
import { channel } from './channel.js';
import { runStatusEnum, runTriggerEnum } from './enums.js';
import { task } from './task.js';

/** A single execution of an agent's LLM run loop. */
export const run = pgTable(
  'run',
  {
    ...baseColumns,
    agent_id: text('agent_id')
      .notNull()
      .references(() => agent.id),
    task_id: text('task_id').references(() => task.id),
    // The channel whose message woke this run (a mention, a DM, or a task
    // thread post) - null for a trigger that isn't a message at all (e.g.
    // "schedule", or an approval decision). @katnor/agents' run executor
    // reads this to show "the message that woke you up" as working
    // context (PLAN.md 4.1's prompt layout, part 4) - without it, a run
    // triggered by chat would have no way to see the chat that triggered it.
    channel_id: text('channel_id').references(() => channel.id),
    trigger: runTriggerEnum('trigger').notNull(),
    status: runStatusEnum('status').notNull().default('queued'),
    started_at: timestamp('started_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    finished_at: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    tokens_in: integer('tokens_in').notNull().default(0),
    tokens_out: integer('tokens_out').notNull().default(0),
    cost_usd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    summary: text('summary'),
  },
  (table) => [
    index('run_agent_id_idx').on(table.agent_id),
    index('run_task_id_idx').on(table.task_id),
    index('run_channel_id_idx').on(table.channel_id),
    index('run_status_idx').on(table.status),
  ],
);
