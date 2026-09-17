import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import {
  repoDirName,
  type ExecOptions,
  type ExecResult,
  type WorkspaceManager,
  type WorkspaceProject,
  type WorkspaceRepo,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 200_000;
const WORKSPACE_ROOT = '/workspace';

/**
 * One Docker container per project, built from `sandbox/Dockerfile` -
 * PLAN.md 4.3. Talks to the Docker daemon over the default socket
 * (`dockerode`'s zero-arg constructor - `/var/run/docker.sock` on Linux),
 * so the process running this (apps/worker) needs that socket mounted -
 * see docker-compose.yml's `worker` service.
 */
export class DockerWorkspaceManager implements WorkspaceManager {
  private readonly docker = new Docker();
  private readonly containers = new Map<string, Docker.Container>();
  private readonly sandboxImage: string;

  constructor(sandboxImage: string) {
    this.sandboxImage = sandboxImage;
  }

  private containerName(project: WorkspaceProject): string {
    return `katnor-workspace-${project.id}`;
  }

  private volumeName(project: WorkspaceProject): string {
    return `katnor-workspace-${project.id}-data`;
  }

  repoPath(repo: WorkspaceRepo): string {
    return `${WORKSPACE_ROOT}/${repoDirName(repo)}`;
  }

  async ensureWorkspace(project: WorkspaceProject): Promise<void> {
    let container = this.containers.get(project.id);

    if (!container) {
      const name = this.containerName(project);
      // Survives a worker restart: reuse an already-created container for
      // this project rather than creating a duplicate (Docker container
      // names must be unique, so a stale one from a prior process would
      // otherwise make `createContainer` fail outright).
      const existing = await this.docker.listContainers({
        all: true,
        filters: JSON.stringify({ name: [name] }),
      });
      if (existing.length > 0 && existing[0]) {
        container = this.docker.getContainer(existing[0].Id);
      } else {
        container = await this.docker.createContainer({
          Image: this.sandboxImage,
          name,
          Cmd: ['sleep', 'infinity'],
          Tty: false,
          HostConfig: {
            Binds: [`${this.volumeName(project)}:${WORKSPACE_ROOT}`],
            // A modest, fixed resource ceiling per project sandbox - not
            // configurable yet (PLAN.md doesn't call for per-project
            // resource tuning until a later phase), just a sane default so
            // one runaway agent process can't starve the host.
            Memory: 2 * 1024 * 1024 * 1024,
            NanoCpus: 2_000_000_000,
          },
        });
      }
      this.containers.set(project.id, container);
    }

    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }

    for (const repo of project.repos) {
      await this.ensureRepoCloned(project, repo);
    }
  }

  private async ensureRepoCloned(project: WorkspaceProject, repo: WorkspaceRepo): Promise<void> {
    const dir = this.repoPath(repo);
    const check = await this.exec(project, `test -d "${dir}/.git" && echo EXISTS || echo MISSING`);
    if (check.stdout.trim() === 'EXISTS') return;

    const cloneResult = await this.exec(
      project,
      `git clone --branch "${repo.default_branch}" "https://github.com/${repo.owner}/${repo.repo}.git" "${dir}"`,
      { timeoutMs: 3 * 60 * 1000 },
    );
    if (cloneResult.exitCode !== 0) {
      throw new Error(
        `ensureWorkspace: failed to clone ${repo.owner}/${repo.repo} for project "${project.id}": ${cloneResult.stderr}`,
      );
    }
  }

  async exec(
    project: WorkspaceProject,
    command: string,
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    const container = this.containers.get(project.id);
    if (!container) {
      throw new Error(
        `exec: workspace for project "${project.id}" was never ensured - call ensureWorkspace first`,
      );
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const execInstance = await container.exec({
      Cmd: ['bash', '-lc', command],
      WorkingDir: opts.cwd ?? WORKSPACE_ROOT,
      Env: opts.env ? Object.entries(opts.env).map(([key, value]) => `${key}=${value}`) : undefined,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await execInstance.start({ hijack: true, stdin: false });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutSink = new PassThrough();
    const stderrSink = new PassThrough();
    stdoutSink.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    stderrSink.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    // Docker multiplexes stdout/stderr onto one stream when the exec wasn't
    // created with a TTY (which this one isn't) - demuxStream is
    // dockerode's own documented way to split it back apart.
    this.docker.modem.demuxStream(stream, stdoutSink, stderrSink);

    const timedOut = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), timeoutMs);
      stream.on('end', () => {
        clearTimeout(timer);
        resolve(false);
      });
      stream.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    let exitCode = -1;
    if (!timedOut) {
      const inspectResult = await execInstance.inspect();
      exitCode = inspectResult.ExitCode ?? -1;
    }

    return {
      stdout: Buffer.concat(stdoutChunks).toString('utf8').slice(0, MAX_OUTPUT_CHARS),
      stderr: Buffer.concat(stderrChunks).toString('utf8').slice(0, MAX_OUTPUT_CHARS),
      exitCode,
      timedOut,
    };
  }

  async readFile(project: WorkspaceProject, relativePath: string): Promise<Buffer> {
    // `docker cp`-style file reads aren't exposed as a clean dockerode
    // method for a single small file - base64-catting it through `exec` is
    // simple, correct for text/binary alike, and avoids pulling in the
    // tar-stream handling `getArchive()` would require.
    const result = await this.exec(project, `base64 "${WORKSPACE_ROOT}/${relativePath}"`);
    if (result.exitCode !== 0) {
      throw new Error(
        `readFile: "${relativePath}" not found in project "${project.id}"'s workspace: ${result.stderr}`,
      );
    }
    return Buffer.from(result.stdout, 'base64');
  }

  async teardown(project: WorkspaceProject): Promise<void> {
    const container = this.containers.get(project.id);
    if (!container) return;
    await container.stop().catch(() => undefined); // already stopped is fine
    this.containers.delete(project.id);
  }
}
