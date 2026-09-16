import { decryptSecret, secretRepo, toolConfigRepo } from '@katnor/db';
import type { McpServerConfig, ToolDefinition } from '@katnor/tools';
import { loadMcpToolDefinitions } from '@katnor/tools';
import type { AgentToolContext } from './context.js';

const MCP_ALLOWLIST_PREFIX = 'mcp__';

/**
 * An agent's `tool_allowlist` grants a whole MCP server at once, as
 * `mcp__<serverName>` (e.g. `"mcp__github"`) - the server's individual tool
 * names (`mcp__github__create_pull_request`, ...) aren't known until it's
 * actually queried, so there's nothing more specific to put in the
 * allowlist at hiring time. See PLAN.md 4.2's "MCP server management in
 * Settings" + "tool allowlists per agent".
 */
function serverNamesFromAllowlist(toolAllowlist: string[]): string[] {
  return toolAllowlist
    .filter((name) => name.startsWith(MCP_ALLOWLIST_PREFIX))
    .map((name) => name.slice(MCP_ALLOWLIST_PREFIX.length));
}

/**
 * Resolves a `tool_config` row's `env_secret_refs` (secret *names*, e.g.
 * `"GITHUB_TOKEN"`) into an actual env map for the spawned MCP server
 * process, decrypting each via @katnor/db's `decryptSecret`. Each secret's
 * own `name` doubles as the env var name it's injected under - simplest
 * convention that needs no extra mapping column on `tool_config` or
 * `secret`. A referenced secret that doesn't exist is skipped (logged), not
 * fatal - the server may simply fail its own auth check instead.
 */
async function resolveEnv(envSecretRefs: string[]): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const name of envSecretRefs) {
    const row = await secretRepo.getByName(name);
    if (!row) {
      console.error(
        `[mcpTools] secret "${name}" referenced by a tool_config but not found - skipping`,
      );
      continue;
    }
    env[name] = decryptSecret(row.value_encrypted);
  }
  return env;
}

/**
 * `tool_config.command` is stored as one shell-style string (e.g.
 * `"npx -y @modelcontextprotocol/server-github"`) since that's what an
 * operator naturally types into a Settings form, but
 * `StdioClientTransport` spawns an executable + argv array directly (no
 * shell) - so it's split here on whitespace. No quoting support: an
 * argument that itself needs a literal space isn't representable in v1's
 * single-field form.
 */
function splitCommand(command: string): { command: string; args: string[] } {
  const [executable, ...args] = command.trim().split(/\s+/);
  return { command: executable ?? '', args };
}

/**
 * Builds this run's MCP-backed tool set: every enabled `tool_config` row of
 * kind 'mcp' whose server name is granted by `toolAllowlist`, connected and
 * turned into `mcp__<server>__<tool>` `ToolDefinition`s (see
 * @katnor/tools/src/mcp/registry.ts). Called once per run by
 * ./runExecutor.ts and merged into the tool set built from
 * `agentToolRegistry` - MCP tools are necessarily dynamic (discovered live
 * from each server) so they can't live in that static, module-level
 * registry the way company/org/work tools do.
 */
export async function loadAgentMcpTools(
  toolAllowlist: string[],
): Promise<ToolDefinition<AgentToolContext>[]> {
  const allowedServers = new Set(serverNamesFromAllowlist(toolAllowlist));
  if (allowedServers.size === 0) return [];

  const rows = await toolConfigRepo.listEnabled();
  const mcpRows = rows.filter((row) => row.kind === 'mcp' && allowedServers.has(row.name));
  if (mcpRows.length === 0) return [];

  const configs: McpServerConfig[] = await Promise.all(
    mcpRows.map(async (row) => {
      const split = row.command ? splitCommand(row.command) : null;
      return {
        name: row.name,
        command: split?.command ?? null,
        args: split?.args ?? [],
        url: row.url,
        env: await resolveEnv(row.env_secret_refs),
      };
    }),
  );

  return loadMcpToolDefinitions<AgentToolContext>(configs);
}
