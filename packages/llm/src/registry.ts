import type { ModelProvider } from '@katnor/core';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiCompatibleProvider } from './openaiCompatible.js';
import type { LLMProvider } from './types.js';

const anthropicProvider = new AnthropicProvider();
const openAiCompatibleProvider = new OpenAiCompatibleProvider();

/**
 * Resolves a `ModelProvider` (from an agent's `model_config.provider`) to
 * its `LLMProvider` implementation. "anthropic" (Phase 1) and
 * "openai_compatible" (Phase 5 - see ./openaiCompatible.ts) are
 * implemented; "google" and "ollama" are not, so hiring an agent onto one
 * of those providers today is accepted by the schema but will fail loudly
 * the first time that agent actually runs, rather than silently falling
 * back to a different provider.
 */
export function getProvider(provider: ModelProvider): LLMProvider {
  if (provider === 'anthropic') return anthropicProvider;
  if (provider === 'openai_compatible') return openAiCompatibleProvider;
  throw new Error(
    `getProvider: no LLMProvider implemented yet for "${provider}" - only "anthropic" and "openai_compatible" are available in this phase.`,
  );
}

export * from './types.js';
export { estimateCostUsd } from './pricing.js';
