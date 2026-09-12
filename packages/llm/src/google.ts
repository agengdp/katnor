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
 * The Google (Gemini) adapter - PLAN.md 4.1's "Google comes third." Built
 * on plain `fetch` against the Generative Language API's `generateContent`
 * REST endpoint, not the `@google/generative-ai` npm package - same
 * rationale as ./openaiCompatible.ts: this sandbox never had registry
 * access to install/verify that SDK, and the REST wire format is stable
 * and documented enough to hand-roll directly.
 *
 * Like ./openaiCompatible.ts, config (base URL / API key) comes from the
 * `provider_config` row for `"google"` (Settings > Providers), not an env
 * var - the base URL defaults to the real API only when the row leaves it
 * unset (see ../../apps/web/src/routes/settings/+page.svelte's hint text:
 * "Defaults to the Google AI API - only set this for a proxy").
 *
 * One real wire-format mismatch this adapter has to paper over: Gemini's
 * `functionCall`/`functionResponse` parts have no call id at all (unlike
 * Anthropic's `tool_use.id` or OpenAI's `tool_calls[].id`) - a
 * `functionResponse` is matched back to its call by function *name* and
 * position alone. Our abstract `ToolUseBlock`/`ToolResultBlock` pair
 * requires an id (see ./types.ts's doc comment - the run executor uses it
 * to pair a tool's result with its call), so this adapter synthesizes one
 * when parsing a response (`step()`, `call-<turnPrefix>-<partIndex>` - see
 * its `turnPrefix` comment for why it's unique run-wide, not just within
 * one response) and resolves it back to a function name when building the
 * next request (`toGeminiContents`'s `toolCallNames` map, built by
 * scanning every `ToolUseBlock` across the whole message history first).
 */

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';

async function readConfig(): Promise<{ baseUrl: string; apiKey: string } | { error: string }> {
  try {
    const row = await providerConfigRepo.getByProvider('google');
    if (!row) {
      return {
        error: 'No "google" provider is configured yet - add an API key under Settings > Providers.',
      };
    }
    if (!row.enabled) {
      return { error: 'The "google" provider is disabled in Settings > Providers.' };
    }
    if (!row.api_key_encrypted) {
      return { error: 'The "google" provider has no API key configured in Settings > Providers.' };
    }
    const baseUrl = row.base_url ? row.base_url.replace(/\/+$/, '') : DEFAULT_BASE_URL;
    return { baseUrl, apiKey: decryptSecret(row.api_key_encrypted) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to load the "google" provider config: ${message}` };
  }
}

function toGeminiToolChoice(
  choice: ToolChoice | undefined,
): { mode: 'AUTO' | 'ANY'; allowedFunctionNames?: string[] } {
  if (choice?.type === 'tool') {
    return { mode: 'ANY', allowedFunctionNames: [choice.name] };
  }
  return { mode: 'AUTO' };
}

function toGeminiTools(tools: ProviderTool[]): unknown[] {
  // Server-side tools (Anthropic's web_search/web_fetch) have no generic
  // Gemini equivalent declared this way - dropped, same as
  // ./openaiCompatible.ts's toOpenAiTools.
  const declarations = tools
    .filter((tool) => !tool.serverType)
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema }));
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : [];
}

type GeminiPart =
  | { text: string }
  // `args` is optional in Gemini's own schema - omitted entirely for a
  // zero-argument function call, not sent as `{}`.
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * Every `ToolUseBlock` id this adapter has ever synthesized, mapped back
 * to its function name - see this file's module doc comment.
 */
function collectToolCallNames(messages: ProviderMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') names.set(block.id, block.name);
    }
  }
  return names;
}

function toGeminiContents(messages: ProviderMessage[]): GeminiContent[] {
  const toolCallNames = collectToolCallNames(messages);
  const result: GeminiContent[] = [];

  for (const message of messages) {
    const parts: GeminiPart[] = [];
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'tool_use') {
        parts.push({ functionCall: { name: block.name, args: block.input } });
      } else if (block.type === 'tool_result') {
        const name = toolCallNames.get(block.toolUseId) ?? block.toolUseId;
        // Gemini's functionResponse.response is a JSON object, not a raw
        // string - our ToolResultBlock.content is always a plain string
        // (see ./types.ts), so it's wrapped rather than parsed/guessed at.
        parts.push({
          functionResponse: { name, response: { result: block.content, isError: block.isError ?? false } },
        });
      }
      // 'thinking'/'server_tool' blocks have no Gemini equivalent this
      // adapter models - dropped, same as ./openaiCompatible.ts.
    }
    if (parts.length === 0) parts.push({ text: '' });
    result.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  return result;
}

function toStopReason(finishReason: string | undefined, hadFunctionCall: boolean): StepStopReason {
  if (hadFunctionCall) return 'tool_use';
  switch (finishReason) {
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'refusal';
    case 'STOP':
    case 'FINISH_REASON_UNSPECIFIED':
    case undefined:
      return 'end_turn';
    default:
      return 'error';
  }
}

interface GeminiCandidate {
  content?: { role: 'model'; parts: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Every failure path in `step()` below returns this shape rather than
 * throwing - same convention as ./anthropic.ts's `step()` and
 * ./openaiCompatible.ts's `step()`.
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

export class GoogleProvider implements LLMProvider {
  readonly id: ModelProvider = 'google';

  capabilities(_model: string): ProviderCapabilities {
    // No per-model profile table (unlike ./anthropic.ts): Gemini's context
    // window varies a lot by model family and this adapter has no way to
    // verify specifics against a live catalog - a conservative floor,
    // same reasoning as ./openaiCompatible.ts's capabilities().
    return {
      supportsThinking: false,
      supportsEffort: false,
      // Gemini has an explicit, separately-billed context-caching API
      // (create a cache, reference it by name) - a fundamentally different
      // shape from Anthropic's automatic `cache_control: ephemeral`, not
      // something this adapter models as the same capability.
      supportsPromptCaching: false,
      supportsTaskBudget: false,
      maxContextTokens: 128_000,
    };
  }

  async step(input: StepInput): Promise<StepResult> {
    const config = await readConfig();
    if ('error' in config) {
      return errorResult(config.error);
    }

    const geminiTools = toGeminiTools(input.tools);
    const requestBody: Record<string, unknown> = {
      contents: toGeminiContents(input.messages),
      systemInstruction: { parts: [{ text: input.systemPrompt }] },
      generationConfig: {
        maxOutputTokens: input.maxTokens,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      },
      ...(geminiTools.length > 0
        ? { tools: geminiTools, toolConfig: { functionCallingConfig: toGeminiToolChoice(input.toolChoice) } }
        : {}),
    };

    const url = `${config.baseUrl}/${API_VERSION}/models/${encodeURIComponent(input.model)}:generateContent`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`Google API request failed: ${message}`);
    }

    // Reading the body (`.text()`/`.json()`) can itself throw - a dropped
    // connection mid-read, or a proxy/misconfigured base_url returning a
    // truncated or non-JSON body - so this whole section is wrapped rather
    // than just the initial `fetch()` call above, to keep the "every
    // failure path returns `errorResult()`, never throws" contract intact.
    try {
      if (!response.ok) {
        const body = await response.text();
        return errorResult(`Google API returned ${response.status}: ${body.slice(0, 500)}`);
      }

      const json = (await response.json()) as GeminiResponse;
      const candidate = json.candidates?.[0];
      if (!candidate?.content) {
        return errorResult('Google API returned no candidates.');
      }

      // `input.messages.length` (the history length *before* this step's
      // reply gets appended to it) strictly increases every step() call
      // within a run, so combined with the part's own index it gives each
      // synthesized id below a value that's unique for the life of the
      // run - not just within this one response. That matters:
      // `toGeminiContents` (called fresh on every step(), scanning the
      // *entire* history) would otherwise let a later turn's id silently
      // overwrite an earlier turn's entry in `collectToolCallNames`'s
      // map, sending the wrong function name back to Gemini for an older
      // tool result.
      const turnPrefix = input.messages.length;
      const content: ContentBlock[] = [];
      let hadFunctionCall = false;
      candidate.content.parts.forEach((part, index) => {
        if ('text' in part && part.text.length > 0) {
          content.push({ type: 'text', text: part.text });
        } else if ('functionCall' in part) {
          hadFunctionCall = true;
          content.push({
            type: 'tool_use',
            // Synthesized - Gemini issues no call id of its own. See the
            // `turnPrefix` comment above for why it's unique run-wide,
            // not just within this response.
            id: `call-${turnPrefix}-${index}`,
            name: part.functionCall.name,
            input: part.functionCall.args ?? {},
          });
        }
      });

      const usage = {
        inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };

      return {
        content,
        stopReason: toStopReason(candidate.finishReason, hadFunctionCall),
        usage,
        // No generic price table for Google models here either - see
        // ./openaiCompatible.ts's identical costUsd comment for why this
        // is 0 rather than guessed at, and what that means for budget
        // enforcement (../agents/src/runExecutor.ts's
        // checkBudgetHardStop doc comment cross-references this).
        costUsd: 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`Failed to read Google API response: ${message}`);
    }
  }
}
