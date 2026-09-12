import { z } from 'zod';
import { AUTHOR_TYPES } from '../enums.js';
import { withBase } from './base.js';

export const messageAttachmentSchema = z.union([
  z.object({ artifact_id: z.string() }),
  z.object({ url: z.string() }),
]);
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

export const messageFields = {
  channel_id: z.string(),
  author_type: z.enum(AUTHOR_TYPES),
  author_id: z.string(),
  content: z.string(),
  mentions: z.array(z.string()),
  reply_to: z.string().nullable(),
  attachments: z.array(messageAttachmentSchema),
};

export const messageSchema = withBase(messageFields);
export type Message = z.infer<typeof messageSchema>;

export const createMessageInputSchema = z.object({
  ...messageFields,
  mentions: messageFields.mentions.default([]),
  reply_to: messageFields.reply_to.optional(),
  attachments: messageFields.attachments.default([]),
});
export type CreateMessageInput = z.infer<typeof createMessageInputSchema>;
