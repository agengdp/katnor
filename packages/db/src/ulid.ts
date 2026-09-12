import { randomBytes } from 'node:crypto';

/**
 * Dependency-free ULID (https://github.com/ulid/spec) generator.
 *
 * A ULID is 26 characters of Crockford's Base32:
 *   - 10 characters encoding a 48-bit millisecond timestamp (most significant
 *     first), so ULIDs are lexicographically sortable by creation time.
 *   - 16 characters encoding 80 bits of randomness.
 *
 * We can't install the "ulid" npm package in this sandbox, so this is a
 * small, careful reimplementation of the same encoding.
 */

// Crockford's Base32 alphabet: excludes I, L, O, U to avoid transcription
// mistakes, and is case-insensitive-safe. Exactly 32 symbols.
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length; // 32 = 2^5, i.e. 5 bits per character
const TIME_LEN = 10; // 10 chars * 5 bits = 50 bits, enough to hold 48 bits of ms
const RANDOM_LEN = 16; // 16 chars * 5 bits = 80 bits of randomness

/**
 * Encodes `time` (milliseconds since epoch) into `len` Base32 characters,
 * most-significant digit first, via repeated division by 32 - the standard
 * technique for base-N encoding of an integer.
 */
function encodeTime(time: number, len: number): string {
  if (!Number.isFinite(time) || time < 0) {
    throw new Error(`ulid: invalid timestamp ${time}`);
  }
  let remaining = Math.floor(time);
  let out = '';
  for (let i = 0; i < len; i++) {
    const mod = remaining % ENCODING_LEN;
    out = ENCODING.charAt(mod) + out;
    remaining = (remaining - mod) / ENCODING_LEN;
  }
  return out;
}

/**
 * Encodes `len` characters of cryptographically random Base32 output.
 *
 * We draw one random byte per output character and reduce it mod 32. Since
 * 256 (the range of a byte) is an exact multiple of 32, `byte % 32` is
 * exactly uniform over 0..31 - no modulo bias - even though this uses more
 * raw random bytes than the tightest possible bit-packing would.
 */
function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ENCODING.charAt(bytes[i]! % ENCODING_LEN);
  }
  return out;
}

/** Generates a new ULID: a 26-character, lexicographically sortable, unique id. */
export function ulid(): string {
  return encodeTime(Date.now(), TIME_LEN) + encodeRandom(RANDOM_LEN);
}
