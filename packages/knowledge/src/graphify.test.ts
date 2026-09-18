import { describe, expect, it } from 'vitest';
import {
  edgeWeight,
  kgNodeName,
  mapGraphifyGraph,
  parseGraphifyGraph,
  type GraphifyGraph,
} from './graphify.js';

/**
 * A minimal graph.json in graphify's real wire format (NetworkX
 * `node_link_data`): one file node, one symbol in it, and an EXTRACTED edge.
 */
const SAMPLE = JSON.stringify({
  directed: false,
  multigraph: false,
  graph: {},
  nodes: [
    {
      id: 'src_server_ts',
      label: 'src/server.ts',
      type: 'file',
      file_type: 'code',
      source_file: './src/server.ts',
      community: 2,
      community_name: 'HTTP layer',
    },
    {
      id: 'startServer',
      label: 'startServer()',
      type: 'function',
      file_type: 'code',
      source_file: 'src/server.ts',
      source_location: 'L42',
      community: 2,
    },
  ],
  links: [
    {
      source: 'src_server_ts',
      target: 'startServer',
      relation: 'defines',
      confidence: 'EXTRACTED',
      confidence_score: 1.0,
    },
  ],
});

describe('parseGraphifyGraph', () => {
  it('parses nodes and links from graphify wire format', () => {
    const { graph, skippedNodes, skippedLinks } = parseGraphifyGraph(SAMPLE);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.links).toHaveLength(1);
    expect(skippedNodes).toBe(0);
    expect(skippedLinks).toBe(0);
    expect(graph.nodes[0]?.type).toBe('file');
    expect(graph.links[0]?.relation).toBe('defines');
  });

  it('throws on input that is not JSON', () => {
    expect(() => parseGraphifyGraph('not json at all')).toThrow(/not valid JSON/);
  });

  it('throws on JSON that is not an object', () => {
    expect(() => parseGraphifyGraph('[1, 2, 3]')).toThrow(/not a JSON object/);
  });

  // A graphify run that produced no graph must not look like a successful
  // ingest of zero nodes - that is the failure this guards.
  it('throws when the nodes or links array is missing', () => {
    expect(() => parseGraphifyGraph('{"links": []}')).toThrow(/no "nodes" array/);
    expect(() => parseGraphifyGraph('{"nodes": []}')).toThrow(/no "links" array/);
  });

  it('skips and counts malformed nodes rather than losing the whole graph', () => {
    const raw = JSON.stringify({
      nodes: [{ id: 'ok' }, { label: 'no id' }, 'not an object', { id: '' }],
      links: [],
    });
    const { graph, skippedNodes } = parseGraphifyGraph(raw);
    expect(graph.nodes).toHaveLength(1);
    expect(skippedNodes).toBe(3);
  });

  it('skips and counts links missing an endpoint', () => {
    const raw = JSON.stringify({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ source: 'a', target: 'b' }, { source: 'a' }, { target: 'b' }, 42],
    });
    const { graph, skippedLinks } = parseGraphifyGraph(raw);
    expect(graph.links).toHaveLength(1);
    expect(skippedLinks).toBe(3);
  });
});

describe('kgNodeName', () => {
  it('names file nodes to match the existing codeIndexer convention', () => {
    const name = kgNodeName(
      { id: 'src_server_ts', type: 'file', source_file: './src/server.ts' },
      'acme/api',
    );
    expect(name).toBe('acme/api/src/server.ts');
  });

  it('namespaces symbols with # so they cannot collide with a path', () => {
    expect(kgNodeName({ id: 'startServer', type: 'function' }, 'acme/api')).toBe(
      'acme/api#startServer',
    );
  });

  it('keeps same-named symbols in different repos distinct', () => {
    const a = kgNodeName({ id: 'Server', type: 'class' }, 'acme/api');
    const b = kgNodeName({ id: 'Server', type: 'class' }, 'acme/web');
    expect(a).not.toBe(b);
  });
});

describe('edgeWeight', () => {
  it('prefers an explicit confidence_score', () => {
    expect(edgeWeight({ source: 'a', target: 'b', confidence_score: 0.8 })).toBe(0.8);
  });

  // kg_edge has no properties column, so the EXTRACTED/INFERRED tag only
  // survives as this number - it must not silently become null.
  it('falls back to graphify’s own score for each confidence tag', () => {
    expect(edgeWeight({ source: 'a', target: 'b', confidence: 'EXTRACTED' })).toBe(1.0);
    expect(edgeWeight({ source: 'a', target: 'b', confidence: 'INFERRED' })).toBe(0.55);
    expect(edgeWeight({ source: 'a', target: 'b', confidence: 'AMBIGUOUS' })).toBe(0.2);
  });

  it('falls back to weight, then null', () => {
    expect(edgeWeight({ source: 'a', target: 'b', weight: 0.3 })).toBe(0.3);
    expect(edgeWeight({ source: 'a', target: 'b' })).toBeNull();
    expect(edgeWeight({ source: 'a', target: 'b', confidence: 'NOVEL_TAG' })).toBeNull();
  });
});

describe('mapGraphifyGraph', () => {
  it('maps nodes and edges onto kg specs', () => {
    const { graph } = parseGraphifyGraph(SAMPLE);
    const { nodes, edges, droppedEdges } = mapGraphifyGraph(graph, 'acme/api');

    expect(droppedEdges).toBe(0);
    expect(nodes.map((n) => n.name)).toEqual(['acme/api/src/server.ts', 'acme/api#startServer']);
    expect(nodes.map((n) => n.type)).toEqual(['file', 'function']);

    const symbol = nodes[1];
    expect(symbol?.properties).toMatchObject({
      repo: 'acme/api',
      graphify_id: 'startServer',
      path: 'src/server.ts',
      location: 'L42',
      community: 2,
    });

    expect(edges).toEqual([
      {
        fromName: 'acme/api/src/server.ts',
        toName: 'acme/api#startServer',
        type: 'defines',
        weight: 1.0,
      },
    ]);
  });

  // graphify's type vocabulary grows with its extractors; an unfamiliar type
  // must reach kg_node.type rather than be dropped, or a graphify upgrade
  // would silently shrink the graph.
  it('passes unknown node types straight through', () => {
    const graph: GraphifyGraph = {
      nodes: [{ id: 'x', type: 'terraform_file' }, { id: 'y' }],
      links: [],
    };
    const { nodes } = mapGraphifyGraph(graph, 'acme/api');
    expect(nodes[0]?.type).toBe('terraform_file');
    expect(nodes[1]?.type).toBe('symbol');
  });

  it('drops and counts edges whose endpoint is not a node', () => {
    const graph: GraphifyGraph = {
      nodes: [{ id: 'a' }],
      links: [
        { source: 'a', target: 'ghost' },
        { source: 'ghost', target: 'a' },
      ],
    };
    const { edges, droppedEdges } = mapGraphifyGraph(graph, 'acme/api');
    expect(edges).toHaveLength(0);
    expect(droppedEdges).toBe(2);
  });

  it('drops self-edges, which kg_edge should not carry', () => {
    const graph: GraphifyGraph = { nodes: [{ id: 'a' }], links: [{ source: 'a', target: 'a' }] };
    const { edges, droppedEdges } = mapGraphifyGraph(graph, 'acme/api');
    expect(edges).toHaveLength(0);
    expect(droppedEdges).toBe(1);
  });

  it('defaults a relation-less edge rather than dropping it', () => {
    const graph: GraphifyGraph = {
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ source: 'a', target: 'b' }],
    };
    const { edges } = mapGraphifyGraph(graph, 'acme/api');
    expect(edges[0]?.type).toBe('related_to');
  });
});
