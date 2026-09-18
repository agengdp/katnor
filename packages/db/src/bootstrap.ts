/**
 * What a freshly-installed Katnor needs before anyone can use it: the
 * single `company` row, the system CEO agent, the `#general` channel, and
 * the first user account that can actually log in.
 *
 * This lives here rather than inside src/seed.ts because there are now two
 * front doors to it, and they must agree on what "set up" means:
 *
 *   - `pnpm db:seed` (src/seed.ts), for a CLI/scripted install, and
 *   - the browser setup wizard (apps/server's `setup.complete`, rendered by
 *     apps/web's /setup route), for a plain `docker compose up`.
 *
 * If those two drifted apart, an install done one way would be subtly
 * different from one done the other way - a missing #general channel, a
 * CEO with a different tool allowlist - and nothing would say so until
 * something failed much later. So both call exactly this.
 *
 * Everything here is idempotent except `createFirstUser`, which is
 * deliberately once-only: see its own comment.
 */
import type { AgentPersona, ModelConfig } from '@katnor/core';
import { DEFAULT_COMPANY_SETTINGS } from '@katnor/core';
import { sql } from 'drizzle-orm';
import { db } from './client.js';
import { hashPassword } from './crypto.js';
import * as agentRepo from './repositories/agent.js';
import * as channelRepo from './repositories/channel.js';
import * as companyRepo from './repositories/company.js';
import type { UserRow } from './repositories/user.js';
import { company, user } from './schema/index.js';
import { ulid } from './ulid.js';

export const DEFAULT_COMPANY_NAME = 'Katnor Inc.';

const CEO_MODEL_CONFIG: ModelConfig = {
  provider: 'anthropic',
  model: 'claude-opus-5',
  effort: 'high',
  thinking_display: 'omitted',
  max_tokens: 8192,
};

const CEO_PERSONA: AgentPersona = {
  bio: 'Founding CEO of the company, hired first and reporting to no one.',
  personality: 'Decisive, pragmatic, communicates in short structured updates.',
  strengths: ['org design', 'delegation', 'clear briefs'],
  style: 'direct',
};

// The full company tool set (@katnor/agents' DEFAULT_COMPANY_TOOL_NAMES)
// plus every CEO-only org tool. Kept as a literal list rather than an
// import from @katnor/agents - that package already depends on
// @katnor/db, so importing it back here would be a circular package
// dependency. Keep in sync with companyTools.ts's tool names by hand.
const CEO_TOOL_ALLOWLIST = [
  'hire_agent',
  'update_agent',
  'fire_agent',
  'create_team',
  'send_message',
  'read_channel',
  'ask_colleague',
  'ask_human',
  'create_project',
  'delegate_task',
  'update_task',
];

const CEO_SYSTEM_PROMPT = [
  "You are Nadia Reyes, the founding CEO of this company. The company's mission is to complete",
  'the tasks its human owner assigns by building and running a small, well-run team of AI',
  'employees who plan, communicate, and ship real work. You are the only agent who can hire,',
  'update, or fire employees, form teams, and create new projects - every other employee works',
  'within the structure you set up. Keep the team lean: hire only the roles a project actually',
  'needs, give each hire a clear brief, and delegate rather than doing the work yourself.',
  'Communicate in short, structured updates, and escalate to the human owner only when a decision',
  'genuinely requires them.',
].join(' ');

/**
 * Thrown by `createFirstUser` when an account already exists.
 *
 * A distinct error class, not a string match: apps/server turns this into
 * a 409 on the public `setup.complete` endpoint, and getting that wrong -
 * reporting "already set up" as a generic 500, or worse, letting the call
 * through - is the difference between a closed front door and an open one.
 */
export class SetupAlreadyCompleteError extends Error {
  constructor() {
    super('Setup has already been completed - a user account already exists.');
    this.name = 'SetupAlreadyCompleteError';
  }
}

/**
 * True when nobody can log in yet, i.e. the install still needs its first
 * account.
 *
 * "No user rows" rather than "no company row" on purpose: the company and
 * CEO are recreated idempotently on every boot path, but a user account is
 * the thing that actually gates access, and the only one that cannot be
 * recreated automatically.
 */
export async function needsSetup(): Promise<boolean> {
  const rows = await db.select({ id: user.id }).from(user).limit(1);
  return rows.length === 0;
}

export interface CompanyBootstrapResult {
  companyId: string;
  companyName: string;
  companyCreated: boolean;
  ceoCreated: boolean;
  generalChannelId: string;
}

/**
 * Ensures the company row, the system CEO agent and `#general` all exist.
 * Safe to run repeatedly - every step is a get-or-create.
 */
export async function ensureCompanyBootstrap(
  companyName: string = DEFAULT_COMPANY_NAME,
): Promise<CompanyBootstrapResult> {
  const name = companyName.trim() || DEFAULT_COMPANY_NAME;

  // Cheap pre-check purely so callers can report "created" vs "already
  // existed" - companyRepo.getOrCreate() does the same select internally
  // and remains the source of truth for whether a row is inserted.
  const [companyExistedBefore] = await db.select().from(company).limit(1);
  const companyRow = await companyRepo.getOrCreate({
    name,
    settings: DEFAULT_COMPANY_SETTINGS,
  });

  const agents = await agentRepo.list();
  const existingCeo = agents.find((a) => a.is_system);
  let ceoCreated = false;
  if (!existingCeo) {
    await agentRepo.create({
      name: 'Nadia Reyes',
      title: 'CEO',
      persona: CEO_PERSONA,
      system_prompt: CEO_SYSTEM_PROMPT,
      // Sprite id for the 2D office view. The office generates its
      // characters from the agent id now (apps/web's lib/office/sprite.ts),
      // so this is carried but unused by the current renderer.
      avatar: 'ceo',
      reports_to: null,
      team_id: null,
      model_config: CEO_MODEL_CONFIG,
      tool_allowlist: CEO_TOOL_ALLOWLIST,
      status: 'active',
      budget_daily_usd: '25.00',
      is_system: true,
    });
    ceoCreated = true;
  }

  const generalChannel = await channelRepo.getOrCreateGeneral();

  return {
    companyId: companyRow.id,
    companyName: companyRow.name,
    companyCreated: !companyExistedBefore,
    ceoCreated,
    generalChannelId: generalChannel.id,
  };
}

export interface CreateFirstUserInput {
  name: string;
  email: string;
  /** Raw password - hashed here. */
  password: string;
}

/**
 * An arbitrary but fixed key for the Postgres advisory lock below. Any
 * constant works as long as nothing else in this database picks the same
 * one; it is not derived from anything, and changing it would only matter
 * mid-flight during a concurrent setup.
 */
const SETUP_ADVISORY_LOCK_KEY = 4820771;

/**
 * Creates the very first user account, and refuses if one already exists.
 *
 * This is the security boundary of the whole setup flow. `setup.complete`
 * is necessarily a *public* endpoint - the first account cannot require
 * being logged in to create - so the only thing standing between a fresh
 * install and anyone on the network claiming it is this check. Once one
 * account exists the door closes permanently, and every account after it
 * is created by an already-logged-in user through Settings > Team members.
 *
 * The check and the insert run in one transaction holding
 * `pg_advisory_xact_lock`, rather than a plain "select then insert":
 *
 *   - At READ COMMITTED, two concurrent requests would both see zero rows
 *     and both insert - two owners, neither aware of the other.
 *   - A unique constraint on `email` does not help, because the racers can
 *     submit different addresses.
 *   - The advisory lock makes the second request wait for the first to
 *     commit, at which point it sees the row and is rejected.
 *
 * Everything runs on `tx`, never the pooled `db` singleton, so the lock
 * and the reads it protects are genuinely on the same connection. The
 * `xact` variant releases at commit or rollback, so a thrown error cannot
 * strand the lock.
 */
export async function createFirstUser(input: CreateFirstUserInput): Promise<UserRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_ADVISORY_LOCK_KEY})`);

    const existing = await tx.select({ id: user.id }).from(user).limit(1);
    if (existing.length > 0) {
      throw new SetupAlreadyCompleteError();
    }

    const [created] = await tx
      .insert(user)
      .values({
        id: ulid(),
        name: input.name.trim(),
        email: input.email.trim().toLowerCase(),
        password_hash: hashPassword(input.password),
      })
      .returning();
    if (!created) {
      throw new Error('createFirstUser: insert returned no row');
    }
    return created;
  });
}

/**
 * Creates the first user account from an already-computed password hash -
 * the `OWNER_PASSWORD_HASH` path `pnpm db:seed` uses, where the operator
 * hashed the password themselves and the raw one never reaches this
 * process. Identical guarantees to `createFirstUser`; see its comment.
 */
export async function createFirstUserWithPasswordHash(input: {
  name: string;
  email: string;
  passwordHash: string;
}): Promise<UserRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_ADVISORY_LOCK_KEY})`);

    const existing = await tx.select({ id: user.id }).from(user).limit(1);
    if (existing.length > 0) {
      throw new SetupAlreadyCompleteError();
    }

    const [created] = await tx
      .insert(user)
      .values({
        id: ulid(),
        name: input.name.trim(),
        email: input.email.trim().toLowerCase(),
        password_hash: input.passwordHash,
      })
      .returning();
    if (!created) {
      throw new Error('createFirstUserWithPasswordHash: insert returned no row');
    }
    return created;
  });
}
