import { getProvider } from '@katnor/llm';
import { channelRepo, messageRepo, projectRepo, taskRepo } from '@katnor/db';
import { commit, ensureProjectWiki, readPage, writePage } from '@katnor/knowledge';
import type PgBoss from 'pg-boss';
import { postMessage } from './messaging.js';

/**
 * PLAN.md 4.2's daily manager stand-up: "summarises threads into the wiki
 * and closes stale ones." Implemented per-project (every project gets one,
 * regardless of whether it has a formal manager agent with reports) rather
 * than per-manager-agent - simpler, and consistent with how @katnor/
 * knowledge's wiki/lint are already project-scoped rather than
 * agent-scoped. "Closes stale ones" is interpreted conservatively: stale
 * in-progress tasks are called out in the summary, not auto-transitioned -
 * silently moving a task's status on a schedule risks surprising whoever
 * is actually working it.
 *
 * This calls `getProvider('anthropic').step()` directly rather than going
 * through ./runExecutor.ts's `runAgentExecutor` - there's no agent "run" to
 * attribute this to (it's a system job, not an employee's turn) and no
 * `task_id` to hang one off of. One side effect worth knowing about: this
 * means the call never passes through `runExecutor.ts`'s
 * `checkBudgetHardStop`, so it runs even if the company is already over
 * its daily budget, and its cost never reaches `runRepo.sumCostSince` (so
 * it's invisible to the cost dashboards too). Low-volume/low-token enough
 * in practice that this hasn't mattered, but a future pass that wants
 * budget enforcement to be airtight would need to check the company
 * budget here too, not just assume run-scoped calls are the only ones
 * that spend money.
 */

const STANDUP_AUTHOR_ID = 'manager-standup';
const STANDUP_MODEL = 'claude-sonnet-5';
const LOOKBACK_HOURS = 24;
const STALE_TASK_DAYS = 3;

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

async function summarize(projectName: string, messagesText: string, taskChangesText: string, staleText: string): Promise<string> {
  const sections = [
    `Project: ${projectName}`,
    messagesText ? `Recent messages (last ${LOOKBACK_HOURS}h):\n${messagesText}` : `No new messages in the last ${LOOKBACK_HOURS}h.`,
    taskChangesText ? `Task changes:\n${taskChangesText}` : 'No task status changes.',
    staleText ? `In-progress tasks with no update in ${STALE_TASK_DAYS}+ days:\n${staleText}` : '',
  ].filter((section) => section.length > 0);

  const provider = getProvider('anthropic');
  try {
    const result = await provider.step({
      systemPrompt:
        'You write a short daily stand-up summary for a project wiki log, 3-6 sentences. Call out anything ' +
        'stale or blocked plainly. If there is genuinely nothing to report, say so in one sentence rather than padding.',
      messages: [{ role: 'user', content: [{ type: 'text', text: sections.join('\n\n') }] }],
      tools: [],
      model: STANDUP_MODEL,
      effort: 'medium',
      thinkingDisplay: 'omitted',
      maxTokens: 512,
    });
    if (result.stopReason === 'error' || result.stopReason === 'refusal') {
      return `Stand-up summary unavailable (${result.errorMessage ?? result.refusalCategory ?? result.stopReason}).`;
    }
    const textBlock = result.content.find((block) => block.type === 'text');
    return textBlock && textBlock.type === 'text' && textBlock.text.trim().length > 0 ? textBlock.text.trim() : 'Nothing notable to report.';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Stand-up summary unavailable: ${message}`;
  }
}

/** Runs one project's daily stand-up: summarizes the last day's activity, appends it to the wiki log, and posts it to the project channel. */
export async function runManagerStandup(projectId: string, boss: PgBoss): Promise<void> {
  const project = await projectRepo.getById(projectId);
  if (!project) return;

  const [tasks, channels] = await Promise.all([
    taskRepo.list({ project_id: projectId }),
    channelRepo.list({ project_id: projectId }),
  ]);
  const projectChannel = channels.find((channel) => channel.kind === 'project');

  const since = hoursAgo(LOOKBACK_HOURS);

  let messagesText = '';
  if (projectChannel) {
    const messages = await messageRepo.list(projectChannel.id);
    messagesText = messages
      .filter((message) => message.created_at >= since)
      .map((message) => `${message.author_type}:${message.author_id}: ${message.content}`)
      .join('\n');
  }

  const taskChangesText = tasks
    .filter((t) => t.updated_at >= since)
    .map((t) => `"${t.title}" -> ${t.status}`)
    .join('\n');

  const staleCutoff = hoursAgo(STALE_TASK_DAYS * 24);
  const staleText = tasks
    .filter((t) => t.status === 'in_progress' && t.updated_at < staleCutoff)
    .map((t) => `"${t.title}" (no update since ${t.updated_at.toISOString().slice(0, 10)})`)
    .join('\n');

  const summary = await summarize(project.name, messagesText, taskChangesText, staleText);

  await ensureProjectWiki(project.id, project.name);
  const existingLog = (await readPage(project.id, 'log.md')) ?? '# Change log\n\n';
  const dateStamp = new Date().toISOString().slice(0, 10);
  await writePage(project.id, 'log.md', `${existingLog.trimEnd()}\n- **Stand-up ${dateStamp}**: ${summary.replace(/\s+/g, ' ')}\n`);
  await commit(project.id, `Manager stand-up: ${project.name}`);

  if (projectChannel) {
    await postMessage(boss, {
      channelId: projectChannel.id,
      authorType: 'agent',
      authorId: STANDUP_AUTHOR_ID,
      content: `📋 Daily stand-up: ${summary}`,
    });
  }
}
