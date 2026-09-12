import { pgEnum } from 'drizzle-orm/pg-core';
import {
  AGENT_STATUSES,
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  ARTIFACT_KINDS,
  AUTHOR_TYPES,
  CHANNEL_KINDS,
  MODEL_PROVIDERS,
  RUN_STATUSES,
  RUN_STEP_KINDS,
  RUN_TRIGGERS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TOOL_CONFIG_KINDS,
} from '@katnor/core';

/**
 * Postgres enum types, one per fixed-vocabulary column in the domain model.
 * The set of allowed values is imported from `@katnor/core`'s enum arrays
 * (the single source of truth for *which values are valid*), while this
 * package remains the source of truth for *how they are stored*.
 *
 * Columns whose allowed values are open-ended, or expected to grow without
 * a schema migration, are intentionally left as plain `text` columns
 * instead of a pgEnum - see the comment at each such column in its schema
 * file (e.g. `kg_node.type`, `kg_edge.type`, `event.type`,
 * `task.created_by`).
 */
export const agentStatusEnum = pgEnum('agent_status', AGENT_STATUSES);
export const approvalKindEnum = pgEnum('approval_kind', APPROVAL_KINDS);
export const approvalStatusEnum = pgEnum('approval_status', APPROVAL_STATUSES);
export const artifactKindEnum = pgEnum('artifact_kind', ARTIFACT_KINDS);
export const authorTypeEnum = pgEnum('author_type', AUTHOR_TYPES);
export const channelKindEnum = pgEnum('channel_kind', CHANNEL_KINDS);
export const modelProviderEnum = pgEnum('model_provider', MODEL_PROVIDERS);
export const runStatusEnum = pgEnum('run_status', RUN_STATUSES);
export const runStepKindEnum = pgEnum('run_step_kind', RUN_STEP_KINDS);
export const runTriggerEnum = pgEnum('run_trigger', RUN_TRIGGERS);
export const taskPriorityEnum = pgEnum('task_priority', TASK_PRIORITIES);
export const taskStatusEnum = pgEnum('task_status', TASK_STATUSES);
export const toolConfigKindEnum = pgEnum('tool_config_kind', TOOL_CONFIG_KINDS);
