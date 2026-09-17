import { describe, expect, it } from 'vitest';
import { createModelComboInputSchema, modelComboEntrySchema } from './modelCombo.js';

describe('modelComboEntrySchema', () => {
  it('accepts a well-formed entry', () => {
    const result = modelComboEntrySchema.safeParse({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    expect(result.success).toBe(true);
  });

  it.each(['anthropic', 'openai_compatible', 'google', 'ollama'] as const)(
    'accepts every real provider ("%s")',
    (provider) => {
      expect(modelComboEntrySchema.safeParse({ provider, model: 'x' }).success).toBe(true);
    },
  );

  it('rejects "combo" as an entry provider - a combo can never nest another combo', () => {
    const result = modelComboEntrySchema.safeParse({
      provider: 'combo',
      model: 'some-other-combo',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty model id', () => {
    const result = modelComboEntrySchema.safeParse({ provider: 'anthropic', model: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an unrecognized provider string', () => {
    const result = modelComboEntrySchema.safeParse({ provider: 'not-a-real-provider', model: 'x' });
    expect(result.success).toBe(false);
  });
});

describe('createModelComboInputSchema', () => {
  it('accepts a name with a single entry', () => {
    const result = createModelComboInputSchema.safeParse({
      name: 'claude-opus-combo',
      entries: [{ provider: 'anthropic', model: 'claude-opus-5' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts multiple ordered entries', () => {
    const result = createModelComboInputSchema.safeParse({
      name: 'claude-opus-combo',
      entries: [
        { provider: 'anthropic', model: 'claude-opus-5' },
        { provider: 'google', model: 'gemini-2.5-pro' },
        { provider: 'ollama', model: 'llama3' },
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
      entries: [{ provider: 'anthropic', model: 'claude-opus-5' }],
    });
    expect(result.success).toBe(false);
  });
});
