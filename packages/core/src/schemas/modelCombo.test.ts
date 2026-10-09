import { describe, expect, it } from 'vitest';
import {
  createModelComboInputSchema,
  legacyModelComboEntrySchema,
  modelEntrySchema,
} from './modelCombo.js';

describe('modelEntrySchema', () => {
  it('accepts a well-formed entry with default weight', () => {
    const result = modelEntrySchema.safeParse({
      providerConnectionId: 'conn-1',
      model: 'gpt-5',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.weight).toBe(1);
  });

  it('accepts an explicit weight', () => {
    const result = modelEntrySchema.safeParse({
      providerConnectionId: 'conn-1',
      model: 'gpt-5',
      weight: 70,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty model id', () => {
    const result = modelEntrySchema.safeParse({ providerConnectionId: 'conn-1', model: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive weight', () => {
    const result = modelEntrySchema.safeParse({
      providerConnectionId: 'conn-1',
      model: 'x',
      weight: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe('legacyModelComboEntrySchema', () => {
  it('accepts the old {provider, model} shape', () => {
    const result = legacyModelComboEntrySchema.safeParse({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    expect(result.success).toBe(true);
  });
});

describe('createModelComboInputSchema', () => {
  it('accepts a name with a single entry', () => {
    const result = createModelComboInputSchema.safeParse({
      name: 'coding',
      entries: [{ providerConnectionId: 'conn-1', model: 'gpt-5' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts multiple weighted entries', () => {
    const result = createModelComboInputSchema.safeParse({
      name: 'coding',
      strategy: 'round_robin',
      entries: [
        { providerConnectionId: 'conn-1', model: 'gpt-5', weight: 70 },
        { providerConnectionId: 'conn-2', model: 'qwen3', weight: 30 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty entries array - a combo needs at least one entry', () => {
    const result = createModelComboInputSchema.safeParse({ name: 'empty-combo', entries: [] });
    expect(result.success).toBe(false);
  });

  it('rejects an empty name', () => {
    const result = createModelComboInputSchema.safeParse({
      name: '',
      entries: [{ providerConnectionId: 'conn-1', model: 'gpt-5' }],
    });
    expect(result.success).toBe(false);
  });
});
