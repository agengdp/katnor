import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { approvalModeSchema, MODEL_COMBO_ENTRY_PROVIDERS } from '@katnor/core';
import { companyRepo, providerConfig, ulid } from '@katnor/db';
import { encryptSecret } from '../../crypto.js';
import { protectedProcedure, publicProcedure, router } from '../trpc.js';

type ProviderConfigRow = typeof providerConfig.$inferSelect;

/**
 * `provider_config.input_cost_per_mtok`/`output_cost_per_mtok` are `numeric`
 * columns - drizzle reads/writes those as strings, not JS numbers. Shared by
 * `upsertProvider`'s update and insert branches below to keep the
 * number-or-null -> string-or-null conversion in one place.
 */
function toNumericColumn(value: number | null): string | null {
  return value === null ? null : String(value);
}

/** The reverse of `toNumericColumn` above, for reading a row back out. */
function fromNumericColumn(value: string | null): number | null {
  return value === null ? null : Number(value);
}

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
    inputCostPerMtok: fromNumericColumn(row.input_cost_per_mtok),
    outputCostPerMtok: fromNumericColumn(row.output_cost_per_mtok),
  };
}

const upsertProviderInputSchema = z.object({
  // "combo" (@katnor/core's MODEL_PROVIDERS) is deliberately excluded here:
  // it's a named fallback chain across the providers below, not a real
  // backend with its own base_url/api_key - see @katnor/llm's combo.ts.
  provider: z.enum(MODEL_COMBO_ENTRY_PROVIDERS),
  // Omitted entirely -> leave the existing key untouched. Present -> replace it.
  // There is no way to *clear* a key back to unset via this input - that's an
  // intentional gap for now (the UI only ever offers "set a new key").
  apiKey: z.string().min(1).optional(),
  // Present-but-null -> clear the base URL. Omitted -> leave it untouched.
  baseUrl: z.string().min(1).nullable().optional(),
  enabled: z.boolean(),
  // Present-but-null -> clear the rate back to "untracked" (costUsd: 0).
  // Omitted -> leave it untouched. See @katnor/db's schema/providerConfig.ts
  // for why this exists: "anthropic" is priced from @katnor/llm's own
  // pricing.ts table and never reads these, so they're meaningless (and
  // not offered in the web UI) for that one provider. The 999,999 max
  // matches the DB column's `numeric(12, 6)` precision - see the matching
  // bound (and its full rationale) in @katnor/core's schemas/providerConfig.ts.
  inputCostPerMtok: z.number().min(0).max(999_999).nullable().optional(),
  outputCostPerMtok: z.number().min(0).max(999_999).nullable().optional(),
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
          ...(input.inputCostPerMtok !== undefined
            ? { input_cost_per_mtok: toNumericColumn(input.inputCostPerMtok) }
            : {}),
          ...(input.outputCostPerMtok !== undefined
            ? { output_cost_per_mtok: toNumericColumn(input.outputCostPerMtok) }
            : {}),
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
        input_cost_per_mtok: toNumericColumn(input.inputCostPerMtok ?? null),
        output_cost_per_mtok: toNumericColumn(input.outputCostPerMtok ?? null),
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
