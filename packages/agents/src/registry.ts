import { createToolRegistry } from '@katnor/tools';
import { companyTools } from './companyTools.js';
import type { AgentToolContext } from './context.js';
import { orgTools } from './orgTools.js';
import { serverTools, workTools } from './workTools.js';

/**
 * The one tool registry for the whole company - every agent's
 * `tool_allowlist` selects from this. MCP server tools are the one
 * exception: they're discovered live from each configured server rather
 * than known up front, so they can't be pre-registered here - see
 * ./mcpTools.ts's `loadAgentMcpTools`, merged in by ./runExecutor.ts on a
 * per-run basis instead.
 */
export const agentToolRegistry = createToolRegistry<AgentToolContext>();
for (const tool of [...companyTools, ...orgTools, ...workTools, ...serverTools]) {
  agentToolRegistry.register(tool);
}

/** Every company tool name - a reasonable default `tool_allowlist` for a fresh hire that doesn't specify one. */
export const DEFAULT_COMPANY_TOOL_NAMES = companyTools.map((tool) => tool.name);
