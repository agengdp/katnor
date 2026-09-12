import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * AES-256-GCM encryption for anything stored at rest that isn't a password
 * (provider API keys - Phase 1's `provider_config.api_key_encrypted` - and
 * now MCP server credentials in the `secret` table, Phase 2). Lives in
 * @katnor/db rather than apps/server so both the server (Settings CRUD) and
 * @katnor/agents (resolving a secret to build an MCP server's env at run
 * time - see ../../agents/src/mcpTools.ts) can decrypt without apps/server
 * needing to be a dependency of the worker. Owner password hashing stays in
 * apps/server/src/crypto.ts - it's only ever used there.
 */

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
// 96-bit IV: the size AES-GCM is designed and recommended for (RFC 5116) -
// using a different length is supported by node:crypto but forces a slower,
// non-standard derivation of the internal counter, so 12 bytes it is.
const IV_BYTES = 12;
const ENCRYPTION_KEY_LENGTH = 32; // AES-256 -> 32-byte key
// Fixed, non-secret "salt" for the key-derivation step. It does not need to
// be random (it isn't protecting against rainbow tables here, it's just
// domain-separating this derived key from any other use of the same
// SETTINGS_ENCRYPTION_KEY), so a constant is fine and must never change -
// changing it silently makes every previously-encrypted secret undecryptable.
const KEY_DERIVATION_SALT = 'katnor-settings';

function readEncryptionKeySource(): string {
  const value = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!value || value.trim().length === 0) {
    throw new Error(
      'SETTINGS_ENCRYPTION_KEY is not set. Copy .env.example to .env at the repo root and set it ' +
        '(any long random string - it is only ever used locally to derive the AES key).',
    );
  }
  return value;
}

// Derived lazily (once) rather than at module load: several scripts that
// import @katnor/db (drizzle-kit config, migration scripts) never touch a
// secret and shouldn't fail just because this env var isn't set for them.
let cachedKey: Buffer | undefined;
function getEncryptionKey(): Buffer {
  if (!cachedKey) {
    cachedKey = scryptSync(readEncryptionKeySource(), KEY_DERIVATION_SALT, ENCRYPTION_KEY_LENGTH);
  }
  return cachedKey;
}

/**
 * Encrypts `plain` with AES-256-GCM using a key derived from
 * `SETTINGS_ENCRYPTION_KEY`.
 *
 * Storage format: `"<ivBase64>:<authTagBase64>:<ciphertextBase64>"`. A
 * future reader needs exactly this to decrypt: split on `:`, base64-decode
 * each part, then AES-256-GCM-decrypt the ciphertext with the derived key,
 * the IV, and the auth tag (via `decipher.setAuthTag(...)`) - see
 * `decryptSecret` below, which does exactly that.
 */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * Decrypts a string produced by `encryptSecret` (see the format documented
 * there: `"<ivBase64>:<authTagBase64>:<ciphertextBase64>"`). Throws if the
 * string is malformed or the auth tag doesn't verify (tampered/corrupted
 * ciphertext, or the wrong `SETTINGS_ENCRYPTION_KEY`).
 */
export function decryptSecret(encrypted: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('decryptSecret: malformed ciphertext (expected "iv:authTag:ciphertext")');
  }
  const [ivB64, authTagB64, ciphertextB64] = parts as [string, string, string];

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
