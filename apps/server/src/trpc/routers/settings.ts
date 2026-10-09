import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { approvalModeSchema, MODEL_COMBO_ENTRY_PROVIDERS } from '@katnor/core';
import { companyRepo, modelComboRepo, providerConfigRepo } from '@katnor/db';
import { decryptSecret, encryptSecret } from '../../crypto.js';
import {
  getCachedConnectionCatalog,
  refreshConnectionCatalog,
} from '../../modelCatalog.js';
import { protectedProcedure, router } from '../trpc.js';

type ProviderConnectionRow = Awaited<ReturnType<typeof providerConfigRepo.list>>[number];

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
 * configured at all. `id` and `name` are the connection identity the
 * Model mappings point at.
 */
function toPublicProvider(row: ProviderConnectionRow) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    hasKey: row.api_key_encrypted !== null,
    baseUrl: row.base_url,
    enabled: row.enabled,
    inputCostPerMtok: fromNumericColumn(row.input_cost_per_mtok),
    outputCostPerMtok: fromNumericColumn(row.output_cost_per_mtok),
  };
}

const createProviderInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // "combo" (@katnor/core's MODEL_PROVIDERS) is deliberately excluded here:
  // it's a named Model mapping across the connections below, not a real
  // backend with its own base_url/api_key.
  provider: z.enum(MODEL_COMBO_ENTRY_PROVIDERS),
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().min(1).nullable().optional(),
  enabled: z.boolean().default(true),
  // See @katnor/db's schema/providerConfig.ts for why these exist:
  // "anthropic" is priced from @katnor/llm's own pricing.ts table and
  // never reads these. The 999,999 max matches the DB column's
  // `numeric(12, 6)` precision.
  inputCostPerMtok: z.number().min(0).max(999_999).nullable().optional(),
  outputCostPerMtok: z.number().min(0).max(999_999).nullable().optional(),
});

const updateProviderInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  // Omitted entirely -> leave the existing key untouched. Present -> replace it.
  // There is no way to *clear* a key back to unset via this input - that's an
  // intentional gap for now (the UI only ever offers "set a new key").
  apiKey: z.string().min(1).optional(),
  // Present-but-null -> clear the base URL. Omitted -> leave it untouched.
  baseUrl: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  // Present-but-null -> clear the rate back to "untracked" (costUsd: 0).
  // Omitted -> leave it untouched.
  inputCostPerMtok: z.number().min(0).max(999_999).nullable().optional(),
  outputCostPerMtok: z.number().min(0).max(999_999).nullable().optional(),
});

export const settingsRouter = router({
  /**
   * Lists every provider connection. Connections are the unit the Model
   * mappings point at - several rows may share one `provider` type with
   * different keys ("OpenAI utama", "OpenAI murah").
   */
  listProviders: protectedProcedure.query(async () => {
    const rows = await providerConfigRepo.list();
    return rows.map(toPublicProvider);
  }),

  createProvider: protectedProcedure
    .input(createProviderInputSchema)
    .mutation(async ({ input }) => {
      const created = await providerConfigRepo.create({
        name: input.name,
        provider: input.provider,
        apiKeyEncrypted: input.apiKey !== undefined ? encryptSecret(input.apiKey) : null,
        baseUrl: input.baseUrl ?? null,
        enabled: input.enabled,
        inputCostPerMtok: toNumericColumn(input.inputCostPerMtok ?? null),
        outputCostPerMtok: toNumericColumn(input.outputCostPerMtok ?? null),
      });
      return toPublicProvider(created);
    }),

  updateProvider: protectedProcedure
    .input(updateProviderInputSchema)
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      const updated = await providerConfigRepo.update(id, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.apiKey !== undefined ? { apiKeyEncrypted: encryptSecret(patch.apiKey) } : {}),
        ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.inputCostPerMtok !== undefined
          ? { inputCostPerMtok: toNumericColumn(patch.inputCostPerMtok) }
          : {}),
        ...(patch.outputCostPerMtok !== undefined
          ? { outputCostPerMtok: toNumericColumn(patch.outputCostPerMtok) }
          : {}),
      });
      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `No provider connection "${id}".` });
      }
      return toPublicProvider(updated);
    }),

  /**
   * Removes a connection. Refuses when a Model still maps to it - same
   * can't-delete-what's-in-use guard the Models router applies to hired
   * agents. The legacy default-connection path (old entries naming a
   * provider type) is NOT checked: removing a non-default connection
   * never breaks it, and removing the default is allowed so the owner
   * can replace it - the next call then reports "no connection".
   */
  removeProvider: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const models = await modelComboRepo.list();
      const usedBy = models.filter((model) =>
        (model.entries as { providerConnectionId?: string }[]).some(
          (entry) => entry?.providerConnectionId === input.id,
        ),
      );
      if (usedBy.length > 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            `Cannot remove this connection - ${usedBy.length} model(s) map to it ` +
            `(${usedBy.map((m) => `"${m.name}"`).join(', ')}). Change them first.`,
        });
      }
      await providerConfigRepo.remove(input.id);
      return { ok: true as const };
    }),

  /**
   * Back-compat for the old single-per-type Settings form: upserts the
   * default connection for `provider`. Kept until the web UI is migrated
   * to connections - new code should use create/update/removeProvider.
   */
  upsertProvider: protectedProcedure
    .input(
      createProviderInputSchema.extend({
        // createProvider's own comments apply to each field here.
        apiKey: z.string().min(1).optional(),
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const existing = await providerConfigRepo.getDefaultByProvider(input.provider);
      const apiKeyEncrypted = input.apiKey !== undefined ? encryptSecret(input.apiKey) : undefined;
      if (existing) {
        const updated = await providerConfigRepo.update(existing.id, {
          enabled: input.enabled,
          ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
          ...(apiKeyEncrypted !== undefined ? { apiKeyEncrypted } : {}),
          ...(input.inputCostPerMtok !== undefined
            ? { inputCostPerMtok: toNumericColumn(input.inputCostPerMtok) }
            : {}),
          ...(input.outputCostPerMtok !== undefined
            ? { outputCostPerMtok: toNumericColumn(input.outputCostPerMtok) }
            : {}),
        });
        if (!updated) {
          throw new Error('upsertProvider: update returned no row');
        }
        return toPublicProvider(updated);
      }
      const created = await providerConfigRepo.create({
        name: input.name,
        provider: input.provider,
        apiKeyEncrypted: apiKeyEncrypted ?? null,
        baseUrl: input.baseUrl ?? null,
        enabled: input.enabled,
        inputCostPerMtok: toNumericColumn(input.inputCostPerMtok ?? null),
        outputCostPerMtok: toNumericColumn(input.outputCostPerMtok ?? null),
      });
      return toPublicProvider(created);
    }),

  /**
   * Lists the models a connection offers - the Zed-style "paste a key,
   * see the models" step. Reads from cache when fresh; `refresh: true`
   * force-fetches (and surfaces provider errors: bad key, unreachable
   * endpoint) so the button doubles as "test connection". Never throws
   * on the cached path - offline just yields the stale list or [].
   */
  listConnectionModels: protectedProcedure
    .input(z.object({ id: z.string().min(1), refresh: z.boolean().optional() }))
    .query(async ({ input }) => {
      if (input.refresh) return refreshConnectionCatalog(input.id);
      return getCachedConnectionCatalog(input.id);
    }),

  /**
   * The named Model new hires default to (`company.settings.default_model`).
   * Resolved through @katnor/db's `resolveDefaultModelName` - the setting
   * when it points at a real Model, else the "default"-named Model,
   * else null (fresh install with no Models yet - hire forms then force
   * an explicit pick).
   */
  getDefaultModel: protectedProcedure.query(async () => {
    const { resolveDefaultModelName } = await import('@katnor/db');
    return { name: await resolveDefaultModelName() };
  }),

  /**
   * Sets the default Model by name. Validated to exist - a default
   * pointing at a ghost would break every hire that relies on it.
   */
  setDefaultModel: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1) }))
    .mutation(async ({ input }) => {
      const model = await modelComboRepo.getByName(input.name);
      if (!model) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `No model named "${input.name}".`,
        });
      }
      await companyRepo.updateSettings({ default_model: model.name });
      return { name: model.name };
    }),

  /**
   * Budgets, approval policy, and the default Model name (PLAN.md 4.9's
   * Settings page, and Phase 5's "hard stops" - @katnor/agents'
   * runExecutor.ts is the actual enforcement, this is just what lets the
   * owner configure the numbers it enforces).
   */
  getCompanySettings: protectedProcedure.query(() => companyRepo.getSettings()),

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
