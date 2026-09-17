import type { WorkspaceProject, WorkspaceRepo } from '@katnor/tools';
import { getWorkspaceManager, repoDirName } from '@katnor/tools';
import { kgEdgeRepo, kgNodeRepo } from '@katnor/db';
import { mapGraphifyGraph, parseGraphifyGraph, type KgNodeSpec } from './graphify.js';

/**
 * PLAN.md 4.4's tree-sitter code indexer: "parses repos with tree-sitter to
 * add Module/File/Function nodes and imports/calls edges".
 *
 * The parsing is done by graphify (https://github.com/Graphify-Labs/graphify,
 * Apache-2.0), a CLI that walks a repo with tree-sitter AST across ~40
 * languages and writes the result as `graph.json`. ./graphify.ts maps that
 * onto `kg_node`/`kg_edge`; this module owns the IO around it - running the
 * CLI in the project workspace, reading the output, and upserting.
 *
 * This replaces a regex heuristic that matched `import`/`require` lines to
 * produce File nodes and best-effort `imports` edges between files in the
 * same repo. Its own doc comment described itself as a stand-in and named
 * the swap: real AST parsing replaces the extraction, while "repo listing,
 * file-node dedup, edge creation" stay. That is what happened here - the
 * repo/file node conventions below are unchanged, so a re-index converges
 * onto the existing nodes rather than creating a parallel set.
 *
 * What the swap buys: Function/Class nodes (the heuristic had none), `calls`
 * and `inherits` edges, cross-file resolution, non-relative imports, and ~40
 * languages instead of 5.
 *
 * Cost: none. `--code-only` restricts graphify to its local tree-sitter pass
 * and skips the LLM pass it would otherwise run over docs and images, so
 * this needs no API key and spends nothing. That matters because this is a
 * background job outside the per-agent/company budget enforcement in
 * @katnor/agents - an indexer that quietly billed tokens would be spend
 * nobody authorized and no dashboard would show.
 *
 * Triggered manually today (apps/server's `knowledge.reindexCode` mutation);
 * PLAN.md's "incremental, per commit" triggering is still deferred. graphify
 * has its own incremental mode, which is the natural way to pick that up.
 */

/**
 * Where graphify writes its output, relative to the workspace root - a
 * sibling of the repo clones, never inside one. Agents run `claude_code` /
 * `shell` / `git` in those clones, so dropping a generated directory into a
 * working tree would show up as untracked noise in every `git status` they
 * run and risk being committed.
 */
const GRAPHIFY_OUT_ROOT = '.graphify';

/** A full AST pass over a large repo is minutes, not seconds. */
const GRAPHIFY_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * A cap, not a design goal - the same rationale as the file cap this
 * replaces. Every node costs a lookup and possibly an insert, so one very
 * large repo would otherwise make an ingest unboundedly slow. A repo past
 * the cap gets a partial index (graph.json is sorted, so "first N" is at
 * least deterministic) rather than none at all.
 */
const MAX_NODES_PER_REPO = 5000;

/** `evidence` for everything this job writes - `kind: 'system'` is exactly what @katnor/core documents for background jobs with no run/artifact/message behind them. */
const EVIDENCE = { kind: 'system' as const, id: 'graphify-code-indexer' };

/**
 * Runs graphify over one repo and returns its `graph.json` text, or null if
 * the run failed. Failure is logged rather than thrown so one unindexable
 * repo does not abort the whole project's re-index.
 */
async function runGraphify(project: WorkspaceProject, repo: WorkspaceRepo): Promise<string | null> {
  const manager = getWorkspaceManager();
  const outDir = `${GRAPHIFY_OUT_ROOT}/${repoDirName(repo)}`;
  const repoName = `${repo.owner}/${repo.repo}`;

  // `--out` is resolved against the cwd (the repo clone), so `../` puts it
  // at the workspace root alongside the clones. `--code-only` keeps this to
  // the local AST pass - see the module doc comment.
  const result = await manager.exec(
    project,
    `graphify extract . --code-only --out "../${outDir}"`,
    {
      cwd: manager.repoPath(repo),
      timeoutMs: GRAPHIFY_TIMEOUT_MS,
    },
  );

  if (result.exitCode !== 0) {
    console.error(
      `[knowledge/codeIndexer] graphify failed for ${repoName} (exit ${result.exitCode}): ` +
        `${result.stderr.trim().slice(-500)}`,
    );
    return null;
  }

  try {
    return (await manager.readFile(project, `${outDir}/graph.json`)).toString('utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[knowledge/codeIndexer] graphify exited 0 for ${repoName} but its graph.json ` +
        `could not be read: ${message}`,
    );
    return null;
  }
}

/** Upserts one mapped node, returning its row id. Dedupes on (project, type, name) exactly as the previous indexer did. */
async function upsertNode(spec: KgNodeSpec, projectId: string): Promise<string> {
  const existing = await kgNodeRepo.getByName(projectId, spec.type, spec.name);
  if (existing) return existing.id;
  const created = await kgNodeRepo.create({
    project_id: projectId,
    type: spec.type,
    name: spec.name,
    summary: null,
    properties: spec.properties,
    embedding: null,
  });
  return created.id;
}

/** Indexes one repo: a `repo` node, a node per symbol/file graphify found, `part_of` edges to the repo, and graphify's own edges between them. */
export async function indexRepo(
  project: WorkspaceProject,
  repo: WorkspaceRepo,
  projectId: string,
): Promise<void> {
  const manager = getWorkspaceManager();
  await manager.ensureWorkspace(project);

  const repoName = `${repo.owner}/${repo.repo}`;
  const raw = await runGraphify(project, repo);
  if (raw === null) return;

  let mapped;
  try {
    const { graph, skippedNodes, skippedLinks } = parseGraphifyGraph(raw);
    if (skippedNodes > 0 || skippedLinks > 0) {
      console.warn(
        `[knowledge/codeIndexer] ${repoName}: skipped ${skippedNodes} malformed node(s) ` +
          `and ${skippedLinks} malformed link(s) in graph.json`,
      );
    }
    mapped = mapGraphifyGraph(graph, repoName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[knowledge/codeIndexer] ${repoName}: unusable graph.json - ${message}`);
    return;
  }

  let { nodes, edges } = mapped;
  if (nodes.length > MAX_NODES_PER_REPO) {
    const kept = new Set(nodes.slice(0, MAX_NODES_PER_REPO).map((node) => node.name));
    console.warn(
      `[knowledge/codeIndexer] ${repoName}: ${nodes.length} nodes exceeds the ` +
        `${MAX_NODES_PER_REPO} cap - indexing the first ${MAX_NODES_PER_REPO} and the edges ` +
        `between them`,
    );
    nodes = nodes.slice(0, MAX_NODES_PER_REPO);
    edges = edges.filter((edge) => kept.has(edge.fromName) && kept.has(edge.toName));
  }
  if (nodes.length === 0) return;

  const existingRepoNode = await kgNodeRepo.getByName(projectId, 'repo', repoName);
  const repoNode =
    existingRepoNode ??
    (await kgNodeRepo.create({
      project_id: projectId,
      type: 'repo',
      name: repoName,
      summary: null,
      properties: {},
      embedding: null,
    }));

  const idByName = new Map<string, string>();
  for (const spec of nodes) {
    const id = await upsertNode(spec, projectId);
    idByName.set(spec.name, id);
    // Only files hang off the repo directly. Symbols reach it transitively
    // through the file that defines them, so adding `part_of` for every
    // symbol too would make the repo node a hub with an edge to everything
    // and tell the graph nothing.
    if (spec.type === 'file') {
      await kgEdgeRepo.createIfMissing({
        from_id: id,
        to_id: repoNode.id,
        type: 'part_of',
        weight: null,
        evidence: EVIDENCE,
      });
    }
  }

  for (const edge of edges) {
    const fromId = idByName.get(edge.fromName);
    const toId = idByName.get(edge.toName);
    if (fromId === undefined || toId === undefined || fromId === toId) continue;
    await kgEdgeRepo.createIfMissing({
      from_id: fromId,
      to_id: toId,
      type: edge.type,
      weight: edge.weight,
      evidence: EVIDENCE,
    });
  }
}

/** Indexes every repo configured on `project` - the whole of what `knowledge.reindexCode` triggers. */
export async function indexProjectRepos(
  project: WorkspaceProject,
  projectId: string,
): Promise<void> {
  for (const repo of project.repos) {
    await indexRepo(project, repo, projectId);
  }
}
