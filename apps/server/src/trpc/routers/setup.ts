import { MODEL_COMBO_ENTRY_PROVIDERS } from '@katnor/core';
import {
  createFirstUser,
  ensureCompanyBootstrap,
  needsSetup,
  providerConfig,
  SetupAlreadyCompleteError,
  ulid,
} from '@katnor/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { createSessionToken, serializeSessionCookie } from '../../auth.js';
import { encryptSecret } from '../../crypto.js';
import { publicProcedure, router } from '../trpc.js';

/**
 * First-run setup, done in a browser (apps/web's /setup route).
 *
 * The problem this solves: a fresh `docker compose up` produces a stack
 * nobody can log into. The first account cannot be created through the
 * dashboard, because the dashboard requires being logged in - so until
 * now the only way in was `pnpm db:seed` with a pre-computed
 * `OWNER_PASSWORD_HASH`, which means a terminal, a checkout, and knowing
 * how to hash a password. This router is the other door.
 *
 * Both procedures here are `publicProcedure`, and they have to be - a
 * login check on the endpoint that creates the first login is a
 * contradiction. What keeps that safe is that `complete` refuses the
 * moment any user account exists (@katnor/db's `createFirstUser`, which
 * does the check and the insert under an advisory lock). The window in
 * which this is usable is "a database with zero users", and it closes
 * permanently the first time anyone walks through it.
 *
 * That window is a real consideration when deploying: between starting the
 * stack and completing setup, whoever reaches the server first becomes its
 * owner. That is the same trade every self-hosted first-run wizard makes,
 * and the mitigation is the same one - do not expose a brand-new install
 * to an untrusted network before finishing setup. It is called out in
 * README.md rather than left implicit.
 */

const setupInputSchema = z.object({
  companyName: z.string().trim().min(1).max(120),
  ownerName: z.string().trim().min(1).max(120),
  ownerEmail: z.string().email(),
  // Matches @katnor/core's `createUserInputSchema` and the `users.create`
  // procedure, so the account made here is subject to the same rule as
  // every account made later.
  ownerPassword: z.string().min(8),
  /**
   * Optional, because setup must be able to finish without one: someone
   * running entirely on a local Ollama has no key to give, and blocking
   * setup on a field they cannot fill would be a dead end. Agents simply
   * cannot run until a provider is configured, here or in Settings later.
   */
  provider: z
    .object({
      name: z.enum(MODEL_COMBO_ENTRY_PROVIDERS),
      apiKey: z.string().min(1),
    })
    .optional(),
});

export const setupRouter = router({
  /**
   * Whether this install still needs setting up, and whether the database
   * is even reachable and migrated yet.
   *
   * The two are reported separately on purpose. A fresh stack where
   * migrations have not run yet looks identical to an un-set-up one from
   * the outside - both have no users - but they need completely different
   * things from the operator, and a wizard that offered a signup form
   * against a database with no tables would fail on submit with a raw SQL
   * error. So the query is allowed to fail, and a failure is reported as
   * `databaseReady: false` for the UI to explain.
   *
   * Deliberately returns nothing else. Before setup this endpoint answers
   * to anyone, so it says only what an anonymous caller must know to be
   * shown the right screen - never the company name, never whether a
   * particular email exists.
   */
  status: publicProcedure.query(async () => {
    try {
      return { databaseReady: true, needsSetup: await needsSetup() };
    } catch (err) {
      console.error('[setup] status check failed - database not ready:', err);
      return { databaseReady: false, needsSetup: true };
    }
  }),

  /**
   * Creates the company, the system CEO, `#general` and the first user
   * account, then logs that user straight in.
   *
   * Logging in here rather than bouncing to /login is not just
   * convenience: the credentials were typed seconds ago into a form that
   * is about to disappear, and sending someone to a login page to retype
   * them is the kind of small insult that makes people wonder whether
   * setup actually worked.
   */
  complete: publicProcedure.input(setupInputSchema).mutation(async ({ ctx, input }) => {
    // Cheap early rejection so an already-set-up install answers without
    // touching the company bootstrap below. `createFirstUser` re-checks
    // under a lock and is the actual guarantee - this is not relied on.
    if (!(await needsSetup())) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'This Katnor install is already set up. Log in instead.',
      });
    }

    await ensureCompanyBootstrap(input.companyName);

    const owner = await createFirstUser({
      name: input.ownerName,
      email: input.ownerEmail,
      password: input.ownerPassword,
    }).catch((err: unknown) => {
      // The real guard, as opposed to the early check above: this is the
      // one that ran under the advisory lock, so a request that loses the
      // race lands here rather than creating a second owner.
      if (err instanceof SetupAlreadyCompleteError) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This Katnor install is already set up. Log in instead.',
        });
      }
      throw err;
    });

    // After the account exists, so a provider that fails to save cannot
    // leave an install with no way in. A key is re-enterable in Settings;
    // a missing owner account is not re-creatable at all once this
    // endpoint has closed.
    if (input.provider) {
      await ctx.db.insert(providerConfig).values({
        id: ulid(),
        provider: input.provider.name,
        api_key_encrypted: encryptSecret(input.provider.apiKey),
        base_url: null,
        enabled: true,
        input_cost_per_mtok: null,
        output_cost_per_mtok: null,
      });
    }

    ctx.resHeaders.append('set-cookie', serializeSessionCookie(createSessionToken(owner.id)));

    const { password_hash: _passwordHash, ...publicUser } = owner;
    return { ok: true as const, user: publicUser };
  }),
});
