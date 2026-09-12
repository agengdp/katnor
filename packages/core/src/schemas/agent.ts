import { z } from 'zod';
import { AGENT_STATUSES } from '../enums.js';
import { withBase } from './base.js';
import { modelConfigSchema } from './modelConfig.js';

export const agentPersonaSchema = z.object({
  bio: z.string(),
  personality: z.string(),
  strengths: z.array(z.string()),
  style: z.string(),
});
export type AgentPersona = z.infer<typeof agentPersonaSchema>;

export const agentFields = {
  name: z.string().min(1),
  title: z.string().min(1),
  persona: agentPersonaSchema,
  system_prompt: z.string(),
  avatar: z.string(),
  reports_to: z.string().nullable(),
  team_id: z.string().nullable(),
  model_config: modelConfigSchema,
  tool_allowlist: z.array(z.string()),
  status: z.enum(AGENT_STATUSES),
  budget_daily_usd: z.number().nonnegative(),
  is_system: z.boolean(),
};

export const agentSchema = withBase(agentFields);
export type Agent = z.infer<typeof agentSchema>;

export const createAgentInputSchema = z.object({
  ...agentFields,
  reports_to: agentFields.reports_to.optional(),
  team_id: agentFields.team_id.optional(),
  tool_allowlist: agentFields.tool_allowlist.default([]),
  status: agentFields.status.default('active'),
  budget_daily_usd: agentFields.budget_daily_usd.default(0),
  is_system: agentFields.is_system.default(false),
});
export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;
