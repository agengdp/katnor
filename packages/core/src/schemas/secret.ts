import { z } from 'zod';
import { withBase } from './base.js';

/**
 * A named secret an MCP server (or, later, another integration) needs in
 * its environment - referenced by name from `tool_config.env_secret_refs`
 * rather than storing the value inline on that row, so the same secret
 * (e.g. a single GITHUB_TOKEN) can back more than one tool config without
 * being duplicated or re-encrypted per row.
 */
export const secretFields = {
  name: z.string().min(1),
  // AES-256-GCM ciphertext, same format/derivation as
  // provider_config.api_key_encrypted (see apps/server/src/crypto.ts) -
  // never the raw value.
  value_encrypted: z.string(),
};

export const secretSchema = withBase(secretFields);
export type Secret = z.infer<typeof secretSchema>;

export const upsertSecretInputSchema = z.object(secretFields);
export type UpsertSecretInput = z.infer<typeof upsertSecretInputSchema>;
