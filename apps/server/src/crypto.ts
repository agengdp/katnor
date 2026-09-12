import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { env } from './env.js';

/**
 * Dependency-free password hashing and settings-secret encryption, both
 * built only on `node:crypto` (no bcrypt/argon2/jose) since this sandbox
 * cannot install packages and v1 has exactly one password to check (the
 * owner's) and one class of secret to encrypt (provider API keys).
 */

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

// ─── Settings secret encryption (provider API keys at rest) ────────────────

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

// Derived once at module load and reused - scrypt is deliberately slow
// (that's the point for password hashing), so deriving it per call would
// make every encrypt/decrypt call needlessly expensive.
const encryptionKey = scryptSync(env.SETTINGS_ENCRYPTION_KEY, KEY_DERIVATION_SALT, ENCRYPTION_KEY_LENGTH);

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
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, encryptionKey, iv);
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

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, encryptionKey, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
