import type { ModelComboEntryProvider, ModelProvider } from '@katnor/core';
import { modelComboRepo } from '@katnor/db';
import type { LLMProvider, ProviderCapabilities, StepInput, StepResult } from './types.js';

/**
 * The "combo" adapter: a named, ordered fallback chain across other
 * providers' models (@katnor/core's schemas/modelCombo.ts). An agent hired
 * onto `provider: "combo"` stores the combo's *name* in `model_config.model`
 * rather than a real model id - `step()` below resolves that name to a
 * `model_combo` row, then tries each entry in order, falling back to the
 * next on any `stopReason: 'error'` and returning the first success (or
 * the last entry's error, if every entry fails).
 *
 * Takes a `resolveProvider` callback rather than importing
 * `./registry.ts`'s `getProvider` directly: `getProvider` is what
 * constructs this class in the first place (`registry.ts` registers a
 * `ComboProvider` instance the same way it does every other adapter), so a
 * direct import the other way would be a circular module dependency.
 * `registry.ts` passes its own `getProvider` function in - a plain
 * function declaration is hoisted, so referencing it before its textual
 * definition in that same file is safe.
 */
export class ComboProvider implements LLMProvider {
  readonly id: ModelProvider = 'combo';

  constructor(
    private readonly resolveProvider: (provider: ModelComboEntryProvider) => LLMProvider,
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
      return errorResult(`Failed to look up combo "${input.model}": ${describeError(err)}`);
    }
    if (!combo) {
      return errorResult(
        `No "combo" model named "${input.model}" exists - check Settings > Model combos.`,
      );
    }
    if (combo.entries.length === 0) {
      return errorResult(
        `Combo "${input.model}" has no entries configured - add at least one in Settings.`,
      );
    }

    let lastResult: StepResult | null = null;
    for (const entry of combo.entries) {
      let result: StepResult;
      try {
        const provider = this.resolveProvider(entry.provider);
        result = await provider.step({ ...input, model: entry.model });
      } catch (err) {
        // Not every adapter fully honors "never throw" yet (see
        // ./anthropic.ts's APIError-only catch) and `entry.provider` is
        // only schema-validated on write, not re-checked on every read of
        // the `model_combo.entries` jsonb column - either way, a throwing
        // entry is exactly the kind of failure this fallback chain exists
        // to route around, so it's treated the same as `stopReason:
        // 'error'` rather than being allowed to crash the whole combo.
        result = errorResult(`Entry ${entry.provider}/${entry.model} threw: ${describeError(err)}`);
      }
      if (result.stopReason !== 'error') {
        return { ...result, servedBy: { provider: entry.provider, model: entry.model } };
      }
      // This entry errored - record it and fall through to try the next
      // one, rather than surfacing the failure immediately. Only
      // `stopReason: 'error'` triggers a fallback; 'refusal'/'max_tokens'/
      // end_turn are real answers from a real model, not something a
      // different backend would necessarily do any better with, so those
      // are returned as-is rather than masked by trying another entry.
      lastResult = { ...result, servedBy: { provider: entry.provider, model: entry.model } };
    }

    // Every entry errored - surface the last one's message rather than a
    // generic "all failed", since it's usually the most specific.
    return (
      lastResult ?? errorResult(`Combo "${input.model}": every entry failed with no error detail.`)
    );
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
