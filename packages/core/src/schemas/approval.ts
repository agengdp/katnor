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
