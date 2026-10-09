import { z } from 'zod';
import { withBase } from './base.js';

/**
 * How a Model spreads calls across its entries.
 *
 * - `round_robin`: weighted rotation - each call picks the next entry by
 *   weight (e.g. weights 70/30 send ~70% of calls to the first). Spreads
 *   load/cost across connections.
 * - `fallback`: strict order - always try the first entry, fall to the
 *   next only when one errors. Cheapest-first ordering.
 * - `router`: reserved for a future cost/latency router. Accepted but
 *   behaves as `fallback` until one exists - never silently dropped, so
 *   a saved strategy never becomes invalid input later.
 */
export const MODEL_STRATEGIES = ['round_robin', 'fallback', 'router'] as const;
export type ModelStrategy = (typeof MODEL_STRATEGIES)[number];

export const modelStrategySchema = z.enum(MODEL_STRATEGIES);

/**
 * One entry in a Model's mapping - a concrete (provider connection,
 * model) pair plus its round-robin weight. `providerConnectionId` is a
 * `provider_config` row id (Settings > Providers), NOT a provider type:
 * two entries can share the same type through different connections
 * (e.g. "OpenAI utama" and "OpenAI murah") with different keys.
 *
 * Weight is a positive integer share, not a percentage - 70/30 and 7/3
 * behave identically. `1` (the default) means "equal share". Kept as an
 * integer so the rotation is exact (no float drift over thousands of
 * calls) and the UI can offer simple +/- steppers.
 */
export const modelEntrySchema = z.object({
  providerConnectionId: z.string().min(1),
  model: z.string().trim().min(1),
  weight: z.number().int().positive().default(1),
});
export type ModelEntry = z.infer<typeof modelEntrySchema>;

/**
 * A named Model mapping (Settings > Models): `{name, entries, strategy}`.
 * An agent hired onto `provider: "model"` stores this `name` in
 * `model_config.model` rather than a real model id - @katnor/llm's
 * ModelRouter resolves the name, picks an entry per `strategy`, and
 * records which connection+model actually answered in `servedBy`.
 *
 * Legacy `model_combo` rows (`{name, entries: [{provider, model}]}`) are
 * read as strategy `fallback` with weight 1 per entry - see
 * @katnor/llm's router for the compat path.
 */
export const modelComboFields = {
  name: z.string().min(1),
  entries: z.array(modelEntrySchema).min(1),
  strategy: modelStrategySchema.default('fallback'),
};

export const modelComboSchema = withBase(modelComboFields);
export type ModelCombo = z.infer<typeof modelComboSchema>;

export const createModelComboInputSchema = z.object(modelComboFields);
export type CreateModelComboInput = z.infer<typeof createModelComboInputSchema>;

/**
 * Back-compat for `model_combo.entries` rows written before connections
 * existed (`{provider, model}` with no connection id or weight). The
 * router resolves `provider` to that type's default connection (first
 * enabled row) at call time, so old rows keep working without a data
 * migration - they just can't address a non-default connection until
 * re-saved through Settings > Models.
 */
export const legacyModelComboEntrySchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type LegacyModelComboEntry = z.infer<typeof legacyModelComboEntrySchema>;
