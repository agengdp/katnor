import { modelComboEntrySchema } from '@katnor/core';
import { agentRepo, modelComboRepo } from '@katnor/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';

/**
 * Settings > Model Combos (see @katnor/llm's src/combo.ts and
 * @katnor/core's schemas/modelCombo.ts for the concept). `remove` refuses
 * to delete a combo that some agent's `model_config` currently points at
 * (provider "combo", model === this combo's name) - the same
 * can't-delete-what's-in-use guard `users.ts`'s `remove` applies to the
 * last remaining user account.
 */
export const modelCombosRouter = router({
  list: protectedProcedure.query(() => modelComboRepo.list()),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        entries: z.array(modelComboEntrySchema).min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const existing = await modelComboRepo.getByName(input.name.trim());
      if (existing) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `A model combo named "${input.name}" already exists.`,
        });
      }
      return modelComboRepo.create(input);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        entries: z.array(modelComboEntrySchema).min(1).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      if (patch.name !== undefined) {
        const existing = await modelComboRepo.getByName(patch.name.trim());
        if (existing && existing.id !== id) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `A model combo named "${patch.name}" already exists.`,
          });
        }
      }
      const updated = await modelComboRepo.update(id, patch);
      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `No model combo "${id}".` });
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
