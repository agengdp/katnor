import type { ToolDefinition, ToolRegistry } from './types.js';

export function createToolRegistry<TContext>(): ToolRegistry<TContext> {
  const tools = new Map<string, ToolDefinition<TContext>>();

  return {
    register(def) {
      if (tools.has(def.name)) {
        throw new Error(`createToolRegistry: tool "${def.name}" is already registered`);
      }
      tools.set(def.name, def);
    },

    get(name) {
      return tools.get(name);
    },

    listForModel(names, opts) {
      const result = [];
      for (const name of names) {
        const def = tools.get(name);
        if (!def) continue; // stale allowlist entry - not this registry's concern to flag
        if (def.ceoOnly && !opts.isSystem) continue;
        result.push({ name: def.name, description: def.description, inputSchema: def.inputSchema });
      }
      return result;
    },

    async execute(name, input, ctx) {
      const def = tools.get(name);
      if (!def) {
        return { content: `Unknown tool "${name}".`, isError: true };
      }
      try {
        return await def.execute(input, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `Tool "${name}" threw an error: ${message}`, isError: true };
      }
    },
  };
}
