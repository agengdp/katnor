// Node/edge type vocabularies for the knowledge graph (PLAN.md 4.4). Both
// are stored as plain `text` columns (see @katnor/db's kgNode.ts/kgEdge.ts
// schema comments) rather than a pgEnum, precisely so new types can appear
// without a migration - these lists are the *suggested*, not exhaustive,
// vocabulary the extraction prompt (./extraction.ts) is steered towards.

export const KG_NODE_TYPES = [
  'project',
  'task',
  'agent',
  'person',
  'repo',
  'module',
  'file',
  'function',
  'decision',
  'requirement',
  'concept',
  'tool',
  'artifact',
  'wiki_page',
  'bug',
  'risk',
] as const;
export type KgNodeType = (typeof KG_NODE_TYPES)[number];

export const KG_EDGE_TYPES = [
  'part_of',
  'depends_on',
  'implements',
  'decided_in',
  'produced_by',
  'assigned_to',
  'references',
  'blocks',
  'supersedes',
  'mentions',
  'imports',
  'calls',
] as const;
export type KgEdgeType = (typeof KG_EDGE_TYPES)[number];
