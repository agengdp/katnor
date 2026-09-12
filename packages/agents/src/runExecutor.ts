import type { ContentBlock, ProviderMessage } from '@katnor/llm';
import { getProvider } from '@katnor/llm';
import type { RunStatus } from '@katnor/core';
import { agentRepo, companyRepo, eventRepo, messageRepo, runRepo, runStepRepo, taskRepo } from '@katnor/db';
import type PgBoss from 'pg-boss';
import type { AgentToolContext } from './context.js';
import { buildInitialUserMessage, buildSystemPrompt } from './promptBuilder.js';
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

  await runRepo.update(runId, { status: 'running' });
  await eventRepo.append({
    type: 'run.started',
    payload: { run_id: runId, agent_id: agent.id, task_id: run.task_id, trigger: run.trigger },
  });

  const [task, manager, company, recentMessages] = await Promise.all([
    run.task_id ? taskRepo.getById(run.task_id) : Promise.resolve(undefined),
    agent.reports_to ? agentRepo.getById(agent.reports_to) : Promise.resolve(undefined),
    companyRepo.get(),
    run.channel_id ? messageRepo.list(run.channel_id) : Promise.resolve([]),
  ]);

  const promptInput = {
    companyName: company.name,
    agent,
    managerName: manager?.name ?? null,
    task: task ?? null,
    recentMessages,
    trigger: run.trigger,
    triggerNote,
  };
  const systemPrompt = buildSystemPrompt(promptInput);
  const initialUserText = buildInitialUserMessage(promptInput);

  const toolNames = agent.tool_allowlist.length > 0 ? agent.tool_allowlist : DEFAULT_COMPANY_TOOL_NAMES;
  const tools = agentToolRegistry.listForModel(toolNames, { isSystem: agent.is_system });
  const provider = getProvider(agent.model_config.provider);

  const messages: ProviderMessage[] = [{ role: 'user', content: [{ type: 'text', text: initialUserText }] }];
  const toolCtx: AgentToolContext = { boss, agent, run, task: task ?? null, pauseRequested: null };

  // PLAN.md 4.1: "a task budget is also sent so the model paces itself."
  // This is a whole-run advisory ceiling (Anthropic's task budgets count
  // generated output plus the tool results read *this turn*, not the full
  // resent history), not a per-step cap - sized as a few steps' worth of
  // this agent's own `max_tokens` so it's meaningful without being either
  // trivially small or so large it never influences pacing. Providers/
  // models that don't support task budgets (see @katnor/llm's per-model
  // profile table) just ignore this field.
  const taskBudgetTokens = Math.max(20_000, agent.model_config.max_tokens * 6);

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
    await runStepRepo.create({
      run_id: runId,
      seq,
      kind: 'llm_call',
      payload: {
        stop_reason: result.stopReason,
        model: agent.model_config.model,
        usage: result.usage,
        refusal_category: result.refusalCategory ?? null,
      },
      tokens: result.usage.inputTokens + result.usage.outputTokens,
      duration_ms: stepDurationMs,
    });

    const thinkingBlock = result.content.find(isThinkingBlock);
    if (thinkingBlock && thinkingBlock.text.trim().length > 0) {
      seq += 1;
      await runStepRepo.create({ run_id: runId, seq, kind: 'thinking_summary', payload: { text: thinkingBlock.text } });
    }

    for (const block of result.content.filter(isTextBlock)) {
      if (block.text.trim().length === 0) continue;
      seq += 1;
      await runStepRepo.create({ run_id: runId, seq, kind: 'message', payload: { text: block.text } });
      summary = block.text.slice(0, 500);
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
      await runStepRepo.create({
        run_id: runId,
        seq,
        kind: 'tool_call',
        payload: { name: toolUse.name, input: toolUse.input },
      });

      const execResult = await agentToolRegistry.execute(toolUse.name, toolUse.input, toolCtx);

      seq += 1;
      await runStepRepo.create({
        run_id: runId,
        seq,
        kind: 'tool_result',
        payload: { name: toolUse.name, is_error: execResult.isError ?? false, content: execResult.content },
        duration_ms: Date.now() - toolStartedAt,
      });

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
}
