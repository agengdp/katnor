// NOTE ON SDK API SHAPE: written with no npm registry access in this
// sandbox, so `@modelcontextprotocol/sdk` was never installed here and
// none of the import paths/method signatures below (Client, StdioClientTransport,
// SSEClientTransport, .connect/.listTools/.callTool's exact shapes) could
// be checked against the real package. They follow the SDK's long-
// documented, stable usage pattern from its own README/examples; if
// `pnpm typecheck` reports a mismatch, this file is the first place to
// look - the *architecture* (connect once per configured server, list
// tools, proxy calls) is the part to trust.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpServerConfig {
  name: string;
  /** stdio server: the command to spawn (e.g. "npx"). */
  command?: string | null;
  /** stdio server: args after `command` - see `splitCommand` in @katnor/agents' src/mcpTools.ts, which splits a `tool_config.command` string into this shape before building a config here. */
  args?: string[];
  /** HTTP/SSE server URL - mutually exclusive with `command`. */
  url?: string | null;
  /** Resolved env vars (secret values already decrypted by the caller - this file never touches encryption). */
  env?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description: string;
  /** JSON Schema, as MCP servers declare it - passed straight through to @katnor/llm's ProviderTool.inputSchema. */
  inputSchema: Record<string, unknown>;
}

/**
 * One connected MCP server (PLAN.md 4.3's "MCP servers added by the user
 * in Settings"). Wraps the official SDK's `Client` behind the two
 * operations this system actually needs: list what tools a server offers,
 * and call one. Connection lifecycle (connect once, stay connected) is
 * this class's job; ./registry.ts owns turning "every enabled tool_config
 * row" into a set of these plus the `ToolDefinition`s that proxy through
 * them.
 */
export class McpServerConnection {
  private client: Client | undefined;

  constructor(private readonly config: McpServerConfig) {}

  async connect(): Promise<void> {
    if (this.client) return;

    const transport = this.config.command
      ? new StdioClientTransport({
          command: this.config.command,
          args: this.config.args ?? [],
          env: this.config.env,
        })
      : this.config.url
        ? new SSEClientTransport(new URL(this.config.url))
        : undefined;
    if (!transport) {
      throw new Error(`McpServerConnection "${this.config.name}": neither command nor url is set`);
    }

    const client = new Client({ name: 'katnor', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.connect();
    if (!this.client) throw new Error(`McpServerConnection "${this.config.name}": not connected`);
    const response = await this.client.listTools();
    return response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: (tool.inputSchema as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} },
    }));
  }

  /**
   * Calls one of this server's tools and returns its result as a single
   * string (tool outputs are treated as untrusted data, per PLAN.md 4.3 -
   * never re-parsed as instructions). MCP tool results are a list of
   * content blocks (text, image, ...) - non-text blocks are summarized
   * rather than dropped silently, so the model at least knows something
   * came back.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    await this.connect();
    if (!this.client) throw new Error(`McpServerConnection "${this.config.name}": not connected`);

    const result = await this.client.callTool({ name, arguments: args });
    const blocks = Array.isArray(result.content) ? result.content : [];
    const rendered = blocks
      .map((block: { type: string; text?: string }) =>
        block.type === 'text' ? (block.text ?? '') : `[${block.type} content omitted]`,
      )
      .join('\n');

    return { content: rendered || '(empty result)', isError: Boolean(result.isError) };
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }
}
