import { z } from 'zod';
import { CHANNEL_KINDS } from '../enums.js';
import { withBase } from './base.js';

export const channelFields = {
  project_id: z.string().nullable(),
  team_id: z.string().nullable(),
  kind: z.enum(CHANNEL_KINDS),
  name: z.string().nullable(),
  task_id: z.string().nullable(),
};

export const channelSchema = withBase(channelFields);
export type Channel = z.infer<typeof channelSchema>;

export const createChannelInputSchema = z.object({
  ...channelFields,
  project_id: channelFields.project_id.optional(),
  team_id: channelFields.team_id.optional(),
  name: channelFields.name.optional(),
  task_id: channelFields.task_id.optional(),
});
export type CreateChannelInput = z.infer<typeof createChannelInputSchema>;
