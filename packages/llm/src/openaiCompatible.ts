import type { ModelProvider } from '@katnor/core';
import { decryptSecret, providerConfigRepo } from '@katnor/db';
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
 * A generic adapter for any server speaking the OpenAI Chat Completions
 * wire format (`POST {base_url}/chat/completions`) - self-hosted runtimes
 * (vLLM, Ollama, LM Studio, text-generation-webui) and hosted
 * "OpenAI-compatible" APIs (OpenRouter, Together, Groq, ...) alike. Built
 * on plain `fetch`, not the `openai` npm package - this system never had
 * npm registry access to install or verify that SDK against, and the wire
 * format itself (unlike Anthropic's beta surface) is stable and widely
 * documented enough to hand-roll with confidence.
 *
 * PLAN.md 4.1 is explicit that this one adapter is meant to cover more
 * than the literal "openai_compatible" `ModelProvider`: "The
 * OpenAI-compatible adapter covers OpenAI, and any local server with the
 * same wire format (Ollama, vLLM)." Ollama's own `/v1/chat/completions`
 * shim is exactly that same wire format, so rather than duplicating this
 * whole file for a second `ModelProvider` value, ./registry.ts constructs
 * two instances of this same class - one per `provider` constructor arg -
 * each reading its own `provider_config` row (`"openai_compatible"` or
 * `"ollama"`) and reporting its own `id`.
 *
 * Unlike ./anthropic.ts, this adapter has no per-model profile table:
 * an arbitrary third-party/self-hosted server's exact capabilities can't
 * be enumerated ahead of time, so it always requests the lowest common
 * denominator (no thinking, no effort, no task budget, no prompt caching)
 * and never guesses at a model-specific quirk.
 *
 * Unlike ./anthropic.ts (whose key comes straight from
 * `ANTHROPIC_API_KEY`), this adapter's base URL / API key are company-wide
 * settings the owner enters in the dashboard's Settings > Providers section
 * (apps/server/src/trpc/routers/settings.ts's `upsertProvider`), stored on
 * the `provider_config` row for whichever `provider` this instance was
 * constructed with. There's no separate env var for either: `.env.example`'s
 * "LLM providers" section explicitly calls out that only Anthropic's key
 * lives there, precisely so a non-OpenAI, non-embeddings endpoint's
 * credentials go through the encrypted `provider_config`/`secret` store
 * like everything else in Settings.
 */

/** The two `ModelProvider` values this one adapter serves - see the module doc comment above. */
type OpenAiCompatibleProviderId = Extract<ModelProvider, 'openai_compatible' | 'ollama'>;

/**
 * Reads and decrypts the `provider_config` row for `provider`. Never
 * throws - every failure (missing/disabled/misconfigured row, a DB error,
 * or `decryptSecret` rejecting a corrupted/re-keyed ciphertext) comes back
 * as `{error}` instead, so `step()` below can turn it into a clean
 * `{stopReason: 'error'}` result rather than crash the run - the same
 * contract every other failure path in this file (and ./anthropic.ts's
 * `step()`) already follows.
 *
 * `defaultBaseUrl`, when given, is used when the row leaves `base_url`
 * unset - Ollama's registry entry passes its own well-known local default
 * (see ./registry.ts) the way ./anthropic.ts and ./google.ts default to
 * their own real APIs; plain "openai_compatible" has no sensible default
 * (an arbitrary third-party endpoint can't be guessed at) and passes none,
 * so a missing base URL there is a hard error instead.
 */
async function readConfig(
  provider: OpenAiCompatibleProviderId,
  defaultBaseUrl?: string,
): Promise<{ baseUrl: string; apiKey: string | undefined } | { error: string }> {
  try {
    const row = await providerConfigRepo.getByProvider(provider);
    if (!row) {
      if (defaultBaseUrl) return { baseUrl: defaultBaseUrl, apiKey: undefined };
      return {
        error: `No "${provider}" provider is configured yet - add a base URL under Settings > Providers.`,
      };
    }
    if (!row.enabled) {
      return { error: `The "${provider}" provider is disabled in Settings > Providers.` };
    }
    const baseUrl = row.base_url ? row.base_url.replace(/\/+$/, '') : defaultBaseUrl;
    if (!baseUrl) {
      return {
        error: `The "${provider}" provider has no base URL configured in Settings > Providers.`,
      };
    }
    return {
      baseUrl,
      // Self-hosted servers (vLLM, Ollama, ...) commonly need no auth at all -
      // an unset key isn't an error here, unlike a missing base URL.
      apiKey: row.api_key_encrypted ? decryptSecret(row.api_key_encrypted) : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to load the "${provider}" provider config: ${message}` };
  }
}

/** Maps this system's provider-agnostic `ToolChoice` to the OpenAI `tool_choice` request field. */
function toOpenAiToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice?.type === 'tool') {
    return { type: 'function', function: { name: choice.name } };
  }
  return 'auto';
}

/** Server-side tools (Anthropic's web_search/web_fetch, PLAN.md 4.3) have no generic OpenAI-compatible equivalent - dropped rather than guessed at, per `ProviderTool.serverType`'s doc comment ("a provider that doesn't support a given tag should skip it"). */
function toOpenAiTools(tools: ProviderTool[]): unknown[] {
  return tools
    .filter((tool) => !tool.serverType)
    .map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

/**
 * Converts our abstract `ProviderMessage`s to the OpenAI message list.
 * Unlike Anthropic, OpenAI has no single "user message with mixed text and
 * tool_result blocks" shape - each `ToolResultBlock` becomes its own
 * `role: 'tool'` message, and a message can't mix tool results with plain
 * text, so a `ProviderMessage` splits into as many OpenAI messages as it
 * has distinct block kinds require. `ThinkingBlock`/`ServerToolBlock` have
 * no OpenAI-compatible equivalent and are dropped - see this file's module
 * doc comment.
 */
function toOpenAiMessages(messages: ProviderMessage[]): OpenAiMessage[] {
  const result: OpenAiMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const toolResults = message.content.filter(
        (block): block is Extract<ContentBlock, { type: 'tool_result' }> => block.type === 'tool_result',
      );
      for (const block of toolResults) {
        result.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content });
      }
      const text = message.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      if (text.length > 0) {
        result.push({ role: 'user', content: text });
      }
      continue;
    }

    // assistant
    const toolCalls: OpenAiToolCall[] = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      }));
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    result.push({
      role: 'assistant',
      content: text.length > 0 ? text : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return result;
}

function toStopReason(finishReason: string | null | undefined): StepStopReason {
  switch (finishReason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'stop':
    case null:
    case undefined:
      return 'end_turn';
    default:
      return 'error';
  }
}

interface OpenAiChoice {
  message: { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] };
  finish_reason: string | null;
}

interface OpenAiChatCompletionResponse {
  choices: OpenAiChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Every failure path in `step()` below returns this shape rather than
 * throwing - same convention as ./anthropic.ts's `step()` and
 * ./google.ts's `step()`.
 */
function errorResult(errorMessage: string): StepResult {
  return {
    content: [],
    stopReason: 'error',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0,
    errorMessage,
  };
}

/**
 * Ollama's own well-known local default, with its OpenAI-compatible
 * shim's `/v1` prefix - see this file's module doc comment.
 */
const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

export class OpenAiCompatibleProvider implements LLMProvider {
  readonly id: ModelProvider;
  private readonly provider: OpenAiCompatibleProviderId;
  private readonly defaultBaseUrl: string | undefined;

  constructor(provider: OpenAiCompatibleProviderId) {
    this.id = provider;
    this.provider = provider;
    this.defaultBaseUrl = provider === 'ollama' ? OLLAMA_DEFAULT_BASE_URL : undefined;
  }

  capabilities(_model: string): ProviderCapabilities {
    // Deliberately the most conservative profile: an arbitrary third-party
    // server's actual context window and feature set can't be known ahead
    // of time the way ./anthropic.ts's hand-maintained table knows
    // Anthropic's. `maxContextTokens` here is a defensive floor, not a
    // measured value - PLAN.md's per-agent model config is the place to
    // pick a model that server actually supports.
    return {
      supportsThinking: false,
      supportsEffort: false,
      supportsPromptCaching: false,
      supportsTaskBudget: false,
      maxContextTokens: 32_000,
    };
  }

  async step(input: StepInput): Promise<StepResult> {
    const config = await readConfig(this.provider, this.defaultBaseUrl);
    if ('error' in config) {
      return errorResult(config.error);
    }

    const openAiTools = toOpenAiTools(input.tools);
    const requestBody: Record<string, unknown> = {
      model: input.model,
      max_tokens: input.maxTokens,
      messages: [{ role: 'system', content: input.systemPrompt }, ...toOpenAiMessages(input.messages)],
      ...(openAiTools.length > 0 ? { tools: openAiTools, tool_choice: toOpenAiToolChoice(input.toolChoice) } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    };

    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`"${this.provider}" endpoint request failed: ${message}`);
    }

    // Reading the body (`.text()`/`.json()`) can itself throw - a dropped
    // connection mid-read, or a server returning a truncated or non-JSON
    // body - so this whole section is wrapped rather than just the
    // initial `fetch()` call above, to keep the "every failure path
    // returns `errorResult()`, never throws" contract intact.
    try {
      if (!response.ok) {
        const body = await response.text();
        return errorResult(
          `"${this.provider}" endpoint returned ${response.status}: ${body.slice(0, 500)}`,
        );
      }

      const json = (await response.json()) as OpenAiChatCompletionResponse;
      const choice = json.choices[0];
      if (!choice) {
        return errorResult(`"${this.provider}" endpoint returned no choices.`);
      }

      const content: ContentBlock[] = [];
      if (choice.message.content && choice.message.content.trim().length > 0) {
        content.push({ type: 'text', text: choice.message.content });
      }
      for (const toolCall of choice.message.tool_calls ?? []) {
        let parsedInput: Record<string, unknown> = {};
        try {
          parsedInput = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        } catch {
          // A non-conforming server sent unparseable JSON arguments -
          // surface the raw string to the model/tool rather than crashing
          // the run; most tool schemas will reject this shape on their
          // own, which is a clearer failure than losing the call entirely.
          console.warn(
            `[llm/${this.provider}] tool call "${toolCall.function.name}" had unparseable arguments:`,
            toolCall.function.arguments,
          );
        }
        content.push({ type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input: parsedInput });
      }

      const usage = {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };

      return {
        content,
        stopReason: toStopReason(choice.finish_reason),
        usage,
        // No generic price table exists for an arbitrary third-party/
        // self-hosted endpoint the way ./pricing.ts has for Anthropic's
        // own models - reported as $0 rather than guessed at, so
        // budget/cost-dashboard numbers stay honest (spend on this
        // provider is currently untracked, not "free"; a future phase
        // could add a configurable $/MTok rate on `provider_config` per
        // PLAN.md 4.7's cost tracking - moot for a genuinely free local
        // Ollama model, but not for a paid "openai_compatible" endpoint).
        costUsd: 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`Failed to read "${this.provider}" endpoint response: ${message}`);
    }
  }
}
