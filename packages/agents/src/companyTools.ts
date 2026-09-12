import type { ArtifactKind, AskHumanPayload, TaskPriority } from '@katnor/core';
import { ARTIFACT_KINDS, DEFAULT_BOARD_COLUMNS, TASK_PRIORITIES } from '@katnor/core';
import { saveArtifact } from '@katnor/artifacts';
import { agentRepo, approvalRepo, artifactRepo, channelRepo, eventRepo, messageRepo, projectRepo, taskRepo } from '@katnor/db';
import type { ToolDefinition } from '@katnor/tools';
import type { AgentToolContext } from './context.js';
import { postMessage } from './messaging.js';
import { slugify } from './slug.js';
import { triggerRun } from './trigger.js';

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function strArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Company tools: available to every agent (not just the CEO - see
 * ./orgTools.ts for the CEO-only hiring/org tools). Covers PLAN.md 4.1/4.2's
 * "messaging, tasks, ask_human" - `ask_colleague` and `request_review` from
 * PLAN.md 4.2's fuller design are out of scope for Phase 1 except
 * `ask_colleague`, included here as a thin, low-risk wrapper over the same
 * DM mechanism `send_message` already uses (`request_review` needs
 * artifacts, which don't exist as a real feature until Phase 2).
 */
export const companyTools: ToolDefinition<AgentToolContext>[] = [
  {
    name: 'send_message',
    description:
      'Post a message to a channel, or DM a colleague directly. Mentioning an agent id in `mentions` wakes them.',
    inputSchema: {
      type: 'object',
      properties: {
        target_type: { type: 'string', enum: ['channel', 'agent'] },
        target: {
          type: 'string',
          description: 'A channel id if target_type is "channel", or an agent id to DM if "agent".',
        },
        text: { type: 'string' },
        mentions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Agent ids to @mention in a channel message (ignored for a DM - the recipient always wakes).',
        },
      },
      required: ['target_type', 'target', 'text'],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const targetType = str(input, 'target_type');
      const target = str(input, 'target');
      const text = str(input, 'text');
      if (!targetType || !target || !text) {
        return { content: 'send_message requires target_type, target, and text.', isError: true };
      }

      const channelId =
        targetType === 'agent' ? (await channelRepo.getOrCreateDm(target)).id : target;
      const created = await postMessage(ctx.boss, {
        channelId,
        authorType: 'agent',
        authorId: ctx.agent.id,
        content: text,
        mentions: targetType === 'channel' ? strArray(input, 'mentions') : [],
      });
      return { content: `Posted message ${created.id}.` };
    },
  },

  {
    name: 'read_channel',
    description: 'Read recent messages in a channel, oldest first.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string' },
        since_message_id: { type: 'string', description: 'Only messages posted after this message id.' },
      },
      required: ['channel_id'],
      additionalProperties: false,
    },
    async execute(input) {
      const channelId = str(input, 'channel_id');
      if (!channelId) {
        return { content: 'read_channel requires channel_id.', isError: true };
      }
      const sinceId = str(input, 'since_message_id');
      const rows = await messageRepo.list(channelId, sinceId ? { after_id: sinceId } : {});
      if (rows.length === 0) return { content: '(no messages)' };
      return { content: rows.map((row) => `[${row.id}] ${row.author_type}:${row.author_id}: ${row.content}`).join('\n') };
    },
  },

  {
    name: 'ask_colleague',
    description: "DM a colleague a question. They'll be woken up; you'll be re-triggered if they reply here.",
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        question: { type: 'string' },
      },
      required: ['agent_id', 'question'],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const agentId = str(input, 'agent_id');
      const question = str(input, 'question');
      if (!agentId || !question) {
        return { content: 'ask_colleague requires agent_id and question.', isError: true };
      }
      const colleague = await agentRepo.getById(agentId);
      if (!colleague) {
        return { content: `No agent "${agentId}".`, isError: true };
      }
      const dm = await channelRepo.getOrCreateDm(agentId);
      const created = await postMessage(ctx.boss, {
        channelId: dm.id,
        authorType: 'agent',
        authorId: ctx.agent.id,
        content: question,
        mentions: [agentId],
      });
      return { content: `Sent to ${colleague.name} (message ${created.id}).` };
    },
  },

  {
    name: 'ask_human',
    description:
      "Ask the company owner a question and pause this run until they answer. Only use this when you're genuinely blocked - see the Inbox for pending questions.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional multiple-choice options.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const question = str(input, 'question');
      if (!question) {
        return { content: 'ask_human requires question.', isError: true };
      }
      const options = strArray(input, 'options');
      const payload: AskHumanPayload = { question, options: options.length > 0 ? options : undefined };
      const created = await approvalRepo.create({ run_id: ctx.run.id, kind: 'question', payload });
      await eventRepo.append({
        type: 'approval.requested',
        payload: { approval_id: created.id, kind: 'question' },
      });
      ctx.pauseRequested = { approvalId: created.id };
      return {
        content: `Question sent to the owner (pending id ${created.id}). Ending this turn now - you'll be re-triggered once they answer.`,
      };
    },
  },

  {
    name: 'create_project',
    description: 'Create a new project - a board, a channel, and a wiki. Do this before delegating any tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const name = str(input, 'name');
      if (!name) {
        return { content: 'create_project requires name.', isError: true };
      }
      const created = await projectRepo.create({
        name,
        description: str(input, 'description') ?? '',
        repos: [],
        workspace_id: null,
        board_settings: { columns: DEFAULT_BOARD_COLUMNS },
        wiki_path: `wiki/${slugify(name)}`,
      });
      await eventRepo.append({
        type: 'project.created',
        payload: { project_id: created.id, name: created.name },
      });
      const projectChannel = await channelRepo.create({
        project_id: created.id,
        team_id: null,
        kind: 'project',
        name: created.name,
        task_id: null,
      });
      await postMessage(ctx.boss, {
        channelId: projectChannel.id,
        authorType: 'agent',
        authorId: ctx.agent.id,
        content: `Created project "${created.name}".`,
      });
      return {
        content: `Created project "${created.name}" (${created.id}), channel ${projectChannel.id}. Use this project_id with delegate_task.`,
      };
    },
  },

  {
    name: 'delegate_task',
    description: 'Create a task in a project and assign it to a colleague, with a brief posted in its thread.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        assignee_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        acceptance_criteria: { type: 'string' },
        priority: { type: 'string', enum: [...TASK_PRIORITIES] },
      },
      required: ['project_id', 'assignee_id', 'title'],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const projectId = str(input, 'project_id');
      const assigneeId = str(input, 'assignee_id');
      const title = str(input, 'title');
      if (!projectId || !assigneeId || !title) {
        return { content: 'delegate_task requires project_id, assignee_id, and title.', isError: true };
      }
      const project = await projectRepo.getById(projectId);
      if (!project) {
        return { content: `No project "${projectId}" - call create_project first.`, isError: true };
      }
      const assignee = await agentRepo.getById(assigneeId);
      if (!assignee) {
        return { content: `No agent "${assigneeId}".`, isError: true };
      }

      const priorityInput = str(input, 'priority');
      const priority: TaskPriority = (TASK_PRIORITIES as readonly string[]).includes(priorityInput ?? '')
        ? (priorityInput as TaskPriority)
        : 'medium';

      const created = await taskRepo.create({
        project_id: project.id,
        title,
        description: str(input, 'description') ?? '',
        acceptance_criteria: str(input, 'acceptance_criteria') ?? '',
        status: 'todo',
        priority,
        assignee_id: assignee.id,
        created_by: ctx.agent.id,
        parent_id: null,
        depends_on: [],
        due_at: null,
      });
      await eventRepo.append({
        type: 'task.created',
        payload: { task_id: created.id, project_id: project.id, title: created.title },
      });

      const thread = await channelRepo.getOrCreateTaskThread(created.id, project.id);
      const brief = [
        `Task: ${created.title}`,
        created.description,
        created.acceptance_criteria ? `Acceptance criteria: ${created.acceptance_criteria}` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n\n');
      await postMessage(ctx.boss, {
        channelId: thread.id,
        authorType: 'agent',
        authorId: ctx.agent.id,
        content: brief,
        mentions: [assignee.id],
        // A task assignment is its own trigger kind (PLAN.md 4.1), distinct
        // from an ordinary @mention - see postMessage's doc comment.
        trigger: 'task',
      });

      return {
        content: `Created task "${created.title}" (${created.id}) in project "${project.name}", assigned to ${assignee.name}. Thread: ${thread.id}.`,
      };
    },
  },

  {
    name: 'update_task',
    description: "Update a task's status, priority, or assignee - e.g. moving it across the board.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: {
          type: 'string',
          enum: ['backlog', 'todo', 'in_progress', 'review', 'done', 'blocked'],
        },
        priority: { type: 'string', enum: [...TASK_PRIORITIES] },
        assignee_id: { type: 'string' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const taskId = str(input, 'task_id');
      if (!taskId) {
        return { content: 'update_task requires task_id.', isError: true };
      }
      const existing = await taskRepo.getById(taskId);
      if (!existing) {
        return { content: `No task "${taskId}".`, isError: true };
      }

      const patch: Parameters<typeof taskRepo.update>[1] = {};
      const status = str(input, 'status');
      if (status) patch.status = status as (typeof existing)['status'];
      const priority = str(input, 'priority');
      if (priority) patch.priority = priority as (typeof existing)['priority'];
      const reassigning = 'assignee_id' in input;
      if (reassigning) patch.assignee_id = str(input, 'assignee_id') ?? null;

      const updated = await taskRepo.update(taskId, patch);
      if (!updated) {
        return { content: `Failed to update task "${taskId}".`, isError: true };
      }
      await eventRepo.append({
        type: 'task.updated',
        payload: {
          task_id: updated.id,
          project_id: updated.project_id,
          status: updated.status,
          assignee_id: updated.assignee_id,
        },
      });

      // PLAN.md 4.7: "moving a card to Todo with an assignee triggers a
      // run" - generalized here to also cover a fresh (re)assignment, so
      // dragging a card onto someone's name wakes them the same way.
      if (updated.assignee_id && ((status === 'todo') || reassigning)) {
        await triggerRun(ctx.boss, { agentId: updated.assignee_id, taskId: updated.id, trigger: 'task' });
      }

      return { content: `Updated task "${updated.id}" (status: ${updated.status}, assignee: ${updated.assignee_id ?? 'none'}).` };
    },
  },

  {
    name: 'save_artifact',
    description:
      'Save a file, diff, PR link, doc, image, or report as an artifact linked to this run\'s task/project - it shows up in the dashboard\'s Artifacts view and on the task card.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...ARTIFACT_KINDS] },
        title: { type: 'string' },
        content: { type: 'string', description: 'Text content - e.g. file contents, a diff, a PR/design URL, a report.' },
        artifact_group_id: {
          type: 'string',
          description: 'Set to add a new version to an existing artifact instead of starting a new one.',
        },
      },
      required: ['kind', 'title', 'content'],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const kind = str(input, 'kind');
      const title = str(input, 'title');
      const content = str(input, 'content');
      if (!kind || !(ARTIFACT_KINDS as readonly string[]).includes(kind) || !title || !content) {
        return {
          content: `save_artifact requires kind (one of ${ARTIFACT_KINDS.join(', ')}), title, and content.`,
          isError: true,
        };
      }
      const created = await saveArtifact({
        projectId: ctx.project?.id ?? null,
        taskId: ctx.task?.id ?? null,
        runId: ctx.run.id,
        artifactGroupId: str(input, 'artifact_group_id'),
        kind: kind as ArtifactKind,
        title,
        content,
      });
      return { content: `Saved artifact "${created.title}" (${created.id}, v${created.version}).` };
    },
  },

  {
    name: 'request_review',
    description: 'Ask a colleague to review an artifact you produced (e.g. a PR or a doc) - DMs them with it attached.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        artifact_id: { type: 'string' },
        note: { type: 'string', description: 'What you want reviewed and any context - defaults to a generic prompt.' },
      },
      required: ['agent_id', 'artifact_id'],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const agentId = str(input, 'agent_id');
      const artifactId = str(input, 'artifact_id');
      if (!agentId || !artifactId) {
        return { content: 'request_review requires agent_id and artifact_id.', isError: true };
      }
      const [colleague, artifact] = await Promise.all([agentRepo.getById(agentId), artifactRepo.getById(artifactId)]);
      if (!colleague) {
        return { content: `No agent "${agentId}".`, isError: true };
      }
      if (!artifact) {
        return { content: `No artifact "${artifactId}".`, isError: true };
      }

      const note = str(input, 'note') ?? `Please review "${artifact.title}".`;
      const dm = await channelRepo.getOrCreateDm(agentId);
      const created = await postMessage(ctx.boss, {
        channelId: dm.id,
        authorType: 'agent',
        authorId: ctx.agent.id,
        content: note,
        mentions: [agentId],
        attachments: [{ artifact_id: artifact.id }],
      });
      return { content: `Sent review request for "${artifact.title}" to ${colleague.name} (message ${created.id}).` };
    },
  },
];
