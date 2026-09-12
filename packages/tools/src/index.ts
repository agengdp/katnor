// @katnor/tools - the generic tool registry mechanism (see ./registry.ts
// and ./types.ts), plus the mechanism-only pieces PLAN.md 4.3's work tools
// are built from: a per-project sandbox abstraction (./workspace) and an
// MCP client/registry (./mcp). The actual company/org/work tool
// *implementations* (send_message, hire_agent, shell, claude_code, ...)
// live in @katnor/agents, which instantiates ./registry.ts's
// `createToolRegistry` with its own context type and wires these
// mechanisms into it - see PLAN.md's repo layout table (section 2.3) for
// why the split lands there: this package stays free of a @katnor/db
// dependency so its abstractions take plain data, not drizzle rows.
export * from './types.js';
export * from './registry.js';
export * from './workspace/index.js';
export * from './mcp/index.js';
