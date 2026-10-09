import type {
  LegacyModelComboEntry,
  ModelEntry,
  ModelProvider,
  ModelStrategy,
} from '@katnor/core';
import { modelComboRepo, providerConfigRepo, type ProviderConfigRow } from '@katnor/db';
import type { LLMProvider, ProviderCapabilities, StepInput, StepResult } from './types.js';

/**
 * The "combo"/Model router: a named mapping across provider
 * *connections* (@katnor/core's schemas/modelCombo.ts). An agent hired
 * onto `provider: "combo"` stores the Model's *name* in
 * `model_config.model` rather than a real model id - `step()` below
 * resolves that name to a `model_combo` row, picks entries per its
 * `strategy`, and records which connection+model actually answered in
 * `servedBy`.
 *
 * Entry resolution, per entry:
 *
 *   - New entries carry `providerConnectionId` - a direct `provider_config`
 *     row lookup. Missing/disabled row = entry error (falls through to
 *     the next entry, never silently re-pointed elsewhere).
 *   - Legacy entries (`{provider, model}`, pre-connections) resolve the
 *     provider *type* to its default connection (first enabled row) at
 *     call time, so old rows keep working without a data migration.
 *
 * Strategy:
 *
 *   - `fallback` (+ legacy rows without one): strict order, next entry
 *     only on `stopReason: 'error'`.
 *   - `round_robin`: weighted rotation across entries; a picked entry
 *     that errors falls through to the next entry in rotation order, so
 *     one dead connection degrades rather than failing the call.
 *   - `router`: accepted, behaves as `fallback` until a real
 *     cost/latency router exists.
 *
 * Rotation state is an in-process counter per Model name (mod total
 * weight) - survives across calls, resets on restart. Exact rather than
 * random so a 70/30 split actually sends ~70% over time instead of
 * drifting.
 *
 * Takes `resolveProvider`/`resolveConnection` callbacks rather than
 * importing `./registry.ts` / adapter internals directly: `getProvider`
 * is what constructs this class in the first place, so a direct import
 * the other way would be a circular module dependency. `registry.ts`
 * passes its own functions in - plain function declarations are hoisted,
 * so referencing them before their textual definition is safe.
 */
export class ComboProvider implements LLMProvider {
  readonly id: ModelProvider = 'combo';

  private readonly counters = new Map<string, number>();

  constructor(
    private readonly resolveProvider: (provider: ModelProvider) => LLMProvider,
    private readonly resolveConnection?: (
      connection: ProviderConfigRow,
      model: string,
    ) => LLMProvider,
  ) {}

  capabilities(_model: string): ProviderCapabilities {
    // Deliberately the most conservative profile, same reasoning as
    // ./openaiCompatible.ts's capabilities(): which entry actually serves
    // a given call isn't known until step() runs (an earlier entry might
    // be down), so this can't honestly report one entry's real
    // capabilities as if they were guaranteed. Nothing calls
    // `LLMProvider.capabilities()` yet in this codebase (see its doc
    // comment in ./types.ts) - a future caller should look up the
    // combo's *first* entry's own capabilities() instead of trusting this
    // default, once one exists.
    return {
      supportsThinking: false,
      supportsEffort: false,
      supportsPromptCaching: false,
      supportsTaskBudget: false,
      maxContextTokens: 32_000,
    };
  }

  async step(input: StepInput): Promise<StepResult> {
    let combo;
    try {
      combo = await modelComboRepo.getByName(input.model);
    } catch (err) {
      // A DB error here (e.g. a dropped connection) must not throw out of
      // step() - see this class's own doc comment and ./types.ts's
      // "never throw" contract on LLMProvider.step(): runExecutor.ts's
      // step-loop doesn't wrap `provider.step()` in try/catch, so an
      // uncaught exception here would crash the whole run instead of
      // cleanly marking it failed.
      return errorResult(`Failed to look up model "${input.model}": ${describeError(err)}`);
    }
    if (!combo) {
      return errorResult(
        `No "combo" model named "${input.model}" exists - check Settings > Models.`,
      );
    }
    const rawEntries = combo.entries as (ModelEntry | LegacyModelComboEntry)[];
    if (rawEntries.length === 0) {
      return errorResult(
        `Model "${input.model}" has no entries configured - add at least one in Settings.`,
      );
    }

    const strategy = (combo.strategy ?? 'fallback') as ModelStrategy;
    const sequence = this.trySequence(input.model, rawEntries, strategy);

    let lastResult: StepResult | null = null;
    for (const index of sequence) {
      const entry = rawEntries[index];
      if (!entry) continue;
      const resolved = await this.resolveEntry(entry);
      if ('error' in resolved) {
        lastResult = errorResult(resolved.error);
        continue;
      }
      let result: StepResult;
      try {
        result = await resolved.provider.step({ ...input, model: resolved.model });
      } catch (err) {
        // Not every adapter fully honors "never throw" yet (see
        // ./anthropic.ts's APIError-only catch) - a throwing entry is
        // exactly the kind of failure this router exists to route around,
        // so it's treated the same as `stopReason: 'error'` rather than
        // being allowed to crash the whole combo.
        result = errorResult(
          `Entry ${resolved.label}/${resolved.model} threw: ${describeError(err)}`,
        );
      }
      if (result.stopReason !== 'error') {
        return { ...result, servedBy: { provider: resolved.servedBy, model: resolved.model } };
      }
      // This entry errored - record it and fall through to try the next
      // one, rather than surfacing the failure immediately. Only
      // `stopReason: 'error'` triggers a fallback; 'refusal'/'max_tokens'/
      // end_turn are real answers from a real model, not something a
      // different backend would necessarily do any better with, so those
      // are returned as-is rather than masked by trying another entry.
      lastResult = {
        ...result,
        servedBy: { provider: resolved.servedBy, model: resolved.model },
      };
    }

    // Every entry errored - surface the last one's message rather than a
    // generic "all failed", since it's usually the most specific.
    return (
      lastResult ??
      errorResult(`Model "${input.model}": every entry failed with no error detail.`)
    );
  }

  /**
   * Full try-sequence for one call under `strategy`: rotation start +
   * wraparound for round_robin (weighted), strict index order otherwise.
   * The counter advances once per call, not per entry tried, so a 70/30
   * split holds regardless of fallbacks within a call.
   */
  private trySequence(
    modelName: string,
    entries: (ModelEntry | LegacyModelComboEntry)[],
    strategy: ModelStrategy,
  ): number[] {
    const order = entries.map((_, i) => i);
    if (strategy !== 'round_robin') return order;
    const weights = entries.map((e) =>
      'weight' in e && typeof e.weight === 'number' && e.weight > 0 ? Math.floor(e.weight) : 1,
    );
    const total = weights.reduce((a, b) => a + b, 0);
    const counter = this.counters.get(modelName) ?? 0;
    this.counters.set(modelName, counter + 1);
    let slot = ((counter % total) + total) % total;
    let start = 0;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i] as number;
      if (slot < w) {
        start = i;
        break;
      }
      slot -= w;
    }
    return [...order.slice(start), ...order.slice(0, start)];
  }

  /**
   * Resolves one entry to a callable adapter. New entries look up their
   * connection row directly; legacy `{provider, model}` entries resolve
   * the provider type to its default connection. Returns `{error}` when
   * the connection is missing/disabled - the caller treats that as an
   * entry failure and falls through, same as a runtime error.
   */
  private async resolveEntry(
    entry: ModelEntry | LegacyModelComboEntry,
  ): Promise<
    | { provider: LLMProvider; model: string; label: string; servedBy: ModelProvider }
    | { error: string }
  > {
    const model = entry.model;
    if ('providerConnectionId' in entry && entry.providerConnectionId) {
      let connection: ProviderConfigRow | undefined;
      try {
        connection = await providerConfigRepo.getById(entry.providerConnectionId);
      } catch (err) {
        return { error: `Failed to look up provider connection: ${describeError(err)}` };
      }
      if (!connection) {
        return {
          error:
            `Model entry points at a removed provider connection - ` +
            `re-point it in Settings > Models.`,
        };
      }
      if (!connection.enabled) {
        return { error: `Provider connection "${connection.name}" is disabled.` };
      }
      if (this.resolveConnection) {
        return {
          provider: this.resolveConnection(connection, model),
          model,
          label: connection.name,
          servedBy: connection.provider,
        };
      }
      return {
        provider: this.resolveProvider(connection.provider),
        model,
        label: connection.name,
        servedBy: connection.provider,
      };
    }
    // Legacy entry: resolve the provider type to its default connection.
    const legacy = entry as LegacyModelComboEntry;
    let connection: ProviderConfigRow | undefined;
    try {
      connection = await providerConfigRepo.getDefaultByProvider(legacy.provider as ModelProvider);
    } catch (err) {
      return { error: `Failed to look up provider "${legacy.provider}": ${describeError(err)}` };
    }
    if (!connection) {
      return {
        error:
          `No "${legacy.provider}" provider connection is configured yet - ` +
          `add one under Settings > Providers.`,
      };
    }
    if (!connection.enabled) {
      return { error: `The "${legacy.provider}" provider connection is disabled.` };
    }
    return {
      provider: this.resolveProvider(connection.provider),
      model,
      label: connection.name,
      servedBy: connection.provider,
    };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorResult(errorMessage: string): StepResult {
  return {
    content: [],
    stopReason: 'error',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0,
    errorMessage,
  };
}
