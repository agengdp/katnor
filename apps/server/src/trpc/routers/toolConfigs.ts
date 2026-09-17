import { TOOL_CONFIG_KINDS } from '@katnor/core';
import { toolConfigRepo } from '@katnor/db';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';

/**
 * MCP server management in Settings (PLAN.md 4.3) - `tool_config` rows of
 * kind 'mcp' are what @katnor/agents' ./mcpTools.ts connects to at run
 * time, keyed by `name` (an agent's `tool_allowlist` grants a whole server
 * via `"mcp__<name>"` - see that module's doc comment). `kind: 'builtin'`
 * rows exist in the schema for a later phase (toggling a built-in work tool
 * off company-wide) but nothing writes them yet.
 */
export const toolConfigsRouter = router({
  list: protectedProcedure.query(() => toolConfigRepo.list()),

  create: protectedProcedure
    .input(
      z.object({
        kind: z.enum(TOOL_CONFIG_KINDS),
        name: z.string().min(1),
        /** Shell-style command + args as one string (e.g. "npx -y @modelcontextprotocol/server-github") - set for a stdio server. */
        command: z.string().min(1).nullable().optional(),
        /** Set for an HTTP/SSE server instead of a stdio one. */
        url: z.string().min(1).nullable().optional(),
        /** Names of `secret` rows to inject into the server's env - see @katnor/agents' ./mcpTools.ts. */
        envSecretRefs: z.array(z.string()).default([]),
        enabled: z.boolean().default(true),
      }),
    )
    .mutation(({ input }) =>
      toolConfigRepo.create({
        kind: input.kind,
        name: input.name,
        command: input.command ?? null,
        url: input.url ?? null,
        env_secret_refs: input.envSecretRefs,
        enabled: input.enabled,
      }),
    ),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        command: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
        envSecretRefs: z.array(z.string()).optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) =>
      toolConfigRepo.update(input.id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.command !== undefined ? { command: input.command } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.envSecretRefs !== undefined ? { env_secret_refs: input.envSecretRefs } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      }),
    ),

  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => toolConfigRepo.remove(input.id)),
});
