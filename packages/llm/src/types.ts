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

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

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
}

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
