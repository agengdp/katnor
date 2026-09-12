import { z } from 'zod';
import { MODEL_PROVIDERS } from '../enums.js';

export const MODEL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export const THINKING_DISPLAY_MODES = ['omitted', 'summarized', 'updated'] as const;
export type ThinkingDisplayMode = (typeof THINKING_DISPLAY_MODES)[number];

/**
 * Per-agent model configuration, stored as jsonb on `agent.model_config`.
 * Validated per provider by higher-level packages (e.g. @katnor/llm).
 */
export const modelConfigSchema = z.object({
  provider: z.enum(MODEL_PROVIDERS),
  model: z.string(),
  effort: z.enum(MODEL_EFFORTS),
  thinking_display: z.enum(THINKING_DISPLAY_MODES),
  max_tokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2).optional(),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;
