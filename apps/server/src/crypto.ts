import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Dependency-free owner password hashing, built only on `node:crypto` (no
 * bcrypt/argon2) since this sandbox cannot install packages and v1 has
 * exactly one password to check. Settings-secret encryption
 * (`encryptSecret`/`decryptSecret`, re-exported below) moved to
 * @katnor/db/src/crypto.ts in Phase 2 so @katnor/agents can decrypt an MCP
 * server's secret env vars at run time without depending on apps/server.
 */
export { decryptSecret, encryptSecret } from '@katnor/db';

// ─── Password hashing (owner login) ────────────────────────────────────────

const SCRYPT_SALT_BYTES = 16;
const SCRYPT_KEYLEN = 64;

/**
 * Hashes `password` with scrypt and a fresh random 16-byte salt.
 *
 * Storage format: `"<saltHex>:<hashHex>"`, both hex-encoded. This is the
 * exact string that belongs in `OWNER_PASSWORD_HASH`; `verifyPassword`
 * below is the only code that needs to understand this format.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/**
 * Verifies `password` against a hash produced by `hashPassword` (the
 * `"<saltHex>:<hashHex>"` format described above). Re-derives the scrypt
 * hash using the stored salt and compares in constant time via
 * `timingSafeEqual` - lengths are checked first since `timingSafeEqual`
 * throws (rather than returning false) when its two buffers differ in
 * length.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const separatorIndex = stored.indexOf(':');
  if (separatorIndex === -1) return false;

  const saltHex = stored.slice(0, separatorIndex);
  const hashHex = stored.slice(separatorIndex + 1);
  if (!saltHex || !hashHex) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }

  const actual = scryptSync(password, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
