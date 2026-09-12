import type { HireApprovalPayload } from '@katnor/core';
import { MODEL_EFFORTS, MODEL_PROVIDERS, THINKING_DISPLAY_MODES } from '@katnor/core';
import { agentRepo, approvalRepo, companyRepo, eventRepo, teamRepo } from '@katnor/db';
import type { ToolDefinition } from '@katnor/tools';
import type { AgentToolContext } from './context.js';
import { createAgentFromPayload } from './hiring.js';

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function strArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function record(input: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = input[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Hiring/org tools - CEO-only (`ceoOnly: true`), per PLAN.md 4.1: "The only
 * agent who can hire, update, or fire employees, form teams." Every other
 * agent works within the structure the CEO sets up.
 */
export const orgTools: ToolDefinition<AgentToolContext>[] = [
  {
    name: 'hire_agent',
    description:
      'Hire a new AI employee: a name, a persona, a model, and an allowlist of tools they can use. Subject to the company hire approval policy - it may need the owner to approve before the employee actually exists.',
    ceoOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        title: { type: 'string' },
        persona: {
          type: 'object',
          properties: {
            bio: { type: 'string' },
            personality: { type: 'string' },
            strengths: { type: 'array', items: { type: 'string' } },
            style: { type: 'string' },
          },
          required: ['bio', 'personality', 'strengths', 'style'],
        },
        system_prompt: { type: 'string' },
        avatar: { type: 'string', description: 'A sprite id for the 2D office; any short string is fine for now.' },
        model: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: [...MODEL_PROVIDERS] },
            model: { type: 'string' },
            effort: { type: 'string', enum: [...MODEL_EFFORTS] },
            thinking_display: { type: 'string', enum: [...THINKING_DISPLAY_MODES] },
            max_tokens: { type: 'number' },
          },
          required: ['provider', 'model', 'effort'],
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Company tool names this hire may use, e.g. ["send_message","read_channel","delegate_task"].',
        },
        reports_to: { type: 'string', description: 'Agent id this hire reports to. Defaults to you.' },
        team_id: { type: 'string' },
      },
      required: ['name', 'title', 'persona', 'system_prompt', 'model'],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const name = str(input, 'name');
      const title = str(input, 'title');
      const systemPrompt = str(input, 'system_prompt');
      const persona = record(input, 'persona');
      const modelInput = record(input, 'model');
      if (!name || !title || !systemPrompt || !persona || !modelInput) {
        return {
          content: 'hire_agent requires name, title, system_prompt, persona, and model.',
          isError: true,
        };
      }

      const bio = str(persona, 'bio');
      const personality = str(persona, 'personality');
      const style = str(persona, 'style');
      const strengths = strArray(persona, 'strengths');
      if (!bio || !personality || !style || strengths.length === 0) {
        return {
          content: 'hire_agent: persona requires bio, personality, style, and at least one strength.',
          isError: true,
        };
      }

      const provider = str(modelInput, 'provider');
      const modelId = str(modelInput, 'model');
      const effort = str(modelInput, 'effort');
      if (!provider || !(MODEL_PROVIDERS as readonly string[]).includes(provider)) {
        return { content: `hire_agent: model.provider must be one of ${MODEL_PROVIDERS.join(', ')}.`, isError: true };
      }
      if (!modelId) {
        return { content: 'hire_agent: model.model is required.', isError: true };
      }
      if (!effort || !(MODEL_EFFORTS as readonly string[]).includes(effort)) {
        return { content: `hire_agent: model.effort must be one of ${MODEL_EFFORTS.join(', ')}.`, isError: true };
      }
      const thinkingDisplayInput = str(modelInput, 'thinking_display');
      const thinkingDisplay = (THINKING_DISPLAY_MODES as readonly string[]).includes(thinkingDisplayInput ?? '')
        ? thinkingDisplayInput!
        : 'omitted';
      const maxTokensRaw = modelInput.max_tokens;
      const maxTokens = typeof maxTokensRaw === 'number' && maxTokensRaw > 0 ? maxTokensRaw : 8192;

      const toolsInput = strArray(input, 'tools');
      const reportsTo = str(input, 'reports_to') ?? ctx.agent.id;
      const teamId = str(input, 'team_id') ?? null;

      const payload: HireApprovalPayload = {
        name,
        title,
        persona: { bio, personality, strengths, style },
        system_prompt: systemPrompt,
        avatar: str(input, 'avatar') ?? 'default',
        model: { provider, model: modelId, effort, thinking_display: thinkingDisplay, max_tokens: maxTokens },
        tools: toolsInput,
        reports_to: reportsTo,
        team_id: teamId,
      };

      // "ask_once_per_project" doesn't map cleanly onto hiring (hires aren't
      // project-scoped), so it's treated the same as "always_ask" here -
      // only "auto" skips the approval step.
      const settings = await companyRepo.getSettings();
      if (settings.approval_policy.hire === 'auto') {
        const created = await createAgentFromPayload(payload);
        return { content: `Hired ${created.name} (${created.title}), id ${created.id}.` };
      }

      const created = await approvalRepo.create({ run_id: ctx.run.id, kind: 'hire', payload });
      await eventRepo.append({ type: 'approval.requested', payload: { approval_id: created.id, kind: 'hire' } });
      ctx.pauseRequested = { approvalId: created.id };
      return {
        content: `Hire request for ${name} sent to the owner for approval (pending id ${created.id}). Ending this turn - you'll be re-triggered once decided.`,
      };
    },
  },

  {
    name: 'update_agent',
    description: "Update a colleague's title, persona, system prompt, model, tool allowlist, or budget.",
    ceoOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        title: { type: 'string' },
        system_prompt: { type: 'string' },
        tools: { type: 'array', items: { type: 'string' } },
        budget_daily_usd: { type: 'number' },
      },
      required: ['agent_id'],
      additionalProperties: false,
    },
    async execute(input) {
      const agentId = str(input, 'agent_id');
      if (!agentId) {
        return { content: 'update_agent requires agent_id.', isError: true };
      }
      const existing = await agentRepo.getById(agentId);
      if (!existing) {
        return { content: `No agent "${agentId}".`, isError: true };
      }

      const patch: Parameters<typeof agentRepo.update>[1] = {};
      const title = str(input, 'title');
      if (title) patch.title = title;
      const systemPrompt = str(input, 'system_prompt');
      if (systemPrompt) patch.system_prompt = systemPrompt;
      if ('tools' in input) patch.tool_allowlist = strArray(input, 'tools');
      if (typeof input.budget_daily_usd === 'number') patch.budget_daily_usd = String(input.budget_daily_usd);

      const updated = await agentRepo.update(agentId, patch);
      if (!updated) {
        return { content: `Failed to update agent "${agentId}".`, isError: true };
      }
      await eventRepo.append({
        type: 'agent.updated',
        payload: { agent_id: updated.id, updated_fields: Object.keys(patch) },
      });
      return { content: `Updated ${updated.name}.` };
    },
  },

  {
    name: 'fire_agent',
    description: 'Fire a colleague. This sets them offline rather than deleting their history.',
    ceoOnly: true,
    inputSchema: {
      type: 'object',
      properties: { agent_id: { type: 'string' } },
      required: ['agent_id'],
      additionalProperties: false,
    },
    async execute(input) {
      const agentId = str(input, 'agent_id');
      if (!agentId) {
        return { content: 'fire_agent requires agent_id.', isError: true };
      }
      const existing = await agentRepo.getById(agentId);
      if (!existing) {
        return { content: `No agent "${agentId}".`, isError: true };
      }
      if (existing.is_system) {
        return { content: 'The CEO cannot fire themselves.', isError: true };
      }
      await agentRepo.update(agentId, { status: 'offline' });
      await eventRepo.append({ type: 'agent.fired', payload: { agent_id: agentId } });
      return { content: `${existing.name} is now offline.` };
    },
  },

  {
    name: 'create_team',
    description: 'Group existing employees into a named team, optionally with a lead.',
    ceoOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        lead_agent_id: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async execute(input) {
      const name = str(input, 'name');
      if (!name) {
        return { content: 'create_team requires name.', isError: true };
      }
      const created = await teamRepo.create({ name, lead_agent_id: str(input, 'lead_agent_id') ?? null });
      await eventRepo.append({ type: 'team.created', payload: { team_id: created.id, name: created.name } });
      return { content: `Created team "${created.name}" (${created.id}).` };
    },
  },
];
