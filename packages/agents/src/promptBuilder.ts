import type { agentRepo, messageRepo, taskRepo } from '@katnor/db';
import type { RunTrigger } from '@katnor/core';

type AgentRow = Awaited<ReturnType<typeof agentRepo.getById>>;
type TaskRow = Awaited<ReturnType<typeof taskRepo.getById>>;
type MessageRow = Awaited<ReturnType<typeof messageRepo.list>>[number];

/**
 * Builds the two halves of a run's first request, per PLAN.md 4.1's
 * cache-friendly, five-part prompt layout:
 *
 *   1. Company system prompt   -\
 *   2. Agent persona            |- returned by `buildSystemPrompt` (sent as
 *                               |  the API's `system` field, which
 *                               |  @katnor/llm's Anthropic adapter marks
 *                              -/  with a single cache breakpoint)
 *   3. Tool definitions        -- NOT text; passed separately as the
 *                                 request's `tools` array by the run
 *                                 executor (./runExecutor.ts), which is why
 *                                 it renders immediately before `system` in
 *                                 the request and still ends up inside the
 *                                 same cached prefix.
 *   4. Working context         -\
 *   5. The trigger                |- returned by `buildInitialUserMessage`
 *                                -/  (the first `messages[]` entry - always
 *                                    volatile, so it stays outside the
 *                                    cache breakpoint)
 *
 * Memory notes and a wiki index (also part of "working context" per
 * PLAN.md 4.1) don't exist yet - the memory tool and the wiki are Phase 3 -
 * so step 4 below is just the task card and recent channel messages.
 */

export interface BuildPromptInput {
  companyName: string;
  agent: NonNullable<AgentRow>;
  /** The resolved name of `agent.reports_to`, if any - just for a friendlier persona line. */
  managerName: string | null;
  task: NonNullable<TaskRow> | null;
  /** Oldest-first, already scoped to the channel this run is about (if any). */
  recentMessages: MessageRow[];
  trigger: RunTrigger;
  /** Free-text context for a trigger that isn't naturally a channel message (e.g. a decided approval). */
  triggerNote?: string;
}

export function buildSystemPrompt(input: BuildPromptInput): string {
  const { agent, companyName, managerName } = input;

  const companySection = [
    `You are an employee of ${companyName}, an AI company that gets real work done for its human owner.`,
    'The owner gives the company tasks; the CEO decides how to staff and organize the work, and every',
    'employee (including the CEO) uses the same tools to communicate and get things done.',
    '',
    'How the company works:',
    '- Every message belongs to a channel or a task thread - post where the right people will see it.',
    '- Mentioning a colleague (or DMing them) wakes them up to read and respond; nothing else does, so',
    '  say what you need plainly rather than assuming someone is watching.',
    '- Prefer making progress over talking about making progress. If a conversation goes back and forth',
    "  more than a couple of times without a task's status changing, stop and either decide something or",
    '  escalate instead of continuing to discuss it.',
    '- Only ask the human owner a question (via ask_human) when you are genuinely blocked and no colleague',
    '  can unblock you - it pauses your work until they answer, so use it sparingly and ask a specific,',
    '  answerable question.',
    '- End your turn once you have made progress or handed something off - you will be woken up again',
    '  when there is something new for you to do.',
  ].join('\n');

  const strengths = agent.persona.strengths.length > 0 ? agent.persona.strengths.join(', ') : 'generalist';
  const personaSection = [
    '',
    `You are ${agent.name}, ${agent.title}.`,
    agent.persona.bio,
    `Personality: ${agent.persona.personality}`,
    `Strengths: ${strengths}`,
    `Communication style: ${agent.persona.style}`,
    managerName ? `You report to ${managerName}.` : agent.is_system ? 'You report to no one - you are the CEO.' : '',
    '',
    agent.system_prompt,
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  return `${companySection}\n${personaSection}`;
}

function renderMessages(messages: MessageRow[]): string {
  if (messages.length === 0) return '(no messages yet)';
  return messages
    .map((m) => `[${m.id}] ${m.author_type}:${m.author_id}${m.mentions.length > 0 ? ` (mentions: ${m.mentions.join(', ')})` : ''}: ${m.content}`)
    .join('\n');
}

const TRIGGER_DESCRIPTIONS: Record<RunTrigger, string> = {
  task: 'You were just assigned a task.',
  mention: 'Someone mentioned you in a channel.',
  human: 'The owner sent you a message.',
  schedule: 'This is a scheduled check-in.',
};

export function buildInitialUserMessage(input: BuildPromptInput): string {
  const parts: string[] = [];

  if (input.task) {
    parts.push(
      [
        `## Current task: ${input.task.title} (${input.task.id})`,
        `Status: ${input.task.status} | Priority: ${input.task.priority}`,
        input.task.description ? `Description: ${input.task.description}` : null,
        input.task.acceptance_criteria ? `Acceptance criteria: ${input.task.acceptance_criteria}` : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n'),
    );
  }

  if (input.recentMessages.length > 0) {
    parts.push(`## Recent messages\n${renderMessages(input.recentMessages)}`);
  }

  parts.push(`## What just happened\n${TRIGGER_DESCRIPTIONS[input.trigger]}${input.triggerNote ? ` ${input.triggerNote}` : ''}`);

  parts.push('Decide what to do next and use your tools. End your turn once you have made progress.');

  return parts.join('\n\n');
}
