import type { AgentPersona, ModelConfig } from '@katnor/core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { boolean, jsonb, numeric, pgTable, text } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';
import { agentStatusEnum } from './enums.js';
import { team } from './team.js';

/**
 * An employee of the company. The CEO is the one row with `is_system: true`
 * and `reports_to: null`.
 *
 * `reports_to` is a self-reference (the manager this agent reports to);
 * `team_id` and `team.lead_agent_id` are a mutual cross-table reference -
 * see the comment in ./team.ts for why the `(): AnyPgColumn =>` closure
 * form is used for both.
 */
export const agent = pgTable('agent', {
  ...baseColumns,
  name: text('name').notNull(),
  title: text('title').notNull(),
  // { bio, personality, strengths[], style } - see AgentPersona in @katnor/core.
  persona: jsonb('persona').$type<AgentPersona>().notNull(),
  system_prompt: text('system_prompt').notNull(),
  // Sprite id used by the 2D office view, not a URL.
  avatar: text('avatar').notNull(),
  reports_to: text('reports_to').references((): AnyPgColumn => agent.id),
  team_id: text('team_id').references((): AnyPgColumn => team.id),
  // { provider, model, effort, thinking_display, max_tokens, temperature? } - see
  // ModelConfig in @katnor/core.
  model_config: jsonb('model_config').$type<ModelConfig>().notNull(),
  tool_allowlist: jsonb('tool_allowlist').$type<string[]>().notNull().default([]),
  status: agentStatusEnum('status').notNull().default('active'),
  budget_daily_usd: numeric('budget_daily_usd', { precision: 12, scale: 4 })
    .notNull()
    .default('0'),
  is_system: boolean('is_system').notNull().default(false),
});
