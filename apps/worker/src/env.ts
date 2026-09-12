import { z } from 'zod';

/**
 * Validated environment for @katnor/worker.
 *
 * Parsed once at import time so the process fails fast at boot with a clear
 * message when a required variable is missing or malformed, instead of
 * pg-boss (or a handler) failing later with a confusing runtime error.
 */
const envSchema = z.object({
  /** Postgres connection string pg-boss uses for its own schema/tables and job storage. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  /** How often (ms) the boot-time heartbeat in src/index.ts logs "worker alive". */
  WORKER_HEARTBEAT_MS: z.coerce.number().int().positive().default(30000),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(
      '[worker] invalid environment configuration:',
      parsed.error.flatten().fieldErrors,
    );
    throw new Error(
      'Invalid worker environment. Copy .env.example to .env at the repo root and check ' +
        'DATABASE_URL / WORKER_HEARTBEAT_MS.',
    );
  }
  return parsed.data;
}

export const env = loadEnv();
