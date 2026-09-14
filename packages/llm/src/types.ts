import type { ModelEffort, ModelProvider, ThinkingDisplayMode } from '@katnor/core';

/**
 * Provider-agnostic shapes for one turn of the agent loop. Every
 * `LLMProvider` implementation (Anthropic today; OpenAI-compatible, Google,
 * and Ollama in a later phase - see PLAN.md 4.1 and Phase 5) translates
 * these to and from its own wire format. @katnor/agents' run executor is
 * the only thing that talks to these types directly - it owns the loop
 * (call `step()`, execute any requested tool calls, append a
 * `ToolResultBlock` per call, call `step()` again) so it can persist a
 * `run_step` row between every individual call, which rules out using
 * Anthropic's own Tool Runner (which would own tool execution itself) -
 * see src/anthropic.ts's module comment for the fuller rationale.
 */

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ServerToolBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * A (possibly empty, if the model/config doesn't surface one) reasoning
 * summary. `signature` is Anthropic-specific: a cryptographic signature the
 * API attaches to a real thinking block, which must be echoed back
 * unchanged (not regenerated or dropped) when this block is later replayed
 * as part of assistant history on the *same* model - "preserved thinking".
 * Carrying it through our abstract type (rather than only inside the
 * Anthropic adapter) is what lets the run executor re-send a prior
 * assistant turn without silently breaking that invariant. Other
 * providers/models simply won't set or read it.
 */
export interface ThinkingBlock {
  type: 'thinking';
  text: string;
  signature?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  /** Provider-assigned id, echoed back on the matching `ToolResultBlock`. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  /** Stringified result content - tool outputs are treated as untrusted data, never re-parsed as instructions. */
  content: string;
  isError?: boolean;
}

/**
 * A block belonging to a server-side tool (Anthropic's `web_search`/
 * `web_fetch` - PLAN.md 4.3) - Anthropic issues the call *and* executes it
 * within the same API turn, so unlike `ToolUseBlock`/`ToolResultBlock`
 * there is nothing for @katnor/agents' run executor to dispatch through
 * the tool registry; the executor never sees `stopReason: 'tool_use'` on
 * their account. This carries the block through opaquely (`raw`, whatever
 * shape the provider actually used) purely so it can be echoed back
 * unchanged when replaying assistant history on a later `step()` call -
 * the same reason `ThinkingBlock` carries a `signature`. Other providers
 * simply won't produce or need to replay this block type.
 */
export interface ServerToolBlock {
  type: 'server_tool';
  raw: unknown;
}

export type ProviderRole = 'user' | 'assistant';

export interface ProviderMessage {
  role: ProviderRole;
  content: ContentBlock[];
}

export interface ProviderTool {
  name: string;
  description: string;
  /** A JSON Schema object (not a zod schema - kept provider-agnostic and dependency-free to build). */
  inputSchema: Record<string, unknown>;
  /**
   * Set only for a server-side tool (PLAN.md 4.3: `web_search`/`web_fetch`
   * "when the model is Claude"). A generic capability tag, NOT a raw
   * provider type string - the exact wire `type` (e.g. Anthropic's
   * `"web_search_20260209"` vs. the older `"web_search_20250305"`) can
   * depend on which model this request targets, which only the provider
   * adapter knows at request-build time (see @katnor/llm/src/anthropic.ts's
   * `resolveModelProfile`). When set, `description`/`inputSchema` are
   * ignored - the adapter declares the tool by this tag + `name` alone. A
   * provider that doesn't support a given tag should skip it (drop it from
   * the request) rather than error.
   */
  serverType?: 'web_search' | 'web_fetch';
}

/**
 * Forces (or leaves automatic) which tool the model must call this step.
 * Defaults to `{ type: 'auto' }` when omitted - the model decides whether
 * to call a tool at all, same as every agent run. `{ type: 'tool', name }`
 * is PLAN.md 4.4's "structured outputs" extraction call: forcing a single,
 * schema-constrained tool call is this system's stand-in for a dedicated
 * JSON-mode API (see @katnor/knowledge/src/extraction.ts, its only caller)
 * without depending on a provider feature this sandbox has no way to
 * verify against a live API.
 */
export type ToolChoice = { type: 'auto' } | { type: 'tool'; name: string };

export interface StepInput {
  systemPrompt: string;
  messages: ProviderMessage[];
  tools: ProviderTool[];
  model: string;
  effort: ModelEffort;
  thinkingDisplay: ThinkingDisplayMode;
  maxTokens: number;
  temperature?: number;
  /** Advisory token ceiling for the whole run, if the provider supports pacing itself against one. */
  taskBudgetTokens?: number;
  /** Defaults to `{ type: 'auto' }` - see `ToolChoice`'s doc comment. */
  toolChoice?: ToolChoice;
}

export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type StepStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'refusal'
  | 'error';

export interface StepResult {
  content: ContentBlock[];
  stopReason: StepStopReason;
  usage: StepUsage;
  costUsd: number;
  /** Set when `stopReason === 'refusal'`. */
  refusalCategory?: string | null;
  /** Set when `stopReason === 'error'` and the caller should stop retrying (e.g. a 400). */
  errorMessage?: string;
  /**
   * Set only by ./combo.ts's `ComboProvider` - which real (provider, model)
   * pair actually answered this call, since the agent's own
   * `model_config.provider`/`model` just names the combo, not the entry
   * that ended up serving it (earlier entries may have errored and been
   * skipped). Every other adapter leaves this unset; @katnor/agents'
   * runExecutor.ts records it on the `run_step` when present so the Runs
   * page can show which entry actually ran, not just "claude-opus-combo."
   */
  servedBy?: { provider: ModelProvider; model: string };
}

export interface ProviderCapabilities {
  supportsThinking: boolean;
  supportsEffort: boolean;
  supportsPromptCaching: boolean;
  supportsTaskBudget: boolean;
  maxContextTokens: number;
}

export interface LLMProvider {
  readonly id: ModelProvider;
  capabilities(model: string): ProviderCapabilities;
  step(input: StepInput): Promise<StepResult>;
}
