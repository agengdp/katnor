import type { ContentBlock } from '@katnor/llm';
import { getProvider } from '@katnor/llm';
import { KG_NODE_TYPES, type KgNodeType } from './types.js';

/**
 * PLAN.md 4.4's Librarian ingest step: "an extraction call (structured
 * outputs, claude-sonnet-5 by default) returns entities and relations".
 * This system has no dedicated JSON-mode API to call (Anthropic's tool-use
 * is the stable, verifiable way to get schema-constrained output - see
 * @katnor/llm's `StepInput.toolChoice` doc comment for why forcing a
 * single tool call is used as the stand-in here), so extraction is just
 * one `provider.step()` call with `toolChoice` forced onto a single
 * `record_extraction` tool whose input IS the structured result.
 */

const EXTRACTION_MODEL = 'claude-sonnet-5';
const EXTRACTION_TOOL_NAME = 'record_extraction';

export interface ExtractedNode {
  /** A local, per-call id (e.g. "n1") - edges below reference nodes by this, not a real DB id, since none exists until ./librarian.ts upserts it. */
  key: string;
  type: KgNodeType;
  name: string;
  summary?: string;
}

export interface ExtractedEdge {
  /** An `ExtractedNode.key` from the same call. */
  from: string;
  /** An `ExtractedNode.key` from the same call. */
  to: string;
  type: string;
}

export interface ExtractionResult {
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
}

const EMPTY_RESULT: ExtractionResult = { nodes: [], edges: [] };

function buildInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'A short local id (e.g. "n1") - referenced by edges below, not a real database id.' },
            type: { type: 'string', enum: [...KG_NODE_TYPES] },
            name: { type: 'string', description: 'A short, specific, human-readable name - not a full sentence.' },
            summary: { type: 'string', description: 'One or two sentences of context, if useful.' },
          },
          required: ['key', 'type', 'name'],
          additionalProperties: false,
        },
      },
      edges: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            type: {
              type: 'string',
              description:
                'e.g. part_of, depends_on, implements, decided_in, produced_by, assigned_to, references, blocks, supersedes, mentions, imports, calls - or another short snake_case verb if none fits.',
            },
          },
          required: ['from', 'to', 'type'],
          additionalProperties: false,
        },
      },
    },
    required: ['nodes', 'edges'],
    additionalProperties: false,
  };
}

const SYSTEM_PROMPT = [
  "You extract a knowledge graph from one piece of an AI software company's work output -",
  'a completed task, a run summary, an artifact, or a discussion thread. Identify concrete,',
  'specific entities (decisions made, requirements stated, modules/files touched, people/agents',
  'involved, risks or bugs raised, tools or concepts discussed) and the relationships between them.',
  '',
  'Be conservative: only extract what the text actually states or clearly implies. Skip vague or',
  'generic entities. A short, low-signal text may legitimately produce zero nodes and zero edges -',
  'call the tool with empty arrays in that case rather than inventing something.',
].join('\n');

function isToolUseBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'tool_use' }> {
  return block.type === 'tool_use';
}

function parseExtraction(input: Record<string, unknown>): ExtractionResult {
  const nodesRaw = Array.isArray(input.nodes) ? input.nodes : [];
  const nodes: ExtractedNode[] = nodesRaw
    .filter((n): n is Record<string, unknown> => typeof n === 'object' && n !== null)
    .map((n) => {
      const type = typeof n.type === 'string' && (KG_NODE_TYPES as readonly string[]).includes(n.type) ? (n.type as KgNodeType) : 'concept';
      return {
        key: typeof n.key === 'string' ? n.key : '',
        type,
        name: typeof n.name === 'string' ? n.name.trim() : '',
        summary: typeof n.summary === 'string' && n.summary.trim().length > 0 ? n.summary.trim() : undefined,
      };
    })
    .filter((n) => n.key.length > 0 && n.name.length > 0);

  const nodeKeys = new Set(nodes.map((n) => n.key));
  const edgesRaw = Array.isArray(input.edges) ? input.edges : [];
  const edges: ExtractedEdge[] = edgesRaw
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      from: typeof e.from === 'string' ? e.from : '',
      to: typeof e.to === 'string' ? e.to : '',
      type: typeof e.type === 'string' && e.type.trim().length > 0 ? e.type.trim() : 'references',
    }))
    // Both endpoints must resolve to a node this same call actually produced.
    .filter((e) => nodeKeys.has(e.from) && nodeKeys.has(e.to));

  return { nodes, edges };
}

/**
 * Extracts entities/relations from `text` (already truncated/prepared by
 * the caller - this function doesn't itself cap length). Never throws: a
 * provider error, refusal, or malformed tool input all come back as
 * `{nodes: [], edges: []}` rather than failing the whole ingest job over
 * one piece of source content.
 */
export async function extractEntities(text: string): Promise<ExtractionResult> {
  if (text.trim().length === 0) return EMPTY_RESULT;

  const provider = getProvider('anthropic');
  let result;
  try {
    result = await provider.step({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      tools: [
        {
          name: EXTRACTION_TOOL_NAME,
          description: 'Records the entities and relationships extracted from the text.',
          inputSchema: buildInputSchema(),
        },
      ],
      toolChoice: { type: 'tool', name: EXTRACTION_TOOL_NAME },
      model: EXTRACTION_MODEL,
      effort: 'medium',
      thinkingDisplay: 'omitted',
      maxTokens: 4096,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[knowledge/extraction] provider.step() threw: ${message}`);
    return EMPTY_RESULT;
  }

  if (result.stopReason === 'error' || result.stopReason === 'refusal') {
    console.error(`[knowledge/extraction] extraction call did not succeed: ${result.errorMessage ?? result.refusalCategory ?? result.stopReason}`);
    return EMPTY_RESULT;
  }

  const toolUse = result.content.filter(isToolUseBlock).find((block) => block.name === EXTRACTION_TOOL_NAME);
  if (!toolUse) return EMPTY_RESULT;

  return parseExtraction(toolUse.input);
}
