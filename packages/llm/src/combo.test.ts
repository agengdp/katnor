import type { ModelComboEntry, ModelComboEntryProvider } from '@katnor/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComboProvider } from './combo.js';
import type { LLMProvider, StepInput, StepResult } from './types.js';

// `combo.ts` only ever calls `modelComboRepo.getByName` - mocking the
// whole `@katnor/db` module (rather than pulling in a real Postgres
// connection) is what makes this a true unit test. `vi.mock` factories run
// before imports are evaluated, so `getByNameMock` has to be created
// inside the factory and re-exported for tests to control per case.
const { getByNameMock } = vi.hoisted(() => ({ getByNameMock: vi.fn() }));
vi.mock('@katnor/db', () => ({
  modelComboRepo: { getByName: getByNameMock },
}));

function fakeCombo(entries: ModelComboEntry[]) {
  return {
    id: 'combo-1',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    name: 'test-combo',
    entries,
  };
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
function fakeProvider(id: ModelComboEntryProvider): FakeProvider {
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
  });

  it("returns the first entry's result on success, without calling later entries", async () => {
    const anthropic = fakeProvider('anthropic');
    anthropic.step.mockResolvedValue(okResult('hi from anthropic'));
    const google = fakeProvider('google');

    getByNameMock.mockResolvedValue(
      fakeCombo([
        { provider: 'anthropic', model: 'claude-sonnet-5' },
        { provider: 'google', model: 'gemini-2.5-pro' },
      ]),
    );

    const resolve = (p: ModelComboEntryProvider) => (p === 'anthropic' ? anthropic : google);
    const combo = new ComboProvider(resolve);

    const result = await combo.step(BASE_INPUT);

    expect(result.stopReason).toBe('end_turn');
    expect(result.servedBy).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(anthropic.step).toHaveBeenCalledTimes(1);
    expect(google.step).not.toHaveBeenCalled();
  });

  it('falls back to the next entry when one returns stopReason: "error"', async () => {
    const anthropic = fakeProvider('anthropic');
    anthropic.step.mockResolvedValue(errorResult('rate limited'));
    const google = fakeProvider('google');
    google.step.mockResolvedValue(okResult('hi from google'));

    getByNameMock.mockResolvedValue(
      fakeCombo([
        { provider: 'anthropic', model: 'claude-sonnet-5' },
        { provider: 'google', model: 'gemini-2.5-pro' },
      ]),
    );

    const resolve = (p: ModelComboEntryProvider) => (p === 'anthropic' ? anthropic : google);
    const result = await new ComboProvider(resolve).step(BASE_INPUT);

    expect(result.stopReason).toBe('end_turn');
    expect(result.servedBy).toEqual({ provider: 'google', model: 'gemini-2.5-pro' });
    expect(anthropic.step).toHaveBeenCalledTimes(1);
    expect(google.step).toHaveBeenCalledTimes(1);
  });

  it.each(['refusal', 'max_tokens', 'end_turn'] as const)(
    'does NOT fall back on stopReason: "%s" - a real answer, not something to route around',
    async (stopReason) => {
      const anthropic = fakeProvider('anthropic');
      anthropic.step.mockResolvedValue({ content: [], stopReason, usage: ZERO_USAGE, costUsd: 0 });
      const google = fakeProvider('google');

      getByNameMock.mockResolvedValue(
        fakeCombo([
          { provider: 'anthropic', model: 'claude-sonnet-5' },
          { provider: 'google', model: 'gemini-2.5-pro' },
        ]),
      );

      const resolve = (p: ModelComboEntryProvider) => (p === 'anthropic' ? anthropic : google);
      const result = await new ComboProvider(resolve).step(BASE_INPUT);

      expect(result.stopReason).toBe(stopReason);
      expect(result.servedBy).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
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

    getByNameMock.mockResolvedValue(
      fakeCombo([
        { provider: 'anthropic', model: 'claude-sonnet-5' },
        { provider: 'google', model: 'gemini-2.5-pro' },
      ]),
    );

    const resolve = (p: ModelComboEntryProvider) => (p === 'anthropic' ? anthropic : google);
    const result = await new ComboProvider(resolve).step(BASE_INPUT);

    expect(result.stopReason).toBe('end_turn');
    expect(result.servedBy).toEqual({ provider: 'google', model: 'gemini-2.5-pro' });
  });

  it("returns the last entry's error, with servedBy set, when every entry fails", async () => {
    const anthropic = fakeProvider('anthropic');
    anthropic.step.mockResolvedValue(errorResult('first failure'));
    const google = fakeProvider('google');
    google.step.mockResolvedValue(errorResult('second failure'));

    getByNameMock.mockResolvedValue(
      fakeCombo([
        { provider: 'anthropic', model: 'claude-sonnet-5' },
        { provider: 'google', model: 'gemini-2.5-pro' },
      ]),
    );

    const resolve = (p: ModelComboEntryProvider) => (p === 'anthropic' ? anthropic : google);
    const result = await new ComboProvider(resolve).step(BASE_INPUT);

    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe('second failure');
    expect(result.servedBy).toEqual({ provider: 'google', model: 'gemini-2.5-pro' });
  });

  it('returns an error result (does not throw) when the combo name is not found', async () => {
    getByNameMock.mockResolvedValue(undefined);
    const resolve = vi.fn();

    const result = await new ComboProvider(resolve).step(BASE_INPUT);

    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('No "combo" model named');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('returns an error result when the combo has no entries configured', async () => {
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
    expect(result.errorMessage).toContain('Failed to look up combo "test-combo"');
    expect(resolve).not.toHaveBeenCalled();
  });
});
