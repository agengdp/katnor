import { secretRepo } from '@katnor/db';
import { z } from 'zod';
import { encryptSecret } from '../../crypto.js';
import { protectedProcedure, router } from '../trpc.js';

/**
 * Named secrets (PLAN.md 4.3) - env vars an MCP server needs (e.g.
 * `GITHUB_TOKEN`), referenced by name from a `tool_config` row's
 * `env_secret_refs` and resolved/decrypted at run time by @katnor/agents'
 * ./mcpTools.ts. Mirrors settings.ts's provider-key handling: a value is
 * write-only through this router - `list` never returns it, encrypted or
 * not.
 */
export const secretsRouter = router({
  list: protectedProcedure.query(async () => {
    const rows = await secretRepo.list();
    return rows.map((row) => ({ name: row.name, updatedAt: row.updated_at }));
  }),

  upsert: protectedProcedure
    .input(z.object({ name: z.string().min(1), value: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const created = await secretRepo.upsert(input.name, encryptSecret(input.value));
      return { name: created.name, updatedAt: created.updated_at };
    }),

  remove: protectedProcedure.input(z.object({ name: z.string().min(1) })).mutation(({ input }) => secretRepo.remove(input.name)),
});
