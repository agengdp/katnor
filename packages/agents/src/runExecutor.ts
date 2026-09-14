import type { ContentBlock, ProviderMessage } from '@katnor/llm';
import { getProvider } from '@katnor/llm';
import type { ApprovalMode, CompanySettings, RunStatus, RunStepKind, SpendApprovalPayload } from '@katnor/core';
import { mergeCompanySettings } from '@katnor/core';
import {
  agentRepo,
  approvalRepo,
  companyRepo,
  eventRepo,
  messageRepo,
  projectRepo,
  runRepo,
  runStepRepo,
  taskRepo,
} from '@katnor/db';
import type PgBoss from 'pg-boss';
import type { AgentToolContext } from './context.js';
import { loadAgentMcpTools } from './mcpTools.js';
import { buildInitialUserMessage, buildSystemPrompt } from './promptBuilder.js';
import { QUEUES } from './queues.js';
import { agentToolRegistry, DEFAULT_COMPANY_TOOL_NAMES } from './registry.js';

/**
 * Hard cap on `provider.step()` calls within one run - PLAN.md 4.1's "max
 * steps per run" limit. A run that hits this without naturally ending is
 * recorded as `failed` (it didn't converge), not silently truncated.
 */
const MAX_STEPS_PER_RUN = 12;

function isTextBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'text' }> {
  return block.type === 'text';
}
function isThinkingBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'thinking' }> {
  return block.type === 'thinking';
}
function isToolUseBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'tool_use' }> {
  return block.type === 'tool_use';
}
function isServerToolBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'server_tool' }> {
  return block.type === 'server_tool';
}

/**
 * Records one `run_step` row and, in the same call, the live
 * `run.step_recorded` event the office/Team page's live-status displays
 * are driven by (PLAN.md 4.8) - the two always go together, so every call
 * site in this file goes through here rather than `runStepRepo.create`
 * directly.
 */
async function recordStep(
  runId: string,
  agentId: string,
  taskId: string | null,
  seq: number,
  kind: RunStepKind,
  payload: Record<string, unknown>,
  opts: { tokens?: number; durationMs?: number; detail?: string | null } = {},
): Promise<void> {
  const created = await runStepRepo.create({
    run_id: runId,
    seq,
    kind,
    payload,
    tokens: opts.tokens ?? null,
    duration_ms: opts.durationMs ?? null,
  });
  await eventRepo.append({
    type: 'run.step_recorded',
    payload: {
      run_id: runId,
      run_step_id: created.id,
      seq,
      kind,
      agent_id: agentId,
      task_id: taskId,
      detail: opts.detail ?? null,
    },
  });
}

function startOfToday(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * What `checkBudgetHardStop` returns when a cap is hit - enough for its
 * caller to build a `spend` approval or a plain cancellation summary.
 */
interface BudgetHit {
  scope: SpendApprovalPayload['scope'];
  summary: string;
}

/**
 * PLAN.md Phase 5's "hard stops": flags a run whose company, project, or
 * agent has already reached its daily USD budget. A budget of 0 - the
 * default for a fresh agent, and for project/agent budgets left unset in
 * Settings - means "no cap", not "cap at $0"; only a positive number is
 * ever enforced. Checked once, right before a run starts, so a blocked run
 * never actually transitions to `running` (see its one call site's
 * comment) - whether that means the run is cancelled outright or paused
 * to ask the owner is `company.settings.approval_policy.spend`'s call, not
 * this function's; see `isSpendPreapproved` and the call site below for
 * that half of the logic.
 *
 * Two gaps this check does NOT cover, surfaced by a Phase 5 cross-review
 * rather than something either commit's own comment called out on its
 * own:
 * - An agent hired on the "openai_compatible" or "google" provider always
 *   reports `costUsd: 0` (see @katnor/llm's openaiCompatible.ts/google.ts -
 *   neither has a generic price table for its models), so
 *   `runRepo.sumCostSince` never sees their real spend and this check can
 *   never block them, however much they actually cost against a paid API.
 * - The scheduled manager-standup and wiki-lint jobs (./standup.ts,
 *   @katnor/knowledge's wikiLint.ts) call `getProvider('anthropic').step()`
 *   directly rather than going through `runAgentExecutor`, so they never
 *   reach this check (or create a `run` row at all) - their cost is both
 *   unenforced and invisible to the cost dashboards.
 */
async function checkBudgetHardStop(
  agent: NonNullable<Awaited<ReturnType<typeof agentRepo.getById>>>,
  project: NonNullable<Awaited<ReturnType<typeof projectRepo.getById>>> | null,
  settings: CompanySettings,
): Promise<BudgetHit | null> {
  const since = startOfToday();

  const companyCap = settings.budgets.company_daily_usd;
  if (companyCap > 0) {
    const spent = await runRepo.sumCostSince(since);
    if (spent >= companyCap) {
      return {
        scope: 'company',
        summary:
          `the company has already spent $${spent.toFixed(2)} today, at or over its ` +
          `$${companyCap.toFixed(2)}/day budget`,
      };
    }
  }

  const agentCap = Number(agent.budget_daily_usd) > 0 ? Number(agent.budget_daily_usd) : (settings.budgets.agent_daily_usd ?? 0);
  if (agentCap > 0) {
    const spent = await runRepo.sumCostSince(since, { agentId: agent.id });
    if (spent >= agentCap) {
      return {
        scope: 'agent',
        summary:
          `${agent.name} has already spent $${spent.toFixed(2)} today, at or over their ` +
          `$${agentCap.toFixed(2)}/day budget`,
      };
    }
  }

  const projectCap = settings.budgets.project_daily_usd ?? 0;
  if (project && projectCap > 0) {
    const spent = await runRepo.sumCostSince(since, { projectId: project.id });
    if (spent >= projectCap) {
      return {
        scope: 'project',
        summary:
          `project "${project.name}" has already spent $${spent.toFixed(2)} today, at or over ` +
          `its $${projectCap.toFixed(2)}/day budget`,
      };
    }
  }

  return null;
}

/**
 * Whether a run blocked by `checkBudgetHardStop` should be let through
 * anyway rather than paused to ask the owner - mirrors ./workTools.ts's
 * `gateDangerousShellCommand` exactly (same three `ApprovalMode` values,
 * same "ask once per project" convention): `"auto"` always lets it
 * through; `"ask_once_per_project"` does too, but only once a prior
 * *approved* `spend` approval already exists for this project (checked by
 * `project_id` alone, not also `scope` - the point is "the owner has
 * already said yes to this project running over budget," not "for this
 * exact cap"); `"always_ask"`, or `"ask_once_per_project"` with no project
 * to scope to, never pre-approves.
 */
async function isSpendPreapproved(policy: ApprovalMode, projectId: string | null): Promise<boolean> {
  if (policy === 'auto') return true;
  if (policy === 'ask_once_per_project' && projectId) {
    const approved = await approvalRepo.list('approved');
    return approved.some((row) => {
      if (row.kind !== 'spend') return false;
      const payload = row.payload as Partial<SpendApprovalPayload>;
      return payload.project_id === projectId;
    });
  }
  return false;
}

/**
 * Runs one agent's turn through the LLM tool-use loop for `runId` (created
 * `queued` by ./trigger.ts's `triggerRun`, called from apps/worker's
 * `agent-run` queue handler). Drives @katnor/llm's provider-agnostic
 * `step()` in a manual loop (see @katnor/llm/src/anthropic.ts's module
 * comment for why this isn't the Anthropic SDK's Tool Runner), executing
 * tool calls through @katnor/tools' registry and recording every LLM call
 * and tool call as a `run_step` - PLAN.md 4.1.
 */
export async function runAgentExecutor(boss: PgBoss, runId: string, triggerNote?: string): Promise<void> {
  const run = await runRepo.getById(runId);
  if (!run) {
    console.error(`[runExecutor] run "${runId}" not found - dropping job`);
    return;
  }
  if (run.status !== 'queued') {
    // Defensive: pg-boss can redeliver a job (e.g. after a crash mid-run).
    // Re-running a non-queued run would double-charge tokens/cost and post
    // duplicate messages, so this is a no-op rather than a retry.
    console.warn(`[runExecutor] run "${runId}" is not queued (status=${run.status}) - skipping redelivery`);
    return;
  }

  const agent = await agentRepo.getById(run.agent_id);
  if (!agent) {
    await runRepo.update(runId, { status: 'failed', finished_at: new Date(), summary: 'Agent no longer exists.' });
    return;
  }
  if (agent.status !== 'active') {
    await runRepo.update(runId, {
      status: 'cancelled',
      finished_at: new Date(),
      summary: `Agent is ${agent.status}, not active.`,
    });
    return;
  }

  const [task, company] = await Promise.all([
    run.task_id ? taskRepo.getById(run.task_id) : Promise.resolve(undefined),
    companyRepo.get(),
  ]);
  const project = task?.project_id ? ((await projectRepo.getById(task.project_id)) ?? null) : null;
  const settings = mergeCompanySettings(company.settings);

  const budgetHit = await checkBudgetHardStop(agent, project, settings);
  if (budgetHit) {
    const preapproved = await isSpendPreapproved(settings.approval_policy.spend, project?.id ?? null);
    if (!preapproved) {
      // "always_ask", or the first time this project has hit a cap under
      // "ask_once_per_project" - pause and ask, the same shape as
      // ./companyTools.ts's `ask_human`/./workTools.ts's dangerous-shell
      // gate: a `spend` approval, the run parked as `waiting_human` rather
      // than cancelled outright, woken up again (a fresh run, not a
      // resumed one - see apps/server's approvals.decide) once the owner
      // decides either way.
      const payload: SpendApprovalPayload = {
        scope: budgetHit.scope,
        agent_id: agent.id,
        project_id: project?.id ?? null,
        summary: budgetHit.summary,
      };
      const created = await approvalRepo.create({ run_id: runId, kind: 'spend', payload });
      await eventRepo.append({ type: 'approval.requested', payload: { approval_id: created.id, kind: 'spend' } });
      await runRepo.update(runId, {
        status: 'waiting_human',
        finished_at: new Date(),
        summary: `Waiting on the owner (pending id ${created.id}): ${budgetHit.summary}.`,
      });
      await eventRepo.append({
        type: 'run.finished',
        payload: { run_id: runId, agent_id: agent.id, status: 'waiting_human', cost_usd: 0 },
      });
      return;
    }
    // "auto", or an already-approved "ask_once_per_project" match - the
    // owner (or policy) has effectively said "let it run anyway", so fall
    // through and start the run despite being over budget.
  }

  await runRepo.update(runId, { status: 'running' });
  await eventRepo.append({
    type: 'run.started',
    payload: { run_id: runId, agent_id: agent.id, task_id: run.task_id, trigger: run.trigger },
  });

  const [manager, recentMessages] = await Promise.all([
    agent.reports_to ? agentRepo.getById(agent.reports_to) : Promise.resolve(undefined),
    run.channel_id ? messageRepo.list(run.channel_id) : Promise.resolve([]),
  ]);

  const promptInput = {
    companyName: company.name,
    agent,
    managerName: manager?.name ?? null,
    task: task ?? null,
    project,
    recentMessages,
    trigger: run.trigger,
    triggerNote,
  };
  const systemPrompt = buildSystemPrompt(promptInput);
  const initialUserText = await buildInitialUserMessage(promptInput);

  const toolNames = agent.tool_allowlist.length > 0 ? agent.tool_allowlist : DEFAULT_COMPANY_TOOL_NAMES;
  // MCP tools (PLAN.md 4.3) are discovered live per run from whatever
  // servers this agent's tool_allowlist grants (see ./mcpTools.ts) rather
  // than pre-registered in the shared, module-level `agentToolRegistry` -
  // so they're merged in here instead of being one of `toolNames`.
  const mcpTools = await loadAgentMcpTools(agent.tool_allowlist);
  const mcpToolsByName = new Map(mcpTools.map((def) => [def.name, def]));
  const tools = [
    ...agentToolRegistry.listForModel(toolNames, { isSystem: agent.is_system }),
    ...mcpTools.map((def) => ({ name: def.name, description: def.description, inputSchema: def.inputSchema })),
  ];
  const provider = getProvider(agent.model_config.provider);

  const messages: ProviderMessage[] = [{ role: 'user', content: [{ type: 'text', text: initialUserText }] }];
  const toolCtx: AgentToolContext = { boss, agent, run, task: task ?? null, project, company, pauseRequested: null };

  // PLAN.md 4.1: "a task budget is also sent so the model paces itself."
  // This is a whole-run advisory ceiling (Anthropic's task budgets count
  // generated output plus the tool results read *this turn*, not the full
  // resent history), not a per-step cap - sized as a few steps' worth of
  // this agent's own `max_tokens` so it's meaningful without being either
  // trivially small or so large it never influences pacing. Providers/
  // models that don't support task budgets (see @katnor/llm's per-model
  // profile table) just ignore this field.
  const taskBudgetTokens = Math.max(20_000, agent.model_config.max_tokens * 6);

  const taskId = task?.id ?? null;
  let seq = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let summary = '';
  let outcome: RunStatus | null = null;

  for (let stepIndex = 0; stepIndex < MAX_STEPS_PER_RUN && outcome === null; stepIndex++) {
    const stepStartedAt = Date.now();
    const result = await provider.step({
      systemPrompt,
      messages,
      tools,
      model: agent.model_config.model,
      effort: agent.model_config.effort,
      thinkingDisplay: agent.model_config.thinking_display,
      maxTokens: agent.model_config.max_tokens,
      temperature: agent.model_config.temperature,
      taskBudgetTokens,
    });
    const stepDurationMs = Date.now() - stepStartedAt;

    tokensIn += result.usage.inputTokens;
    tokensOut += result.usage.outputTokens;
    costUsd += result.costUsd;

    seq += 1;
    await recordStep(
      runId,
      agent.id,
      taskId,
      seq,
      'llm_call',
      {
        stop_reason: result.stopReason,
        model: agent.model_config.model,
        usage: result.usage,
        refusal_category: result.refusalCategory ?? null,
        // Only set by @katnor/llm's ComboProvider - which real
        // (provider, model) pair inside the combo actually answered this
        // call, since `model` above is just the combo's name.
        served_by: result.servedBy ?? null,
      },
      { tokens: result.usage.inputTokens + result.usage.outputTokens, durationMs: stepDurationMs },
    );

    const thinkingBlock = result.content.find(isThinkingBlock);
    if (thinkingBlock && thinkingBlock.text.trim().length > 0) {
      seq += 1;
      await recordStep(runId, agent.id, taskId, seq, 'thinking_summary', { text: thinkingBlock.text }, { detail: 'thinking' });
    }

    for (const block of result.content.filter(isTextBlock)) {
      if (block.text.trim().length === 0) continue;
      seq += 1;
      await recordStep(runId, agent.id, taskId, seq, 'message', { text: block.text }, { detail: block.text.slice(0, 80) });
      summary = block.text.slice(0, 500);
    }

    // Anthropic's server-side tools (web_search/web_fetch) ran and resolved
    // within this same call - there's nothing for the tool registry to
    // execute (see @katnor/llm's ServerToolBlock doc comment), but it's
    // still worth a trace entry so the Runs page shows "the model searched
    // the web" rather than the step silently vanishing.
    for (const block of result.content.filter(isServerToolBlock)) {
      seq += 1;
      await recordStep(
        runId,
        agent.id,
        taskId,
        seq,
        'tool_call',
        { server_tool: true, raw: block.raw },
        { detail: 'web_search/web_fetch' },
      );
    }

    if (result.stopReason === 'error') {
      outcome = 'failed';
      summary = result.errorMessage ?? 'The provider returned an unspecified error.';
      break;
    }
    if (result.stopReason === 'refusal') {
      outcome = 'failed';
      summary = `Refused by the model${result.refusalCategory ? ` (${result.refusalCategory})` : ''}.`;
      break;
    }
    if (result.stopReason === 'max_tokens') {
      outcome = 'failed';
      summary = 'Hit the max_tokens limit before finishing this turn.';
      break;
    }

    // Append verbatim, including any thinking block's signature - needed
    // whether we're about to loop again (tool_use) or stop (end_turn); see
    // @katnor/llm's ThinkingBlock doc comment on why this must be
    // untouched, not reconstructed from a summary.
    messages.push({ role: 'assistant', content: result.content });

    if (result.stopReason === 'end_turn') {
      outcome = 'succeeded';
      break;
    }

    // result.stopReason === 'tool_use': execute every requested call, in
    // order, and feed all of this turn's results back in a single user
    // message (parallel tool calls must return as one batch, never split
    // across messages - see the Claude API skill's tool-use guidance).
    const toolResults: ContentBlock[] = [];
    for (const toolUse of result.content.filter(isToolUseBlock)) {
      const toolStartedAt = Date.now();
      seq += 1;
      await recordStep(
        runId,
        agent.id,
        taskId,
        seq,
        'tool_call',
        { name: toolUse.name, input: toolUse.input },
        { detail: toolUse.name },
      );

      const mcpTool = mcpToolsByName.get(toolUse.name);
      const execResult = mcpTool
        ? await mcpTool.execute(toolUse.input, toolCtx).catch((err: unknown) => ({
            content: `Tool "${toolUse.name}" threw an error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          }))
        : await agentToolRegistry.execute(toolUse.name, toolUse.input, toolCtx);

      seq += 1;
      await recordStep(
        runId,
        agent.id,
        taskId,
        seq,
        'tool_result',
        { name: toolUse.name, is_error: execResult.isError ?? false, content: execResult.content },
        { durationMs: Date.now() - toolStartedAt },
      );

      toolResults.push({
        type: 'tool_result',
        toolUseId: toolUse.id,
        content: execResult.content,
        isError: execResult.isError,
      });

      // ask_human (or a pending hire approval) asked this run to stop -
      // don't execute any further tool calls from this same turn.
      if (toolCtx.pauseRequested) break;
    }

    messages.push({ role: 'user', content: toolResults });

    if (toolCtx.pauseRequested) {
      outcome = 'waiting_human';
      summary = `Waiting on the owner (pending id ${toolCtx.pauseRequested.approvalId}).`;
      break;
    }
    // Otherwise loop: call provider.step() again with the tool results appended.
  }

  if (outcome === null) {
    outcome = 'failed';
    summary = `Exceeded the ${MAX_STEPS_PER_RUN}-step limit for a single run without finishing.`;
  }
  if (outcome === 'succeeded' && summary === '') {
    summary = 'Finished with no text response.';
  }

  await runRepo.update(runId, {
    status: outcome,
    finished_at: new Date(),
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: costUsd.toFixed(6),
    summary,
  });
  await eventRepo.append({
    type: 'run.finished',
    payload: { run_id: runId, agent_id: agent.id, status: outcome, cost_usd: costUsd },
  });

  // PLAN.md 4.4/4.5: "after each run ... an extraction call ... ingester
  // upserts nodes". Only a succeeded, task-scoped run has anything
  // project-level worth filing into the wiki/knowledge graph - see
  // @katnor/knowledge's librarian.ts, which re-checks task_id itself and
  // no-ops if it's still missing (defensive, not load-bearing here).
  if (outcome === 'succeeded' && run.task_id) {
    await boss.send(QUEUES.LIBRARIAN_INGEST, { runId });
  }
}
