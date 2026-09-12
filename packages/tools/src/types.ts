/**
 * A tool's outcome, fed back to the model as `tool_result` content. Tool
 * outputs are untrusted data from the model's perspective (PLAN.md 4.3) -
 * `content` is always a plain string, never re-interpreted as instructions
 * by anything in this package.
 */
export interface ToolExecutionResult {
  content: string;
  isError?: boolean;
}

/**
 * One registered tool. `TContext` is supplied by whoever calls
 * `createToolRegistry<TContext>()` - this package has no opinion on what a
 * tool needs to do its job (a database handle, the acting agent, the
 * current run, ...); @katnor/agents defines the concrete context its
 * company/org tools need and instantiates the registry with it.
 *
 * `{name, description, inputSchema}` is deliberately shaped identically to
 * @katnor/llm's `ProviderTool` (a plain JSON Schema `inputSchema`, no zod)
 * so a tool definition can be handed straight to an `LLMProvider.step()`
 * call with no conversion step - see `ToolRegistry.listForModel()`.
 */
export interface ToolDefinition<TContext = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Restricts this tool to the one system agent (the CEO) - see PLAN.md 4.1's hiring tools. */
  ceoOnly?: boolean;
  execute(input: Record<string, unknown>, ctx: TContext): Promise<ToolExecutionResult>;
}

export interface ProviderToolShape {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolRegistry<TContext> {
  register(def: ToolDefinition<TContext>): void;
  get(name: string): ToolDefinition<TContext> | undefined;
  /**
   * Definitions for `names`, in the shape an `LLMProvider.step()` call
   * expects. Unknown names are silently dropped (an agent's
   * `tool_allowlist` can reference a tool that was since removed) and
   * `ceoOnly` tools are dropped unless `opts.isSystem`.
   */
  listForModel(names: string[], opts: { isSystem: boolean }): ProviderToolShape[];
  /** Never throws - an unknown tool or a thrown `execute()` both come back as `{isError: true}`. */
  execute(name: string, input: Record<string, unknown>, ctx: TContext): Promise<ToolExecutionResult>;
}
