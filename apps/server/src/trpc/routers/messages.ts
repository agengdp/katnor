import { postMessage } from '@katnor/agents';
import { messageRepo } from '@katnor/db';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';

export const messagesRouter = router({
  list: protectedProcedure
    .input(z.object({ channel_id: z.string(), since_message_id: z.string().optional() }))
    .query(({ input }) =>
      messageRepo.list(
        input.channel_id,
        input.since_message_id ? { after_id: input.since_message_id } : {},
      ),
    ),

  /**
   * The owner posting from the Chat page - the one human-facing entry
   * point into `postMessage` (@katnor/agents), which every agent-authored
   * message also goes through (via the `send_message`/`ask_colleague`/
   * `delegate_task` tools) so "who gets woken up" is decided in exactly
   * one place.
   */
  send: protectedProcedure
    .input(
      z.object({
        channel_id: z.string(),
        text: z.string().min(1),
        mentions: z.array(z.string()).default([]),
        reply_to: z.string().nullable().default(null),
      }),
    )
    .mutation(({ input, ctx }) =>
      postMessage(ctx.boss, {
        channelId: input.channel_id,
        authorType: 'human',
        authorId: 'human',
        content: input.text,
        mentions: input.mentions,
        replyTo: input.reply_to,
      }),
    ),
});
