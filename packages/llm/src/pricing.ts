import type { StepUsage } from './types.js';

/**
 * $/million-token rates, as of the Claude API skill's cached model table
 * (2026-06-24). Anthropic's `/v1/models` endpoint (see apps/server's
 * src/modelCatalog.ts) does not return pricing, so this is a small,
 * hand-maintained table rather than something fetched live - keep it in
 * sync with https://www.anthropic.com/pricing when new models ship.
 *
 * Cache pricing is approximated as 1.25x the input rate for cache writes
 * and 0.1x the input rate for cache reads, which holds for every model
 * below except Claude Fable 5 / Fable 5.1, which bill cache reads at a
 * flat $0.25/MTok instead - not modeled here since neither is used by any
 * default agent yet; revisit if a hire is ever given one of those models.
 */
interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
}

const MODEL_RATES: Record<string, ModelRate> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-mythos-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
};

const FALLBACK_RATE: ModelRate = { inputPerMTok: 5, outputPerMTok: 25 };

function rateFor(model: string): ModelRate {
  const exact = MODEL_RATES[model];
  if (exact) return exact;
  console.warn(`[llm/pricing] no pricing entry for model "${model}" - using the Opus-tier fallback rate`);
  return FALLBACK_RATE;
}

/** Computes the USD cost of one `step()` call's usage for `model`. */
export function estimateCostUsd(model: string, usage: StepUsage): number {
  const rate = rateFor(model);
  const inputCost = (usage.inputTokens / 1_000_000) * rate.inputPerMTok;
  const outputCost = (usage.outputTokens / 1_000_000) * rate.outputPerMTok;
  const cacheWriteCost = (usage.cacheCreationTokens / 1_000_000) * rate.inputPerMTok * 1.25;
  const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * rate.inputPerMTok * 0.1;
  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}
