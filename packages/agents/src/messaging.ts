import type { AuthorType, MessageAttachment, RunTrigger } from '@katnor/core';
import { channelRepo, eventRepo, messageRepo } from '@katnor/db';
import type PgBoss from 'pg-boss';
import { triggerRun } from './trigger.js';

// PLAN.md 4.2's "anti-chatter limits" - two independent guards against an
// agent-to-agent conversation looping forever: a plain rate limit (one
// agent posting too fast into one channel) and a "thread escalation" that
// catches a *mutual* loop a per-author rate limit alone would miss (two
// agents ping-ponging just under the rate limit, neither ever resolving
// anything). Both only ever suppress *waking* anyone further - the message
// itself is still recorded, so nothing about the conversation is lost, and
// a human or a later poll can still see it happened via the
// `chatter.limited` event.
const CHATTER_RATE_LIMIT_WINDOW_MS = 60_000;
const CHATTER_RATE_LIMIT_MAX_MESSAGES = 8;
const CHATTER_ESCALATION_TAIL_LENGTH = 12;

interface ChatterVerdict {
  suppressWake: boolean;
  reason: 'rate_limit' | 'thread_escalation' | null;
}

async function evaluateAntiChatter(channelId: string, authorId: string): Promise<ChatterVerdict> {
  // messageRepo.list is capped at the most recent 200 (oldest-first), which
  // is plenty of lookback for both checks below.
  const recent = await messageRepo.list(channelId);

  const cutoff = Date.now() - CHATTER_RATE_LIMIT_WINDOW_MS;
  const recentFromAuthor = recent.filter(
    (row) => row.author_id === authorId && row.created_at.getTime() >= cutoff,
  );
  if (recentFromAuthor.length >= CHATTER_RATE_LIMIT_MAX_MESSAGES) {
    return { suppressWake: true, reason: 'rate_limit' };
  }

  // A run of consecutive agent-authored messages this long, with no human
  // message interleaved, means nobody's actually resolving anything - stop
  // waking people until a human weighs in (visible via the Inbox/event feed).
  const tail = recent.slice(-CHATTER_ESCALATION_TAIL_LENGTH);
  const isUnbrokenAgentChatter =
    tail.length >= CHATTER_ESCALATION_TAIL_LENGTH &&
    tail.every((row) => row.author_type === 'agent');
  if (isUnbrokenAgentChatter) {
    return { suppressWake: true, reason: 'thread_escalation' };
  }

  return { suppressWake: false, reason: null };
}

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

  // Anti-chatter only applies to agent-authored messages - a human posting
  // rapidly, or a long agent discussion the owner is actively part of, is
  // never what this is guarding against.
  const chatterVerdict: ChatterVerdict =
    input.authorType === 'agent'
      ? await evaluateAntiChatter(channel.id, input.authorId)
      : { suppressWake: false, reason: null };
  if (chatterVerdict.suppressWake) {
    await eventRepo.append({
      type: 'chatter.limited',
      payload: { channel_id: channel.id, author_id: input.authorId, reason: chatterVerdict.reason },
    });
  }

  if (!chatterVerdict.suppressWake) {
    const trigger: RunTrigger =
      input.trigger ?? (input.authorType === 'human' ? 'human' : 'mention');
    for (const agentId of toWake) {
      await triggerRun(boss, { agentId, taskId: channel.task_id, channelId: channel.id, trigger });
    }
  }

  return created;
}
