import type { ModelProvider } from '@katnor/core';
import { AnthropicProvider } from './anthropic.js';
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

/**
 * Resolves a `ModelProvider` (from an agent's `model_config.provider`) to
 * its `LLMProvider` implementation. Every value in `@katnor/core`'s
 * `MODEL_PROVIDERS` is now implemented: "anthropic" (Phase 1),
 * "openai_compatible" and "google" (Phase 5 - see ./openaiCompatible.ts/
 * ./google.ts), and "ollama" (also ./openaiCompatible.ts, a second
 * instance - see the doc comment above).
 */
export function getProvider(provider: ModelProvider): LLMProvider {
  if (provider === 'anthropic') return anthropicProvider;
  if (provider === 'openai_compatible') return openAiCompatibleProvider;
  if (provider === 'ollama') return ollamaProvider;
  if (provider === 'google') return googleProvider;
  const exhaustive: never = provider;
  throw new Error(`getProvider: unhandled ModelProvider "${exhaustive}"`);
}

export * from './types.js';
export { estimateCostUsd } from './pricing.js';
