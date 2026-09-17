import { DockerWorkspaceManager } from './docker.js';
import { HostWorkspaceManager } from './host.js';
import type { WorkspaceManager } from './types.js';

const DEFAULT_SANDBOX_IMAGE = 'katnor-sandbox:latest';
const DEFAULT_HOST_WORKSPACE_DIR = '/tmp/katnor-workspaces';

let cached: WorkspaceManager | undefined;

/**
 * The one workspace manager for the process - Docker by default, "host
 * mode" (PLAN.md 4.3) when `SANDBOX_MODE=host`, e.g. for local development
 * without Docker installed.
 */
export function getWorkspaceManager(): WorkspaceManager {
  if (cached) return cached;
  const mode = process.env.SANDBOX_MODE?.trim().toLowerCase();
  cached =
    mode === 'host'
      ? new HostWorkspaceManager(
          process.env.WORKSPACE_HOST_DIR?.trim() || DEFAULT_HOST_WORKSPACE_DIR,
        )
      : new DockerWorkspaceManager(process.env.SANDBOX_IMAGE?.trim() || DEFAULT_SANDBOX_IMAGE);
  return cached;
}

export * from './types.js';
