import { z } from 'zod';
import { APPROVAL_KINDS, APPROVAL_STATUSES } from '../enums.js';
import { withBase } from './base.js';

export const approvalFields = {
  // The run whose tool call raised this approval/question - e.g. the CEO's
  // `hire_agent` call, or any agent's `ask_human` call. Every approval in
  // v1 originates from an in-flight run, so this is required, not optional.
  run_id: z.string(),
  kind: z.enum(APPROVAL_KINDS),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(APPROVAL_STATUSES),
  decided_by: z.string().nullable(),
  decided_at: z.date().nullable(),
};

export const approvalSchema = withBase(approvalFields);
export type Approval = z.infer<typeof approvalSchema>;

/**
 * A caller only proposes what needs approval; status and the decision
 * (decided_by/decided_at) are filled in once a human or policy decides.
 */
export const createApprovalInputSchema = z.object({
  run_id: approvalFields.run_id,
  kind: approvalFields.kind,
  payload: approvalFields.payload,
  status: approvalFields.status.default('pending'),
});
export type CreateApprovalInput = z.infer<typeof createApprovalInputSchema>;

/**
 * The shape `approval.payload` takes for `kind: "question"` (the
 * `ask_human` tool). `answer` is absent until a human decides it via the
 * Inbox (apps/server's approvals router), which fills it in alongside
 * `status: "approved"` - there is no separate "answered" status; a
 * question's `status` stays within the same pending/approved/rejected
 * vocabulary as every other approval kind, with "rejected" standing in for
 * "the human declined to answer."
 */
export const askHumanPayloadSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
  answer: z.string().optional(),
});
export type AskHumanPayload = z.infer<typeof askHumanPayloadSchema>;

/** The shape `approval.payload` takes for `kind: "hire"` - see the `hire_agent` tool. */
export const hireApprovalPayloadSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  persona: z.object({
    bio: z.string(),
    personality: z.string(),
    strengths: z.array(z.string()),
    style: z.string(),
  }),
  system_prompt: z.string(),
  avatar: z.string(),
  model: z.object({
    provider: z.string(),
    model: z.string(),
    effort: z.string(),
    thinking_display: z.string(),
    max_tokens: z.number().int().positive(),
  }),
  tools: z.array(z.string()),
  reports_to: z.string().nullable(),
  team_id: z.string().nullable(),
});
export type HireApprovalPayload = z.infer<typeof hireApprovalPayloadSchema>;

/**
 * The shape `approval.payload` takes for `kind: "tool_call"` - a dangerous
 * work-tool action (currently just the `shell` tool's `git push` detection
 * - see @katnor/agents/src/workTools.ts) gated by
 * `company.settings.approval_policy.tool_call` (PLAN.md 4.2's "approval
 * gates for pushes"). `project_id` is null when the run isn't scoped to a
 * project; `"ask_once_per_project"` policy is implemented by checking for a
 * prior *approved* `tool_call` approval with the same `tool_name` and
 * `project_id` before asking again.
 */
export const toolCallApprovalPayloadSchema = z.object({
  tool_name: z.string().min(1),
  project_id: z.string().nullable(),
  summary: z.string(),
});
export type ToolCallApprovalPayload = z.infer<typeof toolCallApprovalPayloadSchema>;

/**
 * The shape `approval.payload` takes for `kind: "spend"` - raised when
 * @katnor/agents' runExecutor.ts's `checkBudgetHardStop` finds a run that
 * would push the company, the agent, or the project over its daily USD
 * budget, gated by `company.settings.approval_policy.spend` (PLAN.md
 * Phase 5's budget hard stops). `scope` says which cap was hit; `project_id`
 * is null when the run isn't scoped to a project - same
 * `"ask_once_per_project"` convention as `toolCallApprovalPayloadSchema`
 * above (checking for a prior *approved* `spend` approval with the same
 * `project_id`, regardless of `scope`, before asking again).
 */
export const spendApprovalPayloadSchema = z.object({
  scope: z.enum(['company', 'agent', 'project']),
  agent_id: z.string(),
  project_id: z.string().nullable(),
  summary: z.string(),
});
export type SpendApprovalPayload = z.infer<typeof spendApprovalPayloadSchema>;
