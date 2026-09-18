/**
 * Idempotent first-run seed, for a CLI or scripted install.
 *
 * All of the actual work lives in ./bootstrap.ts, which the browser setup
 * wizard (apps/server's `setup.complete`) calls too - see that file for
 * why the two share one definition of "set up". This script is the thin
 * CLI wrapper: read env, call bootstrap, print what happened.
 *
 * The browser wizard is the easier path for a plain `docker compose up`:
 * start the stack, open the dashboard, and it walks you through the same
 * steps. This script stays for scripted and unattended installs, where
 * there is nobody to fill in a form.
 *
 * Run after `db:post-migrate`, e.g.:
 *   pnpm db:generate && pnpm db:migrate && pnpm db:post-migrate && pnpm db:seed
 */
import { client } from './client.js';
import {
  createFirstUserWithPasswordHash,
  ensureCompanyBootstrap,
  needsSetup,
  SetupAlreadyCompleteError,
} from './bootstrap.js';

async function main() {
  const result = await ensureCompanyBootstrap(process.env.COMPANY_NAME?.trim() || undefined);

  console.log(
    result.companyCreated
      ? `[seed] created company: "${result.companyName}" (${result.companyId})`
      : `[seed] company already exists: "${result.companyName}" (${result.companyId})`,
  );
  console.log(
    result.ceoCreated
      ? '[seed] created system agent: "Nadia Reyes" (CEO)'
      : '[seed] system agent already exists',
  );
  console.log(`[seed] #general channel ready: (${result.generalChannelId})`);

  // The very first user account: a chicken-and-egg problem otherwise,
  // since creating one through the dashboard requires already being
  // logged in. Every account after this one is created by an
  // already-logged-in user through Settings > Team members.
  if (!(await needsSetup())) {
    console.log('[seed] a user account already exists - skipping owner bootstrap.');
  } else {
    const ownerEmail = process.env.OWNER_EMAIL?.trim();
    const ownerPasswordHash = process.env.OWNER_PASSWORD_HASH?.trim();
    if (ownerEmail && ownerPasswordHash) {
      try {
        const owner = await createFirstUserWithPasswordHash({
          name: process.env.OWNER_NAME?.trim() || 'Owner',
          email: ownerEmail,
          passwordHash: ownerPasswordHash,
        });
        console.log(`[seed] created first user account: ${owner.email} (${owner.id})`);
      } catch (err) {
        // Only reachable if an account appeared between the check above
        // and the insert - e.g. somebody completing the browser wizard at
        // the same moment. Not an error worth failing the seed over: the
        // install ends up in exactly the intended state either way.
        if (!(err instanceof SetupAlreadyCompleteError)) throw err;
        console.log('[seed] a user account was created concurrently - skipping owner bootstrap.');
      }
    } else {
      console.warn(
        '[seed] OWNER_EMAIL and/or OWNER_PASSWORD_HASH are not set - no user account created. ' +
          'Nobody can log in until one exists. Either set both in .env and re-run db:seed, or ' +
          'just open the dashboard in a browser and complete the setup wizard, which creates ' +
          'the same account without needing a pre-computed hash.',
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
