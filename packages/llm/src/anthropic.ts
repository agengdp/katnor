// NOTE ON SDK TYPE NAMES: this file was written with no npm registry access
// in this sandbox, so `@anthropic-ai/sdk` was never installed here and
// none of the `Anthropic.Beta.*` type names below (BetaToolUnion,
// BetaMessageParam, BetaContentBlockParam, BetaContentBlock,
// BetaThinkingConfigParam, AnthropicBeta, MessageCreateParamsStreaming,
// BetaMessage, BetaTool.InputSchema) could be checked against the real
// package - they follow the naming convention the Claude API skill's own
// examples use (e.g. `Anthropic.Beta.BetaTextBlock`), but one or more may
// be spelled slightly differently in the actual pinned SDK version. If
// `pnpm typecheck` reports a missing/wrong type under `Anthropic.Beta`,
// this is the first place to look - the request/response *shapes* (which
// fields go where) are the part to trust; the *type names* are the
// best-effort part.
import Anthropic from '@anthropic-ai/sdk';
import type { ModelProvider } from '@katnor/core';
import { estimateCostUsd } from './pricing.js';
import type {
  ContentBlock,
  LLMProvider,
  ProviderCapabilities,
  ProviderMessage,
  ProviderTool,
  StepInput,
  StepResult,
  StepStopReason,
  ToolChoice,
} from './types.js';

/**
 * The Anthropic provider adapter. Deliberately built on a single-turn
 * `client.beta.messages.stream()` call per `step()`, NOT the SDK's Tool
 * Runner (`client.beta.messages.toolRunner`) - even though the Claude API
 * skill recommends the Tool Runner for most agents. Two things about this
 * system rule that out:
 *
 *   1. Every LLM call *and* every individual tool call needs to persist a
 *      `run_step` row (PLAN.md 4.1: "Every LLM call and tool call is
 *      recorded as a run_step with token counts and cost") - the Tool
 *      Runner drives the whole loop internally, so there's no seam to hook
 *      per-tool-call persistence into between iterations the way this
 *      system needs.
 *   2. `LLMProvider` (see ./types.ts) is a provider-agnostic interface -
 *      the same run executor in @katnor/agents drives Anthropic,
 *      OpenAI-compatible, Google, and Ollama hires (PLAN.md 4.1) through
 *      identical `step()` calls. A Tool Runner is Anthropic-only by
 *      construction.
 *
 * @katnor/agents' run executor owns the actual `while` loop: call
 * `step()`, execute any `tool_use` blocks via the tool registry, append a
 * `tool_result` per call, call `step()` again - see the Claude API skill's
 * "Manual Agentic Loop" pattern, generalized here to more than one
 * provider.
 */

let cachedClient: Anthropic | undefined;

function getClient(): Anthropic {
  // Reads ANTHROPIC_API_KEY from the environment by default. Per-agent
  // provider overrides (a different key/base URL from `provider_config`,
  // decrypted by apps/server) are a Phase 5 concern (PLAN.md Phase 5:
  // "OpenAI-compatible and Google provider adapters" is where per-provider
  // credential plumbing gets built out generally) - every agent uses the
  // one company-wide Anthropic key for now.
  cachedClient ??= new Anthropic();
  return cachedClient;
}

interface ModelProfile {
  thinkingMode: 'adaptive' | 'omit_param' | 'none';
  supportsEffort: boolean;
  supportsTaskBudget: boolean;
  /**
   * Whether to request the server-side refusal fallback chain by default,
   * per the Claude API skill: "When you write claude-fable-5-1 or
   * claude-opus-5 code, include the server-side fallbacks parameter by
   * default." Left off for Sonnet/Haiku/older models, which the skill
   * doesn't call out the same way.
   */
  useFallbackDefault: boolean;
  maxContextTokens: number;
  /**
   * Which web_search/web_fetch tool generation this model supports (Claude
   * API skill's Server Tools table): "dynamic" is the newer
   * `_20260209` type with built-in filtering (Opus 5/4.8/4.7/4.6, Sonnet
   * 5, Sonnet 4.6, Fable/Mythos); "basic" is the older `_20250305`/
   * `_20250910` type for everything else (Haiku 4.5, unrecognized models).
   */
  webToolGeneration: 'dynamic' | 'basic';
}

/**
 * A small, hand-maintained table of per-model-family request shapes - see
 * the Claude API skill's Thinking & Effort compatibility table. Not
 * exhaustive; unrecognized/older model ids fall through to the most
 * conservative profile (no adaptive thinking, no effort, no task budget).
 */
function resolveModelProfile(model: string): ModelProfile {
  // Claude Fable 5 / 5.1, Mythos 5 / 5.1: thinking is always on and the
  // `thinking` param must be omitted entirely - explicitly setting it
  // (even `{type: "adaptive"}`) is accepted, but simplest and per the
  // skill's own recommendation is to just not send it.
  if (/^claude-(fable|mythos)-5(-1)?$/.test(model)) {
    return {
      thinkingMode: 'omit_param',
      supportsEffort: true,
      supportsTaskBudget: true,
      useFallbackDefault: true,
      maxContextTokens: 1_000_000,
      webToolGeneration: 'dynamic',
    };
  }
  if (model === 'claude-opus-5') {
    return {
      thinkingMode: 'adaptive',
      supportsEffort: true,
      supportsTaskBudget: true,
      useFallbackDefault: true,
      maxContextTokens: 1_000_000,
      webToolGeneration: 'dynamic',
    };
  }
  if (model === 'claude-sonnet-5' || model === 'claude-opus-4-8' || model === 'claude-opus-4-7') {
    return {
      thinkingMode: 'adaptive',
      supportsEffort: true,
      supportsTaskBudget: true,
      useFallbackDefault: false,
      maxContextTokens: 1_000_000,
      webToolGeneration: 'dynamic',
    };
  }
  if (model === 'claude-opus-4-6' || model === 'claude-sonnet-4-6') {
    return {
      thinkingMode: 'adaptive',
      supportsEffort: true,
      supportsTaskBudget: false,
      useFallbackDefault: false,
      maxContextTokens: 1_000_000,
      webToolGeneration: 'dynamic',
    };
  }
  // claude-haiku-4-5 and anything else unrecognized: no adaptive thinking
  // (Haiku needs the deprecated `budget_tokens` form for thinking, which
  // this system doesn't use), no `effort` (Haiku errors on it), no task
  // budget (Haiku isn't in the Task Budgets model list).
  return {
    thinkingMode: 'none',
    supportsEffort: false,
    supportsTaskBudget: false,
    useFallbackDefault: false,
    maxContextTokens: 200_000,
    webToolGeneration: 'basic',
  };
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const TASK_BUDGET_BETA = 'task-budgets-2026-03-13';
const THINKING_UPDATES_BETA = 'thinking-display-updates-2026-08-18';
/** Anthropic requires a task budget of at least this many tokens. */
const MIN_TASK_BUDGET_TOKENS = 20_000;

/** Maps this system's provider-agnostic `ToolChoice` to Anthropic's `tool_choice` request field. */
function toAnthropicToolChoice(choice: ToolChoice | undefined): Anthropic.Beta.BetaToolChoice {
  if (choice?.type === 'tool') {
    return { type: 'tool', name: choice.name } as Anthropic.Beta.BetaToolChoice;
  }
  return { type: 'auto' };
}

/** The concrete Anthropic tool `type` string for a `ProviderTool.serverType` tag, per model generation. */
function resolveServerToolType(
  tag: 'web_search' | 'web_fetch',
  generation: ModelProfile['webToolGeneration'],
): string {
  if (tag === 'web_search') {
    return generation === 'dynamic' ? 'web_search_20260209' : 'web_search_20250305';
  }
  // web_fetch has no "basic" fallback in the skill's table for Vertex, but
  // this adapter only ever talks to the first-party API, where
  // web_fetch_20250910 is the documented pre-dynamic-filtering type.
  return generation === 'dynamic' ? 'web_fetch_20260209' : 'web_fetch_20250910';
}

function toAnthropicTools(
  tools: ProviderTool[],
  profile: ModelProfile,
): Anthropic.Beta.BetaToolUnion[] {
  return tools.map((tool) => {
    // A server-side tool (web_search/web_fetch - PLAN.md 4.3) is declared
    // by type+name alone; Anthropic supplies the real schema, so
    // description/inputSchema are ignored for these.
    if (tool.serverType) {
      return {
        type: resolveServerToolType(tool.serverType, profile.webToolGeneration),
        name: tool.name,
      } as Anthropic.Beta.BetaToolUnion;
    }
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    };
  });
}

/**
 * Converts one of our abstract `ProviderMessage`s into an Anthropic
 * `BetaMessageParam`. Thinking blocks keep their `signature` (see
 * ./types.ts's `ThinkingBlock` doc comment on why that matters) so an
 * assistant turn can be replayed verbatim on a later `step()` call within
 * the same run.
 */
function toAnthropicMessage(message: ProviderMessage): Anthropic.Beta.BetaMessageParam {
  const content: Anthropic.Beta.BetaContentBlockParam[] = message.content.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'thinking':
        // A thinking block with no signature was never actually returned by
        // the API (e.g. an empty "omitted"-display placeholder) - sending it
        // back as a real `thinking` block would be rejected, so it's
        // dropped rather than round-tripped.
        return block.signature
          ? { type: 'thinking', thinking: block.text, signature: block.signature }
          : { type: 'text', text: '' };
      case 'tool_use':
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: block.content,
          is_error: block.isError,
        };
      case 'server_tool':
        // Echoed back exactly as Anthropic returned it - see ./types.ts's
        // ServerToolBlock doc comment.
        return block.raw as Anthropic.Beta.BetaContentBlockParam;
      default: {
        const exhaustive: never = block;
        throw new Error(
          `toAnthropicMessage: unhandled content block ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  });
  // A message made only of dropped (signature-less) thinking blocks would
  // otherwise become empty content, which the API rejects - guard with a
  // single empty text block in that (rare) case.
  return {
    role: message.role,
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
  };
}

function fromAnthropicContent(blocks: Anthropic.Beta.BetaContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      result.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      result.push({ type: 'thinking', text: block.thinking, signature: block.signature });
    } else if (block.type === 'tool_use') {
      result.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    } else if (
      block.type === 'server_tool_use' ||
      block.type === 'web_search_tool_result' ||
      block.type === 'web_fetch_tool_result'
    ) {
      // Anthropic issued *and executed* this within the same turn (PLAN.md
      // 4.3's web_search/web_fetch) - nothing for the run executor's tool
      // registry to dispatch. Carried through opaquely so it can be
      // echoed back verbatim on a later `step()` call - see
      // ServerToolBlock's doc comment in ./types.ts.
      result.push({ type: 'server_tool', raw: block });
    }
    // Other block types (redacted_thinking, citations, fallback markers,
    // ...) aren't part of this system's tool-calling loop yet and are
    // intentionally dropped rather than guessed at.
  }
  return result;
}

function toStopReason(anthropicStopReason: string | null): StepStopReason {
  switch (anthropicStopReason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'pause_turn':
      // A server-side tool (not used by this system yet) hit its own
      // iteration limit and can be resumed by sending the same request
      // again - from the run executor's point of view that's "not done,
      // but not a tool call either," which the caller should just treat as
      // "call step() again with the same messages." Reporting it as
      // 'end_turn' would end the run early; 'tool_use' would look for tool
      // calls that don't exist. Neither abstract stop reason fits, so this
      // maps to 'error' with a message the executor can special-case if it
      // ever starts using server-side tools.
      return 'error';
    default:
      return 'error';
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly id: ModelProvider = 'anthropic';

  capabilities(model: string): ProviderCapabilities {
    const profile = resolveModelProfile(model);
    return {
      supportsThinking: profile.thinkingMode !== 'none',
      supportsEffort: profile.supportsEffort,
      supportsPromptCaching: true,
      supportsTaskBudget: profile.supportsTaskBudget,
      maxContextTokens: profile.maxContextTokens,
    };
  }

  async step(input: StepInput): Promise<StepResult> {
    const profile = resolveModelProfile(input.model);
    const betas: string[] = [];

    let thinking: Anthropic.Beta.BetaThinkingConfigParam | undefined;
    if (profile.thinkingMode === 'adaptive') {
      if (input.thinkingDisplay === 'updated') {
        betas.push(THINKING_UPDATES_BETA);
        thinking = {
          type: 'adaptive',
          display: 'updates',
        } as Anthropic.Beta.BetaThinkingConfigParam;
      } else if (input.thinkingDisplay === 'summarized') {
        thinking = { type: 'adaptive', display: 'summarized' };
      } else {
        thinking = { type: 'adaptive' };
      }
    }
    // 'omit_param' (Fable/Mythos) and 'none' (Haiku/older) both leave
    // `thinking` undefined - the former because the API rejects the param
    // outright, the latter because adaptive thinking isn't available and
    // this system doesn't use the legacy `budget_tokens` form.

    const outputConfig: { effort?: string; task_budget?: { type: 'tokens'; total: number } } = {};
    if (profile.supportsEffort) {
      outputConfig.effort = input.effort;
    }
    if (
      profile.supportsTaskBudget &&
      input.taskBudgetTokens &&
      input.taskBudgetTokens >= MIN_TASK_BUDGET_TOKENS
    ) {
      betas.push(TASK_BUDGET_BETA);
      outputConfig.task_budget = { type: 'tokens', total: input.taskBudgetTokens };
    }

    let fallbacks: 'default' | undefined;
    if (profile.useFallbackDefault) {
      betas.push(FALLBACK_BETA);
      fallbacks = 'default';
    }

    // No explicit `stream: true` field here - unlike `.create()`, the
    // Claude API skill's own `.stream()` examples never pass one (the
    // method itself is what opts into streaming); this object's exact
    // type is left to be inferred from `.stream()`'s own parameter type
    // rather than annotated, since the right params type name for the
    // *streaming* call may differ from `MessageCreateParamsStreaming`
    // (which likely names the *non-streaming* `.create()` call's shape
    // when `stream: true` is passed there instead).
    const requestBody = {
      model: input.model,
      max_tokens: input.maxTokens,
      system: [
        {
          type: 'text' as const,
          text: input.systemPrompt,
          cache_control: { type: 'ephemeral' as const },
        },
      ],
      tools: toAnthropicTools(input.tools, profile),
      tool_choice: toAnthropicToolChoice(input.toolChoice),
      messages: input.messages.map(toAnthropicMessage),
      ...(thinking ? { thinking } : {}),
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
      ...(fallbacks ? { fallbacks } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(betas.length > 0 ? { betas: betas as Anthropic.Beta.AnthropicBeta[] } : {}),
    };

    let response: Anthropic.Beta.BetaMessage;
    try {
      const stream = getClient().beta.messages.stream(requestBody);
      response = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        return {
          content: [],
          stopReason: 'error',
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          costUsd: 0,
          errorMessage: `Anthropic API error (${err.status}): ${err.message}`,
        };
      }
      throw err;
    }

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    };

    return {
      content: fromAnthropicContent(response.content),
      stopReason: toStopReason(response.stop_reason),
      usage,
      costUsd: estimateCostUsd(input.model, usage),
      refusalCategory:
        response.stop_reason === 'refusal' ? (response.stop_details?.category ?? null) : undefined,
    };
  }
}
