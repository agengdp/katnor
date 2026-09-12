export interface WorkspaceRepo {
  owner: string;
  repo: string;
  default_branch: string;
}

/** The minimal project shape a workspace manager needs - plain data, not a drizzle row, so this package stays free of a @katnor/db dependency. */
export interface WorkspaceProject {
  id: string;
  name: string;
  repos: WorkspaceRepo[];
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Working directory - defaults to the workspace root (see each implementation's DEFAULT_WORKDIR). */
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Runs and drives one project's isolated workspace - PLAN.md 4.3
 * "Workspaces": a Docker container per project in production
 * (./docker.ts), or a plain local directory in "host mode" for
 * development without Docker (./host.ts) - see ./index.ts's factory.
 * @katnor/tools' work tools (shell, claude_code) execute everything
 * through this interface, never a raw child_process/dockerode call of
 * their own, so they work identically in either mode.
 */
export interface WorkspaceManager {
  /** Idempotent: creates/starts the container (or directory) if needed, and clones any repo it doesn't have yet. */
  ensureWorkspace(project: WorkspaceProject): Promise<void>;
  exec(project: WorkspaceProject, command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Where `repo` is checked out - pass as `ExecOptions.cwd` to run a command inside that repo's clone. */
  repoPath(repo: WorkspaceRepo): string;
  /** Reads a file's content out of the workspace (e.g. a diff or a generated report) so it can become an artifact. */
  readFile(project: WorkspaceProject, relativePath: string): Promise<Buffer>;
  /** Stops (Docker) or leaves in place (host - nothing to stop) the workspace. Does not delete cloned repos. */
  teardown(project: WorkspaceProject): Promise<void>;
}

/** A repo's on-disk directory name - `<owner>-<repo>`, stable and collision-free enough for one project's repo list. */
export function repoDirName(repo: WorkspaceRepo): string {
  return `${repo.owner}-${repo.repo}`;
}
