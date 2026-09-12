import type { ModelProvider } from '@katnor/core';
import { AnthropicProvider } from './anthropic.js';
import type { LLMProvider } from './types.js';

const anthropicProvider = new AnthropicProvider();

/**
 * Resolves a `ModelProvider` (from an agent's `model_config.provider`) to
 * its `LLMProvider` implementation. Only "anthropic" is implemented in
 * Phase 1 - "openai_compatible", "google", and "ollama" are Phase 5
 * (PLAN.md Phase 5: "OpenAI-compatible and Google provider adapters"), so
 * hiring an agent onto one of those providers today is accepted by the
 * schema but will fail loudly the first time that agent actually runs,
 * rather than silently falling back to a different provider.
 */
export function getProvider(provider: ModelProvider): LLMProvider {
  if (provider === 'anthropic') return anthropicProvider;
  throw new Error(
    `getProvider: no LLMProvider implemented yet for "${provider}" - only "anthropic" is available in this phase.`,
  );
}

export * from './types.js';
export { estimateCostUsd } from './pricing.js';
