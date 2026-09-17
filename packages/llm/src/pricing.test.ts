import { describe, expect, it, vi } from 'vitest';
import { estimateCostFromRates, estimateCostUsd, numericColumnToRate } from './pricing.js';
import type { StepUsage } from './types.js';

function usage(overrides: Partial<StepUsage> = {}): StepUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  };
}

describe('estimateCostUsd', () => {
  it('computes input/output/cache cost for a known model from the hand-maintained table', () => {
    // claude-sonnet-5: inputPerMTok 2, outputPerMTok 10.
    const cost = estimateCostUsd(
      'claude-sonnet-5',
      usage({
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 200_000,
        cacheCreationTokens: 100_000,
      }),
    );
    // input: 1 * 2 = 2
    // output: 0.5 * 10 = 5
    // cache write: 0.1 * 2 * 1.25 = 0.25
    // cache read: 0.2 * 2 * 0.1 = 0.04
    expect(cost).toBeCloseTo(7.29, 10);
  });

  it('returns 0 for zero usage on a known model', () => {
    expect(estimateCostUsd('claude-sonnet-5', usage())).toBe(0);
  });

  it('falls back to the Opus-tier rate (and warns) for an unrecognized model', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cost = estimateCostUsd(
        'some-future-model-not-in-the-table',
        usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      );
      // Fallback rate: inputPerMTok 5, outputPerMTok 25.
      expect(cost).toBeCloseTo(30, 10);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('some-future-model-not-in-the-table');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('numericColumnToRate', () => {
  it('passes null through unchanged', () => {
    expect(numericColumnToRate(null)).toBeNull();
  });

  it('parses a numeric-column string into a number', () => {
    expect(numericColumnToRate('1.500000')).toBe(1.5);
  });

  it('parses a whole-number string', () => {
    expect(numericColumnToRate('42')).toBe(42);
  });
});

describe('estimateCostFromRates', () => {
  it('is $0 when both rates are unset (null), regardless of usage', () => {
    const cost = estimateCostFromRates(
      { inputCostPerMtok: null, outputCostPerMtok: null },
      usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    );
    expect(cost).toBe(0);
  });

  it('only charges the side with a configured rate when the other is null', () => {
    const cost = estimateCostFromRates(
      { inputCostPerMtok: 2, outputCostPerMtok: null },
      usage({ inputTokens: 500_000, outputTokens: 1_000_000 }),
    );
    expect(cost).toBeCloseTo(1, 10);
  });

  it('sums both sides when both rates are configured', () => {
    const cost = estimateCostFromRates(
      { inputCostPerMtok: 1, outputCostPerMtok: 2 },
      usage({ inputTokens: 2_000_000, outputTokens: 3_000_000 }),
    );
    expect(cost).toBeCloseTo(8, 10);
  });

  it('treats an explicit 0 rate as legitimately free, not "unset"', () => {
    // Same $0 result as the null case above, but for a different reason -
    // this exercises the `?? 0` fallback not accidentally special-casing 0.
    const cost = estimateCostFromRates(
      { inputCostPerMtok: 0, outputCostPerMtok: 0 },
      usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    );
    expect(cost).toBe(0);
  });

  it('ignores cache tokens (neither openaiCompatible.ts nor google.ts report cache usage)', () => {
    const cost = estimateCostFromRates(
      { inputCostPerMtok: 10, outputCostPerMtok: 10 },
      usage({ cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 }),
    );
    expect(cost).toBe(0);
  });
});
