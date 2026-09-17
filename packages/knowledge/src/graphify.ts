/**
 * Parses graphify's `graph.json` and maps it onto this project's knowledge
 * graph shape (`kg_node` / `kg_edge`).
 *
 * graphify (https://github.com/Graphify-Labs/graphify, Apache-2.0) parses a
 * repo with tree-sitter AST across ~40 languages and emits the symbols it
 * finds plus the edges between them, with no LLM involved for code. That is
 * what PLAN.md 4.4 asks for - "parses repos with tree-sitter to add
 * Module/File/Function nodes and imports/calls edges" - and what
 * ./codeIndexer.ts's regex heuristic explicitly stood in for until now.
 *
 * This module is deliberately pure: no database, no workspace, no process
 * spawning. That is what lets the mapping be unit-tested against fixtures on
 * a machine with no graphify installed (./graphify.test.ts), which matters
 * because graphify is a Python CLI with ~26 native tree-sitter grammar
 * wheels - it runs in the sandbox image (sandbox/Dockerfile), not here.
 * ./codeIndexer.ts owns all of the IO.
 *
 * Wire format: graphify writes NetworkX `node_link_data`, i.e.
 * `{ nodes: [{ id, ... }], links: [{ source, target, ... }] }`. It is
 * validated by hand below rather than with zod, because @katnor/knowledge
 * does not currently depend on zod and pulling one in to parse a single file
 * whose contract we already pin (by pinning graphify's version in the image)
 * is not worth the dependency.
 */

/** A node as it appears in graphify's `graph.json`. Only the fields consumed here are declared. */
export interface GraphifyNode {
  id: string;
  label?: string;
  /**
   * graphify's own node kind - "file", "module", "external", and the symbol
   * kinds its extractors emit. Deliberately open: see `mapGraphifyGraph`.
   */
  type?: string;
  file_type?: string;
  source_file?: string;
  /** graphify formats this as `L<line>`, e.g. "L42". */
  source_location?: string;
  external?: boolean;
  community?: number | null;
  community_name?: string;
}

/** An edge as it appears in graphify's `graph.json` (`links`, not `edges` - NetworkX naming). */
export interface GraphifyLink {
  source: string;
  target: string;
  /** e.g. "imports", "calls", "inherits", "method", "references", "uses". */
  relation?: string;
  /** "EXTRACTED" (explicit in the source), "INFERRED", or "AMBIGUOUS". */
  confidence?: string;
  confidence_score?: number;
  weight?: number;
}

export interface GraphifyGraph {
  nodes: GraphifyNode[];
  links: GraphifyLink[];
}

/**
 * The result of parsing, including how much was discarded. The counts are
 * returned rather than logged here so this module stays pure - and so a
 * caller can treat a large skip count as a failure rather than a shrug,
 * which is the whole reason they are not silently swallowed.
 */
export interface ParsedGraphifyGraph {
  graph: GraphifyGraph;
  skippedNodes: number;
  skippedLinks: number;
}

/** A `kg_node` to upsert. Mirrors `CreateKgNodeInput` minus the fields codeIndexer.ts fills in. */
export interface KgNodeSpec {
  type: string;
  name: string;
  properties: Record<string, unknown>;
}

/** A `kg_edge` to upsert, with endpoints named rather than resolved - codeIndexer.ts maps names to ids. */
export interface KgEdgeSpec {
  fromName: string;
  toName: string;
  type: string;
  weight: number | null;
}

export interface MappedGraphifyGraph {
  nodes: KgNodeSpec[];
  edges: KgEdgeSpec[];
  /** Edges whose source or target was not among `nodes` - graphify can emit these. */
  droppedEdges: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parses `graph.json`'s text into the subset of graphify's wire format used
 * here.
 *
 * Malformed individual nodes/links are skipped and counted rather than
 * thrown on: one unparseable entry in a graph of thousands should not lose
 * the whole ingest. A structurally wrong file (not JSON, not an object, no
 * `nodes`/`links` arrays) does throw - that is a broken graphify run, not a
 * bad row, and silently indexing nothing would look identical to success.
 */
export function parseGraphifyGraph(raw: string): ParsedGraphifyGraph {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`graphify graph.json is not valid JSON: ${message}`);
  }
  if (!isRecord(data)) {
    throw new Error('graphify graph.json is not a JSON object');
  }
  if (!Array.isArray(data.nodes)) {
    throw new Error('graphify graph.json has no "nodes" array');
  }
  if (!Array.isArray(data.links)) {
    throw new Error('graphify graph.json has no "links" array');
  }

  const nodes: GraphifyNode[] = [];
  let skippedNodes = 0;
  for (const entry of data.nodes) {
    const id = isRecord(entry) ? optionalString(entry.id) : undefined;
    if (!isRecord(entry) || id === undefined) {
      skippedNodes += 1;
      continue;
    }
    nodes.push({
      id,
      label: optionalString(entry.label),
      type: optionalString(entry.type),
      file_type: optionalString(entry.file_type),
      source_file: optionalString(entry.source_file),
      source_location: optionalString(entry.source_location),
      external: typeof entry.external === 'boolean' ? entry.external : undefined,
      community: optionalNumber(entry.community) ?? null,
      community_name: optionalString(entry.community_name),
    });
  }

  const links: GraphifyLink[] = [];
  let skippedLinks = 0;
  for (const entry of data.links) {
    const source = isRecord(entry) ? optionalString(entry.source) : undefined;
    const target = isRecord(entry) ? optionalString(entry.target) : undefined;
    if (!isRecord(entry) || source === undefined || target === undefined) {
      skippedLinks += 1;
      continue;
    }
    links.push({
      source,
      target,
      relation: optionalString(entry.relation),
      confidence: optionalString(entry.confidence),
      confidence_score: optionalNumber(entry.confidence_score),
      weight: optionalNumber(entry.weight),
    });
  }

  return { graph: { nodes, links }, skippedNodes, skippedLinks };
}

/** graphify marks file nodes with `type: "file"` (see its export.py). Everything else is a symbol. */
function isFileNode(node: GraphifyNode): boolean {
  return node.type === 'file';
}

function stripLeadingDotSlash(path: string): string {
  return path.replace(/^\.\//, '');
}

/**
 * The `kg_node.name` a graphify node maps to.
 *
 * File nodes reuse the `<owner>/<repo>/<path>` convention ./codeIndexer.ts
 * already uses for its own file nodes, so a re-index converges on one node
 * per file instead of creating a parallel set. Symbols are namespaced with
 * `#` instead, so two repos that both define a `Server` stay distinct and
 * neither can collide with a path.
 */
export function kgNodeName(node: GraphifyNode, repoName: string): string {
  if (isFileNode(node)) {
    const path = node.source_file ?? node.label ?? node.id;
    return `${repoName}/${stripLeadingDotSlash(path)}`;
  }
  return `${repoName}#${node.id}`;
}

/**
 * graphify's confidence tag as a number, for `kg_edge.weight`.
 *
 * `kg_edge` has no `properties` column, so the EXTRACTED/INFERRED
 * distinction - one of the things graphify is most useful for - can only
 * survive as this score. The fallbacks mirror graphify's own
 * `_CONFIDENCE_SCORE_DEFAULTS` (EXTRACTED 1.0, INFERRED 0.55, AMBIGUOUS
 * 0.2) so an edge keeps the same number whether or not its producer
 * happened to write `confidence_score` explicitly.
 */
const CONFIDENCE_SCORES: Record<string, number> = {
  EXTRACTED: 1.0,
  INFERRED: 0.55,
  AMBIGUOUS: 0.2,
};

export function edgeWeight(link: GraphifyLink): number | null {
  if (link.confidence_score !== undefined) return link.confidence_score;
  if (link.confidence !== undefined && link.confidence in CONFIDENCE_SCORES) {
    return CONFIDENCE_SCORES[link.confidence] ?? null;
  }
  return link.weight ?? null;
}

/**
 * Maps a parsed graphify graph onto `kg_node` / `kg_edge` specs for one repo.
 *
 * graphify's node `type` vocabulary is open-ended and grows with its
 * extractors, so an unrecognized type is passed straight through to
 * `kg_node.type` (which is free-form text in the schema for exactly this
 * reason) rather than dropped or coerced to a placeholder. Dropping would
 * silently shrink the graph on a graphify upgrade, which is a far worse
 * failure than an unfamiliar type string showing up in the UI.
 *
 * Edges pointing at a node that is not in `nodes` are dropped and counted.
 * `kg_edge.from_id`/`to_id` are non-null foreign keys, so a dangling edge
 * cannot be represented at all.
 */
export function mapGraphifyGraph(graph: GraphifyGraph, repoName: string): MappedGraphifyGraph {
  const nameById = new Map<string, string>();
  const nodes: KgNodeSpec[] = [];

  for (const node of graph.nodes) {
    const name = kgNodeName(node, repoName);
    // First writer wins: graphify ids are unique, but two ids can map to one
    // name (e.g. a file node and a symbol whose id is that path). Keeping the
    // first keeps the mapping deterministic for a given graph.json.
    if (!nameById.has(node.id)) nameById.set(node.id, name);

    const properties: Record<string, unknown> = { repo: repoName, graphify_id: node.id };
    if (node.label !== undefined) properties.label = node.label;
    if (node.source_file !== undefined) properties.path = stripLeadingDotSlash(node.source_file);
    if (node.source_location !== undefined) properties.location = node.source_location;
    if (node.community !== null && node.community !== undefined) {
      properties.community = node.community;
    }
    if (node.community_name !== undefined) properties.community_name = node.community_name;
    if (node.external !== undefined) properties.external = node.external;

    nodes.push({ type: node.type ?? 'symbol', name, properties });
  }

  const edges: KgEdgeSpec[] = [];
  let droppedEdges = 0;
  for (const link of graph.links) {
    const fromName = nameById.get(link.source);
    const toName = nameById.get(link.target);
    if (fromName === undefined || toName === undefined || fromName === toName) {
      droppedEdges += 1;
      continue;
    }
    edges.push({
      fromName,
      toName,
      type: link.relation ?? 'related_to',
      weight: edgeWeight(link),
    });
  }

  return { nodes, edges, droppedEdges };
}
