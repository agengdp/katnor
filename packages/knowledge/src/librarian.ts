import { createHash } from 'node:crypto';
import type { KgEdgeEvidence } from '@katnor/core';
import {
  agentRepo,
  artifactRepo,
  eventRepo,
  kgEdgeRepo,
  kgNodeRepo,
  projectRepo,
  runRepo,
  taskRepo,
  wikiPageRepo,
} from '@katnor/db';
import { embed } from './embeddings.js';
import { extractEntities, type ExtractedNode } from './extraction.js';
import { slugify } from './slug.js';
import * as wikiStorage from './wikiStorage.js';

/**
 * The Librarian (PLAN.md 4.4/4.5) - a system job, not a hired employee
 * (see PLAN.md 6.2.6), triggered once per successfully finished,
 * task-scoped run (see @katnor/agents' runExecutor.ts, which enqueues the
 * `librarian-ingest` job this module's `ingestRun` handles). A run with no
 * task (the CEO hiring someone, an ask_human round-trip, ...) has no
 * project to file anything under and is skipped - the knowledge graph and
 * wiki are both project-scoped by design.
 *
 * Scope note: PLAN.md's fuller vision has the Librarian deciding which of
 * many concept/module/person pages to create or update per ingest. This
 * implementation is deliberately narrower - every extracted `decision`
 * node gets a real ADR page under `wiki/decisions/`, `wiki/log.md` gets one
 * line per ingested run, and `wiki/index.md` is regenerated - while every
 * other extracted entity (module, concept, person, ...) becomes a
 * knowledge-graph node with its own searchable/citable summary but not
 * (yet) its own dedicated wiki page. Extending this to write a page per
 * concept/module is future work, not a broken stub: `search_knowledge`/
 * `ask_wiki` (./search.ts, ./ask.ts) already surface graph nodes as first-
 * class citable results, so "cited answers" work today without it.
 */

function buildSourceText(
  project: NonNullable<Awaited<ReturnType<typeof projectRepo.getById>>>,
  task: NonNullable<Awaited<ReturnType<typeof taskRepo.getById>>>,
  run: NonNullable<Awaited<ReturnType<typeof runRepo.getById>>>,
  agent: Awaited<ReturnType<typeof agentRepo.getById>>,
  artifacts: Awaited<ReturnType<typeof artifactRepo.listLatest>>,
): string {
  const parts = [
    `Project: ${project.name}`,
    `Task: ${task.title}`,
    task.description ? `Description: ${task.description}` : null,
    task.acceptance_criteria ? `Acceptance criteria: ${task.acceptance_criteria}` : null,
    `Agent: ${agent?.name ?? run.agent_id}${agent ? ` (${agent.title})` : ''}`,
    run.summary ? `Run summary: ${run.summary}` : null,
    artifacts.length > 0 ? `Artifacts produced: ${artifacts.map((a) => `${a.kind} "${a.title}"`).join(', ')}` : null,
  ];
  return parts.filter((part): part is string => Boolean(part)).join('\n');
}

/** Upserts one extracted node by (project_id, type, name) and returns its real DB id. */
async function upsertNode(projectId: string, node: ExtractedNode): Promise<string> {
  const existing = await kgNodeRepo.getByName(projectId, node.type, node.name);
  const embedding = await embed(`${node.name}\n${node.summary ?? ''}`.trim());

  if (existing) {
    const updated = await kgNodeRepo.update(existing.id, {
      summary: node.summary ?? existing.summary,
      embedding: embedding ?? existing.embedding,
    });
    return (updated ?? existing).id;
  }

  const created = await kgNodeRepo.create({
    project_id: projectId,
    type: node.type,
    name: node.name,
    summary: node.summary ?? null,
    properties: {},
    embedding,
  });
  await eventRepo.append({
    type: 'kg_node.upserted',
    payload: { kg_node_id: created.id, project_id: projectId, node_type: created.type, name: created.name },
  });
  return created.id;
}

/** Creates or extends this decision's ADR page under wiki/decisions/ - see this module's doc comment for why decisions specifically get a page. */
async function writeDecisionPage(projectId: string, node: ExtractedNode, evidence: KgEdgeEvidence): Promise<void> {
  const relPath = `decisions/ADR-${slugify(node.name)}.md`;
  const existing = await wikiStorage.readPage(projectId, relPath);
  const timestamp = new Date().toISOString();
  const sourceLine = `${evidence.kind}:${evidence.id}`;
  const updateSection = `\n\n## Update - ${timestamp}\n\n${node.summary ?? node.name}\n\nSource: ${sourceLine}\n`;

  const content = existing
    ? `${existing.trimEnd()}${updateSection}`
    : [
        '---',
        'type: decision',
        `sources: ["${sourceLine}"]`,
        '---',
        '',
        `# ${node.name}`,
        (node.summary ?? node.name).trim(),
        '',
        `Source: ${sourceLine}`,
        '',
      ].join('\n');

  await wikiStorage.writePage(projectId, relPath, content);

  const contentHash = createHash('sha256').update(content).digest('hex');
  const embedding = await embed(content);
  const row = await wikiPageRepo.upsert({
    project_id: projectId,
    path: relPath,
    title: node.name,
    frontmatter: { type: 'decision', sources: [sourceLine] },
    content_hash: contentHash,
    embedding,
  });
  await eventRepo.append({
    type: 'wiki_page.updated',
    payload: { wiki_page_id: row.id, project_id: projectId, path: row.path },
  });
}

async function appendLogEntry(projectId: string, line: string): Promise<void> {
  const existing = (await wikiStorage.readPage(projectId, 'log.md')) ?? '# Change log\n\n';
  await wikiStorage.writePage(projectId, 'log.md', `${existing.trimEnd()}\n- ${line}\n`);
}

async function regenerateIndex(projectId: string, projectName: string): Promise<void> {
  const pages = (await wikiStorage.listPages(projectId)).filter((p) => p !== 'index.md' && p !== 'log.md');
  const lines = [
    `# ${projectName} wiki`,
    '',
    "A catalogue of this project's pages - the Librarian keeps this in sync as pages are added.",
    '',
    '## Pages',
    '',
  ];
  for (const page of pages.sort()) {
    lines.push(`- [[${page}]]`);
  }
  if (pages.length === 0) lines.push('(no pages yet)');
  await wikiStorage.writePage(projectId, 'index.md', `${lines.join('\n')}\n`);
}

/**
 * Ingests one finished run into its project's wiki and knowledge graph.
 * Never throws past its own boundary in normal operation - a project with
 * nothing to file under, or an extraction call that returns nothing, both
 * just result in a quiet no-op (logged, not surfaced as a job failure)
 * rather than retrying pg-boss's redelivery for something that will never
 * succeed differently.
 */
export async function ingestRun(runId: string): Promise<void> {
  const run = await runRepo.getById(runId);
  if (!run) {
    console.warn(`[knowledge/librarian] run "${runId}" not found - skipping ingest`);
    return;
  }
  const task = run.task_id ? await taskRepo.getById(run.task_id) : undefined;
  if (!task) return; // not task-scoped - nothing project-level to file this under

  const [project, agent, artifacts] = await Promise.all([
    projectRepo.getById(task.project_id),
    agentRepo.getById(run.agent_id),
    artifactRepo.listLatest({ run_id: runId }),
  ]);
  if (!project) return;

  await wikiStorage.ensureProjectWiki(project.id, project.name);

  const sourceText = buildSourceText(project, task, run, agent, artifacts);
  const extraction = await extractEntities(sourceText);
  const evidence: KgEdgeEvidence = { kind: 'run', id: runId };

  const keyToId = new Map<string, string>();
  for (const node of extraction.nodes) {
    const id = await upsertNode(project.id, node);
    keyToId.set(node.key, id);
    if (node.type === 'decision') {
      await writeDecisionPage(project.id, node, evidence);
    }
  }

  for (const edge of extraction.edges) {
    const fromId = keyToId.get(edge.from);
    const toId = keyToId.get(edge.to);
    if (!fromId || !toId) continue;
    await kgEdgeRepo.createIfMissing({ from_id: fromId, to_id: toId, type: edge.type, weight: null, evidence });
  }

  const summaryLine = `${new Date().toISOString()} - ${agent?.name ?? run.agent_id} finished "${task.title}"${
    run.summary ? `: ${run.summary.slice(0, 200)}` : ''
  }`;
  await appendLogEntry(project.id, summaryLine);
  if (extraction.nodes.length > 0) {
    await regenerateIndex(project.id, project.name);
  }

  await wikiStorage.commit(project.id, `Librarian: ingest run ${runId}`);
}
