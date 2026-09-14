import { z } from 'zod';
import { MODEL_COMBO_ENTRY_PROVIDERS } from '../enums.js';
import { withBase } from './base.js';

/**
 * One entry in a `model_combo`'s ordered fallback chain - a concrete
 * (provider, model) pair, same shape as `agent.model_config.provider`/
 * `.model` but without the effort/thinking/token-limit fields (those stay
 * per-agent, not per-combo-entry - every entry in a combo answers the same
 * request the same way the agent asked for it, just against a different
 * backend).
 */
export const modelComboEntrySchema = z.object({
  provider: z.enum(MODEL_COMBO_ENTRY_PROVIDERS),
  model: z.string().min(1),
});
export type ModelComboEntry = z.infer<typeof modelComboEntrySchema>;

/**
 * A named, reusable fallback chain across providers/models (e.g. hire
 * something onto "claude-opus-combo": try Anthropic's claude-opus-5 first,
 * fall back to Google's gemini-2.5-pro, then a self-hosted Ollama model,
 * in that order, on any error). Selected the same way any other model is:
 * an agent's `model_config.provider` is `"combo"` and `.model` holds this
 * `name` - see @katnor/llm's src/combo.ts, the `LLMProvider` that
 * implements the actual fallback loop.
 */
export const modelComboFields = {
  name: z.string().min(1),
  entries: z.array(modelComboEntrySchema).min(1),
};

export const modelComboSchema = withBase(modelComboFields);
export type ModelCombo = z.infer<typeof modelComboSchema>;

export const createModelComboInputSchema = z.object(modelComboFields);
export type CreateModelComboInput = z.infer<typeof createModelComboInputSchema>;
