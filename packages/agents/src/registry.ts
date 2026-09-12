import { createToolRegistry } from '@katnor/tools';
import { companyTools } from './companyTools.js';
import type { AgentToolContext } from './context.js';
import { orgTools } from './orgTools.js';

/** The one tool registry for the whole company - every agent's `tool_allowlist` selects from this. */
export const agentToolRegistry = createToolRegistry<AgentToolContext>();
for (const tool of [...companyTools, ...orgTools]) {
  agentToolRegistry.register(tool);
}

/** Every company tool name - a reasonable default `tool_allowlist` for a fresh hire that doesn't specify one. */
export const DEFAULT_COMPANY_TOOL_NAMES = companyTools.map((tool) => tool.name);
