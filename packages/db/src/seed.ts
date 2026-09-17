/**
 * Idempotent first-run seed: ensures the single `company` row exists,
 * ensures the system CEO agent exists, and (Phase 5's multi-user auth)
 * bootstraps the first login-able user account from `OWNER_EMAIL`/
 * `OWNER_PASSWORD_HASH` if no user exists yet.
 *
 * Run after `db:post-migrate`, e.g.:
 *   pnpm db:generate && pnpm db:migrate && pnpm db:post-migrate && pnpm db:seed
 */
import type { AgentPersona, ModelConfig } from '@katnor/core';
import { DEFAULT_COMPANY_SETTINGS } from '@katnor/core';
import { client, db } from './client.js';
import * as agentRepo from './repositories/agent.js';
import * as channelRepo from './repositories/channel.js';
import * as companyRepo from './repositories/company.js';
import * as userRepo from './repositories/user.js';
import { company } from './schema/index.js';

const DEFAULT_COMPANY_NAME = 'Katnor Inc.';

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

async function main() {
  const companyName = process.env.COMPANY_NAME?.trim() || DEFAULT_COMPANY_NAME;

  // Cheap pre-check purely so we can log "created" vs "already existed" -
  // companyRepo.getOrCreate() itself does the same select internally and
  // is the source of truth for whether a row is actually inserted.
  const [companyExistedBefore] = await db.select().from(company).limit(1);
  const companyRow = await companyRepo.getOrCreate({
    name: companyName,
    settings: DEFAULT_COMPANY_SETTINGS,
  });
  console.log(
    companyExistedBefore
      ? `[seed] company already exists: "${companyRow.name}" (${companyRow.id})`
      : `[seed] created company: "${companyRow.name}" (${companyRow.id})`,
  );

  const agents = await agentRepo.list();
  const existingCeo = agents.find((a) => a.is_system);

  if (existingCeo) {
    console.log(`[seed] system agent already exists: "${existingCeo.name}" (${existingCeo.id})`);
  } else {
    const ceo = await agentRepo.create({
      name: 'Nadia Reyes',
      title: 'CEO',
      persona: CEO_PERSONA,
      system_prompt: CEO_SYSTEM_PROMPT,
      // Sprite id for the 2D office view - a placeholder until the office
      // package defines its real sprite catalog.
      avatar: 'ceo',
      reports_to: null,
      team_id: null,
      model_config: CEO_MODEL_CONFIG,
      tool_allowlist: CEO_TOOL_ALLOWLIST,
      status: 'active',
      budget_daily_usd: '25.00',
      is_system: true,
    });
    console.log(`[seed] created system agent: "${ceo.name}" (${ceo.id})`);
  }

  const generalChannel = await channelRepo.getOrCreateGeneral();
  console.log(`[seed] #general channel ready: (${generalChannel.id})`);

  // Phase 5's "no self-serve signup" multi-user auth: the very first user
  // account can only come from here (a chicken-and-egg problem otherwise -
  // creating one via the dashboard requires already being logged in as
  // one). Every user after that is created by an already-logged-in user
  // through Settings > Team members (apps/server's `users.create`).
  const existingUsers = await userRepo.list();
  if (existingUsers.length > 0) {
    console.log(
      `[seed] ${existingUsers.length} user account(s) already exist - skipping owner bootstrap.`,
    );
  } else {
    const ownerEmail = process.env.OWNER_EMAIL?.trim();
    const ownerPasswordHash = process.env.OWNER_PASSWORD_HASH?.trim();
    if (ownerEmail && ownerPasswordHash) {
      const owner = await userRepo.createWithPasswordHash({
        name: 'Owner',
        email: ownerEmail,
        passwordHash: ownerPasswordHash,
      });
      console.log(`[seed] created first user account: ${owner.email} (${owner.id})`);
    } else {
      console.warn(
        '[seed] OWNER_EMAIL and/or OWNER_PASSWORD_HASH are not set - no user account created. ' +
          'Nobody can log in until one exists: set both in .env and re-run db:seed. ' +
          'See .env.example.',
      );
    }
  }

  await client.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[seed] failed:', err);
  await client.end({ timeout: 1 });
  process.exit(1);
});
