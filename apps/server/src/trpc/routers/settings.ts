import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { approvalModeSchema, MODEL_PROVIDERS } from '@katnor/core';
import { companyRepo, providerConfig, ulid } from '@katnor/db';
import { encryptSecret } from '../../crypto.js';
import { protectedProcedure, publicProcedure, router } from '../trpc.js';

type ProviderConfigRow = typeof providerConfig.$inferSelect;

/**
 * Maps a `provider_config` row to what the client is allowed to see: never
 * the decrypted key, never even the ciphertext - just whether a key is
 * configured at all.
 */
function toPublicProvider(row: ProviderConfigRow) {
  return {
    provider: row.provider,
    hasKey: row.api_key_encrypted !== null,
    baseUrl: row.base_url,
    enabled: row.enabled,
  };
}

const upsertProviderInputSchema = z.object({
  provider: z.enum(MODEL_PROVIDERS),
  // Omitted entirely -> leave the existing key untouched. Present -> replace it.
  // There is no way to *clear* a key back to unset via this input - that's an
  // intentional gap for now (the UI only ever offers "set a new key").
  apiKey: z.string().min(1).optional(),
  // Present-but-null -> clear the base URL. Omitted -> leave it untouched.
  baseUrl: z.string().min(1).nullable().optional(),
  enabled: z.boolean(),
});

export const settingsRouter = router({
  /**
   * Lists every configured provider. Note this only ever returns rows that
   * already exist - a provider nobody has touched yet in Settings simply
   * doesn't appear (the web app should treat "not in this list" the same
   * as "hasKey: false, enabled: false").
   */
  listProviders: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(providerConfig);
    return rows.map(toPublicProvider);
  }),

  upsertProvider: protectedProcedure.input(upsertProviderInputSchema).mutation(async ({ ctx, input }) => {
    const existingRows = await ctx.db.select().from(providerConfig);
    const existing = existingRows.find((row) => row.provider === input.provider);

    const apiKeyEncrypted = input.apiKey !== undefined ? encryptSecret(input.apiKey) : undefined;

    if (existing) {
      const [updated] = await ctx.db
        .update(providerConfig)
        .set({
          enabled: input.enabled,
          ...(input.baseUrl !== undefined ? { base_url: input.baseUrl } : {}),
          ...(apiKeyEncrypted !== undefined ? { api_key_encrypted: apiKeyEncrypted } : {}),
          updated_at: new Date(),
        })
        .where(eq(providerConfig.id, existing.id))
        .returning();
      if (!updated) {
        throw new Error('upsertProvider: update returned no row');
      }
      return toPublicProvider(updated);
    }

    const [created] = await ctx.db
      .insert(providerConfig)
      .values({
        id: ulid(),
        provider: input.provider,
        enabled: input.enabled,
        base_url: input.baseUrl ?? null,
        api_key_encrypted: apiKeyEncrypted ?? null,
      })
      .returning();
    if (!created) {
      throw new Error('upsertProvider: insert returned no row');
    }
    return toPublicProvider(created);
  }),

  /**
   * Budgets and approval policy (PLAN.md 4.9's Settings page, and Phase 5's
   * "hard stops" - @katnor/agents' runExecutor.ts is the actual enforcement,
   * this is just what lets the owner configure the numbers it enforces).
   * `default_model` isn't exposed here yet - nothing edits it outside the
   * seed script today.
   */
  getCompanySettings: publicProcedure.query(() => companyRepo.getSettings()),

  updateBudgets: protectedProcedure
    .input(
      z.object({
        company_daily_usd: z.number().nonnegative(),
        project_daily_usd: z.number().nonnegative().optional(),
        agent_daily_usd: z.number().nonnegative().optional(),
      }),
    )
    .mutation(({ input }) => companyRepo.updateSettings({ budgets: input })),

  updateApprovalPolicy: protectedProcedure
    .input(
      z.object({
        hire: approvalModeSchema,
        tool_call: approvalModeSchema,
        spend: approvalModeSchema,
      }),
    )
    .mutation(({ input }) => companyRepo.updateSettings({ approval_policy: input })),
});
