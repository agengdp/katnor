import type { WorkspaceProject, WorkspaceRepo } from '@katnor/tools';
import { getWorkspaceManager, repoDirName } from '@katnor/tools';
import { kgEdgeRepo, kgNodeRepo } from '@katnor/db';

/**
 * A regex-heuristic stand-in for PLAN.md 4.4's tree-sitter code indexer
 * ("parses repos with tree-sitter to add Module/File/Function nodes and
 * imports/calls edges"). Real tree-sitter parsing needs native bindings
 * and per-language grammar packages this sandbox has no way to install or
 * verify against, so this instead: lists each repo's source files (via
 * @katnor/tools' WorkspaceManager, the same mechanism the `shell`/
 * `claude_code` work tools use), reads each one, and regex-matches
 * `import`/`require`/Python `import` statements to build File nodes and
 * best-effort `imports` edges between files in the SAME repo.
 *
 * What this deliberately does NOT do, unlike a real AST parser: create
 * Function/Class nodes, resolve non-relative (package) imports to
 * anything, or handle re-exports/barrel files specially. Swapping in real
 * tree-sitter parsing later replaces `extractImportSpecifiers` and the
 * per-file node-creation loop below - the rest of this module (repo
 * listing, file-node dedup, edge creation) stays the same.
 *
 * Triggered manually today (apps/server's `knowledge.reindexCode`
 * mutation - PLAN.md's "incremental, per commit" automatic triggering is
 * deferred; see that router's doc comment) rather than on every commit.
 */

const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py'];
// A cap, not a design goal - keeps one huge repo from making an ingest run
// unboundedly slow/expensive; a project with more source files than this
// gets a partial (first N alphabetically) index rather than none at all.
const MAX_FILES_PER_REPO = 400;
const FILE_READ_TIMEOUT_MS = 30_000;

const IMPORT_PATTERNS: RegExp[] = [
  /import\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g, // ES `import ... from '...'` and `import '...'`
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, // CJS `require('...')`
  /^\s*from\s+(\.[\w.]*)\s+import\b/gm, // Python `from .foo import bar` (relative only - see doc comment)
];

function extractImportSpecifiers(content: string): string[] {
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}

function normalizePath(rawPath: string): string {
  const stack: string[] = [];
  for (const part of rawPath.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/** Resolves a relative import specifier (from `fromPath`) against the repo's known file paths, trying common extensions and `/index.*`. Non-relative (package) specifiers are never resolved - see the module doc comment. */
function resolveImport(fromPath: string, specifier: string, knownPaths: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const combined = normalizePath(`${fromDir}/${specifier}`);
  const candidates = [
    combined,
    ...CODE_EXTENSIONS.map((ext) => `${combined}${ext}`),
    ...CODE_EXTENSIONS.map((ext) => `${combined}/index${ext}`),
  ];
  return candidates.find((candidate) => knownPaths.has(candidate)) ?? null;
}

async function listSourceFiles(project: WorkspaceProject, repo: WorkspaceRepo): Promise<string[]> {
  const manager = getWorkspaceManager();
  const findExpr = CODE_EXTENSIONS.map((ext) => `-name '*${ext}'`).join(' -o ');
  const command = `find . \\( ${findExpr} \\) -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | sort | head -n ${MAX_FILES_PER_REPO}`;
  const result = await manager.exec(project, command, { cwd: manager.repoPath(repo), timeoutMs: 60_000 });
  if (result.exitCode !== 0) {
    console.error(`[knowledge/codeIndexer] listing files in ${repo.owner}/${repo.repo} failed: ${result.stderr}`);
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim().replace(/^\.\//, ''))
    .filter((line) => line.length > 0);
}

/** Indexes one repo: a `repo` node, a `file` node per source file (`part_of` the repo), and best-effort `imports` edges between them. */
export async function indexRepo(project: WorkspaceProject, repo: WorkspaceRepo, projectId: string): Promise<void> {
  const manager = getWorkspaceManager();
  await manager.ensureWorkspace(project);

  const relativePaths = await listSourceFiles(project, repo);
  if (relativePaths.length === 0) return;

  const repoName = `${repo.owner}/${repo.repo}`;
  const existingRepoNode = await kgNodeRepo.getByName(projectId, 'repo', repoName);
  const repoNode = existingRepoNode ?? (await kgNodeRepo.create({ project_id: projectId, type: 'repo', name: repoName, summary: null, properties: {}, embedding: null }));

  const knownPaths = new Set(relativePaths);
  const pathToNodeId = new Map<string, string>();
  const importsByPath = new Map<string, string[]>();

  for (const relPath of relativePaths) {
    const fileName = `${repoName}/${relPath}`;
    let content: string;
    try {
      content = (await Promise.race([
        manager.readFile(project, `${repoDirName(repo)}/${relPath}`),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('read timed out')), FILE_READ_TIMEOUT_MS)),
      ])).toString('utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[knowledge/codeIndexer] failed to read "${fileName}": ${message}`);
      continue;
    }

    const existing = await kgNodeRepo.getByName(projectId, 'file', fileName);
    const fileNode =
      existing ??
      (await kgNodeRepo.create({
        project_id: projectId,
        type: 'file',
        name: fileName,
        summary: null,
        properties: { repo: repoName, path: relPath },
        embedding: null,
      }));
    pathToNodeId.set(relPath, fileNode.id);
    importsByPath.set(relPath, extractImportSpecifiers(content));
  }

  const evidence = { kind: 'system' as const, id: 'code-indexer' };

  for (const [relPath, fileId] of pathToNodeId) {
    await kgEdgeRepo.createIfMissing({ from_id: fileId, to_id: repoNode.id, type: 'part_of', weight: null, evidence });

    for (const specifier of importsByPath.get(relPath) ?? []) {
      const resolved = resolveImport(relPath, specifier, knownPaths);
      if (!resolved) continue;
      const targetId = pathToNodeId.get(resolved);
      if (!targetId || targetId === fileId) continue;
      await kgEdgeRepo.createIfMissing({ from_id: fileId, to_id: targetId, type: 'imports', weight: null, evidence });
    }
  }
}

/** Indexes every repo configured on `project` - the whole of what `knowledge.reindexCode` triggers. */
export async function indexProjectRepos(project: WorkspaceProject, projectId: string): Promise<void> {
  for (const repo of project.repos) {
    await indexRepo(project, repo, projectId);
  }
}
