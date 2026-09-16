import { z } from 'zod';

/**
 * Zod-validated process env for apps/server. Read directly from
 * `process.env` (no dotenv) - same convention as @katnor/db's src/env.ts -
 * since this app is always run either via `docker compose` (which injects
 * variables from the repo-root `.env` via `env_file:`) or locally with the
 * shell environment already populated.
 *
 * `OWNER_EMAIL`/`OWNER_PASSWORD_HASH` (Phase 5's multi-user auth
 * bootstrap) are deliberately NOT part of this schema: they're read only
 * once, directly, by @katnor/db's src/seed.ts to create the very first
 * `user` row - this running server process never reads them itself, since
 * every login now goes through that table (src/auth.ts's `attemptLogin`),
 * not an env var.
 */

/** Treats an unset/blank env var the same as "not provided" for zod's `.optional()`. */
function emptyToUndefined(value: unknown): unknown {
  if (typeof value === 'string' && value.trim().length === 0) return undefined;
  return value;
}

const envSchema = z.object({
  DATABASE_URL: z.preprocess(
    emptyToUndefined,
    z.string({ required_error: 'DATABASE_URL is required' }),
  ),
  SERVER_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(3001)),
  SESSION_SECRET: z.preprocess(
    emptyToUndefined,
    z.string({ required_error: 'SESSION_SECRET is required' }).min(1),
  ),
  SETTINGS_ENCRYPTION_KEY: z.preprocess(
    emptyToUndefined,
    z.string({ required_error: 'SETTINGS_ENCRYPTION_KEY is required' }).min(1),
  ),
  // Optional: the worker is the primary consumer of ANTHROPIC_API_KEY; the
  // server only needs it as a convenience default so Settings can show a
  // provider as already configured before the owner ever visits the UI.
  // Provider keys can otherwise be set per-provider through the settings
  // UI (see src/trpc/routers/settings.ts), encrypted at rest.
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  // Not part of .env.example - read directly because it's the standard
  // Node convention (and controls the session cookie's `Secure` flag, see
  // src/auth.ts). Defaults to "development" when unset, same as Node itself.
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(['development', 'production', 'test']).default('development'),
  ),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration for @katnor/server:\n${issues}\n` +
        'Copy .env.example to .env at the repo root and fill in the missing values.',
    );
  }
  return parsed.data;
}

export const env = loadEnv();
