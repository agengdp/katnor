import { spawn } from 'node:child_process';
import { readFile as fsReadFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { repoDirName, type ExecOptions, type ExecResult, type WorkspaceManager, type WorkspaceProject, type WorkspaceRepo } from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 200_000;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Host mode" - PLAN.md 4.3: runs work tools directly in a local directory
 * on whatever machine apps/worker is running on, with no Docker isolation
 * at all. Meant only for development without Docker installed; never use
 * this for an untrusted/production workload, since a `shell`/`claude_code`
 * tool call here runs with this process's own OS-level permissions.
 */
export class HostWorkspaceManager implements WorkspaceManager {
  constructor(private readonly baseDir: string) {}

  private projectDir(project: WorkspaceProject): string {
    return path.join(this.baseDir, project.id);
  }

  repoPath(repo: WorkspaceRepo): string {
    // Relative - resolved against a project's own directory by exec()/
    // readFile() below, since (unlike Docker mode's single shared
    // `/workspace`) every project has a different absolute base path here.
    return repoDirName(repo);
  }

  async ensureWorkspace(project: WorkspaceProject): Promise<void> {
    await mkdir(this.projectDir(project), { recursive: true });
    for (const repo of project.repos) {
      const dir = path.join(this.projectDir(project), this.repoPath(repo));
      if (await pathExists(path.join(dir, '.git'))) continue;
      const result = await this.exec(
        project,
        `git clone --branch "${repo.default_branch}" "https://github.com/${repo.owner}/${repo.repo}.git" "${this.repoPath(repo)}"`,
        { timeoutMs: 3 * 60 * 1000 },
      );
      if (result.exitCode !== 0) {
        throw new Error(`ensureWorkspace: failed to clone ${repo.owner}/${repo.repo}: ${result.stderr}`);
      }
    }
  }

  async exec(project: WorkspaceProject, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const cwd = opts.cwd ? path.join(this.projectDir(project), opts.cwd) : this.projectDir(project);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<ExecResult>((resolve) => {
      const child = spawn('bash', ['-lc', command], {
        cwd,
        env: { ...process.env, ...opts.env },
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString('utf8');
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
          stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
          exitCode: code ?? -1,
          timedOut,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: `${stderr}\n${err.message}`, exitCode: -1, timedOut: false });
      });
    });
  }

  async readFile(project: WorkspaceProject, relativePath: string): Promise<Buffer> {
    return fsReadFile(path.join(this.projectDir(project), relativePath));
  }

  // Nothing persistent to stop - the directory just stays on disk for next time.
  async teardown(): Promise<void> {}
}
