import type { AuthorType, MessageAttachment, RunTrigger } from '@katnor/core';
import { channelRepo, eventRepo, messageRepo } from '@katnor/db';
import type PgBoss from 'pg-boss';
import { triggerRun } from './trigger.js';

export interface PostMessageInput {
  channelId: string;
  authorType: AuthorType;
  /** An agent id, or the literal string "human". */
  authorId: string;
  content: string;
  /** Agent ids explicitly @mentioned - each is woken (see below), in addition to a DM channel's sole agent. */
  mentions?: string[];
  replyTo?: string | null;
  attachments?: MessageAttachment[];
  /**
   * Overrides the trigger type used to wake every agent this message wakes.
   * Defaults to "human" when a human posted it, "mention" otherwise (see
   * PLAN.md 4.1's four trigger kinds). `delegate_task` (./companyTools.ts)
   * passes `"task"` here so a task assignment wakes its assignee with the
   * correct trigger even though the mechanism (a message + mention) is the
   * same one used for everything else.
   */
  trigger?: RunTrigger;
}

/**
 * Posts one message and wakes whoever needs to see it: every id in
 * `mentions`, plus - for a DM channel - the one agent it's with, even
 * without an explicit mention (a DM is inherently "to" that agent, the
 * same way a Slack DM doesn't require @name). An agent never wakes itself
 * on its own message.
 *
 * This is the single path both humans (via apps/server's messages router)
 * and agents (via the `send_message`/`ask_colleague`/`delegate_task`
 * company tools in ./companyTools.ts) go through to post anything - so
 * "every message wakes the right people" only has to be correct once.
 */
export async function postMessage(boss: PgBoss, input: PostMessageInput) {
  const channel = await channelRepo.getById(input.channelId);
  if (!channel) {
    throw new Error(`postMessage: channel "${input.channelId}" not found`);
  }

  const mentions = input.mentions ?? [];
  const created = await messageRepo.create({
    channel_id: input.channelId,
    author_type: input.authorType,
    author_id: input.authorId,
    content: input.content,
    mentions,
    reply_to: input.replyTo ?? null,
    attachments: input.attachments ?? [],
  });

  await eventRepo.append({
    type: 'message.posted',
    payload: {
      message_id: created.id,
      channel_id: created.channel_id,
      author_type: created.author_type,
      author_id: created.author_id,
      mentions,
    },
  });

  const toWake = new Set<string>(mentions);
  if (channel.kind === 'dm' && channel.name?.startsWith('dm:')) {
    toWake.add(channel.name.slice('dm:'.length));
  }
  toWake.delete(input.authorId); // never wake an agent on its own message

  const trigger: RunTrigger = input.trigger ?? (input.authorType === 'human' ? 'human' : 'mention');
  for (const agentId of toWake) {
    await triggerRun(boss, { agentId, taskId: channel.task_id, channelId: channel.id, trigger });
  }

  return created;
}
