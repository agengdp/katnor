import {
  AGENT_STATUSES,
  MODEL_EFFORTS,
  MODEL_PROVIDERS,
  THINKING_DISPLAY_MODES,
} from '@katnor/core';
import { agentRepo, eventRepo } from '@katnor/db';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';

const modelConfigInputSchema = z.object({
  provider: z.enum(MODEL_PROVIDERS),
  model: z.string().min(1),
  effort: z.enum(MODEL_EFFORTS),
  thinking_display: z.enum(THINKING_DISPLAY_MODES),
  max_tokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2).optional(),
});

const personaInputSchema = z.object({
  bio: z.string(),
  personality: z.string(),
  strengths: z.array(z.string()),
  style: z.string(),
});

/**
 * The org chart and agent editor (PLAN.md 4.9's Team page) read/write
 * through this router. Reads are public (the office/team views render
 * without login, same as everything else that isn't a secret) but every
 * mutation is `protectedProcedure` - only the logged-in owner may hire,
 * edit, or fire anyone directly. Agents themselves hire/update/fire through
 * the `hire_agent`/`update_agent`/`fire_agent` tools (@katnor/agents), not
 * through this HTTP surface.
 */
export const agentsRouter = router({
  list: protectedProcedure.query(() => agentRepo.list()),

  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => agentRepo.getById(input.id)),

  /**
   * A manual hire from the dashboard - unlike the `hire_agent` tool, this
   * is never subject to the company's hire approval policy: a human acting
   * directly through the Team page IS the approval.
   */
  hire: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        title: z.string().min(1),
        persona: personaInputSchema,
        system_prompt: z.string(),
        avatar: z.string().default('default'),
        model: modelConfigInputSchema,
        tools: z.array(z.string()).default([]),
        reports_to: z.string().nullable().default(null),
        team_id: z.string().nullable().default(null),
      }),
    )
    .mutation(async ({ input }) => {
      const created = await agentRepo.create({
        name: input.name,
        title: input.title,
        persona: input.persona,
        system_prompt: input.system_prompt,
        avatar: input.avatar,
        reports_to: input.reports_to,
        team_id: input.team_id,
        model_config: input.model,
        tool_allowlist: input.tools,
        status: 'active',
        budget_daily_usd: '10',
        is_system: false,
      });
      await eventRepo.append({
        type: 'agent.hired',
        payload: { agent_id: created.id, name: created.name, title: created.title },
      });
      return created;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().optional(),
        persona: personaInputSchema.optional(),
        system_prompt: z.string().optional(),
        avatar: z.string().optional(),
        model: modelConfigInputSchema.optional(),
        tools: z.array(z.string()).optional(),
        status: z.enum(AGENT_STATUSES).optional(),
        budget_daily_usd: z.number().nonnegative().optional(),
        reports_to: z.string().nullable().optional(),
        team_id: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, model, tools, budget_daily_usd, ...rest } = input;
      const patch: Parameters<typeof agentRepo.update>[1] = { ...rest };
      if (model) patch.model_config = model;
      if (tools) patch.tool_allowlist = tools;
      if (budget_daily_usd !== undefined) patch.budget_daily_usd = String(budget_daily_usd);

      const updated = await agentRepo.update(id, patch);
      if (updated) {
        await eventRepo.append({
          type: 'agent.updated',
          payload: { agent_id: updated.id, updated_fields: Object.keys(patch) },
        });
      }
      return updated;
    }),

  fire: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const existing = await agentRepo.getById(input.id);
    if (!existing) return undefined;
    if (existing.is_system) {
      throw new Error('The CEO cannot be fired.');
    }
    const updated = await agentRepo.update(input.id, { status: 'offline' });
    await eventRepo.append({ type: 'agent.fired', payload: { agent_id: input.id } });
    return updated;
  }),
});
