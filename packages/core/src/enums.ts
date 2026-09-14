export const TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'blocked',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const RUN_TRIGGERS = ['task', 'mention', 'schedule', 'human'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

// 'waiting_human' is a run that called `ask_human` and is parked until the
// owner answers via the Inbox - see @katnor/agents' ask_human tool and
// apps/server's approvals router. It is distinct from 'running' (actively
// generating) and not a failure.
export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting_human',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STEP_KINDS = [
  'llm_call',
  'tool_call',
  'tool_result',
  'message',
  'thinking_summary',
] as const;
export type RunStepKind = (typeof RUN_STEP_KINDS)[number];

export const CHANNEL_KINDS = ['project', 'team', 'dm', 'task_thread', 'general'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const AUTHOR_TYPES = ['agent', 'human'] as const;
export type AuthorType = (typeof AUTHOR_TYPES)[number];

export const ARTIFACT_KINDS = [
  'file',
  'diff',
  'pr',
  'doc',
  'image',
  'design',
  'link',
  'report',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

// 'question' is Phase 1's `ask_human` tool: the Inbox page (PLAN.md 4.9)
// deliberately shows pending approvals and pending questions together, so
// both are modeled as `approval` rows rather than as two separate tables -
// see @katnor/core's askHumanPayloadSchema in schemas/approval.ts.
export const APPROVAL_KINDS = ['hire', 'tool_call', 'spend', 'question'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const TOOL_CONFIG_KINDS = ['mcp', 'builtin'] as const;
export type ToolConfigKind = (typeof TOOL_CONFIG_KINDS)[number];

export const AGENT_STATUSES = ['active', 'paused', 'offline'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const MODEL_PROVIDERS = [
  'anthropic',
  'openai_compatible',
  'google',
  'ollama',
  'combo',
] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/**
 * The `ModelProvider` values a `model_combo` entry (@katnor/core's
 * schemas/modelCombo.ts) can point at - every real provider except
 * `"combo"` itself, so a combo can never nest another combo (no cycles,
 * no "which one actually answered" ambiguity to chase through more than
 * one level). Hand-maintained rather than derived from `MODEL_PROVIDERS`
 * by filtering, so `z.enum(...)` gets the literal tuple type it needs -
 * keep in sync by hand if a new provider is ever added above.
 */
export const MODEL_COMBO_ENTRY_PROVIDERS = [
  'anthropic',
  'openai_compatible',
  'google',
  'ollama',
] as const;
export type ModelComboEntryProvider = (typeof MODEL_COMBO_ENTRY_PROVIDERS)[number];
