import type { KgEdgeEvidence } from '@katnor/core';
import { index, jsonb, pgTable, real, text } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';
import { kgNode } from './kgNode.js';

/** A directed, typed edge between two knowledge graph nodes. */
export const kgEdge = pgTable(
  'kg_edge',
  {
    ...baseColumns,
    from_id: text('from_id')
      .notNull()
      .references(() => kgNode.id),
    to_id: text('to_id')
      .notNull()
      .references(() => kgNode.id),
    // Open-ended (e.g. "depends_on", "authored_by", "mentions", ...) - left
    // as plain text rather than a pgEnum for the same reason as kg_node.type.
    type: text('type').notNull(),
    weight: real('weight'),
    // { kind: "run" | "artifact" | "message", id } - see KgEdgeEvidence in @katnor/core.
    evidence: jsonb('evidence').$type<KgEdgeEvidence>().notNull(),
  },
  (table) => [
    index('kg_edge_from_id_idx').on(table.from_id),
    index('kg_edge_to_id_idx').on(table.to_id),
  ],
);
