// @katnor/knowledge - the knowledge graph (kg_node/kg_edge), the wiki
// librarian, embeddings, and hybrid (vector + keyword) search. See PLAN.md
// sections 4.4 and 4.5.
//
// TODO: implemented in a later phase

export const KNOWLEDGE_PACKAGE_NAME = '@katnor/knowledge';

export type KgNodeType =
  | 'project'
  | 'task'
  | 'agent'
  | 'person'
  | 'repo'
  | 'module'
  | 'file'
  | 'function'
  | 'decision'
  | 'requirement'
  | 'concept'
  | 'tool'
  | 'artifact'
  | 'wiki_page'
  | 'bug'
  | 'risk';
