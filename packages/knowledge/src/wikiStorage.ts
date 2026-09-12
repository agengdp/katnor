import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_WIKI_DIR = '/tmp/katnor-wiki';
const GIT_AUTHOR_NAME = 'Katnor Librarian';
const GIT_AUTHOR_EMAIL = 'librarian@katnor.local';

/**
 * One local git repository per project under this directory (PLAN.md 4.5:
 * "Markdown files in a git repo per project"), read and written directly
 * by both apps/worker (the Librarian - see ./librarian.ts) and apps/server
 * (the dashboard's wiki browser/editor) - both processes mount the same
 * volume at this path (see docker-compose.yml's `wiki-data` volume), so
 * neither needs to go through the other to read or write a page.
 */
function getWikiDir(): string {
  return process.env.WIKI_STORAGE_DIR?.trim() || DEFAULT_WIKI_DIR;
}

export function projectWikiDir(projectId: string): string {
  return path.join(getWikiDir(), projectId);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd });
}

const INITIAL_INDEX_MD = (projectName: string) =>
  `# ${projectName} wiki\n\nA catalogue of this project's pages - the Librarian keeps this in sync as pages are added.\n`;
const INITIAL_LOG_MD = '# Change log\n\nAppend-only. The Librarian adds one entry per wiki update.\n';

/**
 * Idempotent: creates the project's wiki directory and git repo if either
 * doesn't exist yet, seeding `index.md`/`log.md`. Every other function in
 * this module assumes this has already run for the project (the Librarian
 * and every tRPC wiki procedure call it first).
 */
export async function ensureProjectWiki(projectId: string, projectName: string): Promise<void> {
  const dir = projectWikiDir(projectId);
  await mkdir(dir, { recursive: true });

  if (!(await pathExists(path.join(dir, '.git')))) {
    // `-b main` pins a deterministic default branch name across git
    // versions/configs rather than trusting whatever `init.defaultBranch`
    // happens to be set to in the running container.
    await runGit(dir, ['init', '-b', 'main']);
  }

  let wroteSeedFile = false;
  if (!(await pathExists(path.join(dir, 'index.md')))) {
    await writeFile(path.join(dir, 'index.md'), INITIAL_INDEX_MD(projectName), 'utf8');
    wroteSeedFile = true;
  }
  if (!(await pathExists(path.join(dir, 'log.md')))) {
    await writeFile(path.join(dir, 'log.md'), INITIAL_LOG_MD, 'utf8');
    wroteSeedFile = true;
  }
  if (wroteSeedFile) {
    await commit(projectId, 'Initialize wiki');
  }
}

/**
 * `relativePath` is always a path under the project's wiki root (e.g.
 * `"pages/auth.md"`, `"index.md"`) - callers control this value (the
 * Librarian's own generated slugs, or a human editing an existing listed
 * page), never raw untrusted input, so a plain `path.join` is used rather
 * than defending against traversal.
 */
export async function readPage(projectId: string, relativePath: string): Promise<string | null> {
  try {
    return await readFile(path.join(projectWikiDir(projectId), relativePath), 'utf8');
  } catch {
    return null;
  }
}

export async function writePage(projectId: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(projectWikiDir(projectId), relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

export async function deletePage(projectId: string, relativePath: string): Promise<void> {
  await rm(path.join(projectWikiDir(projectId), relativePath), { force: true });
}

/** Every `.md` file's path relative to the project's wiki root, recursively, skipping `.git`. */
export async function listPages(projectId: string): Promise<string[]> {
  const root = projectWikiDir(projectId);
  if (!(await pathExists(root))) return [];

  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith('.md')) {
        results.push(path.relative(root, fullPath));
      }
    }
  }
  await walk(root);
  return results.sort();
}

/**
 * Stages and commits everything currently written under the project's wiki
 * directory. A no-op (not an error) when there is nothing to commit -
 * `git commit` itself exits non-zero in that case, which would otherwise
 * make every idempotent re-ingest of unchanged content look like a
 * failure.
 */
export async function commit(projectId: string, message: string): Promise<void> {
  const dir = projectWikiDir(projectId);
  await runGit(dir, ['add', '-A']);
  const { stdout } = await runGit(dir, ['status', '--porcelain']);
  if (stdout.trim().length === 0) return;

  await runGit(dir, [
    '-c',
    `user.name=${GIT_AUTHOR_NAME}`,
    '-c',
    `user.email=${GIT_AUTHOR_EMAIL}`,
    'commit',
    '-m',
    message,
  ]);
}
