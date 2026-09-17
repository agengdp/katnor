import type { ContentBlock } from '@katnor/llm';
import { getProvider } from '@katnor/llm';
import { kgEdgeRepo, kgNodeRepo, wikiPageRepo } from '@katnor/db';
import * as wikiStorage from './wikiStorage.js';

/**
 * PLAN.md 4.5's wiki lint job: "finds contradictions, orphan pages, stale
 * facts (source superseded), and missing pages for frequently referenced
 * graph nodes." Returns a plain report rather than posting anywhere
 * itself - @katnor/knowledge can't depend on @katnor/agents (which already
 * depends on @katnor/knowledge for the search_knowledge/ask_wiki tools;
 * that would be a cycle), so apps/worker's wiki-lint handler is what turns
 * this into a channel message via @katnor/agents' postMessage.
 *
 * Only orphan pages and missing-pages-for-frequent-nodes are found by
 * plain, mechanical checks (a wikilink graph traversal; an edge-count
 * threshold). Contradictions and "stale" facts are inherently a judgement
 * call about meaning, not something a fixed rule can reliably catch - so
 * those two use the same forced-tool-call LLM pattern as
 * ./extraction.ts, reading every page's actual content and asking the
 * model to flag what it finds. A project with fewer than two non-empty
 * pages skips that call entirely (nothing to compare).
 */

export interface MissingPageFinding {
  name: string;
  type: string;
  edgeCount: number;
}

export interface LintReport {
  orphanPages: string[];
  missingPages: MissingPageFinding[];
  contradictions: string[];
  staleFacts: string[];
}

const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

async function findOrphanPages(projectId: string): Promise<string[]> {
  const pages = await wikiStorage.listPages(projectId);
  const referenced = new Set<string>();

  for (const page of pages) {
    const content = await wikiStorage.readPage(projectId, page);
    if (!content) continue;
    for (const match of content.matchAll(WIKILINK_PATTERN)) {
      const target = match[1]?.trim();
      if (target) referenced.add(target);
    }
  }

  return pages.filter((page) => page !== 'index.md' && page !== 'log.md' && !referenced.has(page));
}

/** A node "frequently referenced" enough to deserve its own page - at least this many edges (either direction). */
const FREQUENT_NODE_EDGE_THRESHOLD = 3;

async function findMissingPages(projectId: string): Promise<MissingPageFinding[]> {
  const [nodes, pages] = await Promise.all([
    kgNodeRepo.list({ project_id: projectId }),
    wikiPageRepo.list(projectId),
  ]);
  const pageTitles = new Set(pages.map((page) => page.title.toLowerCase()));

  const findings: MissingPageFinding[] = [];
  for (const node of nodes) {
    if (pageTitles.has(node.name.toLowerCase())) continue;
    const edges = await kgEdgeRepo.listForNode(node.id);
    if (edges.length >= FREQUENT_NODE_EDGE_THRESHOLD) {
      findings.push({ name: node.name, type: node.type, edgeCount: edges.length });
    }
  }
  return findings;
}

const LINT_MODEL = 'claude-sonnet-5';
const LINT_TOOL_NAME = 'record_lint_findings';
const MAX_PAGE_CHARS = 3000;
const MAX_TOTAL_CHARS = 40_000;

const LINT_SYSTEM_PROMPT = [
  "You are reviewing a project's wiki for two kinds of problems:",
  '1. Contradictions: two pages making incompatible claims about the same thing.',
  '2. Stale facts: a page describing something that a LATER page (by content, not necessarily order',
  '   given here) appears to have superseded or reversed, without the older page being updated.',
  '',
  'Only report findings you can point to concretely (name the pages involved). If you see nothing',
  'wrong, call the tool with both arrays empty - do not invent problems to have something to report.',
].join('\n');

function isToolUseBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'tool_use' }> {
  return block.type === 'tool_use';
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : [];
}

async function findContradictionsAndStaleFacts(
  projectId: string,
): Promise<{ contradictions: string[]; staleFacts: string[] }> {
  const paths = (await wikiStorage.listPages(projectId)).filter((path) => path !== 'log.md');
  const pages = await Promise.all(
    paths.map(async (path) => ({ path, content: await wikiStorage.readPage(projectId, path) })),
  );
  const nonEmpty = pages.filter((page): page is { path: string; content: string } =>
    Boolean(page.content && page.content.trim().length > 0),
  );
  if (nonEmpty.length < 2) return { contradictions: [], staleFacts: [] };

  const combined = nonEmpty
    .map((page) => `## ${page.path}\n\n${page.content.slice(0, MAX_PAGE_CHARS)}`)
    .join('\n\n---\n\n')
    .slice(0, MAX_TOTAL_CHARS);

  // Calls the provider directly rather than going through @katnor/agents'
  // runExecutor.ts - there's no agent "run" to attribute this system job
  // to. That also means it never reaches that file's Phase 5
  // `checkBudgetHardStop`: this call runs regardless of the company's
  // daily budget, and its cost never reaches `runRepo.sumCostSince` (so
  // it's invisible to the cost dashboards too) - the same caveat
  // @katnor/agents' standup.ts documents for its own direct provider call.
  const provider = getProvider('anthropic');
  let result;
  try {
    result = await provider.step({
      systemPrompt: LINT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: combined }] }],
      tools: [
        {
          name: LINT_TOOL_NAME,
          description: 'Records contradiction and stale-fact findings across the given wiki pages.',
          inputSchema: {
            type: 'object',
            properties: {
              contradictions: {
                type: 'array',
                items: { type: 'string' },
                description: 'One sentence per finding, naming the pages involved.',
              },
              stale_facts: {
                type: 'array',
                items: { type: 'string' },
                description: 'One sentence per finding, naming the pages involved.',
              },
            },
            required: ['contradictions', 'stale_facts'],
            additionalProperties: false,
          },
        },
      ],
      toolChoice: { type: 'tool', name: LINT_TOOL_NAME },
      model: LINT_MODEL,
      effort: 'medium',
      thinkingDisplay: 'omitted',
      maxTokens: 2048,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[knowledge/wikiLint] provider.step() threw: ${message}`);
    return { contradictions: [], staleFacts: [] };
  }

  if (result.stopReason === 'error' || result.stopReason === 'refusal') {
    console.error(
      `[knowledge/wikiLint] lint call did not succeed: ${result.errorMessage ?? result.refusalCategory ?? result.stopReason}`,
    );
    return { contradictions: [], staleFacts: [] };
  }

  const toolUse = result.content
    .filter(isToolUseBlock)
    .find((block) => block.name === LINT_TOOL_NAME);
  if (!toolUse) return { contradictions: [], staleFacts: [] };

  return {
    contradictions: toStringArray(toolUse.input.contradictions),
    staleFacts: toStringArray(toolUse.input.stale_facts),
  };
}

export async function runWikiLint(projectId: string): Promise<LintReport> {
  const [orphanPages, missingPages, semanticFindings] = await Promise.all([
    findOrphanPages(projectId),
    findMissingPages(projectId),
    findContradictionsAndStaleFacts(projectId),
  ]);

  return {
    orphanPages,
    missingPages,
    contradictions: semanticFindings.contradictions,
    staleFacts: semanticFindings.staleFacts,
  };
}

/** True when `report` found nothing worth surfacing - callers use this to skip posting an empty "all clear" message every time. */
export function isLintReportEmpty(report: LintReport): boolean {
  return (
    report.orphanPages.length === 0 &&
    report.missingPages.length === 0 &&
    report.contradictions.length === 0 &&
    report.staleFacts.length === 0
  );
}

/** Renders `report` as a short, human-readable channel message. */
export function formatLintReport(report: LintReport): string {
  const sections: string[] = ['Wiki lint report:'];
  if (report.orphanPages.length > 0) {
    sections.push(`Orphan pages (not linked from anywhere): ${report.orphanPages.join(', ')}`);
  }
  if (report.missingPages.length > 0) {
    sections.push(
      `Frequently-referenced concepts with no wiki page: ${report.missingPages
        .map((m) => `${m.name} (${m.type}, ${m.edgeCount} connections)`)
        .join(', ')}`,
    );
  }
  if (report.contradictions.length > 0) {
    sections.push(
      `Possible contradictions:\n${report.contradictions.map((c) => `- ${c}`).join('\n')}`,
    );
  }
  if (report.staleFacts.length > 0) {
    sections.push(`Possibly stale facts:\n${report.staleFacts.map((s) => `- ${s}`).join('\n')}`);
  }
  return sections.join('\n\n');
}
