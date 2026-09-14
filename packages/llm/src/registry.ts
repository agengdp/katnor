import type { ModelProvider } from '@katnor/core';
import { AnthropicProvider } from './anthropic.js';
import { ComboProvider } from './combo.js';
import { GoogleProvider } from './google.js';
import { OpenAiCompatibleProvider } from './openaiCompatible.js';
import type { LLMProvider } from './types.js';

const anthropicProvider = new AnthropicProvider();
const openAiCompatibleProvider = new OpenAiCompatibleProvider('openai_compatible');
// PLAN.md 4.1: "The OpenAI-compatible adapter covers OpenAI, and any local
// server with the same wire format (Ollama, vLLM)." Ollama's own
// `/v1/chat/completions` shim is that same wire format, so "ollama" gets
// its own instance of the same OpenAiCompatibleProvider class - not a
// separate adapter file - configured against its own `provider_config`
// row and its own localhost default (see ./openaiCompatible.ts's
// constructor).
const ollamaProvider = new OpenAiCompatibleProvider('ollama');
const googleProvider = new GoogleProvider();
// `ComboProvider` needs to resolve *other* providers by name at step()
// time, so it takes `getProvider` itself as a callback rather than this
// module importing itself. Referencing `getProvider` here, above its own
// textual declaration, works because a `function` declaration (not a
// `const`/arrow function) is hoisted - see ./combo.ts's doc comment.
const comboProvider = new ComboProvider(getProvider);

/**
 * Resolves a `ModelProvider` (from an agent's `model_config.provider`) to
 * its `LLMProvider` implementation. Every value in `@katnor/core`'s
 * `MODEL_PROVIDERS` is now implemented: "anthropic" (Phase 1),
 * "openai_compatible" and "google" (Phase 5 - see ./openaiCompatible.ts/
 * ./google.ts), "ollama" (also ./openaiCompatible.ts, a second instance -
 * see the doc comment above), and "combo" (./combo.ts - a named ordered
 * fallback chain across the other four).
 */
export function getProvider(provider: ModelProvider): LLMProvider {
  if (provider === 'anthropic') return anthropicProvider;
  if (provider === 'openai_compatible') return openAiCompatibleProvider;
  if (provider === 'ollama') return ollamaProvider;
  if (provider === 'google') return googleProvider;
  if (provider === 'combo') return comboProvider;
  const exhaustive: never = provider;
  throw new Error(`getProvider: unhandled ModelProvider "${exhaustive}"`);
}

export * from './types.js';
export { estimateCostUsd } from './pricing.js';
