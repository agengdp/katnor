import type { ModelEntry, ModelProvider, ModelStrategy } from '@katnor/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComboProvider } from './combo.js';
import type { LLMProvider, StepInput, StepResult } from './types.js';

// `combo.ts` calls `modelComboRepo.getByName` + `providerConfigRepo`
// (`getById` for new entries, `getDefaultByProvider` for legacy) -
// mocking the whole `@katnor/db` module (rather than pulling in a real
// Postgres connection) is what makes this a true unit test. `vi.mock`
// factories run before imports are evaluated, so the mocks have to be
// created inside the factory and re-exported for tests to control.
const { getByNameMock, getConnByIdMock, getDefaultConnMock } = vi.hoisted(() => ({
  getByNameMock: vi.fn(),
  getConnByIdMock: vi.fn(),
  getDefaultConnMock: vi.fn(),
}));
vi.mock('@katnor/db', () => ({
  modelComboRepo: { getByName: getByNameMock },
  providerConfigRepo: {
    getById: getConnByIdMock,
    getDefaultByProvider: getDefaultConnMock,
  },
}));

function fakeCombo(entries: unknown[], strategy: ModelStrategy = 'fallback') {
  return {
    id: 'combo-1',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    name: 'test-combo',
    entries,
    strategy,
  };
}

function fakeConnection(id: string, provider: ModelProvider, enabled = true) {
  return {
    id,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    name: `${provider} conn`,
    provider,
    api_key_encrypted: 'enc',
    base_url: null,
    enabled,
    model_catalog_cache: null,
    model_catalog_cached_at: null,
    input_cost_per_mtok: null,
    output_cost_per_mtok: null,
  };
}

function newEntries(): ModelEntry[] {
  return [
    { providerConnectionId: 'conn-a', model: 'model-a', weight: 1 },
    { providerConnectionId: 'conn-g', model: 'model-g', weight: 1 },
  ];
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

function okResult(text: string): StepResult {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: ZERO_USAGE,
    costUsd: 0,
  };
}

function errorResult(message: string): StepResult {
  return { content: [], stopReason: 'error', usage: ZERO_USAGE, costUsd: 0, errorMessage: message };
}

type FakeProvider = LLMProvider & { step: ReturnType<typeof vi.fn> };

/** A stub `LLMProvider` whose `step()` is a controllable `vi.fn()`. */
function fakeProvider(id: ModelProvider): FakeProvider {
  return {
    id,
    capabilities: () => ({
      supportsThinking: false,
      supportsEffort: false,
      supportsPromptCaching: false,
      supportsTaskBudget: false,
      maxContextTokens: 32_000,
    }),
    step: vi.fn(),
  };
}

const BASE_INPUT: StepInput = {
  systemPrompt: 'system',
  messages: [],
  tools: [],
  model: 'test-combo',
  effort: 'medium',
  thinkingDisplay: 'omitted',
  maxTokens: 1024,
};

describe('ComboProvider', () => {
  beforeEach(() => {
    getByNameMock.mockReset();
    getConnByIdMock.mockReset();
    getDefaultConnMock.mockReset();
    // New-shape entries resolve via getById by default in every test.
    getConnByIdMock.mockImplementation(async (id: string) =>
      fakeConnection(id, id === 'conn-g' ? 'google' : 'anthropic'),
    );
  });

  // resolveConnection binds a connection row to a fake adapter directly,
  // so no real adapter constructor runs in these tests.
  function wire(fakes: Record<string, FakeProvider>) {
    const resolve = (p: ModelProvider): LLMProvider => {
      const found = Object.values(fakes).find((f) => f.id === p);
      if (!found) throw new Error(`no fake for ${p}`);
      return found;
    };
    const resolveConnection = (conn: { id: string }): LLMProvider => {
      const fake = fakes[conn.id];
      if (!fake) throw new Error(`no fake for connection ${conn.id}`);
      return fake;
    };
    return new ComboProvider(resolve, resolveConnection);
  }

  it("returns the first entry's result on success, without calling later entries", async () => {
    const anthropic = fakeProvider('anthropic');
    anthropic.step.mockResolvedValue(okResult('hi from anthropic'));
    const google = fakeProvider('google');

    getByNameMock.mockResolvedValue(fakeCombo(newEntries()));

    const result = await wire({ 'conn-a': anthropic, 'conn-g': google }).step(BASE_INPUT);

    expect(result.stopReason).toBe('end_turn');
    expect(result.servedBy).toEqual({ provider: 'anthropic', model: 'model-a' });
    expect(anthropic.step).toHaveBeenCalledTimes(1);
    expect(google.step).not.toHaveBeenCalled();
  });

  it('falls back to the next entry when one returns stopReason: "error"', async () => {
    const anthropic = fakeProvider('anthropic');
    anthropic.step.mockResolvedValue(errorResult('rate limited'));
    const google = fakeProvider('google');
    google.step.mockResolvedValue(okResult('hi from google'));

    getByNameMock.mockResolvedValue(fakeCombo(newEntries()));

    const result = await wire({ 'conn-a': anthropic, 'conn-g': google }).step(BASE_INPUT);

    expect(result.stopReason).toBe('end_turn');
    expect(result.servedBy).toEqual({ provider: 'google', model: 'model-g' });
    expect(anthropic.step).toHaveBeenCalledTimes(1);
    expect(google.step).toHaveBeenCalledTimes(1);
  });

  it.each(['refusal', 'max_tokens', 'end_turn'] as const)(
    'does NOT fall back on stopReason: "%s" - a real answer, not something to route around',
    async (stopReason) => {
      const anthropic = fakeProvider('anthropic');
      anthropic.step.mockResolvedValue({ content: [], stopReason, usage: ZERO_USAGE, costUsd: 0 });
      const google = fakeProvider('google');

      getByNameMock.mockResolvedValue(fakeCombo(newEntries()));

      const result = await wire({ 'conn-a': anthropic, 'conn-g': google }).step(BASE_INPUT);

      expect(result.stopReason).toBe(stopReason);
      expect(result.servedBy).toEqual({ provider: 'anthropic', model: 'model-a' });
      expect(google.step).not.toHaveBeenCalled();
    },
  );

  it('treats an entry throwing the same as stopReason: "error" and falls back', async () => {
    // Regression test: a background review of this class found that
    // neither `resolveProvider()` nor `provider.step()` were wrapped in
    // try/catch, so a throwing entry (e.g. an adapter that doesn't fully
    // honor the "never throw" contract) would have propagated straight out
    // of ComboProvider.step() uncaught - defeating the entire point of a
    // fallback chain. This locks that fix in.
    const anthropic = fakeProvider('anthropic');
    anthropic.step.mockRejectedValue(new Error('socket hang up'));
    const google = fakeProvider('google');
    google.step.mockResolvedValue(okResult('hi from google'));

    getByNameMock.mockResolvedValue(fakeCombo(newEntries()));

    const result = await wire({ 'conn-a': anthropic, 'conn-g': google }).step(BASE_INPUT);

    expect(result.stopReason).toBe('end_turn');
    expect(result.servedBy).toEqual({ provider: 'google', model: 'model-g' });
  });

  it("returns the last entry's error, with servedBy set, when every entry fails", async () => {
    const anthropic = fakeProvider('anthropic');
    anthropic.step.mockResolvedValue(errorResult('first failure'));
    const google = fakeProvider('google');
    google.step.mockResolvedValue(errorResult('second failure'));

    getByNameMock.mockResolvedValue(fakeCombo(newEntries()));

    const result = await wire({ 'conn-a': anthropic, 'conn-g': google }).step(BASE_INPUT);

    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe('second failure');
    expect(result.servedBy).toEqual({ provider: 'google', model: 'model-g' });
  });

  it('resolves legacy {provider, model} entries via the default connection', async () => {
    const anthropic = fakeProvider('anthropic');
    anthropic.step.mockResolvedValue(okResult('hi from legacy'));

    getByNameMock.mockResolvedValue(
      fakeCombo([{ provider: 'anthropic', model: 'claude-sonnet-5' }]),
    );
    getDefaultConnMock.mockResolvedValue(fakeConnection('conn-legacy', 'anthropic'));

    const result = await wire({ 'conn-legacy': anthropic }).step(BASE_INPUT);

    expect(result.stopReason).toBe('end_turn');
    expect(result.servedBy).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(getDefaultConnMock).toHaveBeenCalledWith('anthropic');
    expect(anthropic.step).toHaveBeenCalledTimes(1);
  });

  it('round_robin rotates by weight across calls', async () => {
    const anthropic = fakeProvider('anthropic');
    anthropic.step.mockResolvedValue(okResult('a'));
    const google = fakeProvider('google');
    google.step.mockResolvedValue(okResult('g'));

    getByNameMock.mockResolvedValue(
      fakeCombo(
        [
          { providerConnectionId: 'conn-a', model: 'model-a', weight: 3 },
          { providerConnectionId: 'conn-g', model: 'model-g', weight: 1 },
        ],
        'round_robin',
      ),
    );

    const router = wire({ 'conn-a': anthropic, 'conn-g': google });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await router.step(BASE_INPUT);
      seen.push((result.servedBy as { model: string }).model);
    }
    // 3:1 weights over 4 calls: a, a, a, g in some rotation - g exactly once.
    expect(seen.filter((m) => m === 'model-g')).toHaveLength(1);
    expect(seen.filter((m) => m === 'model-a')).toHaveLength(3);
  });

  it('round_robin falls through to the next entry when the pick errors', async () => {
    const anthropic = fakeProvider('anthropic');
    anthropic.step.mockResolvedValue(errorResult('down'));
    const google = fakeProvider('google');
    google.step.mockResolvedValue(okResult('g'));

    getByNameMock.mockResolvedValue(
      fakeCombo(
        [
          { providerConnectionId: 'conn-a', model: 'model-a', weight: 1 },
          { providerConnectionId: 'conn-g', model: 'model-g', weight: 1 },
        ],
        'round_robin',
      ),
    );

    const result = await wire({ 'conn-a': anthropic, 'conn-g': google }).step(BASE_INPUT);

    expect(result.stopReason).toBe('end_turn');
    expect(result.servedBy).toEqual({ provider: 'google', model: 'model-g' });
  });

  it('skips a removed connection and reports it, routing around to the next entry', async () => {
    const google = fakeProvider('google');
    google.step.mockResolvedValue(okResult('g'));
    getConnByIdMock.mockImplementation(async (id: string) =>
      id === 'conn-gone' ? undefined : fakeConnection(id, 'google'),
    );

    getByNameMock.mockResolvedValue(
      fakeCombo([
        { providerConnectionId: 'conn-gone', model: 'model-x', weight: 1 },
        { providerConnectionId: 'conn-g', model: 'model-g', weight: 1 },
      ]),
    );

    const result = await wire({ 'conn-g': google }).step(BASE_INPUT);

    expect(result.stopReason).toBe('end_turn');
    expect(result.servedBy).toEqual({ provider: 'google', model: 'model-g' });
  });

  it('returns an error result (does not throw) when the model name is not found', async () => {
    getByNameMock.mockResolvedValue(undefined);
    const resolve = vi.fn();
    const resolveConnection = vi.fn();

    const result = await new ComboProvider(resolve, resolveConnection).step(BASE_INPUT);

    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('No "combo" model named');
    expect(resolve).not.toHaveBeenCalled();
    expect(resolveConnection).not.toHaveBeenCalled();
  });

  it('returns an error result when the model has no entries configured', async () => {
    getByNameMock.mockResolvedValue(fakeCombo([]));
    const resolve = vi.fn();

    const result = await new ComboProvider(resolve).step(BASE_INPUT);

    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('no entries configured');
  });

  it('returns an error result (does not throw) when the DB lookup itself throws', async () => {
    // Same "never throw out of step()" contract as the entry-level test
    // above, but for the initial modelComboRepo.getByName() call.
    getByNameMock.mockRejectedValue(new Error('connection terminated'));
    const resolve = vi.fn();

    const result = await new ComboProvider(resolve).step(BASE_INPUT);

    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('Failed to look up model "test-combo"');
    expect(resolve).not.toHaveBeenCalled();
  });
});
