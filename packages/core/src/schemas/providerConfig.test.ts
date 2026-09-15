import { describe, expect, it } from 'vitest';
import { createProviderConfigInputSchema } from './providerConfig.js';

// Focused on `input_cost_per_mtok`/`output_cost_per_mtok`: the cost-rate
// fields added alongside @katnor/llm's `estimateCostFromRates` (see its
// own tests in packages/llm/src/pricing.test.ts). The 999,999 upper bound
// exists specifically to fail here, with a clear validation error, rather
// than at the Postgres `numeric(12, 6)` column as a raw overflow.
describe('createProviderConfigInputSchema - cost rate bounds', () => {
  const base = { provider: 'openai_compatible' as const, enabled: true };

  it('accepts a typical rate', () => {
    const result = createProviderConfigInputSchema.safeParse({
      ...base,
      input_cost_per_mtok: 0.5,
      output_cost_per_mtok: 1.5,
    });
    expect(result.success).toBe(true);
  });

  it('accepts null (untracked)', () => {
    const result = createProviderConfigInputSchema.safeParse({
      ...base,
      input_cost_per_mtok: null,
      output_cost_per_mtok: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts the fields being omitted entirely', () => {
    const result = createProviderConfigInputSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it('accepts exactly 0 (legitimately free, distinct from null/unset)', () => {
    const result = createProviderConfigInputSchema.safeParse({
      ...base,
      input_cost_per_mtok: 0,
      output_cost_per_mtok: 0,
    });
    expect(result.success).toBe(true);
  });

  it('accepts exactly the upper bound, 999999', () => {
    const result = createProviderConfigInputSchema.safeParse({
      ...base,
      input_cost_per_mtok: 999_999,
      output_cost_per_mtok: 999_999,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a value past the numeric(12, 6) column's precision", () => {
    const result = createProviderConfigInputSchema.safeParse({
      ...base,
      input_cost_per_mtok: 1_000_000,
      output_cost_per_mtok: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative rate', () => {
    const result = createProviderConfigInputSchema.safeParse({
      ...base,
      input_cost_per_mtok: -1,
      output_cost_per_mtok: 1,
    });
    expect(result.success).toBe(false);
  });
});
