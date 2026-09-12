import { z } from 'zod';
import {
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  ARTIFACT_KINDS,
  AUTHOR_TYPES,
  RUN_STATUSES,
  RUN_STEP_KINDS,
  RUN_TRIGGERS,
  TASK_STATUSES,
} from './enums.js';

/**
 * The append-only `event` table's payload, keyed by `type`. This is the
 * shape published on the event bus and consumed by the office, the
 * dashboard's live views, and the Librarian.
 */

const agentHiredEvent = z.object({
  type: z.literal('agent.hired'),
  agent_id: z.string(),
  name: z.string(),
  title: z.string(),
});

const agentUpdatedEvent = z.object({
  type: z.literal('agent.updated'),
  agent_id: z.string(),
  updated_fields: z.array(z.string()),
});

const agentFiredEvent = z.object({
  type: z.literal('agent.fired'),
  agent_id: z.string(),
});

const taskCreatedEvent = z.object({
  type: z.literal('task.created'),
  task_id: z.string(),
  project_id: z.string(),
  title: z.string(),
});

const taskUpdatedEvent = z.object({
  type: z.literal('task.updated'),
  task_id: z.string(),
  project_id: z.string(),
  status: z.enum(TASK_STATUSES),
  assignee_id: z.string().nullable(),
});

const messagePostedEvent = z.object({
  type: z.literal('message.posted'),
  message_id: z.string(),
  channel_id: z.string(),
  author_type: z.enum(AUTHOR_TYPES),
  author_id: z.string(),
  mentions: z.array(z.string()),
});

const runStartedEvent = z.object({
  type: z.literal('run.started'),
  run_id: z.string(),
  agent_id: z.string(),
  task_id: z.string().nullable(),
  trigger: z.enum(RUN_TRIGGERS),
});

const runStepRecordedEvent = z.object({
  type: z.literal('run.step_recorded'),
  run_id: z.string(),
  run_step_id: z.string(),
  seq: z.number().int().nonnegative(),
  kind: z.enum(RUN_STEP_KINDS),
});

const runFinishedEvent = z.object({
  type: z.literal('run.finished'),
  run_id: z.string(),
  agent_id: z.string(),
  status: z.enum(RUN_STATUSES),
  cost_usd: z.number().nonnegative(),
});

const artifactCreatedEvent = z.object({
  type: z.literal('artifact.created'),
  artifact_id: z.string(),
  project_id: z.string().nullable(),
  task_id: z.string().nullable(),
  kind: z.enum(ARTIFACT_KINDS),
  title: z.string(),
});

const approvalRequestedEvent = z.object({
  type: z.literal('approval.requested'),
  approval_id: z.string(),
  kind: z.enum(APPROVAL_KINDS),
});

const approvalDecidedEvent = z.object({
  type: z.literal('approval.decided'),
  approval_id: z.string(),
  kind: z.enum(APPROVAL_KINDS),
  status: z.enum(APPROVAL_STATUSES),
  decided_by: z.string().nullable(),
});

const kgNodeUpsertedEvent = z.object({
  type: z.literal('kg_node.upserted'),
  kg_node_id: z.string(),
  project_id: z.string().nullable(),
  node_type: z.string(),
  name: z.string(),
});

const wikiPageUpdatedEvent = z.object({
  type: z.literal('wiki_page.updated'),
  wiki_page_id: z.string(),
  project_id: z.string(),
  path: z.string(),
});

export const eventPayloadSchema = z.discriminatedUnion('type', [
  agentHiredEvent,
  agentUpdatedEvent,
  agentFiredEvent,
  taskCreatedEvent,
  taskUpdatedEvent,
  messagePostedEvent,
  runStartedEvent,
  runStepRecordedEvent,
  runFinishedEvent,
  artifactCreatedEvent,
  approvalRequestedEvent,
  approvalDecidedEvent,
  kgNodeUpsertedEvent,
  wikiPageUpdatedEvent,
]);

export type EventPayload = z.infer<typeof eventPayloadSchema>;

export const EVENT_TYPES = [
  'agent.hired',
  'agent.updated',
  'agent.fired',
  'task.created',
  'task.updated',
  'message.posted',
  'run.started',
  'run.step_recorded',
  'run.finished',
  'artifact.created',
  'approval.requested',
  'approval.decided',
  'kg_node.upserted',
  'wiki_page.updated',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** The union of all possible event payload shapes, discriminated by `type`. */
export type Event = z.infer<typeof eventPayloadSchema>;
