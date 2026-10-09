import { modelEntrySchema, modelStrategySchema } from '@katnor/core';
import { agentRepo, modelComboRepo, providerConfigRepo } from '@katnor/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';

/**
 * Settings > Models (see @katnor/core's schemas/modelCombo.ts and
 * @katnor/llm's router for the concept). A Model is a named mapping:
 * entries of `{providerConnectionId, model, weight}` plus a
 * `round_robin | fallback | router` strategy. `remove` refuses to delete
 * a Model that some agent's `model_config` currently points at
 * (provider "combo", model === this Model's name).
 *
 * Every entry's connection id is validated to exist - a Model pointing
 * at a removed connection is a broken hire waiting to happen, so it is
 * rejected at write time rather than surfacing as a runtime error.
 */
async function assertConnectionsExist(connectionIds: string[]): Promise<void> {
  const rows = await providerConfigRepo.list();
  const ids = new Set(rows.map((row) => row.id));
  const missing = connectionIds.filter((id) => !ids.has(id));
  if (missing.length > 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Unknown provider connection(s): ${missing.join(', ')}.`,
    });
  }
}
export const modelCombosRouter = router({
  list: protectedProcedure.query(() => modelComboRepo.list()),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        entries: z.array(modelEntrySchema).min(1),
        strategy: modelStrategySchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const existing = await modelComboRepo.getByName(input.name.trim());
      if (existing) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `A model named "${input.name}" already exists.`,
        });
      }
      await assertConnectionsExist(input.entries.map((e) => e.providerConnectionId));
      return modelComboRepo.create(input);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        entries: z.array(modelEntrySchema).min(1).optional(),
        strategy: modelStrategySchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      if (patch.name !== undefined) {
        const existing = await modelComboRepo.getByName(patch.name.trim());
        if (existing && existing.id !== id) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `A model named "${patch.name}" already exists.`,
          });
        }
      }
      if (patch.entries !== undefined) {
        await assertConnectionsExist(patch.entries.map((e) => e.providerConnectionId));
      }
      const updated = await modelComboRepo.update(id, patch);
      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `No model "${id}".` });
      }
      return updated;
    }),

  remove: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const combo = await modelComboRepo.getById(input.id);
    if (!combo) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `No model combo "${input.id}".` });
    }
    const agents = await agentRepo.list();
    const inUseBy = agents.filter(
      (agent) => agent.model_config.provider === 'combo' && agent.model_config.model === combo.name,
    );
    if (inUseBy.length > 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          `Cannot remove "${combo.name}" - ${inUseBy.length} agent(s) are hired onto it. ` +
          'Change their model first.',
      });
    }
    await modelComboRepo.remove(input.id);
    return { ok: true as const };
  }),
});
