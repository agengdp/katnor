import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { env } from './env.js';
import { verifyPassword } from './crypto.js';

/**
 * Single-owner session auth. There is exactly one account (the owner,
 * `OWNER_PASSWORD_HASH`), so this is deliberately simpler than a general
 * user/session table: a session is just a signed, self-contained token -
 * "is this owner-token valid and unexpired?" - with nothing to look up in
 * the database.
 */

export const SESSION_COOKIE_NAME = 'katnor_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Signs `expiryMs` (epoch milliseconds) with HMAC-SHA256 over
 * `SESSION_SECRET` and returns it hex-encoded.
 */
function sign(expiryMs: number): string {
  return createHmac('sha256', env.SESSION_SECRET).update(String(expiryMs)).digest('hex');
}

/**
 * Creates a new session token good for 7 days from now.
 *
 * Format: `"<expiryEpochMs>.<signatureHex>"`, where `signatureHex` is
 * `HMAC-SHA256(SESSION_SECRET, expiryEpochMs)`. There is no session id and
 * nothing is stored server-side - `verifySessionToken` below re-derives the
 * signature from the expiry it's given and compares.
 */
export function createSessionToken(): string {
  const expiryMs = Date.now() + SESSION_TTL_MS;
  return `${expiryMs}.${sign(expiryMs)}`;
}

/**
 * Verifies a token produced by `createSessionToken`: the signature must
 * match (checked in constant time) and the expiry must still be in the
 * future. Accepts `undefined`/`null` (e.g. "no cookie present") as simply
 * invalid, so callers don't need a separate presence check.
 */
export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;

  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;

  const expiryPart = token.slice(0, dotIndex);
  const signaturePart = token.slice(dotIndex + 1);

  const expiryMs = Number(expiryPart);
  if (!Number.isFinite(expiryMs)) return false;
  if (expiryMs <= Date.now()) return false;

  const expectedSignature = Buffer.from(sign(expiryMs), 'hex');
  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(signaturePart, 'hex');
  } catch {
    return false;
  }

  // timingSafeEqual throws on a length mismatch rather than returning
  // false, so that case is rejected explicitly first.
  if (providedSignature.length !== expectedSignature.length) return false;
  return timingSafeEqual(providedSignature, expectedSignature);
}

/** Reads a single cookie value out of a raw `Cookie` request header. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eqIndex = part.indexOf('=');
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    if (key !== name) continue;
    const value = part.slice(eqIndex + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/**
 * Serializes the `Set-Cookie` header value that logs the owner in:
 * httpOnly, `SameSite=Lax`, and `Secure` when `NODE_ENV=production` (a
 * plain-HTTP local dev server can't set a Secure cookie and have the
 * browser accept it back).
 */
export function serializeSessionCookie(token: string): string {
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (env.NODE_ENV === 'production') attributes.push('Secure');
  return attributes.join('; ');
}

/** Serializes the `Set-Cookie` header value that clears the session cookie (logout). */
export function serializeLogoutCookie(): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (env.NODE_ENV === 'production') attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * Checks `password` against `OWNER_PASSWORD_HASH` and, on success, returns
 * a fresh session token (or `null` on failure, including when
 * `OWNER_PASSWORD_HASH` isn't set at all, i.e. login is disabled). Shared
 * by the plain Hono `loginHandler` below and the `auth.login` tRPC
 * procedure (src/trpc/routers/auth.ts) so the password check lives in
 * exactly one place.
 */
export function attemptOwnerLogin(password: string): string | null {
  if (!env.OWNER_PASSWORD_HASH) return null;
  if (!verifyPassword(password, env.OWNER_PASSWORD_HASH)) return null;
  return createSessionToken();
}

/**
 * Hono middleware that 401s unless the `katnor_session` cookie holds a
 * valid, unexpired session token. Not currently mounted on any route in
 * src/index.ts (v1's only HTTP surface is `/trpc/*`, which enforces auth
 * per-procedure via `protectedProcedure` in src/trpc/trpc.ts instead) - it
 * is exported for future plain HTTP routes that need the same check
 * outside of tRPC, e.g. artifact/file downloads in a later phase.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const token = readCookie(c.req.header('cookie'), SESSION_COOKIE_NAME);
  if (!verifySessionToken(token)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};

/**
 * Plain Hono login handler: reads `{ password: string }` from the JSON
 * body, and on success sets the session cookie and responds `{ ok: true }`.
 * Like `requireAuth`, this is not mounted by src/index.ts by default (the
 * web app logs in via the `auth.login` tRPC procedure) - it's exported so a
 * non-tRPC client (curl, a health-check script, a future REST surface) has
 * a working login endpoint to mount if needed.
 */
export async function loginHandler(c: Context): Promise<Response> {
  const body: unknown = await c.req.json().catch(() => null);
  const rawPassword =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>).password : undefined;
  const password = typeof rawPassword === 'string' ? rawPassword : undefined;

  if (!password) {
    return c.json({ ok: false, error: 'password is required' }, 400);
  }

  const token = attemptOwnerLogin(password);
  if (!token) {
    return c.json({ ok: false, error: 'invalid password' }, 401);
  }

  c.header('Set-Cookie', serializeSessionCookie(token), { append: true });
  return c.json({ ok: true });
}
