/**
 * Settings-secret encryption (`encryptSecret`/`decryptSecret`) and user
 * password hashing (`hashPassword`/`verifyPassword`) both live in
 * @katnor/db/src/crypto.ts - see that file's module comment for why (both
 * need to be reachable from outside apps/server: @katnor/agents for
 * secrets, @katnor/db's own src/seed.ts for the first user account).
 * Re-exported here so this app's own call sites (the `auth`/`users`
 * routers) don't need to import from @katnor/db directly.
 */
export { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '@katnor/db';
