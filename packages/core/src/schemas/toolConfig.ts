import { z } from 'zod';
import { TOOL_CONFIG_KINDS } from '../enums.js';
import { withBase } from './base.js';

export const toolConfigFields = {
  kind: z.enum(TOOL_CONFIG_KINDS),
  name: z.string().min(1),
  command: z.string().nullable(),
  url: z.string().nullable(),
  env_secret_refs: z.array(z.string()),
  enabled: z.boolean(),
};

export const toolConfigSchema = withBase(toolConfigFields);
export type ToolConfig = z.infer<typeof toolConfigSchema>;

export const createToolConfigInputSchema = z.object({
  ...toolConfigFields,
  command: toolConfigFields.command.optional(),
  url: toolConfigFields.url.optional(),
  env_secret_refs: toolConfigFields.env_secret_refs.default([]),
  enabled: toolConfigFields.enabled.default(true),
});
export type CreateToolConfigInput = z.infer<typeof createToolConfigInputSchema>;
