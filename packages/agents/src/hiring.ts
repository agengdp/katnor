import type {
  HireApprovalPayload,
  ModelEffort,
  ModelProvider,
  ThinkingDisplayMode,
} from '@katnor/core';
import { agentRepo, eventRepo } from '@katnor/db';

/**
 * Actually creates the `agent` row (and emits `agent.hired`) from a
 * validated `HireApprovalPayload`. Shared by two callers: `hire_agent`
 * (./orgTools.ts) when the company's hire approval policy is "auto", and
 * apps/server's approvals router when a human approves a pending hire
 * request through the Inbox - both need the exact same "turn a payload
 * into a real employee" logic.
 *
 * The payload's `model.*` fields arrive as plain strings (see
 * `hireApprovalPayloadSchema` in @katnor/core) because a pending approval
 * has to survive a round trip through jsonb storage; ./orgTools.ts's
 * `hire_agent` validates them against the real enums *before* ever storing
 * a payload (approved or pending), so casting them back here is safe.
 */
export async function createAgentFromPayload(payload: HireApprovalPayload) {
  const created = await agentRepo.create({
    name: payload.name,
    title: payload.title,
    persona: payload.persona,
    system_prompt: payload.system_prompt,
    avatar: payload.avatar,
    reports_to: payload.reports_to,
    team_id: payload.team_id,
    model_config: {
      provider: payload.model.provider as ModelProvider,
      model: payload.model.model,
      effort: payload.model.effort as ModelEffort,
      thinking_display: payload.model.thinking_display as ThinkingDisplayMode,
      max_tokens: payload.model.max_tokens,
    },
    tool_allowlist: payload.tools,
    status: 'active',
    // A modest per-hire default; the owner can raise it from the Team page's agent editor.
    budget_daily_usd: '10',
    is_system: false,
  });
  await eventRepo.append({
    type: 'agent.hired',
    payload: { agent_id: created.id, name: created.name, title: created.title },
  });
  return created;
}
