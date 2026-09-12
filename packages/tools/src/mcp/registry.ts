import type { ToolDefinition } from '../types.js';
import { McpServerConnection, type McpServerConfig } from './client.js';

// Cached by server name (not per-config) so repeated calls within a
// long-lived process (the worker) don't reconnect every run - a run just
// asks for the servers its agent's `tool_allowlist` names (see
// @katnor/agents/src/mcpTools.ts) and gets back an already-open connection
// after the first.
const connections = new Map<string, McpServerConnection>();

function namespacedToolName(serverName: string, mcpToolName: string): string {
  return `mcp__${serverName}__${mcpToolName}`;
}

function getConnection(config: McpServerConfig): McpServerConnection {
  let connection = connections.get(config.name);
  if (!connection) {
    connection = new McpServerConnection(config);
    connections.set(config.name, connection);
  }
  return connection;
}

/**
 * Connects to every server in `configs` (PLAN.md 4.2/4.3: "GitHub MCP" is
 * just one user-configured `tool_config` row of kind 'mcp' - there is
 * nothing GitHub-specific in this package) and turns each of its
 * server-reported tools into a namespaced `mcp__<server>__<tool>`
 * `ToolDefinition` whose `execute` proxies straight through to the MCP
 * server via @modelcontextprotocol/sdk.
 *
 * `TContext` is left generic and unused by the returned definitions'
 * `execute` (an MCP call needs nothing from the caller's own tool context -
 * the server call is fully described by `name` + `input`) so this can be
 * called from @katnor/agents and merged directly into its
 * `ToolDefinition<AgentToolContext>[]` tool set.
 *
 * A server that fails to connect or list its tools is skipped (logged, not
 * thrown) - one misconfigured MCP server shouldn't take down a run that
 * doesn't even use it.
 */
export async function loadMcpToolDefinitions<TContext = unknown>(
  configs: McpServerConfig[],
): Promise<ToolDefinition<TContext>[]> {
  const definitions: ToolDefinition<TContext>[] = [];

  for (const config of configs) {
    const connection = getConnection(config);
    let tools;
    try {
      tools = await connection.listTools();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[mcp/registry] failed to list tools for server "${config.name}": ${message}`);
      continue;
    }

    for (const tool of tools) {
      definitions.push({
        name: namespacedToolName(config.name, tool.name),
        description: tool.description || `Tool "${tool.name}" from MCP server "${config.name}".`,
        inputSchema: tool.inputSchema,
        async execute(input) {
          const result = await connection.callTool(tool.name, input);
          return { content: result.content, isError: result.isError };
        },
      });
    }
  }

  return definitions;
}

/** Closes every cached connection - call once on worker shutdown. */
export async function closeAllMcpConnections(): Promise<void> {
  await Promise.all([...connections.values()].map((connection) => connection.close()));
  connections.clear();
}
