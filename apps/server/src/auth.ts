import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PublicUser } from '@katnor/core';
import { userRepo } from '@katnor/db';
import type { Context, MiddlewareHandler } from 'hono';
import { env } from './env.js';
import { verifyPassword } from './crypto.js';

/**
 * Multi-user session auth (PLAN.md Phase 5). A session token is a signed,
 * self-contained "this user id is logged in until this expiry" claim -
 * nothing is stored server-side, so `verifySessionToken` never needs a DB
 * round trip to validate one (it's called on every `/trpc/*` request via
 * src/trpc/context.ts). One consequence of that: removing a user
 * (Settings > Team members) doesn't instantly invalidate a session token
 * they already hold - it just expires normally within 7 days like any
 * other. Instant revocation would need a server-side session store this
 * design deliberately doesn't have; acceptable for a self-hosted app where
 * removing a teammate is a rare, low-stakes admin action, not something
 * this pass builds a bigger mechanism for.
 *
 * This replaces the single-owner, env-var-only scheme (`OWNER_PASSWORD_HASH`
 * checked directly, no user identity at all) - see @katnor/db's
 * src/seed.ts for how the very first user account still gets created from
 * that same env var, one time, since there's no self-serve signup.
 */

export const SESSION_COOKIE_NAME = 'katnor_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Signs `${userId}.${expiryMs}` with HMAC-SHA256 over `SESSION_SECRET` and
 * returns it hex-encoded.
 */
function sign(userId: string, expiryMs: number): string {
  return createHmac('sha256', env.SESSION_SECRET).update(`${userId}.${expiryMs}`).digest('hex');
}

/**
 * Creates a new session token for `userId`, good for 7 days from now.
 *
 * Format: `"<userId>.<expiryEpochMs>.<signatureHex>"`. ULIDs (every `id` in
 * this system, including `user.id`) never contain a `.`, so splitting on
 * `.` unambiguously recovers all three parts - see `verifySessionToken`.
 */
export function createSessionToken(userId: string): string {
  const expiryMs = Date.now() + SESSION_TTL_MS;
  return `${userId}.${expiryMs}.${sign(userId, expiryMs)}`;
}

/**
 * Verifies a token produced by `createSessionToken`: the signature must
 * match (checked in constant time) and the expiry must still be in the
 * future. Returns the token's `userId` on success, `null` on any failure
 * (including `undefined`/`null` input, e.g. "no cookie present") - callers
 * don't need a separate presence check.
 */
export function verifySessionToken(token: string | undefined | null): string | null {
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiryPart, signaturePart] = parts as [string, string, string];
  if (!userId) return null;

  const expiryMs = Number(expiryPart);
  if (!Number.isFinite(expiryMs)) return null;
  if (expiryMs <= Date.now()) return null;

  const expectedSignature = Buffer.from(sign(userId, expiryMs), 'hex');
  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(signaturePart, 'hex');
  } catch {
    return null;
  }

  // timingSafeEqual throws on a length mismatch rather than returning
  // false, so that case is rejected explicitly first.
  if (providedSignature.length !== expectedSignature.length) return null;
  return timingSafeEqual(providedSignature, expectedSignature) ? userId : null;
}

/** Reads a single cookie value out of a raw `Cookie` request header. */
export function readCookie(
  cookieHeader: string | null | undefined,
  name: string,
): string | undefined {
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
 * Serializes the `Set-Cookie` header value that logs a user in: httpOnly,
 * `SameSite=Lax`, and `Secure` when `NODE_ENV=production` (a plain-HTTP
 * local dev server can't set a Secure cookie and have the browser accept
 * it back).
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
  const attributes = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (env.NODE_ENV === 'production') attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * What a successful login hands back: a fresh session token plus the
 * public shape of who logged in.
 */
export interface LoginResult {
  token: string;
  user: PublicUser;
}

/**
 * Looks up `email` in the `user` table and checks `password` against its
 * stored hash, returning a fresh session token + the public user shape on
 * success, `null` on any failure (no such user, or wrong password - never
 * distinguished in the response, so a login attempt can't be used to probe
 * which emails have accounts). Shared by the plain Hono `loginHandler`
 * below and the `auth.login` tRPC procedure (src/trpc/routers/auth.ts) so
 * the credential check lives in exactly one place.
 */
export async function attemptLogin(email: string, password: string): Promise<LoginResult | null> {
  const user = await userRepo.getByEmail(email);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  const { password_hash: _passwordHash, ...publicUser } = user;
  return { token: createSessionToken(user.id), user: publicUser };
}

/**
 * Hono middleware that 401s unless the `katnor_session` cookie holds a
 * valid, unexpired session token. Most of v1's HTTP surface is `/trpc/*`,
 * which enforces auth per-procedure via `protectedProcedure` in
 * src/trpc/trpc.ts instead - this is for the plain HTTP routes that need
 * the same check outside of tRPC, e.g. Phase 5's `/export/backup` (see
 * src/index.ts), a file download that doesn't fit tRPC's request/response
 * shape.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const token = readCookie(c.req.header('cookie'), SESSION_COOKIE_NAME);
  if (verifySessionToken(token) === null) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};

/**
 * Plain Hono login handler: reads `{ email: string, password: string }`
 * from the JSON body, and on success sets the session cookie and responds
 * `{ ok: true }`. Like `requireAuth`, this is not mounted by src/index.ts
 * by default (the web app logs in via the `auth.login` tRPC procedure) -
 * it's exported so a non-tRPC client (curl, a health-check script, a
 * future REST surface) has a working login endpoint to mount if needed.
 */
export async function loginHandler(c: Context): Promise<Response> {
  const body: unknown = await c.req.json().catch(() => null);
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const email = typeof record.email === 'string' ? record.email : undefined;
  const password = typeof record.password === 'string' ? record.password : undefined;

  if (!email || !password) {
    return c.json({ ok: false, error: 'email and password are required' }, 400);
  }

  const result = await attemptLogin(email, password);
  if (!result) {
    return c.json({ ok: false, error: 'invalid email or password' }, 401);
  }

  c.header('Set-Cookie', serializeSessionCookie(result.token), { append: true });
  return c.json({ ok: true });
}
