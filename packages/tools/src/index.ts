// @katnor/tools - the generic tool registry mechanism (see ./registry.ts
// and ./types.ts). The actual company/org tool *implementations*
// (send_message, hire_agent, ...) live in @katnor/agents, which
// instantiates this registry with its own context type - see PLAN.md's
// repo layout table (section 2.3) for why the split lands there. MCP
// client support and work-tool wrappers (claude_code, codex, shell, git,
// figma, browser) are a later phase (PLAN.md 4.3, Phase 2+).
export * from './types.js';
export * from './registry.js';
