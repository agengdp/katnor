import { asc, eq } from 'drizzle-orm';
import { hashPassword } from '../crypto.js';
import { db } from '../client.js';
import { user } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type UserRow = typeof user.$inferSelect;

/**
 * Trims and lowercases so lookup/uniqueness don't depend on how an
 * address was capitalized when typed.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface CreateUserInput {
  name: string;
  email: string;
  /**
   * A raw password - hashed here before storage. Use
   * `createWithPasswordHash` instead when you already have a hash (e.g.
   * `db:seed`'s `OWNER_PASSWORD_HASH` bootstrap).
   */
  password: string;
}

export async function create(input: CreateUserInput): Promise<UserRow> {
  const [created] = await db
    .insert(user)
    .values({
      id: ulid(),
      name: input.name.trim(),
      email: normalizeEmail(input.email),
      password_hash: hashPassword(input.password),
    })
    .returning();
  if (!created) {
    throw new Error('create(user): insert returned no row');
  }
  return created;
}

export interface CreateUserWithPasswordHashInput {
  name: string;
  email: string;
  /**
   * Already in the `"<saltHex>:<hashHex>"` format ../crypto.ts's
   * `hashPassword` produces - not re-hashed.
   */
  passwordHash: string;
}

/**
 * For `src/seed.ts`'s one-time bootstrap only, where the hash already
 * exists (`OWNER_PASSWORD_HASH`) - every other caller should use `create`
 * with a raw password instead.
 */
export async function createWithPasswordHash(
  input: CreateUserWithPasswordHashInput,
): Promise<UserRow> {
  const [created] = await db
    .insert(user)
    .values({
      id: ulid(),
      name: input.name.trim(),
      email: normalizeEmail(input.email),
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

export async function getByEmail(email: string): Promise<UserRow | undefined> {
  const [row] = await db
    .select()
    .from(user)
    .where(eq(user.email, normalizeEmail(email)))
    .limit(1);
  return row;
}

/**
 * Oldest first - the first user ever created (typically the bootstrapped
 * owner) reads naturally as "first" in a list.
 */
export async function list(): Promise<UserRow[]> {
  return db.select().from(user).orderBy(asc(user.created_at));
}

export async function remove(id: string): Promise<void> {
  await db.delete(user).where(eq(user.id, id));
}
