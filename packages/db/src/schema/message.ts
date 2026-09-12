import type { MessageAttachment } from '@katnor/core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { authorTypeEnum } from './enums.js';
import { baseColumns } from './columns.js';
import { channel } from './channel.js';

export const message = pgTable(
  'message',
  {
    ...baseColumns,
    channel_id: text('channel_id')
      .notNull()
      .references(() => channel.id),
    author_type: authorTypeEnum('author_type').notNull(),
    // An agent id, or the literal string "human" - not a FK, since the
    // author may not be an agent row.
    author_id: text('author_id').notNull(),
    content: text('content').notNull(),
    mentions: jsonb('mentions').$type<string[]>().notNull().default([]),
    reply_to: text('reply_to').references((): AnyPgColumn => message.id),
    // Array of { artifact_id } | { url } - see MessageAttachment in @katnor/core.
    attachments: jsonb('attachments').$type<MessageAttachment[]>().notNull().default([]),
  },
  (table) => [index('message_channel_id_idx').on(table.channel_id)],
);
