import type { ModelProvider } from '@katnor/core';
import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import { OpenAiCompatibleProvider } from './openaiCompatible.js';
import type { LLMProvider } from './types.js';

const anthropicProvider = new AnthropicProvider();
const openAiCompatibleProvider = new OpenAiCompatibleProvider();
const googleProvider = new GoogleProvider();

/**
 * Resolves a `ModelProvider` (from an agent's `model_config.provider`) to
 * its `LLMProvider` implementation. "anthropic" (Phase 1),
 * "openai_compatible" (Phase 5 - see ./openaiCompatible.ts), and "google"
 * (Phase 5 - see ./google.ts) are implemented; "ollama" is not, so hiring
 * an agent onto that provider today is accepted by the schema but will
 * fail loudly the first time that agent actually runs, rather than
 * silently falling back to a different provider.
 */
export function getProvider(provider: ModelProvider): LLMProvider {
  if (provider === 'anthropic') return anthropicProvider;
  if (provider === 'openai_compatible') return openAiCompatibleProvider;
  if (provider === 'google') return googleProvider;
  throw new Error(
    `getProvider: no LLMProvider implemented yet for "${provider}" - "anthropic", ` +
      '"openai_compatible", and "google" are available in this phase.',
  );
}

export * from './types.js';
export { estimateCostUsd } from './pricing.js';
