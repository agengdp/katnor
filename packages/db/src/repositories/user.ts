import { eq } from 'drizzle-orm';
import { hashPassword } from '../crypto.js';
import { db } from '../client.js';
import { user } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type UserRow = typeof user.$inferSelect;

export interface CreateUserInput {
  name: string;
  /**
   * A raw passcode - hashed here before storage. Use
   * `createWithPasswordHash` instead when you already have a hash (e.g.
   * `db:seed`'s `OWNER_PASSCODE_HASH` bootstrap).
   */
  passcode: string;
}

export async function create(input: CreateUserInput): Promise<UserRow> {
  const [created] = await db
    .insert(user)
    .values({
      id: ulid(),
      name: input.name.trim(),
      password_hash: hashPassword(input.passcode),
    })
    .returning();
  if (!created) {
    throw new Error('create(user): insert returned no row');
  }
  return created;
}

export interface CreateUserWithPasswordHashInput {
  name: string;
  /**
   * Already in the `"<saltHex>:<hashHex>"` format ../crypto.ts's
   * `hashPassword` produces - not re-hashed.
   */
  passwordHash: string;
}

/**
 * For `src/seed.ts`'s one-time bootstrap only, where the hash already
 * exists (`OWNER_PASSCODE_HASH`) - every other caller should use `create`
 * with a raw passcode instead.
 */
export async function createWithPasswordHash(
  input: CreateUserWithPasswordHashInput,
): Promise<UserRow> {
  const [created] = await db
    .insert(user)
    .values({
      id: ulid(),
      name: input.name.trim(),
      password_hash: input.passwordHash,
    })
    .returning();
  if (!created) {
    throw new Error('createWithPasswordHash(user): insert returned no row');
  }
  return created;
}

export async function getById(id: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(user).where(eq(user.id, id)).limit(1);
  return row;
}

/**
 * The single account, if setup has completed. Single-user means "the
 * user" is unambiguous - callers that need whoever owns this install
 * (login) use this instead of looking anyone up by identifier.
 */
export async function getSingleUser(): Promise<UserRow | undefined> {
  const [row] = await db.select().from(user).limit(1);
  return row;
}

/**
 * Renames the single account. Used by the logged-in owner editing their
 * own display name in Settings.
 */
export async function updateName(id: string, name: string): Promise<void> {
  await db.update(user).set({ name: name.trim() }).where(eq(user.id, id));
}

/**
 * Replaces the single account's passcode hash. Used by the logged-in
 * owner changing their own passcode in Settings.
 */
export async function updatePasscodeHash(id: string, passwordHash: string): Promise<void> {
  await db.update(user).set({ password_hash: passwordHash }).where(eq(user.id, id));
}
